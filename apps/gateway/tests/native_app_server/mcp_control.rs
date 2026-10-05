use super::fixture::{api, Fixture, ModelResponse, NativeSession};
use anyhow::Context;
use axum::{
    body::Body,
    extract::Request,
    middleware::{self, Next},
};
use kodex_gateway::app_server_api::{CodexClient, McpServerStatusDetail, McpServerToolCallRequest};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::time::{timeout, Duration};

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_native_installed_control_bundle_uses_its_owned_gateway_and_explicit_target(
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
        let installed=api(&session.app,"POST","/v1/kodex-control-plugin/install",None).await?;
        anyhow::ensure!(installed["status"]["plugin"]["installed"]==true,"native installation did not confirm: {installed}");
        let source_root=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let source=source_root.join("plugins/kodex-control");
        let manifest:Value=serde_json::from_slice(&std::fs::read(source.join(".codex-plugin/plugin.json"))?)?;
        let version=manifest["version"].as_str().context("source plugin version")?;
        let cache=fixture.config.codex.home.join("plugins/cache/kodex-local/kodex-control").join(version);
        anyhow::ensure!(cache.is_dir(),"native installed bundle missing at {}",cache.display());
        for file in [".mcp.json","bin/kodex-control-mcp",".codex-plugin/plugin.json"] {
            anyhow::ensure!(std::fs::read(cache.join(file))?==std::fs::read(source.join(file))?,"installed {file} differs from actual source bundle");
        }
        // Native installation/discovery must run the unmodified installed shim,
        // with no test-only MCP override or patched plugin cache.
        let inventory=CodexClient::new(session.state.app_server.clone()).mcp_server_status_list(McpServerStatusDetail::Full).await?;
        let server=inventory.servers.iter().find(|server|server.tools.values().any(|tool|tool.name=="get_status")).context("installed native Control server absent from inventory")?;
        let project=api(&session.app,"POST","/v1/projects",Some(json!({"name":"Installed Control proof","roots":[{"path":fixture.workspace}],"idempotencyKey":"installed-control"}))).await?;
        let thread=api(&session.app,"POST","/v1/threads",Some(json!({"projectId":project["id"]}))).await?;
        let thread_id=thread["thread"]["id"].as_str().context("Kodex-owned native target")?.to_owned();
        fixture.enqueue([ModelResponse::message("Control target materialized")]);
        api(&session.app,"POST",&format!("/v1/threads/{thread_id}/input"),Some(json!({"input":[{"type":"text","text":"materialize installed Control target"}]}))).await?;
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
        let status=client.mcp_tool_call(McpServerToolCallRequest {server:server.name.clone(),thread_id:invoking_id.clone(),tool:"get_status".into(),arguments:Some(json!({})),meta:None}).await.context("installed Control get_status")?;
        anyhow::ensure!(status.is_error!=Some(true),"installed native Control status error: {status:?}");
        anyhow::ensure!(owned_reads.load(Ordering::SeqCst)>0,"Control request did not reach the owning gateway listener");
        // Native MCP supplies the invoking chat A in metadata. The explicit
        // owned target B must win, and omission must not default to A.
        let opened=client.mcp_tool_call(McpServerToolCallRequest {server:server.name.clone(),thread_id:invoking_id.clone(),tool:"open_app_surface".into(),arguments:Some(json!({"threadId":thread_id,"title":"Installed native app","html":"<h1>Owned Control bundle</h1>","fallbackContent":"Owned Control bundle"})),meta:None}).await.context("installed Control explicit app target")?;
        anyhow::ensure!(opened.is_error!=Some(true),"installed bundle surface call failed: {opened:?}");
        let surface=session.state.store.latest_app_surface_session(&thread_id).await?.context("installed native call did not create artifact in owning store")?;
        anyhow::ensure!(surface.thread_id==thread_id && surface.title=="Installed native app");
        anyhow::ensure!(session.state.store.latest_app_surface_session(&invoking_id).await?.is_none());
        let rejected=client.mcp_tool_call(McpServerToolCallRequest {server:server.name.clone(),thread_id:invoking_id.clone(),tool:"open_app_surface".into(),arguments:Some(json!({"title":"No implicit target","html":"<h1>Reject</h1>","fallbackContent":"Reject"})),meta:None}).await;
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
    result.context("installed native Control proof exceeded observation bound")??;
    anyhow::ensure!(!fixture.config.codex.home.join("auth.json").exists());
    Ok(())
}
