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
    app_server::{AppServer, InboundMessage, JsonRpcAppServer},
    app_server_api::{CodexClient, SortDirection, ThreadItemsListPage},
    build_router,
    config::Config,
    events::ingest_inbound,
    native_runtime::{prepare_instance, PreparedInstance},
    store::Store,
    thread_view::ThreadViewStore,
    AppState,
};
use serde_json::{json, Value};
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinHandle,
    time::{timeout, Duration},
};
use tower::ServiceExt;

#[path = "queue_adapter.rs"]
mod queue_adapter;

pub(super) enum ModelResponse {
    Items(Vec<Value>),
    GatedItems(Vec<Value>, oneshot::Receiver<()>),
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

    pub(super) fn gated_message(text: &str) -> (Self, oneshot::Sender<()>) {
        let (release, wait) = oneshot::channel();
        let Self::Items(items) = Self::message(text) else {
            unreachable!("message constructs model response items")
        };
        (Self::GatedItems(items, wait), release)
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

    pub(super) async fn assert_no_model_request(
        &mut self,
        duration: Duration,
    ) -> anyhow::Result<()> {
        // Observe the live provider; the timeout cancels only this receiver,
        // never the native process or its queue watcher.
        match timeout(duration, self.requests.recv()).await {
            Err(_) => Ok(()),
            Ok(Some(request)) => anyhow::bail!("unexpected native model request: {request}"),
            Ok(None) => anyhow::bail!("model fixture stopped during absence observation"),
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.provider.abort();
    }
}

pub(super) struct NativeSession {
    pub(super) app: Router,
    pub(super) state: AppState,
    thread_views: ThreadViewStore,
    server: Arc<JsonRpcAppServer>,
    relay: JoinHandle<()>,
    import_worker: std::sync::Mutex<Option<kodex_gateway::app_surfaces::AppSurfaceImportWorker>>,
    notifications: mpsc::UnboundedReceiver<(String, Value)>,
    requests: mpsc::UnboundedReceiver<(String, String)>,
}

impl NativeSession {
    pub(super) async fn native_queue_rpc(
        &self,
        operation: &str,
        params: Value,
    ) -> anyhow::Result<Value> {
        queue_adapter::request(&CodexClient::new(self.server.clone()), operation, params).await
    }

    pub(super) async fn native_loaded_threads(&self) -> anyhow::Result<Value> {
        Ok(self.server.request("thread/loaded/list", json!({})).await?)
    }

    pub(super) async fn canonical_view(&self, thread_id: &str) -> anyhow::Result<Value> {
        // Read the live projection without a history request repairing it first.
        Ok(serde_json::to_value(
            self.thread_views.patch_for_thread(thread_id).await,
        )?)
    }

    pub(super) async fn native_config_read(&self) -> anyhow::Result<Value> {
        Ok(self
            .server
            .request("config/read", json!({"cwd":null,"includeLayers":true}))
            .await?)
    }

    pub(super) async fn native_revert(
        &self,
        thread_id: &str,
        before_turn_id: &str,
    ) -> anyhow::Result<Value> {
        Ok(self
            .server
            .request(
                "thread/revert",
                json!({"threadId":thread_id, "beforeTurnId":before_turn_id}),
            )
            .await?)
    }

    pub(super) async fn native_revert_without_gateway_ingestion(
        &mut self,
        thread_id: &str,
        before_turn_id: &str,
    ) -> anyhow::Result<Value> {
        // Simulate native history changing while this gateway is offline. Join
        // the cancelled relay before mutation so no revert receipt is applied.
        self.relay.abort();
        if let Err(error) = (&mut self.relay).await {
            anyhow::ensure!(
                error.is_cancelled(),
                "gateway relay failed before offline mutation: {error}"
            );
        }
        self.native_revert(thread_id, before_turn_id).await
    }

    pub(super) async fn native_items_page(
        &self,
        thread_id: &str,
        turn_id: Option<&str>,
        cursor: Option<String>,
        sort_direction: SortDirection,
        limit: u32,
    ) -> anyhow::Result<ThreadItemsListPage> {
        Ok(CodexClient::new(self.server.clone())
            .thread_items_list_page(
                thread_id.to_owned(),
                turn_id.map(str::to_owned),
                cursor,
                sort_direction,
                Some(limit),
            )
            .await?)
    }

    pub(super) async fn start(fixture: &Fixture) -> anyhow::Result<Self> {
        Self::start_inner(fixture, None).await
    }

    pub(super) async fn start_with_control(
        fixture: &Fixture,
        address: std::net::SocketAddr,
    ) -> anyhow::Result<Self> {
        Self::start_inner(fixture, Some(address)).await
    }

    async fn start_inner(
        fixture: &Fixture,
        address: Option<std::net::SocketAddr>,
    ) -> anyhow::Result<Self> {
        let store = Store::connect(&fixture.config.database.path).await?;
        let (tx, mut native_rx) = mpsc::channel(1024);
        let server = if let Some(address) = address {
            JsonRpcAppServer::start_with_control(
                &fixture.config.codex,
                tx,
                address,
                std::path::Path::new(env!("CARGO_BIN_EXE_kodex-gateway")),
            )
            .await?
        } else {
            JsonRpcAppServer::start(&fixture.config.codex, tx).await?
        };
        let (notification_tx, notifications) = mpsc::unbounded_channel();
        let (request_tx, requests) = mpsc::unbounded_channel();
        let state = AppState::new(fixture.config.clone(), store, server.clone());
        if let Err(error) = kodex_gateway::approvals::initialize(&state).await {
            server.shutdown().await.with_context(|| {
                format!("native fixture initialization failed ({error}); cleanup failed")
            })?;
            return Err(error.into());
        }
        let import_worker = match kodex_gateway::app_surfaces::start_import_worker(&state) {
            Ok(worker) => worker,
            Err(error) => {
                server.shutdown().await.with_context(|| {
                    format!("native fixture importer failed ({error}); cleanup failed")
                })?;
                return Err(error.into());
            }
        };
        let app = build_router(state.clone());
        let thread_views = state.thread_views.clone();
        let fixture_state = state.clone();
        let relay = tokio::spawn(async move {
            while let Some(message) = native_rx.recv().await {
                let notification = match &message {
                    InboundMessage::Notification { method, params } => {
                        Some((method.clone(), params.clone()))
                    }
                    _ => None,
                };
                let request = match &message {
                    InboundMessage::ServerRequest {
                        request_id, method, ..
                    } => Some((request_id.clone(), method.clone())),
                    _ => None,
                };
                // Proof observers run after gateway ingestion, so a replay assertion
                // cannot pass merely because the duplicate is still in a relay queue.
                ingest_inbound(message, &state)
                    .await
                    .expect("native fixture ingestion failed");
                if let Some(notification) = notification {
                    let _ = notification_tx.send(notification);
                }
                if let Some(request) = request {
                    let _ = request_tx.send(request);
                }
            }
        });
        Ok(Self {
            app,
            state: fixture_state,
            thread_views,
            server,
            relay,
            import_worker: std::sync::Mutex::new(Some(import_worker)),
            notifications,
            requests,
        })
    }

    pub(super) async fn next_server_request(&mut self) -> anyhow::Result<(String, String)> {
        timeout(Duration::from_secs(15), self.requests.recv())
            .await
            .context("native request was not received")?
            .context("native request stream closed")
    }

    pub(super) async fn notification(
        &mut self,
        method: &str,
        key: &str,
        expected: &str,
    ) -> anyhow::Result<Value> {
        timeout(Duration::from_secs(15), async {
            while let Some((received, params)) = self.notifications.recv().await {
                if received == method && params[key] == expected {
                    return Ok(params);
                }
            }
            anyhow::bail!("native notification stream closed")
        })
        .await
        .with_context(|| format!("missing native {method} for {key}={expected}"))?
    }

    pub(super) async fn completed_turn(
        &mut self,
        thread_id: &str,
        status: &str,
    ) -> anyhow::Result<Value> {
        self.turn_and_resolution(thread_id, status, None).await
    }

    pub(super) async fn completed_turn_and_resolution(
        &mut self,
        thread_id: &str,
        status: &str,
        request_id: &str,
    ) -> anyhow::Result<Value> {
        self.turn_and_resolution(thread_id, status, Some(request_id))
            .await
    }

    async fn turn_and_resolution(
        &mut self,
        thread_id: &str,
        status: &str,
        request_id: Option<&str>,
    ) -> anyhow::Result<Value> {
        timeout(Duration::from_secs(20), async {
            let mut turn = None;
            let mut resolved = request_id.is_none();
            while let Some((method, params)) = self.notifications.recv().await {
                if method == "turn/completed" && params["threadId"] == thread_id {
                    anyhow::ensure!(
                        params["turn"]["status"] == status,
                        "expected {status} native turn: {params}"
                    );
                    turn = Some(params["turn"].clone());
                }
                if method == "serverRequest/resolved"
                    && params["threadId"] == thread_id
                    && request_id.is_some_and(|id| params["requestId"].to_string() == id)
                {
                    resolved = true;
                }
                if resolved {
                    if let Some(turn) = turn.take() {
                        return Ok(turn);
                    }
                }
            }
            anyhow::bail!("native notifications stopped before turn completion/request resolution")
        })
        .await
        .context("native turn/request did not finish")?
    }

    pub(super) async fn shutdown(&self) -> anyhow::Result<()> {
        let worker = self.import_worker.lock().unwrap().take();
        if let Some(worker) = worker {
            worker.shutdown().await;
        }
        self.server.shutdown().await?;
        self.relay.abort();
        Ok(())
    }
}

impl Drop for NativeSession {
    fn drop(&mut self) {
        self.import_worker.get_mut().unwrap().take();
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
        Some(ModelResponse::Items(items)) => Body::from(created + &completed_events(items)),
        Some(ModelResponse::GatedItems(items, release)) => {
            Body::from_stream(async_stream::stream! {
                yield Ok::<_, std::io::Error>(created);
                if release.await.is_ok() {
                    yield Ok(completed_events(items));
                }
            })
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

fn completed_events(items: Vec<Value>) -> String {
    let mut events = String::new();
    for item in items {
        events.push_str(&event(
            json!({"type":"response.output_item.done", "item":item}),
        ));
    }
    events.push_str(&event(json!({"type":"response.completed", "response":{
        "id":"fixture-response", "usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2,
            "input_tokens_details":null,"output_tokens_details":null}
    }})));
    events
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
    if status == axum::http::StatusCode::NO_CONTENT {
        return Ok(Value::Null);
    }
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
