use std::{
    collections::{HashMap, VecDeque},
    env,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, RwLock as StdRwLock,
    },
    time::Duration,
};

use anyhow::{anyhow, Context};
use chrono::Utc;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, mpsc, Mutex};
use utoipa::ToSchema;
use uuid::Uuid;

const DEFAULT_ROWS: u16 = 24;
const DEFAULT_COLS: u16 = 80;
const HISTORY_MAX_BYTES: usize = 1024 * 1024;
const STDOUT_CHANNEL_CAPACITY: usize = 1024;
const STDIN_CHANNEL_CAPACITY: usize = 1024;
const EXIT_CHANNEL_CAPACITY: usize = 16;
pub const MAX_TERMINAL_SESSIONS: usize = 8;

#[derive(Clone)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>,
    default_cwd: PathBuf,
}

impl TerminalManager {
    pub fn new(default_cwd: PathBuf) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            default_cwd,
        }
    }

    pub async fn create_session(
        &self,
        request: CreateTerminalSession,
    ) -> anyhow::Result<TerminalSessionInfo> {
        let cwd = resolve_terminal_cwd(request.cwd.as_deref(), &self.default_cwd)?;
        let command = request.command.unwrap_or_else(default_terminal_command);
        let title = request
            .title
            .filter(|title| !title.trim().is_empty())
            .unwrap_or_else(|| terminal_title(&command, &cwd));
        let mut sessions = self.sessions.lock().await;
        sessions.retain(|_, session| !session.cancelled());
        if sessions.len() >= MAX_TERMINAL_SESSIONS {
            return Err(anyhow!(
                "terminal session limit reached; close a terminal before opening another"
            ));
        }
        let session = Arc::new(TerminalSession::spawn(title, cwd, command)?);
        let info = session.info();
        sessions.insert(info.id.clone(), session);
        Ok(info)
    }

    pub async fn list_sessions(&self) -> Vec<TerminalSessionInfo> {
        self.cleanup_exited().await;
        let mut sessions = self
            .sessions
            .lock()
            .await
            .values()
            .map(|session| session.info())
            .collect::<Vec<_>>();
        sessions.sort_by(|left, right| left.created_at.cmp(&right.created_at));
        sessions
    }

    pub async fn get_session(&self, terminal_id: &str) -> Option<Arc<TerminalSession>> {
        self.cleanup_exited().await;
        self.sessions.lock().await.get(terminal_id).cloned()
    }

    pub async fn delete_session(&self, terminal_id: &str) -> bool {
        if let Some(session) = self.sessions.lock().await.remove(terminal_id) {
            session.kill();
            true
        } else {
            false
        }
    }

    async fn cleanup_exited(&self) {
        self.sessions
            .lock()
            .await
            .retain(|_, session| !session.cancelled());
    }
}

pub struct TerminalSession {
    id: String,
    title: String,
    cwd: PathBuf,
    command: String,
    created_at: String,
    cancelled: Arc<AtomicBool>,
    stdin: mpsc::Sender<TerminalInput>,
    stdout: broadcast::Sender<Vec<u8>>,
    exit: broadcast::Sender<()>,
    history: Arc<TerminalHistory>,
}

