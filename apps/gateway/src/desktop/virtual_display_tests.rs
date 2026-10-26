use super::*;
use std::fs;
use tokio::time::{sleep, timeout};

fn fixture(script: &str) -> (tempfile::TempDir, VirtualDisplayManager) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("helper.py");
    fs::write(
        &path,
        format!(
            r#"import os,sys,time,json

def emit(state='virtual', generation=1, x=2560):
 print(json.dumps(dict(state=state,generation=generation,target=dict(x=x,y=0,width=1200,height=900) if state=='virtual' else None)),flush=True)
with open(sys.argv[1], 'a') as log: log.write(str(os.getpid())+'\n')
{script}
"#
        ),
    )
    .unwrap();
    let manager = VirtualDisplayManager::with_command(
        "/usr/bin/python3".into(),
        vec![
            "-u".into(),
            path.into_os_string(),
            dir.path().join("pids").into_os_string(),
        ],
        Duration::from_millis(50),
    );
    (dir, manager)
}
const READY: &str = r#"emit()
while sys.stdin.buffer.read(1): emit()"#;
fn pids(dir: &tempfile::TempDir) -> Vec<u32> {
    fs::read_to_string(dir.path().join("pids"))
        .unwrap_or_default()
        .lines()
        .map(|line| line.parse().unwrap())
        .collect()
}
async fn gone(pid: u32) {
    timeout(Duration::from_secs(3), async {
        while std::process::Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success()
        {
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("owned helper must be reaped");
}

#[tokio::test]
async fn simultaneous_viewers_share_one_display_and_final_close_removes_it() {
    let (dir, manager) = fixture(READY);
    let (a, b) = tokio::join!(manager.acquire(), manager.acquire());
    let a = a.unwrap();
    let b = b.unwrap();
    assert_eq!(pids(&dir).len(), 1);
    assert_eq!(
        manager.target().await.unwrap(),
        Some(DisplayTarget {
            x: 2560,
            y: 0,
            width: 1200,
            height: 900
        })
    );
    drop(a);
    sleep(Duration::from_millis(100)).await;
    assert!(manager.target().await.unwrap().is_some());
    drop(b);
    gone(pids(&dir)[0]).await;
    assert_eq!(manager.target().await.unwrap(), None);
}

#[tokio::test]
async fn a_short_reconnect_retains_the_display_but_a_later_open_creates_a_new_one() {
    let (dir, manager) = fixture(READY);
    drop(manager.acquire().await.unwrap());
    let reconnected = manager.acquire().await.unwrap();
    sleep(Duration::from_millis(100)).await;
    assert_eq!(pids(&dir).len(), 1);
    drop(reconnected);
    gone(pids(&dir)[0]).await;
    let next = manager.acquire().await.unwrap();
    assert_eq!(pids(&dir).len(), 2);
    drop(next);
    gone(pids(&dir)[1]).await;
}

#[tokio::test]
async fn canceled_startup_kills_the_unready_helper_without_leaking_a_display_owner() {
    let (dir, manager) = fixture("time.sleep(30)");
    {
        let acquire = manager.acquire();
        tokio::pin!(acquire);
        tokio::select! {result=&mut acquire=>panic!("startup unexpectedly returned: {}",result.is_ok()), _=sleep(Duration::from_millis(150))=>{}}
        assert_eq!(pids(&dir).len(), 1);
    }
    gone(pids(&dir)[0]).await;
    assert_eq!(manager.target().await.unwrap(), None);
}

#[tokio::test]
async fn failed_or_wrong_mode_startup_does_not_poison_the_next_acquisition() {
    let (dir, manager) =
        fixture("print('{\"x\":0,\"y\":0,\"width\":2400,\"height\":1800}',flush=True)");
    assert!(manager.acquire().await.is_err());
    assert!(manager.acquire().await.is_err());
    let ids = pids(&dir);
    assert_eq!(ids.len(), 2);
    for id in ids {
        gone(id).await;
    }
    assert_eq!(manager.target().await.unwrap(), None);
}

#[tokio::test]
async fn live_target_reads_current_geometry_and_a_dead_helper_can_be_replaced() {
    let (dir, manager) = fixture(
        r#"emit()
while sys.stdin.buffer.read(1): emit(generation=2,x=-1200)"#,
    );
    let a = manager.acquire().await.unwrap();
    assert_eq!(manager.target().await.unwrap().unwrap().x, -1200);
    let other = manager.acquire().await.unwrap();
    assert!(std::process::Command::new("/bin/kill")
        .args(["-KILL", &pids(&dir)[0].to_string()])
        .status()
        .unwrap()
        .success());
    sleep(Duration::from_millis(50)).await;
    assert_eq!(
        manager.acquire().await.err(),
        Some(DesktopFailure::Connection)
    );
    assert_eq!(
        pids(&dir).len(),
        1,
        "replacement must wait for old input lease"
    );
    drop(a);
    assert_eq!(
        manager.acquire().await.err(),
        Some(DesktopFailure::Connection)
    );
    drop(other);
    let b = manager.acquire().await.unwrap();
    assert_eq!(pids(&dir).len(), 2);
    drop(b);
    for pid in pids(&dir) {
        gone(pid).await;
    }
}

#[tokio::test]
async fn an_unresponsive_helper_is_invalidated_before_the_next_connection() {
    let (dir, manager) = fixture(
        r#"emit()
time.sleep(30)"#,
    );
    let a = manager.acquire().await.unwrap();
    assert!(manager.target().await.is_err());
    gone(pids(&dir)[0]).await; // old input lease is still held; replacement must wait
    assert_eq!(
        manager.acquire().await.err(),
        Some(DesktopFailure::Connection)
    );
    drop(a);
    let b = manager.acquire().await.unwrap();
    assert_eq!(
        pids(&dir).len(),
        2,
        "reconnect replaces the hung owner after drain"
    );
    drop(b);
    for id in pids(&dir) {
        gone(id).await;
    }
}

#[tokio::test]
async fn a_new_viewer_waits_for_final_release_cleanup_before_creating_another_helper() {
    let (dir, manager) = fixture(&format!("{READY}\ntime.sleep(.3)"));
    drop(manager.acquire().await.unwrap());
    let old = pids(&dir)[0];
    sleep(Duration::from_millis(100)).await;
    let next = manager.acquire().await.unwrap();
    assert!(
        !std::process::Command::new("/bin/kill")
            .args(["-0", &old.to_string()])
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success(),
        "replacement must wait for previous owner removal/reaping"
    );
    drop(next);
    for pid in pids(&dir) {
        gone(pid).await;
    }
}

#[tokio::test]
async fn a_lost_helper_ends_the_viewer_lifetime_without_waiting_for_native_metadata() {
    let (dir, manager) = fixture(READY);
    let lease = manager.acquire().await.unwrap();
    assert!(std::process::Command::new("/bin/kill")
        .args(["-KILL", &pids(&dir)[0].to_string()])
        .status()
        .unwrap()
        .success());
    assert_eq!(
        timeout(Duration::from_secs(2), lease.watch())
            .await
            .unwrap(),
        DesktopFailure::Connection
    );
    gone(pids(&dir)[0]).await;
}

#[tokio::test]
async fn locked_login_handover_waits_for_every_old_connection_to_drain() {
    let (dir, manager) = fixture(
        r#"emit('login')
while True:
 command=sys.stdin.buffer.read(1)
 if not command: break
 unlocked=os.path.exists(sys.argv[1]+'.unlock')
 if command==b'p':
  assert unlocked
  with open(sys.argv[1]+'.promoted','w') as log:log.write('yes')
  emit(generation=3)
 elif os.path.exists(sys.argv[1]+'.promoted'): emit(generation=3)
 elif unlocked: emit('transitioning',2)
 else: emit('login')"#,
    );
    let a = manager
        .acquire()
        .await
        .expect("locked readiness must permit native login");
    let b = manager.acquire().await.unwrap();
    assert_eq!(manager.target().await.unwrap(), None);
    fs::write(dir.path().join("pids.unlock"), "").unwrap();
    assert_eq!(
        timeout(Duration::from_secs(2), a.watch()).await.unwrap(),
        DesktopFailure::Connection
    );
    assert_eq!(
        timeout(Duration::from_secs(2), b.watch()).await.unwrap(),
        DesktopFailure::Connection
    );
    assert_eq!(
        manager.acquire().await.err(),
        Some(DesktopFailure::Connection)
    );
    assert!(
        !dir.path().join("pids.promoted").exists(),
        "old input socket leases still own the login geometry"
    );
    drop(a);
    assert_eq!(
        manager.acquire().await.err(),
        Some(DesktopFailure::Connection)
    );
    drop(b);
    let virtual_lease = manager.acquire().await.unwrap();
    assert!(dir.path().join("pids.promoted").exists());
    assert!(manager.target().await.unwrap().is_some());
    assert_eq!(pids(&dir).len(), 1, "handover must retain helper identity");
    drop(virtual_lease);
    gone(pids(&dir)[0]).await;
}

#[tokio::test]
async fn generation_fences_a_rapid_cycle_back_to_identical_geometry() {
    let (dir, manager) = fixture(
        r#"emit()
while sys.stdin.buffer.read(1): emit(generation=3)"#,
    );
    let lease = manager.acquire().await.unwrap();
    assert_eq!(
        timeout(Duration::from_secs(2), lease.watch())
            .await
            .unwrap(),
        DesktopFailure::Connection
    );
    drop(lease);
    gone(pids(&dir)[0]).await;
}

#[tokio::test]
async fn contradictory_or_regressing_helper_state_is_replaced() {
    for reply in [
        r#"print('{"state":"login","generation":2,"target":{"x":0,"y":0,"width":1200,"height":900}}',flush=True)"#,
        "emit('virtual',0)",
        "emit('transitioning',1)",
    ] {
        let (dir, manager) = fixture(&format!("emit()\nwhile sys.stdin.buffer.read(1): {reply}"));
        let lease = manager.acquire().await.unwrap();
        assert!(manager.target().await.is_err());
        gone(pids(&dir)[0]).await;
        drop(lease);
    }
}

#[tokio::test]
async fn canceled_helper_query_cannot_leave_a_reusable_partial_protocol_exchange() {
    let (dir, manager) = fixture("emit('login')\nwhile sys.stdin.buffer.read(1): time.sleep(30)");
    let lease = manager.acquire().await.unwrap();
    {
        let read = manager.target();
        tokio::pin!(read);
        tokio::select! {result=&mut read=>panic!("unexpected reply: {result:?}"),_=sleep(Duration::from_millis(100))=>{}}
    }
    assert_eq!(
        manager.acquire().await.err(),
        Some(DesktopFailure::Connection)
    );
    gone(pids(&dir)[0]).await;
    drop(lease);
    let replacement = manager.acquire().await.unwrap();
    assert_eq!(pids(&dir).len(), 2);
    drop(replacement);
    gone(pids(&dir)[1]).await;
}

#[tokio::test]
async fn last_close_while_locked_and_a_fresh_locked_open_never_promote() {
    let (dir, manager) = fixture("emit('login')\nwhile sys.stdin.buffer.read(1): emit('login')");
    let lease = manager.acquire().await.unwrap();
    assert_eq!(manager.target().await.unwrap(), None);
    drop(lease);
    gone(pids(&dir)[0]).await;
    let lease = manager.acquire().await.unwrap();
    assert_eq!(manager.target().await.unwrap(), None);
    assert_eq!(pids(&dir).len(), 2);
    drop(lease);
    gone(pids(&dir)[1]).await;
}
