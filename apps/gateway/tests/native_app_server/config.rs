//! Native config CAS, literal key paths, masked secrets and cold-read persistence.
use std::io::Write;

use anyhow::Context;
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::time::{timeout, Duration};
use tower::ServiceExt;

use super::fixture::{api, Fixture, NativeSession};

const SERVER: &str = "proof.with.dot";
const SECRET: &str = "disposable-native-config-proof-secret";

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_native_config_sparse_edits_preserve_policy_secrets_and_reject_stale_versions(
) -> anyhow::Result<()> {
    let fixture = Fixture::new().await?;
    let path = fixture.config.codex.home.join("config.toml");
    std::fs::OpenOptions::new()
        .append(true)
        .open(&path)?
        .write_all(
            format!(
                r#"
[mcp_servers."{SERVER}"]
url = "http://127.0.0.1:1/initial"
enabled = false
disabled_tools = ["protected-tool"]
oauth_resource = "proof-audience"
[mcp_servers."{SERVER}".http_headers]
Authorization = "{SECRET}"
"X.Proof.Key" = "initial-header"
"#
            )
            .as_bytes(),
        )?;
    let session = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(30), exercise(&session)).await;
    session.shutdown().await?;
    result??;

    // Only the native config file persists these values; no gateway overlay is needed.
    let reopened = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(15), async {
        let configured = api(&reopened.app, "GET", "/v1/mcp/configured-servers", None).await?;
        verify_masked(&configured)?;
        let native = reopened.native_config_read().await?;
        verify_retained_fields(&native)?;
        anyhow::ensure!(
            native["config"]["mcp_servers"][SERVER]["url"] == "http://127.0.0.1:1/edited"
        );
        anyhow::ensure!(
            native["config"]["mcp_servers"][SERVER]["http_headers"]["X.Proof.Key"].is_null()
        );
        anyhow::ensure!(native["config"]["model_reasoning_effort"] == "high");
        Ok::<_, anyhow::Error>(())
    })
    .await;
    reopened.shutdown().await?;
    result??;
    anyhow::ensure!(!fixture.config.codex.home.join("auth.json").exists());
    Ok(())
}

async fn exercise(session: &NativeSession) -> anyhow::Result<()> {
    let configured = api(&session.app, "GET", "/v1/mcp/configured-servers", None).await?;
    verify_masked(&configured)?;
    let original_target = target(&configured)?;
    let changed = patch(
        session,
        original_target.clone(),
        json!([
            {"keyPath":["url"], "value":"http://127.0.0.1:1/edited"},
        ]),
    )
    .await?;
    anyhow::ensure!(changed["saved"] == true);
    anyhow::ensure!(changed["reload"]["queued"] == true);
    anyhow::ensure!(changed["write"]["version"] != original_target["version"]);
    verify_retained_fields(&session.native_config_read().await?)?;

    stale_write(session, &format!("/v1/mcp/servers/{SERVER}"), json!({
        "writeTarget":original_target, "edits":[{"keyPath":["url"],"value":"http://127.0.0.1:1/stale"}],
    })).await?;
    let native = session.native_config_read().await?;
    anyhow::ensure!(native["config"]["mcp_servers"][SERVER]["url"] == "http://127.0.0.1:1/edited");

    let configured = api(&session.app, "GET", "/v1/mcp/configured-servers", None).await?;
    patch(
        session,
        target(&configured)?,
        json!([
            {"keyPath":["http_headers","X.Proof.Key"],"value":"changed-header"},
        ]),
    )
    .await?;
    let native = session.native_config_read().await?;
    anyhow::ensure!(
        native["config"]["mcp_servers"][SERVER]["http_headers"]["X.Proof.Key"] == "changed-header"
    );
    verify_retained_fields(&native)?;
    let configured = api(&session.app, "GET", "/v1/mcp/configured-servers", None).await?;
    patch(
        session,
        target(&configured)?,
        json!([
            {"keyPath":["http_headers","X.Proof.Key"],"value":null},
        ]),
    )
    .await?;
    let native = session.native_config_read().await?;
    anyhow::ensure!(
        native["config"]["mcp_servers"][SERVER]["http_headers"]["X.Proof.Key"].is_null()
    );
    verify_retained_fields(&native)?;

    let defaults = api(&session.app, "GET", "/v1/composer-settings", None).await?;
    let defaults_target = target(&defaults)?;
    api(
        &session.app,
        "PATCH",
        "/v1/composer-settings",
        Some(json!({
            "writeTarget":defaults_target,"effort":"high",
        })),
    )
    .await?;
    stale_write(
        session,
        "/v1/composer-settings",
        json!({
            "writeTarget":defaults_target,"model":"stale-model",
        }),
    )
    .await?;
    let native = session.native_config_read().await?;
    anyhow::ensure!(native["config"]["model"] == "mock-model");
    anyhow::ensure!(native["config"]["model_reasoning_effort"] == "high");
    verify_retained_fields(&native)?;
    Ok(())
}

