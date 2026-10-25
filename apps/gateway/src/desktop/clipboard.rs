//! Explicit writes to the gateway Mac's pasteboard; never shell execution.
use crate::error::ApiError;
use std::{process::Stdio, time::Duration};
use tokio::{io::AsyncWriteExt, process::Command};
use zeroize::Zeroizing;

pub(crate) const MAX_BYTES: usize = 65_536;
const FAILED: &str = "The Mac clipboard could not be written.";

pub(crate) async fn write(text: Zeroizing<String>) -> Result<(), ApiError> {
    write_with_command(
        Command::new("/usr/bin/pbcopy"),
        text,
        Duration::from_secs(2),
    )
    .await
}

async fn write_with_command(
    mut command: Command,
    text: Zeroizing<String>,
    deadline: Duration,
) -> Result<(), ApiError> {
    if text.is_empty() {
        return Err(ApiError::BadRequest("The clipboard is empty.".into()));
    }
    if text.len() > MAX_BYTES {
        return Err(ApiError::BadRequest(
            "Clipboard text exceeds 64 KiB.".into(),
        ));
    }
    // No VNC credential, shell, target, user-controlled executable or inherited
    // process environment. The fixed locale preserves Unicode on macOS.
    command
        .env_clear()
        .env("LANG", "en_US.UTF-8")
        .env("LC_CTYPE", "en_US.UTF-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let result = tokio::time::timeout(deadline, async {
        let mut child = command.spawn()?;
        let mut stdin = child.stdin.take().expect("piped clipboard stdin");
        stdin.write_all(text.as_bytes()).await?;
        stdin.shutdown().await?;
        drop(stdin);
        child.wait().await
    })
    .await;
    match result {
        Ok(Ok(status)) if status.success() => Ok(()),
        _ => Err(ApiError::BadGateway(FAILED.into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn python(script: &str) -> Command {
        let mut command = Command::new("/usr/bin/python3");
        command.args(["-c", script]);
        command
    }

    #[tokio::test]
    async fn unicode_stdin_is_exact_and_environment_is_cleared() {
        let mut command = python("import os,sys; data=sys.stdin.buffer.read(); assert data == 'café — 你好 👋\\nline 2'.encode(); assert os.environ['LANG']=='en_US.UTF-8'; assert os.environ['LC_CTYPE']=='en_US.UTF-8'; assert not (set(os.environ)-{'LANG','LC_CTYPE','CPATH','LIBRARY_PATH','MANPATH','SDKROOT','__CF_USER_TEXT_ENCODING'})");
        command.env("KODEX_VNC_PASSWORD", "must-not-inherit");
        write_with_command(
            command,
            Zeroizing::new("café — 你好 👋\nline 2".into()),
            Duration::from_secs(2),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn empty_and_decoded_utf8_bounds_fail_before_spawn() {
        for (text, expected) in [
            (String::new(), "empty"),
            ("👋".repeat(MAX_BYTES / 4 + 1), "64 KiB"),
        ] {
            let error = write_with_command(
                Command::new("/no/such/executable"),
                text.into(),
                Duration::from_secs(1),
            )
            .await
            .unwrap_err();
            assert_eq!(error.status_code(), axum::http::StatusCode::BAD_REQUEST);
            assert!(error.body().message.contains(expected));
        }
        write_with_command(
            python("import sys; assert len(sys.stdin.buffer.read()) == 65536"),
            "x".repeat(MAX_BYTES).into(),
            Duration::from_secs(2),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn process_failures_are_bounded_and_do_not_echo_text_or_stderr() {
        for command in [
            Command::new("/no/such/executable"),
            python("import sys; sys.stderr.write('private clipboard'); sys.exit(2)"),
            python("import time; time.sleep(60)"),
        ] {
            let start = std::time::Instant::now();
            let error = write_with_command(
                command,
                Zeroizing::new("private clipboard".into()),
                Duration::from_millis(150),
            )
            .await
            .unwrap_err();
            assert_eq!(error.body().message, FAILED);
            assert!(start.elapsed() < Duration::from_secs(2));
        }
    }

    #[tokio::test]
    async fn timeout_and_task_drop_kill_the_child() {
        for cancel in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let pid_path = directory.path().join("pid");
            let mut command = python(
                "import os,sys,time; open(sys.argv[1],'w').write(str(os.getpid())); time.sleep(60)",
            );
            command.arg(&pid_path);
            let task = tokio::spawn(write_with_command(
                command,
                Zeroizing::new("test".into()),
                Duration::from_millis(500),
            ));
            tokio::time::timeout(Duration::from_secs(2), async {
                while std::fs::read_to_string(&pid_path).map_or(true, |pid| pid.is_empty()) {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            let pid = std::fs::read_to_string(&pid_path).unwrap();
            if cancel {
                task.abort();
            }
            let _ = task.await;
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    let status = Command::new("/bin/kill")
                        .args(["-0", &pid])
                        .stderr(Stdio::null())
                        .status()
                        .await
                        .unwrap();
                    if !status.success() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("clipboard process is killed and reaped");
        }
    }
}
