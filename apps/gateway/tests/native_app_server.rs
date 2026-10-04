//! Real protocol integration, with a local Responses fixture rather than an account.
//! Run explicitly with KODEX_TEST_CODEX_BINARY set to the pinned executable.
use axum::{body::Body, http::Request, routing::post, Router};
use http_body_util::BodyExt;
use kodex_gateway::{
    app_server::{InboundMessage, JsonRpcAppServer},
    build_router,
    config::Config,
    events::run_inbound_ingest,
    native_runtime::prepare_instance,
    store::Store,
    AppState,
};
use serde_json::{json, Value};
use tokio::{
    sync::mpsc,
    time::{timeout, Duration},
};
use tower::ServiceExt;

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_native_project_thread_turn_and_reopen_use_fresh_state() -> anyhow::Result<()> {
    let binary = std::env::var("KODEX_TEST_CODEX_BINARY")?;
    let dir = tempfile::tempdir()?;
    let workspace = dir.path().join("workspace");
    std::fs::create_dir(&workspace)?;
    let mut config = Config::default();
    config.instance.data_dir = dir.path().join("instance");
    config.database.path = config.instance.data_dir.join("gateway.db");
    config.codex.home = config.instance.data_dir.join("codex-home");
    config.codex.binary = binary;
    let _guard = prepare_instance(&mut config)?;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    // Deliberate new-home configuration, no imported credentials/provider overrides.
    std::fs::write(
        config.codex.home.join("config.toml"),
        format!(
            r#"
model = "mock-model"
model_provider = "local_fixture"
approval_policy = "never"
sandbox_mode = "read-only"
[model_providers.local_fixture]
name = "Local integration fixture"
base_url = "http://{address}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
"#
        ),
    )?;
    let provider = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route(
                "/v1/responses",
                post(|| async { ([("content-type", "text/event-stream")], response_events()) }),
            ),
        )
        .await
        .unwrap();
    });
    let (tx, mut native_rx) = mpsc::channel(1024);
    let server = JsonRpcAppServer::start(&config.codex, tx).await?;
    let (gateway_tx, rx) = mpsc::channel(1024);
    let (completed_tx, completed_rx) = tokio::sync::oneshot::channel();
    let relay = tokio::spawn(async move {
        let mut completed_tx = Some(completed_tx);
        while let Some(message) = native_rx.recv().await {
            if let InboundMessage::Notification { method, params } = &message {
                if method == "turn/completed" {
                    if let Some(tx) = completed_tx.take() {
                        let _ = tx.send(params.clone());
                    }
                }
            }
            if gateway_tx.send(message).await.is_err() {
                break;
            }
        }
    });
    let store = Store::connect(&config.database.path).await?;
    let state = AppState::new(config.clone(), store, server.clone());
    let ingest = tokio::spawn(run_inbound_ingest(rx, state.clone()));
    let result = timeout(
        Duration::from_secs(30),
        exercise(build_router(state), &workspace, completed_rx),
    )
    .await;
    server.shutdown().await?;
    ingest.abort();
    relay.abort();
    provider.abort();
    result??;
    anyhow::ensure!(config.codex.home.join("sqlite").is_dir());
    anyhow::ensure!(!config.codex.home.join("auth.json").exists());
    Ok(())
}

async fn exercise(
    app: Router,
    workspace: &std::path::Path,
    completed: tokio::sync::oneshot::Receiver<Value>,
) -> anyhow::Result<()> {
    let project = api(
        &app,
        "POST",
        "/v1/projects",
        Some(json!({
            "cwd": workspace, "name":"Native integration",
            "idempotencyKey":"real-native-project-fixture",
        })),
    )
    .await?;
    let id = project["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("missing native project ID"))?;
    let listed = api(&app, "GET", "/v1/projects", None).await?;
    anyhow::ensure!(listed["projects"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["id"] == id));
    let thread = api(&app, "POST", "/v1/threads", Some(json!({"projectId":id}))).await?;
    let thread_id = thread["thread"]["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("missing thread ID: {thread}"))?;
    // A newly opened empty chat must also have a usable canonical view.
    api(&app, "GET", &format!("/v1/threads/{thread_id}"), None).await?;
    api(
        &app,
        "POST",
        &format!("/v1/threads/{thread_id}/turns"),
        Some(json!({
            "input":[{"type":"text", "text":"Hello local fixture", "textElements":[]}]
        })),
    )
    .await?;
    let completed = timeout(Duration::from_secs(20), completed).await??;
    anyhow::ensure!(
        completed["turn"]["status"] == "completed",
        "native turn did not complete: {completed}"
    );
    // Canonical gateway snapshots must converge to real native persisted history.
    timeout(Duration::from_secs(20), async {
        loop {
            let reopened = api(&app, "GET", &format!("/v1/threads/{thread_id}"), None).await?;
            if reopened.to_string().contains("fixture completed") {
                break Ok::<_, anyhow::Error>(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await??;
    Ok(())
}

async fn api(app: &Router, method: &str, path: &str, body: Option<Value>) -> anyhow::Result<Value> {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .body(Body::from(
                    body.map(|value| value.to_string()).unwrap_or_default(),
                ))?,
        )
        .await?;
    let status = response.status();
    let payload = response.into_body().collect().await?.to_bytes();
    anyhow::ensure!(
        status.is_success(),
        "{method} {path}: {status}: {}",
        String::from_utf8_lossy(&payload)
    );
    Ok(serde_json::from_slice(&payload)?)
}

fn response_events() -> String {
    [
        json!({"type":"response.created","response":{"id":"fixture-response"}}),
        json!({"type":"response.output_item.done","item":{
            "type":"message","role":"assistant","id":"fixture-message",
            "content":[{"type":"output_text","text":"fixture completed"}]
        }}),
        json!({"type":"response.completed","response":{"id":"fixture-response","usage":{
            "input_tokens":1,"output_tokens":1,"total_tokens":2,
            "input_tokens_details":null,"output_tokens_details":null
        }}}),
    ]
    .into_iter()
    .map(|event| {
        format!(
            "event: {}\ndata: {event}\n\n",
            event["type"].as_str().unwrap()
        )
    })
    .collect()
}