fn target(read: &Value) -> anyhow::Result<Value> {
    let target = read
        .get("writeTarget")
        .filter(|target| target.is_object())
        .context("native config read did not expose an editable native user layer")?;
    anyhow::ensure!(target["version"]
        .as_str()
        .is_some_and(|version| !version.is_empty()));
    Ok(target.clone())
}

fn verify_masked(configured: &Value) -> anyhow::Result<()> {
    anyhow::ensure!(
        !configured.to_string().contains(SECRET),
        "masked config projection exposed a fixture secret"
    );
    let server = configured["servers"]
        .as_array()
        .context("missing MCP inventory")?
        .iter()
        .find(|server| server["name"] == SERVER)
        .context("missing literal dotted MCP name")?;
    anyhow::ensure!(server["transport"]["httpHeaders"]["Authorization"]["masked"] == true);
    Ok(())
}

fn verify_retained_fields(native: &Value) -> anyhow::Result<()> {
    let server = &native["config"]["mcp_servers"][SERVER];
    anyhow::ensure!(
        server["disabled_tools"] == json!(["protected-tool"]),
        "unexposed native tool policy was lost"
    );
    anyhow::ensure!(server["oauth_resource"] == "proof-audience");
    anyhow::ensure!(
        server["http_headers"]["Authorization"] == SECRET,
        "untouched fixture secret was changed"
    );
    anyhow::ensure!(server["enabled"] == false);
    Ok(())
}

async fn patch(session: &NativeSession, target: Value, edits: Value) -> anyhow::Result<Value> {
    api(
        &session.app,
        "PATCH",
        &format!("/v1/mcp/servers/{SERVER}"),
        Some(json!({"writeTarget":target,"edits":edits})),
    )
    .await
}

async fn stale_write(session: &NativeSession, path: &str, body: Value) -> anyhow::Result<()> {
    let response = session
        .app
        .clone()
        .oneshot(
            Request::patch(path)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))?,
        )
        .await?;
    anyhow::ensure!(
        response.status() == 409,
        "stale native config submission was not rejected"
    );
    let payload: Value = serde_json::from_slice(&response.into_body().collect().await?.to_bytes())?;
    anyhow::ensure!(payload["code"] == "config_version_conflict");
    anyhow::ensure!(
        !payload.to_string().contains(SECRET),
        "config error exposed a fixture secret"
    );
    Ok(())
}

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_native_missing_config_uses_native_empty_layer_version() -> anyhow::Result<()> {
    let fixture = Fixture::new().await?;
    let path = fixture.config.codex.home.join("config.toml");
    std::fs::remove_file(&path)?;
    let session = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(15), async {
        anyhow::ensure!(
            !path.exists(),
            "native startup created config before the missing-layer proof"
        );
        let defaults = api(&session.app, "GET", "/v1/composer-settings", None).await?;
        let target = target(&defaults)?;
        anyhow::ensure!(target["filePath"] == path.to_string_lossy().as_ref());
        api(
            &session.app,
            "PATCH",
            "/v1/composer-settings",
            Some(json!({
                "writeTarget":target,"effort":"high",
            })),
        )
        .await?;
        let native = session.native_config_read().await?;
        anyhow::ensure!(native["config"]["model_reasoning_effort"] == "high");
        anyhow::ensure!(path.is_file());
        Ok::<_, anyhow::Error>(())
    })
    .await;
    session.shutdown().await?;
    result??;
    Ok(())
}

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_native_config_reports_higher_layer_override_without_faking_effective_values(
) -> anyhow::Result<()> {
    let mut fixture = Fixture::new().await?;
    fixture
        .config
        .codex
        .args
        .extend(["-c".into(), "model_reasoning_effort=\"low\"".into()]);
    let session = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(15), async {
        let defaults = api(&session.app, "GET", "/v1/composer-settings", None).await?;
        anyhow::ensure!(defaults["effort"] == "low");
        let saved = api(
            &session.app,
            "PATCH",
            "/v1/composer-settings",
            Some(json!({
                "writeTarget":target(&defaults)?, "effort":"high",
            })),
        )
        .await?;
        anyhow::ensure!(saved["saved"] == true);
        anyhow::ensure!(saved["write"]["status"] == "okOverridden");
        let metadata = &saved["write"]["overriddenMetadata"];
        anyhow::ensure!(metadata["overridingLayer"]["kind"] == "sessionFlags");
        anyhow::ensure!(metadata.get("effectiveValue").is_none());
        let reread = api(&session.app, "GET", "/v1/composer-settings", None).await?;
        anyhow::ensure!(
            reread["effort"] == "low",
            "saved default was fabricated as effective"
        );
        let native = session.native_config_read().await?;
        let user = native["layers"]
            .as_array()
            .context("native config layers missing")?
            .iter()
            .find(|layer| layer["name"]["type"] == "user")
            .context("native user layer missing")?;
        anyhow::ensure!(
            user["config"]["model_reasoning_effort"] == "high",
            "overridden native write was not durable"
        );
        Ok::<_, anyhow::Error>(())
    })
    .await;
    session.shutdown().await?;
    result??;
    Ok(())
}