impl TerminalSession {
    fn spawn(title: String, cwd: PathBuf, command: String) -> anyhow::Result<Self> {
        let terminal = native_pty_system()
            .openpty(PtySize {
                rows: DEFAULT_ROWS,
                cols: DEFAULT_COLS,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("failed to open pseudo-terminal")?;
        let mut command_builder = command_builder(&command)?;
        command_builder.cwd(&cwd);
        command_builder.env("TERM", "xterm-256color");
        command_builder.env("COLORTERM", "truecolor");
        let mut child = terminal
            .slave
            .spawn_command(command_builder)
            .context("failed to spawn terminal command")?;

        std::thread::sleep(Duration::from_millis(75));
        if let Some(status) = child
            .try_wait()
            .context("failed to check terminal command status")?
        {
            return Err(anyhow!(
                "terminal command exited immediately with code {}",
                status.exit_code()
            ));
        }

        let mut writer = terminal
            .master
            .take_writer()
            .context("failed to take terminal writer")?;
        let mut reader = terminal
            .master
            .try_clone_reader()
            .context("failed to clone terminal reader")?;
        let (stdin, mut stdin_rx) = mpsc::channel::<TerminalInput>(STDIN_CHANNEL_CAPACITY);
        let (stdout, _) = broadcast::channel::<Vec<u8>>(STDOUT_CHANNEL_CAPACITY);
        let (exit, _) = broadcast::channel::<()>(EXIT_CHANNEL_CAPACITY);
        let history = Arc::new(TerminalHistory::default());
        let cancelled = Arc::new(AtomicBool::new(false));

        {
            let cancelled = cancelled.clone();
            let exit = exit.clone();
            tokio::task::spawn_blocking(move || loop {
                if cancelled.load(Ordering::SeqCst) {
                    let _ = child.kill();
                    let _ = exit.send(());
                    break;
                }
                match child.try_wait() {
                    Ok(None) => std::thread::sleep(Duration::from_millis(250)),
                    Ok(Some(_)) | Err(_) => {
                        cancelled.store(true, Ordering::SeqCst);
                        let _ = exit.send(());
                        break;
                    }
                }
            });
        }

        {
            let cancelled = cancelled.clone();
            let exit = exit.clone();
            tokio::task::spawn_blocking(move || {
                while !cancelled.load(Ordering::SeqCst) {
                    match stdin_rx.blocking_recv() {
                        Some(TerminalInput::Stdin(bytes)) => {
                            if writer.write_all(&bytes).is_err() {
                                cancelled.store(true, Ordering::SeqCst);
                                let _ = exit.send(());
                                break;
                            }
                        }
                        Some(TerminalInput::Resize(size)) => {
                            if terminal
                                .master
                                .resize(PtySize {
                                    rows: size.rows,
                                    cols: size.cols,
                                    pixel_width: 0,
                                    pixel_height: 0,
                                })
                                .is_err()
                            {
                                cancelled.store(true, Ordering::SeqCst);
                                let _ = exit.send(());
                                break;
                            }
                        }
                        Some(TerminalInput::Begin) => {}
                        None => {
                            cancelled.store(true, Ordering::SeqCst);
                            let _ = exit.send(());
                            break;
                        }
                    }
                }
            });
        }

        {
            let cancelled = cancelled.clone();
            let history = history.clone();
            let stdout = stdout.clone();
            let exit = exit.clone();
            tokio::task::spawn_blocking(move || {
                let mut buffer = [0_u8; 8192];
                while !cancelled.load(Ordering::SeqCst) {
                    match reader.read(&mut buffer) {
                        Ok(0) => {
                            cancelled.store(true, Ordering::SeqCst);
                            let _ = exit.send(());
                            break;
                        }
                        Ok(read) => {
                            let bytes = buffer[..read].to_vec();
                            history.push(&bytes);
                            let _ = stdout.send(bytes);
                        }
                        Err(_) => {
                            cancelled.store(true, Ordering::SeqCst);
                            let _ = exit.send(());
                            break;
                        }
                    }
                }
            });
        }

        Ok(Self {
            id: Uuid::new_v4().to_string(),
            title,
            cwd,
            command,
            created_at: Utc::now().to_rfc3339(),
            cancelled,
            stdin,
            stdout,
            exit,
            history,
        })
    }

    pub fn info(&self) -> TerminalSessionInfo {
        TerminalSessionInfo {
            id: self.id.clone(),
            title: self.title.clone(),
            cwd: self.cwd.to_string_lossy().to_string(),
            command: self.command.clone(),
            created_at: self.created_at.clone(),
            history_size_bytes: self.history.len() as u64,
            status: if self.cancelled() {
                TerminalSessionStatus::Exited
            } else {
                TerminalSessionStatus::Running
            },
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Vec<u8>> {
        self.stdout.subscribe()
    }

    pub fn subscribe_exit(&self) -> broadcast::Receiver<()> {
        self.exit.subscribe()
    }

    pub fn history_parts(&self) -> (Vec<u8>, Vec<u8>) {
        self.history.bytes_parts()
    }

    pub async fn send(&self, input: TerminalInput) -> anyhow::Result<()> {
        self.stdin
            .send(input)
            .await
            .map_err(|_| anyhow!("terminal stdin is closed"))
    }

    pub fn kill(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        let _ = self.exit.send(());
    }

    pub fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub command: String,
    pub created_at: String,
    pub history_size_bytes: u64,
    pub status: TerminalSessionStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TerminalSessionStatus {
    Running,
    Exited,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateTerminalSession {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionListResponse {
    pub terminals: Vec<TerminalSessionInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionResponse {
    pub terminal: TerminalSessionInfo,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalInput {
    Begin,
    Stdin(Vec<u8>),
    Resize(TerminalResize),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResize {
    pub rows: u16,
    pub cols: u16,
}

impl TerminalResize {
    fn valid(self) -> bool {
        self.rows > 0 && self.cols > 0
    }
}

pub fn decode_browser_terminal_message(bytes: &[u8]) -> anyhow::Result<TerminalInput> {
    let Some((&variant, payload)) = bytes.split_last() else {
        return Err(anyhow!("terminal frame is empty"));
    };
    match variant {
        0x00 => {
            if payload.is_empty() {
                Ok(TerminalInput::Begin)
            } else {
                Err(anyhow!("begin terminal frame must not include a payload"))
            }
        }
        0x01 => Ok(TerminalInput::Stdin(payload.to_vec())),
        0xff => {
            let resize: TerminalResize =
                serde_json::from_slice(payload).context("invalid terminal resize payload")?;
            if !resize.valid() {
                return Err(anyhow!("terminal resize dimensions must be non-zero"));
            }
            Ok(TerminalInput::Resize(resize))
        }
        other => Err(anyhow!("unknown terminal frame variant byte: {other}")),
    }
}

#[derive(Default)]
struct TerminalHistory {
    bytes: StdRwLock<VecDeque<u8>>,
}

impl TerminalHistory {
    fn push(&self, bytes: &[u8]) {
        let mut history = self.bytes.write().expect("terminal history lock poisoned");
        for byte in bytes {
            if history.len() == HISTORY_MAX_BYTES {
                history.pop_front();
            }
            history.push_back(*byte);
        }
    }

    fn bytes_parts(&self) -> (Vec<u8>, Vec<u8>) {
        let history = self.bytes.read().expect("terminal history lock poisoned");
        let (left, right) = history.as_slices();
        (left.to_vec(), right.to_vec())
    }

    fn len(&self) -> usize {
        self.bytes
            .read()
            .expect("terminal history lock poisoned")
            .len()
    }
}

fn command_builder(command: &str) -> anyhow::Result<CommandBuilder> {
    let mut parts = shlex::split(command)
        .filter(|parts| !parts.is_empty())
        .ok_or_else(|| anyhow!("terminal command cannot be empty"))?
        .into_iter();
    let binary = parts
        .next()
        .ok_or_else(|| anyhow!("terminal command cannot be empty"))?;
    let mut builder = CommandBuilder::new(binary);
    for arg in parts {
        builder.arg(arg);
    }
    Ok(builder)
}

fn terminal_title(command: &str, cwd: &Path) -> String {
    cwd.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(|name| format!("{name}: {command}"))
        .unwrap_or_else(|| command.to_string())
}

fn default_terminal_command() -> String {
    if cfg!(windows) {
        env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    } else {
        env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
}

fn resolve_terminal_cwd(cwd: Option<&str>, default_cwd: &Path) -> anyhow::Result<PathBuf> {
    let candidate = match cwd.map(str::trim).filter(|cwd| !cwd.is_empty()) {
        Some(cwd) => {
            let path = PathBuf::from(cwd);
            if path.is_absolute() {
                path
            } else {
                default_cwd.join(path)
            }
        }
        None => default_cwd.to_path_buf(),
    };
    let cwd = std::fs::canonicalize(&candidate)
        .with_context(|| format!("terminal cwd does not exist: {}", candidate.display()))?;
    if !cwd.is_dir() {
        return Err(anyhow!("terminal cwd must be a directory"));
    }
    Ok(cwd)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_stdin_frame() {
        assert_eq!(
            decode_browser_terminal_message(&[b'l', b's', b'\n', 0x01]).unwrap(),
            TerminalInput::Stdin(b"ls\n".to_vec())
        );
    }

    #[test]
    fn decodes_resize_frame() {
        let mut frame = serde_json::to_vec(&TerminalResize {
            rows: 40,
            cols: 120,
        })
        .unwrap();
        frame.push(0xff);
        assert_eq!(
            decode_browser_terminal_message(&frame).unwrap(),
            TerminalInput::Resize(TerminalResize {
                rows: 40,
                cols: 120
            })
        );
    }

    #[test]
    fn rejects_invalid_frames() {
        assert!(decode_browser_terminal_message(&[]).is_err());
        assert!(decode_browser_terminal_message(&[1, 2, 3, 0x00]).is_err());
        assert!(decode_browser_terminal_message(&[0x42]).is_err());

        let mut frame = serde_json::to_vec(&TerminalResize { rows: 0, cols: 120 }).unwrap();
        frame.push(0xff);
        assert!(decode_browser_terminal_message(&frame).is_err());
    }

    #[test]
    fn resolves_relative_cwd_against_default() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("project")).unwrap();
        let cwd = resolve_terminal_cwd(Some("project"), temp.path()).unwrap();
        assert_eq!(cwd, temp.path().join("project").canonicalize().unwrap());
    }

    #[tokio::test]
    async fn session_exit_notifies_subscribers() {
        let temp = tempfile::tempdir().unwrap();
        let session = TerminalSession::spawn(
            "test shell".to_string(),
            temp.path().to_path_buf(),
            "/bin/sh".to_string(),
        )
        .unwrap();
        let mut exit = session.subscribe_exit();

        session.kill();

        tokio::time::timeout(Duration::from_secs(2), exit.recv())
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn manager_rejects_sessions_over_limit() {
        let temp = tempfile::tempdir().unwrap();
        let manager = TerminalManager::new(temp.path().to_path_buf());
        let mut terminal_ids = Vec::new();
        for _ in 0..MAX_TERMINAL_SESSIONS {
            let terminal = manager
                .create_session(CreateTerminalSession {
                    command: Some("/bin/sh".to_string()),
                    cwd: None,
                    title: None,
                })
                .await
                .unwrap();
            terminal_ids.push(terminal.id);
        }

        let error = manager
            .create_session(CreateTerminalSession {
                command: Some("/bin/sh".to_string()),
                cwd: None,
                title: None,
            })
            .await
            .unwrap_err();
        assert!(error.to_string().contains("terminal session limit reached"));

        for terminal_id in terminal_ids {
            assert!(manager.delete_session(&terminal_id).await);
        }
    }

    #[tokio::test]
    async fn manager_enforces_session_limit_under_concurrent_creates() {
        let temp = tempfile::tempdir().unwrap();
        let manager = TerminalManager::new(temp.path().to_path_buf());
        let mut handles = Vec::new();

        for _ in 0..(MAX_TERMINAL_SESSIONS + 4) {
            let manager = manager.clone();
            handles.push(tokio::spawn(async move {
                manager
                    .create_session(CreateTerminalSession {
                        command: Some("/bin/sh".to_string()),
                        cwd: None,
                        title: None,
                    })
                    .await
                    .map(|info| info.id)
            }));
        }

        let mut terminal_ids = Vec::new();
        let mut errors = Vec::new();
        for handle in handles {
            match handle.await.unwrap() {
                Ok(terminal_id) => terminal_ids.push(terminal_id),
                Err(error) => errors.push(error.to_string()),
            }
        }

        assert_eq!(terminal_ids.len(), MAX_TERMINAL_SESSIONS);
        assert_eq!(manager.list_sessions().await.len(), MAX_TERMINAL_SESSIONS);
        assert!(errors
            .iter()
            .all(|error| error.contains("terminal session limit reached")));

        for terminal_id in terminal_ids {
            assert!(manager.delete_session(&terminal_id).await);
        }
    }
}
