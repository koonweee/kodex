use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use anyhow::Context;
use axum::{
    body::Body,
    extract::State,
    http::{Request, Response},
    routing::post,
    Json, Router,
};
use http_body_util::BodyExt;
use kodex_gateway::{
    app_server::{InboundMessage, JsonRpcAppServer},
    build_router,
    config::Config,
    events::run_inbound_ingest,
    native_runtime::{prepare_instance, PreparedInstance},
    store::Store,
    AppState,
};
use serde_json::{json, Value};
use tokio::{
    sync::mpsc,
    task::JoinHandle,
    time::{timeout, Duration},
};
use tower::ServiceExt;

pub(super) enum ModelResponse {
    Items(Vec<Value>),
    Hold,
}

impl ModelResponse {
    pub(super) fn message(text: &str) -> Self {
        Self::Items(vec![json!({
            "type":"message", "role":"assistant", "id":"fixture-message",
            "content":[{"type":"output_text", "text":text}],
        })])
    }

    pub(super) fn command(call_id: &str, arguments: Value) -> Self {
        Self::Items(vec![json!({
            "type":"function_call", "call_id":call_id, "name":"exec_command",
            "arguments":arguments.to_string(),
        })])
    }
}

#[derive(Clone)]
struct ProviderState {
    responses: Arc<Mutex<VecDeque<ModelResponse>>>,
    requests: mpsc::UnboundedSender<Value>,
}

pub(super) struct Fixture {
    provider: JoinHandle<()>,
    responses: Arc<Mutex<VecDeque<ModelResponse>>>,
    requests: mpsc::UnboundedReceiver<Value>,
    pub(super) config: Config,
    pub(super) workspace: PathBuf,
    _instance: PreparedInstance,
    _dir: tempfile::TempDir,
}

impl Fixture {
    pub(super) async fn new() -> anyhow::Result<Self> {
        let dir = tempfile::tempdir()?;
        let workspace = dir.path().join("workspace");
        std::fs::create_dir(&workspace)?;
        let mut config = Config::default();
        config.instance.data_dir = dir.path().join("instance");
        config.database.path = config.instance.data_dir.join("gateway.db");
        config.codex.home = config.instance.data_dir.join("codex-home");
        config.codex.binary = std::env::var("KODEX_TEST_CODEX_BINARY")?;
        config.uploads.dir = config.instance.data_dir.join("uploads");
        let instance = prepare_instance(&mut config)?;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        std::fs::write(
            config.codex.home.join("config.toml"),
            format!(
                r#"
model = "mock-model"
model_provider = "local_fixture"
approval_policy = "on-request"
approvals_reviewer = "user"
sandbox_mode = "read-only"
cli_auth_credentials_store = "file"
[features]
enable_request_compression = false
plugins = false
[model_providers.local_fixture]
name = "Local integration fixture"
base_url = "http://{address}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
"#
            ),
        )?;
        let (request_tx, requests) = mpsc::unbounded_channel();
        let responses = Arc::new(Mutex::new(VecDeque::new()));
        let state = ProviderState {
            responses: responses.clone(),
            requests: request_tx,
        };
        let provider = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new()
                    .route("/v1/responses", post(model_response))
                    .with_state(state),
            )
            .await
            .unwrap();
        });
        Ok(Self {
            provider,
            responses,
            requests,
            config,
            workspace,
            _instance: instance,
            _dir: dir,
        })
    }

    pub(super) fn enqueue(&self, responses: impl IntoIterator<Item = ModelResponse>) {
        self.responses.lock().unwrap().extend(responses);
    }

    pub(super) async fn next_model_request(&mut self) -> anyhow::Result<Value> {
        timeout(Duration::from_secs(15), self.requests.recv())
            .await
            .context("model fixture was not called")?
            .context("model fixture stopped")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.provider.abort();
    }
}

pub(super) struct NativeSession {
    pub(super) app: Router,
    server: Arc<JsonRpcAppServer>,
    relay: JoinHandle<()>,
    ingest: JoinHandle<()>,
    notifications: mpsc::UnboundedReceiver<(String, Value)>,
}

