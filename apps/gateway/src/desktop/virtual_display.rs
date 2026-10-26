//! One fixed temporary main display shared by live Desktop sockets, never browser state.
use super::DesktopFailure;
use std::{
    ffi::OsString,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Weak,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{Mutex, OwnedMutexGuard},
};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct DisplayTarget {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone)]
pub(crate) struct VirtualDisplayManager {
    current: Arc<Mutex<Weak<Session>>>,
    ownership: Arc<Mutex<()>>,
    program: Option<PathBuf>,
    args: Vec<OsString>,
    grace: Duration,
}
impl Default for VirtualDisplayManager {
    fn default() -> Self {
        Self {
            current: Arc::default(),
            ownership: Arc::default(),
            program: None,
            args: vec!["--desktop-virtual-display-helper".into()],
            grace: Duration::from_secs(5),
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum DisplayState {
    Login,
    Transitioning,
    Virtual,
}
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    generation: u64,
    state: DisplayState,
    target: Option<DisplayTarget>,
}
struct Session {
    process: Mutex<HelperProcess>,
    healthy: AtomicBool,
    active: AtomicUsize,
}
struct HelperProcess {
    child: Option<Child>,
    ownership: Option<OwnedMutexGuard<()>>,
    input: Option<ChildStdin>,
    output: BufReader<ChildStdout>,
    last: Option<Snapshot>,
}
// A canceled/partial request cannot leave a healthy but desynchronized pipe.
struct QueryGuard<'a> {
    healthy: &'a AtomicBool,
    completed: bool,
}
impl Drop for QueryGuard<'_> {
    fn drop(&mut self) {
        if !self.completed {
            self.healthy.store(false, Ordering::Release);
        }
    }
}
impl VirtualDisplayManager {
    #[cfg(test)]
    pub(crate) fn with_command(program: PathBuf, args: Vec<OsString>, grace: Duration) -> Self {
        Self {
            program: Some(program),
            args,
            grace,
            ..Self::default()
        }
    }
    pub(crate) async fn acquire(&self) -> Result<DisplayLease, DesktopFailure> {
        tokio::time::timeout(Duration::from_secs(10), self.acquire_inner())
            .await
            .map_err(|_| DesktopFailure::Timeout)?
    }
    async fn acquire_inner(&self) -> Result<DisplayLease, DesktopFailure> {
        // Serialize admission with promotion; drops may only reduce the live count.
        let mut current = self.current.lock().await;
        if let Some(session) = current.upgrade() {
            let mut process = session.process.lock().await;
            if session.healthy.load(Ordering::Acquire) && process.alive() {
                drop(process);
                let snapshot = session.query(b"?").await?;
                return self.admit(session, snapshot).await;
            }
            session.healthy.store(false, Ordering::Release);
            process.stop().await?;
            if session.active.load(Ordering::Acquire) != 0 {
                return Err(DesktopFailure::Connection);
            }
        }
        let program = self
            .program
            .clone()
            .map(Ok)
            .unwrap_or_else(std::env::current_exe)
            .map_err(|_| DesktopFailure::VirtualDisplay)?;
        let ownership = self.ownership.clone().lock_owned().await;
        let mut child = Command::new(program)
            .args(&self.args)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| DesktopFailure::VirtualDisplay)?;
        let input = child.stdin.take().ok_or(DesktopFailure::VirtualDisplay)?;
        let output = child.stdout.take().ok_or(DesktopFailure::VirtualDisplay)?;
        let mut process = HelperProcess {
            child: Some(child),
            ownership: Some(ownership),
            input: Some(input),
            output: BufReader::new(output),
            last: None,
        };
        let snapshot = tokio::time::timeout(Duration::from_secs(5), process.read_snapshot())
            .await
            .map_err(|_| DesktopFailure::Timeout)??;
        let session = Arc::new(Session {
            process: Mutex::new(process),
            healthy: AtomicBool::new(true),
            active: AtomicUsize::new(0),
        });
        *current = Arc::downgrade(&session);
        self.admit(session, snapshot).await
    }
    async fn admit(
        &self,
        session: Arc<Session>,
        mut snapshot: Snapshot,
    ) -> Result<DisplayLease, DesktopFailure> {
        if snapshot.state == DisplayState::Transitioning {
            if session.active.load(Ordering::Acquire) != 0 {
                return Err(DesktopFailure::Connection);
            }
            // Old run() calls have finished, dropping their relay futures/upstream
            // sockets. Only this explicit command can authorize geometry mutation.
            snapshot = session.query(b"p").await?;
            snapshot = tokio::time::timeout(Duration::from_secs(5), async {
                while snapshot.state == DisplayState::Transitioning {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    snapshot = session.query(b"?").await?;
                }
                Ok::<_, DesktopFailure>(snapshot)
            })
            .await
            .map_err(|_| DesktopFailure::Timeout)??;
        }
        session.active.fetch_add(1, Ordering::AcqRel);
        Ok(DisplayLease {
            session: Some(session),
            generation: snapshot.generation,
            grace: self.grace,
        })
    }
    pub(crate) async fn target(&self) -> Result<Option<DisplayTarget>, DesktopFailure> {
        let Some(session) = self.current.lock().await.upgrade() else {
            return Ok(None);
        };
        let snapshot = session.query(b"?").await?;
        if snapshot.state == DisplayState::Transitioning {
            // A normal handover is retryable, not a poisoned helper.
            return Err(DesktopFailure::Connection);
        }
        Ok(snapshot.target)
    }
}
impl Session {
    async fn query(&self, command: &[u8]) -> Result<Snapshot, DesktopFailure> {
        let result = tokio::time::timeout(Duration::from_secs(2), async {
            let mut process = self.process.lock().await;
            if !self.healthy.load(Ordering::Acquire) || !process.alive() {
                return Err(DesktopFailure::VirtualDisplay);
            }
            let mut guard = QueryGuard {
                healthy: &self.healthy,
                completed: false,
            };
            process
                .input
                .as_mut()
                .ok_or(DesktopFailure::VirtualDisplay)?
                .write_all(command)
                .await?;
            let snapshot = process.read_snapshot().await?;
            guard.completed = true;
            Ok(snapshot)
        })
        .await
        .map_err(|_| DesktopFailure::Timeout)
        .and_then(|result| result);
        if result.is_err() {
            self.healthy.store(false, Ordering::Release);
            let _ = self.process.lock().await.stop().await;
        }
        result
    }
}
impl HelperProcess {
    fn alive(&mut self) -> bool {
        self.child
            .as_mut()
            .is_some_and(|child| matches!(child.try_wait(), Ok(None)))
    }
    async fn stop(&mut self) -> Result<(), DesktopFailure> {
        self.input.take();
        if let Some(child) = self.child.as_mut() {
            if !matches!(
                tokio::time::timeout(Duration::from_secs(2), child.wait()).await,
                Ok(Ok(_))
            ) {
                if let Err(error) = child.start_kill() {
                    if !matches!(child.try_wait(), Ok(Some(_))) {
                        return Err(error.into());
                    }
                }
                tokio::time::timeout(Duration::from_secs(1), child.wait())
                    .await
                    .map_err(|_| DesktopFailure::Timeout)??;
            }
        }
        self.child.take();
        self.ownership.take();
        Ok(())
    }
    async fn read_snapshot(&mut self) -> Result<Snapshot, DesktopFailure> {
        let mut bytes = Vec::new();
        (&mut self.output)
            .take(512)
            .read_until(b'\n', &mut bytes)
            .await?;
        if !bytes.ends_with(b"\n") {
            return Err(DesktopFailure::VirtualDisplay);
        }
        let snapshot: Snapshot =
            serde_json::from_slice(&bytes).map_err(|_| DesktopFailure::VirtualDisplay)?;
        let target_valid = match (&snapshot.state, &snapshot.target) {
            (DisplayState::Virtual, Some(target)) => {
                target.width == 1200
                    && target.height == 900
                    && i16::try_from(target.x).is_ok()
                    && i16::try_from(target.y).is_ok()
            }
            (DisplayState::Login | DisplayState::Transitioning, None) => true,
            _ => false,
        };
        if !target_valid
            || snapshot.generation == 0
            || self.last.as_ref().is_some_and(|previous| {
                snapshot.generation < previous.generation
                    || (snapshot.generation == previous.generation && snapshot != *previous)
            })
        {
            return Err(DesktopFailure::VirtualDisplay);
        }
        self.last = Some(snapshot.clone());
        Ok(snapshot)
    }
}
impl Drop for HelperProcess {
    fn drop(&mut self) {
        self.input.take();
        let ownership = self.ownership.take();
        if let (Some(mut child), Ok(runtime)) =
            (self.child.take(), tokio::runtime::Handle::try_current())
        {
            runtime.spawn(async move {
                // Keep creation serialized until graceful removal or forced reaping.
                let _ownership = ownership;
                if !matches!(
                    tokio::time::timeout(Duration::from_secs(2), child.wait()).await,
                    Ok(Ok(_))
                ) {
                    let _ = child.start_kill();
                    let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
                }
            });
        }
    }
}
pub(crate) struct DisplayLease {
    session: Option<Arc<Session>>,
    generation: u64,
    grace: Duration,
}
impl DisplayLease {
    pub(crate) fn watch(
        &self,
    ) -> impl std::future::Future<Output = DesktopFailure> + Send + 'static {
        let session = self.session.as_ref().expect("live display lease").clone();
        let generation = self.generation;
        async move {
            loop {
                tokio::time::sleep(Duration::from_millis(250)).await;
                match session.query(b"?").await {
                    Ok(snapshot) if snapshot.generation == generation => {}
                    _ => return DesktopFailure::Connection,
                }
            }
        }
    }
}
impl Drop for DisplayLease {
    fn drop(&mut self) {
        if let Some(session) = self.session.take() {
            session.active.fetch_sub(1, Ordering::AcqRel);
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                let grace = self.grace;
                runtime.spawn(async move {
                    tokio::time::sleep(grace).await;
                    drop(session);
                });
            }
        }
    }
}

/// Internal subprocess entry: no gateway config, database, credentials or app-server.
pub fn run_helper() -> i32 {
    #[cfg(target_os = "macos")]
    {
        unsafe {
            unsafe extern "C" {
                fn kodex_virtual_display_main() -> std::ffi::c_int;
            }
            kodex_virtual_display_main()
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        1
    }
}
#[cfg(test)]
#[path = "virtual_display_tests.rs"]
mod tests;
