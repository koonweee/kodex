use super::*;
use std::fs;
use tokio::time::{sleep, timeout};

fn fixture(script: &str) -> (tempfile::TempDir, VirtualDisplayManager) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("helper.py");
    fs::write(
        &path,
        format!(
            r#"import os,sys,time
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
const READY: &str = r#"print('{"x":2560,"y":0,"width":1200,"height":900}', flush=True)
while sys.stdin.buffer.read(1): print('{"x":2560,"y":0,"width":1200,"height":900}', flush=True)"#;
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
        r#"print('{"x":2560,"y":0,"width":1200,"height":900}',flush=True)
while sys.stdin.buffer.read(1): print('{"x":-1200,"y":50,"width":1200,"height":900}',flush=True)"#,
    );
    let a = manager.acquire().await.unwrap();
    assert_eq!(manager.target().await.unwrap().unwrap().x, -1200);
    assert!(std::process::Command::new("/bin/kill")
        .args(["-KILL", &pids(&dir)[0].to_string()])
        .status()
        .unwrap()
        .success());
    sleep(Duration::from_millis(50)).await;
    let b = manager.acquire().await.unwrap();
    assert_eq!(pids(&dir).len(), 2);
    drop(a);
    drop(b);
    for pid in pids(&dir) {
        gone(pid).await;
    }
}

#[tokio::test]
async fn an_unresponsive_helper_is_invalidated_before_the_next_connection() {
    let (dir, manager) = fixture(
        r#"print('{"x":2560,"y":0,"width":1200,"height":900}',flush=True)
time.sleep(30)"#,
    );
    let a = manager.acquire().await.unwrap();
    assert!(manager.target().await.is_err());
    gone(pids(&dir)[0]).await; // old lease remains held until after replacement
    let b = manager.acquire().await.unwrap();
    assert_eq!(pids(&dir).len(), 2, "reconnect must replace the hung owner");
    drop(a);
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
