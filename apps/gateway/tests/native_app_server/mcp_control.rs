use super::fixture::{api, Fixture, ModelResponse, NativeSession};
use anyhow::Context;
use axum::{
    body::Body,
    extract::Request,
    middleware::{self, Next},
};
use kodex_gateway::app_server_api::{CodexClient, McpServerStatusDetail, McpServerToolCallRequest};
use serde_json::json;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::time::{timeout, Duration};

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_native_builtin_control_bundle_uses_its_owned_gateway_and_explicit_target(
) -> anyhow::Result<()> {
    let mut fixture = Fixture::new().await?;
    let config_file = fixture.config.codex.home.join("config.toml");
    let config = std::fs::read_to_string(&config_file)?;
    std::fs::write(
        &config_file,
        config.replace("plugins = false", "plugins = true"),
    )?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    anyhow::ensure!(address.port() != 8787);
    let mut session = NativeSession::start_with_control(&fixture, address).await?;
    let owned_reads = Arc::new(AtomicUsize::new(0));
    let marker = owned_reads.clone();
    let router = session.app.clone().layer(middleware::from_fn(
        move |request: Request<Body>, next: Next| {
            let marker = marker.clone();
            async move {
                if request.uri().path() == "/v1/self-control/status" {
                    marker.fetch_add(1, Ordering::SeqCst);
                }
                next.run(request).await
            }
        },
    ));
    let serving = tokio::spawn(async move { axum::serve(listener, router).await });
    let result=timeout(Duration::from_secs(60),async {
        let skills=api(&session.app,"GET","/v1/skills",None).await?;
        anyhow::ensure!(skills.to_string().contains("kodex-generative-ui"), "built-in skill missing: {skills}");
        let inventory=CodexClient::new(session.state.app_server.clone()).mcp_server_status_list(McpServerStatusDetail::Full).await?;
        anyhow::ensure!(inventory.servers.iter().filter(|server| server.tools.values().any(|tool|tool.name=="get_status")).count()==1, "expected exactly one built-in Control server");
        let server=inventory.servers.iter().find(|server|server.tools.values().any(|tool|tool.name=="get_status")).context("built-in native Control server absent from inventory")?;
        let project=api(&session.app,"POST","/v1/projects",Some(json!({"name":"Installed Control proof","roots":[{"path":fixture.workspace}],"idempotencyKey":"installed-control"}))).await?;
        let thread=api(&session.app,"POST","/v1/threads",Some(json!({"projectId":project["id"]}))).await?;
        let thread_id=thread["thread"]["id"].as_str().context("Kodex-owned native target")?.to_owned();
        fixture.enqueue([ModelResponse::message("Control target materialized")]);
        api(&session.app,"POST",&format!("/v1/threads/{thread_id}/input"),Some(json!({"input":[{"type":"text","text":"materialize built-in Control target"}]}))).await?;
        fixture.next_model_request().await?;
        session.completed_turn(&thread_id,"completed").await?;
        let invoking_id=thread_id.clone();
        let target=api(&session.app,"POST","/v1/threads",Some(json!({"projectId":project["id"]}))).await?;
        let thread_id=target["thread"]["id"].as_str().context("separate explicit Control target")?.to_owned();
        fixture.enqueue([ModelResponse::message("Separate target materialized")]);
        api(&session.app,"POST",&format!("/v1/threads/{thread_id}/input"),Some(json!({"input":[{"type":"text","text":"materialize separate target"}]}))).await?;
        fixture.next_model_request().await?;
        session.completed_turn(&thread_id,"completed").await?;
        let client=CodexClient::new(session.state.app_server.clone());
        let status=client.mcp_tool_call(McpServerToolCallRequest {server:server.name.clone(),thread_id:invoking_id.clone(),tool:"get_status".into(),arguments:Some(json!({})),meta:None}).await.context("built-in Control get_status")?;
        anyhow::ensure!(status.is_error!=Some(true),"built-in native Control status error: {status:?}");
        anyhow::ensure!(owned_reads.load(Ordering::SeqCst)>0,"Control request did not reach the owning gateway listener");
        // Inline creation cannot target another chat or invent a call origin.
        let rejected_target=client.mcp_tool_call(McpServerToolCallRequest {server:server.name.clone(),thread_id:invoking_id.clone(),tool:"create_app_surface".into(),arguments:Some(json!({"threadId":thread_id,"title":"Foreign inline app","html":"<h1>Reject</h1>","fallbackContent":"Reject"})),meta:None}).await;
        match rejected_target {
            Ok(result) => anyhow::ensure!(result.is_error==Some(true),"cross-chat inline creation accepted"),
            Err(kodex_gateway::error::ApiError::NativeRpc(error)) if error.code == -32602 => {},
            Err(error) => return Err(anyhow::anyhow!("unexpected cross-target failure: {error}")),
        }
        anyhow::ensure!(session.state.store.generated_apps(&thread_id).await?.is_empty());
        anyhow::ensure!(session.state.store.generated_apps(&invoking_id).await?.is_empty());
        let rejected=client.mcp_tool_call(McpServerToolCallRequest {server:server.name.clone(),thread_id:invoking_id.clone(),tool:"create_app_surface".into(),arguments:Some(json!({"title":"No implicit target","html":"<h1>Reject</h1>","fallbackContent":"Reject"})),meta:None}).await;
        match rejected {
            Ok(rejected) => anyhow::ensure!(rejected.is_error==Some(true),"installed handler accepted implicit thread target"),
            Err(kodex_gateway::error::ApiError::NativeRpc(error)) if error.code == -32602 && error.message.contains("missing field `threadId`") => {},
            Err(error) => return Err(anyhow::anyhow!("unexpected missing-target failure: {error}")),
        }
        Ok::<_,anyhow::Error>(())
    }).await;
    serving.abort();
    let _ = serving.await;
    session.shutdown().await?;
    result.context("built-in native Control proof exceeded observation bound")??;
    anyhow::ensure!(!fixture.config.codex.home.join("auth.json").exists());
    Ok(())
}

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_native_builtin_control_replaces_legacy_plugin_without_config_writes(
) -> anyhow::Result<()> {
    let fixture = Fixture::new().await?;
    let config_file = fixture.config.codex.home.join("config.toml");
    let config =
        std::fs::read_to_string(&config_file)?.replace("plugins = false", "plugins = true");
    std::fs::write(&config_file, config)?;
    let market = fixture.workspace.join("legacy-market");
    let plugin = market.join("plugins/kodex-control");
    std::fs::create_dir_all(plugin.join(".codex-plugin"))?;
    std::fs::create_dir_all(plugin.join("skills/legacy"))?;
    std::fs::create_dir_all(market.join(".agents/plugins"))?;
    std::fs::write(market.join(".agents/plugins/marketplace.json"), json!({
        "name":"kodex-local", "plugins":[{"name":"kodex-control","source":{"source":"local","path":"./plugins/kodex-control"},"policy":{"installation":"AVAILABLE","authentication":"ON_INSTALL"},"category":"Coding"}]
    }).to_string())?;
    std::fs::write(plugin.join(".codex-plugin/plugin.json"), json!({"name":"kodex-control","version":"0.1.0","skills":"./skills/","mcpServers":"./.mcp.json"}).to_string())?;
    std::fs::write(
        plugin.join(".mcp.json"),
        json!({"mcpServers":{"kodex-control":{"command":"/usr/bin/false"}}}).to_string(),
    )?;
    std::fs::write(plugin.join("skills/legacy/SKILL.md"), "---\nname: legacy-control-probe\ndescription: Legacy plugin fixture.\n---\nLegacy probe.\n")?;
    let legacy = NativeSession::start(&fixture).await?;
    let client = CodexClient::new(legacy.state.app_server.clone());
    client
        .marketplace_add(market.to_string_lossy().into_owned(), None, None)
        .await?;
    let market_path = market
        .join(".agents/plugins/marketplace.json")
        .to_string_lossy()
        .into_owned();
    client
        .plugin_install("kodex-control".into(), Some(market_path.clone()), None)
        .await?;
    let skills = api(&legacy.app, "GET", "/v1/skills", None).await?;
    anyhow::ensure!(
        skills.to_string().contains("legacy-control-probe"),
        "legacy installation not discovered: {skills}"
    );
    legacy.shutdown().await?;
    drop(legacy);
    let saved = std::fs::read_to_string(&config_file)?;
    for _ in 0..2 {
        let session =
            NativeSession::start_with_control(&fixture, "127.0.0.1:12345".parse()?).await?;
        let result = async {
            let config = session
                .state
                .app_server
                .request("config/read", json!({"includeLayers":false}))
                .await?;
            let server = &config["config"]["mcp_servers"]["kodex-control"];
            anyhow::ensure!(
                server["command"] == env!("CARGO_BIN_EXE_kodex-gateway"),
                "wrong owned command: {server}"
            );
            anyhow::ensure!(
                server.get("url").is_none_or(|v| v.is_null())
                    && server.get("env").is_none_or(|v| v.is_null()),
                "stale fields survived: {server}"
            );
            let skills = api(&session.app, "GET", "/v1/skills", None).await?;
            anyhow::ensure!(
                skills.to_string().contains("kodex-generative-ui")
                    && !skills.to_string().contains("legacy-control-probe"),
                "legacy skill remained active: {skills}"
            );
            let inventory = CodexClient::new(session.state.app_server.clone())
                .mcp_server_status_list(McpServerStatusDetail::Full)
                .await?;
            anyhow::ensure!(
                inventory
                    .servers
                    .iter()
                    .filter(|s| s.tools.values().any(|t| t.name == "get_status"))
                    .count()
                    == 1,
                "built-in Control absent or duplicated"
            );
            anyhow::ensure!(
                std::fs::read_to_string(&config_file)? == saved,
                "managed startup mutated user config"
            );
            Ok::<_, anyhow::Error>(())
        }
        .await;
        session.shutdown().await?;
        result?;
    }
    // Reject manual collisions instead of inheriting transport or policy fields.
    let conflicting = format!("{saved}\n[mcp_servers.kodex-control]\nurl = \"http://127.0.0.1:1/foreign\"\nenabled = false\n");
    std::fs::write(&config_file, &conflicting)?;
    let result = NativeSession::start_with_control(&fixture, "127.0.0.1:12345".parse()?).await;
    anyhow::ensure!(
        result.is_err(),
        "manual Control definition should be rejected"
    );
    anyhow::ensure!(std::fs::read_to_string(&config_file)? == conflicting);
    Ok(())
}