impl NativeSession {
    pub(super) async fn start(fixture: &Fixture) -> anyhow::Result<Self> {
        let store = Store::connect(&fixture.config.database.path).await?;
        let (tx, mut native_rx) = mpsc::channel(1024);
        let server = JsonRpcAppServer::start(&fixture.config.codex, tx).await?;
        let (gateway_tx, rx) = mpsc::channel(1024);
        let (notification_tx, notifications) = mpsc::unbounded_channel();
        let relay = tokio::spawn(async move {
            while let Some(message) = native_rx.recv().await {
                if let InboundMessage::Notification { method, params } = &message {
                    let _ = notification_tx.send((method.clone(), params.clone()));
                }
                if gateway_tx.send(message).await.is_err() {
                    break;
                }
            }
        });
        let state = AppState::new(fixture.config.clone(), store, server.clone());
        let app = build_router(state.clone());
        let ingest = tokio::spawn(run_inbound_ingest(rx, state));
        Ok(Self {
            app,
            server,
            relay,
            ingest,
            notifications,
        })
    }

    pub(super) async fn completed_turn(
        &mut self,
        thread_id: &str,
        status: &str,
    ) -> anyhow::Result<Value> {
        timeout(Duration::from_secs(20), async {
            while let Some((method, params)) = self.notifications.recv().await {
                if method == "turn/completed" && params["threadId"] == thread_id {
                    anyhow::ensure!(
                        params["turn"]["status"] == status,
                        "expected {status} native turn: {params}"
                    );
                    return Ok(params["turn"].clone());
                }
            }
            anyhow::bail!("native notifications stopped before turn completion")
        })
        .await
        .context("native turn did not finish")?
    }

    pub(super) async fn shutdown(&self) -> anyhow::Result<()> {
        self.server.shutdown().await?;
        self.ingest.abort();
        self.relay.abort();
        Ok(())
    }
}

impl Drop for NativeSession {
    fn drop(&mut self) {
        self.ingest.abort();
        self.relay.abort();
    }
}

async fn model_response(
    State(state): State<ProviderState>,
    Json(request): Json<Value>,
) -> Response<Body> {
    let _ = state.requests.send(request);
    let response = state.responses.lock().unwrap().pop_front();
    let created = event(json!({"type":"response.created", "response":{"id":"fixture-response"}}));
    let body = match response {
        Some(ModelResponse::Items(items)) => {
            let mut events = created;
            for item in items {
                events.push_str(&event(
                    json!({"type":"response.output_item.done", "item":item}),
                ));
            }
            events.push_str(&event(json!({"type":"response.completed", "response":{
                "id":"fixture-response", "usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2,
                    "input_tokens_details":null,"output_tokens_details":null}
            }})));
            Body::from(events)
        }
        Some(ModelResponse::Hold) => Body::from_stream(async_stream::stream! {
            yield Ok::<_, std::io::Error>(created);
            std::future::pending::<()>().await;
        }),
        None => {
            return Response::builder()
                .status(500)
                .body(Body::from("unexpected model request"))
                .unwrap()
        }
    };
    Response::builder()
        .header("content-type", "text/event-stream")
        .body(body)
        .unwrap()
}

fn event(value: Value) -> String {
    format!(
        "event: {}\ndata: {value}\n\n",
        value["type"].as_str().unwrap()
    )
}

pub(super) async fn api(
    app: &Router,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> anyhow::Result<Value> {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .body(Body::from(
            body.map(|value| value.to_string()).unwrap_or_default(),
        ))?;
    request_json(app, request)
        .await
        .with_context(|| format!("{method} {path}"))
}

pub(super) async fn request_json(app: &Router, request: Request<Body>) -> anyhow::Result<Value> {
    let response = app.clone().oneshot(request).await?;
    let status = response.status();
    let payload = response.into_body().collect().await?.to_bytes();
    anyhow::ensure!(
        status.is_success(),
        "{status}: {}",
        String::from_utf8_lossy(&payload)
    );
    Ok(serde_json::from_slice(&payload)?)
}

pub(super) async fn upload(
    app: &Router,
    path: &str,
    field: &str,
    file_name: &str,
    mime: &str,
    bytes: &[u8],
) -> anyhow::Result<Value> {
    let mut body = format!(
        "--fixture\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{file_name}\"\r\nContent-Type: {mime}\r\n\r\n"
    ).into_bytes();
    body.extend_from_slice(bytes);
    body.extend_from_slice(b"\r\n--fixture--\r\n");
    request_json(
        app,
        Request::post(path)
            .header("content-type", "multipart/form-data; boundary=fixture")
            .body(Body::from(body))?,
    )
    .await
}
