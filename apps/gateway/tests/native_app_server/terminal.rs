//! Retained gateway PTYs are independent of the native chat process. This proof
//! replaces the native process explicitly; it does not claim automatic restart.
use std::sync::Arc;

use anyhow::Context;
use kodex_gateway::{
    app_server::{AppServer, JsonRpcAppServer},
    terminal::{TerminalInput, TerminalResize, TerminalSession},
};
use serde_json::json;
use tokio::{
    sync::mpsc,
    time::{timeout, Duration},
};

use super::fixture::{api, Fixture, NativeSession};

struct ShellCleanup(Arc<TerminalSession>);
impl Drop for ShellCleanup {
    fn drop(&mut self) {
        self.0.kill();
    }
}

async fn output(shell: &TerminalSession, expected: &str) -> anyhow::Result<()> {
    timeout(Duration::from_secs(5), async {
        loop {
            let (left, right) = shell.history_parts();
            let text = String::from_utf8_lossy(&[left, right].concat()).to_string();
            if text.contains(expected) {
                return Ok::<_, anyhow::Error>(());
            }
            anyhow::ensure!(
                !shell.cancelled(),
                "PTY exited before expected output: {text}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .with_context(|| {
        let (left, right) = shell.history_parts();
        format!(
            "PTY did not produce {expected:?}: {:?}",
            String::from_utf8_lossy(&[left, right].concat())
        )
    })??;
    Ok(())
}

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_gateway_pty_survives_native_stop_replacement_and_detachment() -> anyhow::Result<()> {
    let fixture = Fixture::new().await?;
    let session = NativeSession::start(&fixture).await?;
    let created = api(
        &session.app,
        "POST",
        "/v1/terminals",
        Some(json!({
            "command":"/bin/sh", "cwd":fixture.workspace, "title":"Native-independent PTY",
        })),
    )
    .await;
    let created = match created {
        Ok(created) => created,
        Err(error) => {
            session.shutdown().await?;
            return Err(error);
        }
    };
    let id = created["terminal"]["id"]
        .as_str()
        .context("terminal ID")?
        .to_owned();
    let shell = session
        .state
        .terminals
        .get_session(&id)
        .await
        .context("created PTY")?;
    let _cleanup = ShellCleanup(shell.clone());
    let mut replacement = None;
    let mut relay = None;
    let result = timeout(Duration::from_secs(30), async {
        let attachment = shell.attach();
        shell.send(TerminalInput::Stdin(b"stty -echo; printf '\\n%s%s\\n' READY BEFORE; printf '\\nHOME=%s\\n' \"$CODEX_HOME\"\n".to_vec())).await?;
        output(&shell, "\r\nREADYBEFORE\r\n").await?;
        output(&shell, &format!("HOME={}\r\n", fixture.config.codex.home.display())).await?;
        session.shutdown().await?;
        anyhow::ensure!(!session.state.app_server.is_ready());
        shell.send(TerminalInput::Stdin(b"printf '\\n%s%s\\n' NATIVE STOPPED\n".to_vec())).await?;
        output(&shell, "\r\nNATIVESTOPPED\r\n").await?;
        let listed = api(&session.app, "GET", "/v1/terminals", None).await?;
        anyhow::ensure!(listed["terminals"].as_array().is_some_and(|rows| rows.len() == 1 && rows[0]["id"] == id && rows[0]["status"] == "running"));

        let (tx, mut rx) = mpsc::channel(1024);
        replacement = Some(JsonRpcAppServer::start(&fixture.config.codex, tx).await?);
        relay = Some(tokio::spawn(async move { while rx.recv().await.is_some() {} }));
        drop(attachment);
        // Detached output still enters the bounded gateway reconnect buffer.
        shell.send(TerminalInput::Stdin(b"printf '\\n%s%s\\n' BUFFER DETACHED\n".to_vec())).await?;
        output(&shell, "\r\nBUFFERDETACHED\r\n").await?;
        let _reattached = shell.attach();
        shell.send(TerminalInput::Resize(TerminalResize { rows:31, cols:99 })).await?;
        shell.send(TerminalInput::Stdin(b"stty size\n".to_vec())).await?;
        output(&shell, "31 99\r\n").await?;
        anyhow::ensure!(replacement.as_ref().unwrap().is_ready());
        let deleted = api(&session.app, "DELETE", &format!("/v1/terminals/{id}"), None).await?;
        anyhow::ensure!(deleted["id"] == id && shell.cancelled());
        anyhow::ensure!(api(&session.app, "GET", "/v1/terminals", None).await?["terminals"] == json!([]));
        Ok::<_, anyhow::Error>(())
    }).await;
    shell.kill();
    if let Some(native) = replacement {
        native.shutdown().await?;
    }
    if let Some(relay) = relay {
        relay.abort();
        let _ = relay.await;
    }
    session.shutdown().await?;
    result.context("native-independent PTY proof exceeded observation bound")??;
    Ok(())
}
