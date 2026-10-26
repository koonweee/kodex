//! One fixed secondary display shared by live Desktop sockets, never browser state.
use super::DesktopFailure;
use std::{
    ffi::OsString,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
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
struct Session {
    process: Mutex<HelperProcess>,
    healthy: AtomicBool,
}
struct HelperProcess {
    child: Option<Child>,
    ownership: Option<OwnedMutexGuard<()>>,
    input: Option<ChildStdin>,
    output: BufReader<ChildStdout>,
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
        let mut current = self.current.lock().await;
        if let Some(session) = current.upgrade() {
            let mut process = session.process.lock().await;
            let alive = session.healthy.load(Ordering::Acquire)
                && process
                    .child
                    .as_mut()
                    .is_some_and(|child| matches!(child.try_wait(), Ok(None)));
            if alive {
                drop(process);
                return Ok(DisplayLease {
                    session: Some(session),
                    grace: self.grace,
                });
            }
            // Replacement waits for removal/reaping, even while old viewers retain leases.
            process.stop().await?;
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
        };
        tokio::time::timeout(Duration::from_secs(5), process.read_target())
            .await
            .map_err(|_| DesktopFailure::Timeout)??;
        let session = Arc::new(Session {
            process: Mutex::new(process),
            healthy: AtomicBool::new(true),
        });
        *current = Arc::downgrade(&session);
        Ok(DisplayLease {
            session: Some(session),
            grace: self.grace,
        })
    }
    pub(crate) async fn target(&self) -> Result<Option<DisplayTarget>, DesktopFailure> {
        let Some(session) = self.current.lock().await.upgrade() else {
            return Ok(None);
        };
        if !session.healthy.load(Ordering::Acquire) {
            return Err(DesktopFailure::VirtualDisplay);
        }
        let result = tokio::time::timeout(Duration::from_secs(2), async {
            let mut process = session.process.lock().await;
            process
                .input
                .as_mut()
                .ok_or(DesktopFailure::VirtualDisplay)?
                .write_all(b"?")
                .await?;
            process.read_target().await.map(Some)
        })
        .await
        .map_err(|_| DesktopFailure::Timeout)
        .and_then(|value| value);
        if result.is_err() {
            // Keep an unhealthy weak entry until replacement, so remaining viewers
            // see an error rather than a misleading "no preferred display" reply.
            session.healthy.store(false, Ordering::Release);
            let _ = session.process.lock().await.stop().await;
        }
        result
    }
}
impl HelperProcess {
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
    async fn read_target(&mut self) -> Result<DisplayTarget, DesktopFailure> {
        let mut bytes = Vec::new();
        (&mut self.output)
            .take(512)
            .read_until(b'\n', &mut bytes)
            .await?;
        if !bytes.ends_with(b"\n") {
            return Err(DesktopFailure::VirtualDisplay);
        }
        let target: DisplayTarget =
            serde_json::from_slice(&bytes).map_err(|_| DesktopFailure::VirtualDisplay)?;
        if target.width != 1200
            || target.height != 900
            || i16::try_from(target.x).is_err()
            || i16::try_from(target.y).is_err()
        {
            return Err(DesktopFailure::VirtualDisplay);
        }
        Ok(target)
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
    grace: Duration,
}
impl DisplayLease {
    pub(crate) fn watch(self) -> impl std::future::Future<Output = DesktopFailure> + Send {
        async move {
            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                let session = self.session.as_ref().expect("live display lease");
                let mut process = session.process.lock().await;
                if !session.healthy.load(Ordering::Acquire)
                    || !process
                        .child
                        .as_mut()
                        .is_some_and(|child| matches!(child.try_wait(), Ok(None)))
                {
                    return DesktopFailure::Connection;
                }
            }
        }
    }
}
impl Drop for DisplayLease {
    fn drop(&mut self) {
        if let (Some(session), Ok(runtime)) =
            (self.session.take(), tokio::runtime::Handle::try_current())
        {
            let grace = self.grace;
            runtime.spawn(async move {
                tokio::time::sleep(grace).await;
                drop(session);
            });
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
