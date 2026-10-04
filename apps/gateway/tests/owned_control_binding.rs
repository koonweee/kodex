//! The real gateway binary must advertise only its own reserved listener/binary
//! to managed native children, even when its parent has a foreign binding.
#![cfg(unix)]

use anyhow::Context;
use std::{os::unix::fs::PermissionsExt, process::Stdio};
use tokio::{
    process::Command,
    time::{timeout, Duration},
};

#[tokio::test]
async fn gateway_binds_owned_control_before_starting_native_child() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let capture = dir.path().join("child-control.txt");
    let fake = dir.path().join("fixture-codex");
    std::fs::write(
        &fake,
        r#"#!/bin/bash
if [[ ${1:-} == --version ]]; then printf 'codex-cli 0.160.0\n'; exit 0; fi
printf '%s\n%s\n%s\n' "${KODEX_GATEWAY_URL:-unset}" "${KODEX_GATEWAY_BINARY:-unset}" "${KODEX_ALLOW_REMOTE_SELF_CONTROL:-unset}" > "$KODEX_CONTROL_CAPTURE"
IFS= read -r line
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{}}'
while IFS= read -r line; do :; done
"#,
    )?;
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755))?;
    let binary = env!("CARGO_BIN_EXE_kodex-gateway");
    let mut child = Command::new(binary)
        .env("KODEX_DATA_DIR", dir.path().join("instance"))
        .env("KODEX_BIND", "127.0.0.1:0")
        .env("KODEX_CODEX_BINARY", &fake)
        .env("KODEX_GATEWAY_URL", "http://foreign.invalid:8787")
        .env("KODEX_GATEWAY_BINARY", "/foreign/desktop/gateway")
        .env("KODEX_ALLOW_REMOTE_SELF_CONTROL", "1")
        .env("KODEX_CONTROL_CAPTURE", &capture)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let result = timeout(Duration::from_secs(10), async {
        let captured = loop {
            if let Ok(value) = tokio::fs::read_to_string(&capture).await {
                if value.lines().count() == 3 {
                    break value;
                }
            }
            if let Some(status) = child.try_wait()? {
                anyhow::bail!("gateway exited before child capture: {status}");
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        let lines = captured.lines().collect::<Vec<_>>();
        let url = reqwest::Url::parse(lines[0])?;
        anyhow::ensure!(
            url.host_str() == Some("127.0.0.1"),
            "managed native child inherited foreign control binding: {}",
            lines[0]
        );
        anyhow::ensure!(
            url.port().is_some_and(|port| port != 0),
            "owned binding must use actual reserved port"
        );
        anyhow::ensure!(
            lines[1] == binary,
            "managed plugin must launch the running gateway binary"
        );
        anyhow::ensure!(
            lines[2] == "unset",
            "loopback child must not inherit remote control permission"
        );
        let client = reqwest::Client::new();
        loop {
            if let Ok(response) = client.get(url.join("v1/capabilities")?).send().await {
                if response.status().is_success() {
                    let body = response.json::<serde_json::Value>().await?;
                    anyhow::ensure!(body["gateway"]["instanceId"]
                        .as_str()
                        .is_some_and(|id| !id.is_empty()));
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await
    .context("owned gateway startup proof timed out");
    let _ = child.kill().await;
    let _ = child.wait().await;
    result??;
    Ok(())
}
