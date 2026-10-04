//! Real native hosted MCP origin/account scope with entirely synthetic services.
//! This is not interactive ChatGPT sign-in, a real connector, or browser rendering.

use std::sync::{Arc, Mutex};

use anyhow::Context;
use axum::{
    body::Body,
    extract::{Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::{
    sync::{broadcast, Notify},
    task::JoinHandle,
    time::{timeout, Duration},
};
use tower::ServiceExt;

use super::fixture::{api, Fixture, ModelResponse, NativeSession};

const WIDGET: &str = "ui://widget/native-scope.html";
const OWN_RESOURCE: &str = "data://best_buy/selection";
const FOREIGN_RESOURCE: &str = "data://walmart/selection";
const CALL: &str = "native-widget-origin";
const HTML: &str = "<!doctype html><h1>Native Best Buy fixture</h1>";
const FALLBACK: &str = "Native widget fallback: selected lamp.";

#[derive(Default)]
struct Observations {
    calls: Vec<Value>,
    unexpected: Vec<String>,
}

#[derive(Clone, Default)]
struct HostedState {
    observed: Arc<Mutex<Observations>>,
    resource_entered: Arc<Notify>,
    release_resource: Arc<Notify>,
}

struct HostedService {
    url: String,
    state: HostedState,
    task: JoinHandle<()>,
}

impl HostedService {
    async fn start() -> anyhow::Result<Self> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}", listener.local_addr()?);
        let state = HostedState::default();
        let app = Router::new()
            .route(
                "/api/codex/ps/mcp",
                post(mcp).get(|| async { StatusCode::METHOD_NOT_ALLOWED }),
            )
            // Pinned native bootstrap uses the configured ChatGPT base URL for
            // these optional settings reads. No response redirects elsewhere.
            .route(
                "/api/codex/config/bundle",
                get(|| async { Json(json!({})) }),
            )
            .route(
                "/api/codex/settings/user",
                get(|| async { Json(json!({"code_review_attribution_enabled":false})) }),
            )
            .route(
                "/connectors/directory/list",
                get(|| async { Json(json!({"apps":[]})) }),
            )
            .fallback(unexpected)
            .with_state(state.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("local hosted MCP service failed");
        });
        Ok(Self { url, state, task })
    }

    fn calls(&self, method: &str) -> Vec<Value> {
        self.state
            .observed
            .lock()
            .unwrap()
            .calls
            .iter()
            .filter(|request| request["method"] == method)
            .cloned()
            .collect()
    }
}

impl Drop for HostedService {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn unexpected(State(state): State<HostedState>, request: Request) -> StatusCode {
    // Pinned rmcp-client auth_status/oauth_http_client probes these exact
    // metadata locations while discovering a loopback server's auth support.
    // The synthetic hosted service does not provide OAuth or OIDC metadata.
    if request.method() == axum::http::Method::GET
        && matches!(
            request.uri().path(),
            "/.well-known/oauth-protected-resource/api/codex/ps/mcp"
                | "/api/codex/ps/mcp/.well-known/oauth-protected-resource"
                | "/.well-known/oauth-protected-resource"
                | "/.well-known/oauth-authorization-server/api/codex/ps/mcp"
                | "/.well-known/openid-configuration/api/codex/ps/mcp"
                | "/api/codex/ps/mcp/.well-known/openid-configuration"
                | "/.well-known/oauth-authorization-server"
        )
    {
        return StatusCode::NOT_FOUND;
    }
    state.observed.lock().unwrap().unexpected.push(format!(
        "{} {}",
        request.method(),
        request.uri()
    ));
    StatusCode::NOT_FOUND
}

fn tool(connector: &str) -> Value {
    // Exact metadata/namespace shape from pinned upstream
    // app-server/tests/suite/v2/mcp_resource{,_origin}.rs.
    json!({
        "name":format!("{connector}_product_search"), "description":"Search fixture products",
        "inputSchema":{"type":"object"},
        "annotations":{"readOnlyHint":true,"openWorldHint":false},
        "_meta":{
            "connector_id":connector,"connector_name":connector,"link_id":format!("link_{connector}"),
            "ui":{"resourceUri":WIDGET},"openai/outputTemplate":WIDGET,
            "openai/ui":{"preferredModelDisplayMode":"inline"},
            "_codex_apps":{
                "resource_uri":format!("/{connector}/link_{connector}/{connector}_product_search"),
                "contains_mcp_source":true
            }
        }
    })
}

async fn mcp(State(state): State<HostedState>, Json(request): Json<Value>) -> Response {
    let method = request["method"].as_str().unwrap_or_default();
    state.observed.lock().unwrap().calls.push(request.clone());
    let result = match method {
        "initialize" => json!({
            "protocolVersion":request["params"]["protocolVersion"],
            "capabilities":{"tools":{},"resources":{}},
            "serverInfo":{"name":"Synthetic hosted Apps","version":"1"}
        }),
        "tools/list" => json!({"tools":[tool("best_buy"),tool("walmart")]}),
        "resources/list" => json!({"resources":[
            {"uri":OWN_RESOURCE,"name":"Own selection","mimeType":"text/plain",
             "_meta":{"connector_id":"best_buy","link_id":"link_best_buy"}},
            {"uri":FOREIGN_RESOURCE,"name":"Other selection","mimeType":"text/plain",
             "_meta":{"connector_id":"walmart","link_id":"link_walmart"}}
        ]}),
        "resources/templates/list" => json!({"resourceTemplates":[]}),
        "tools/call" if request["params"]["name"] == "best_buy_product_search" => {
            json!({"content":[{"type":"text","text":FALLBACK}],"structuredContent":{"selected":"lamp"},"isError":false})
        }
        "resources/read" if request["params"]["uri"] == WIDGET => {
            let meta = &request["params"]["_meta"];
            if meta["x-codex-turn-metadata"]["mcp_request_meta"]
                != json!({"selected_connector_ids":["best_buy"],"link_id":"link_best_buy"})
            {
                return rpc_error(
                    &request,
                    "native origin did not retain its app/account scope",
                );
            }
            state.resource_entered.notify_one();
            state.release_resource.notified().await;
            json!({"contents":[{"uri":WIDGET,"mimeType":"text/html;profile=mcp-app","text":HTML}]})
        }
        "resources/read" if request["params"]["uri"] == OWN_RESOURCE => {
            let meta = &request["params"]["_meta"];
            if meta["connector_id"] != "best_buy" || meta["link_id"] != "link_best_buy" {
                return rpc_error(
                    &request,
                    "auxiliary read did not use the verified native account target",
                );
            }
            json!({"contents":[{"uri":OWN_RESOURCE,"mimeType":"text/plain","text":"Own account selection"}]})
        }
        "notifications/initialized" | "notifications/cancelled" => {
            return StatusCode::ACCEPTED.into_response();
        }
        "ping" => json!({}),
        _ => {
            state
                .observed
                .lock()
                .unwrap()
                .unexpected
                .push(request.to_string());
            return rpc_error(&request, "unexpected fixture MCP request");
        }
    };
    Json(json!({"jsonrpc":"2.0","id":request["id"],"result":result})).into_response()
}

fn rpc_error(request: &Value, message: &str) -> Response {
    Json(json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32602,"message":message}}))
        .into_response()
}

fn configure(fixture: &Fixture, service: &HostedService) -> anyhow::Result<()> {
    let path = fixture.config.codex.home.join("config.toml");
    let config = std::fs::read_to_string(&path)?;
    std::fs::write(
        path,
        format!(
            "chatgpt_base_url = {:?}\nmcp_oauth_credentials_store = \"file\"\n{}\n[analytics]\nenabled = false\n[otel]\nexporter = \"none\"\ntrace_exporter = \"none\"\nmetrics_exporter = \"none\"\n",
            service.url,
            config.replace("plugins = false", "plugins = false\napps = true"),
        ),
    )?;
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"none","typ":"JWT"}"#);
    let claims = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!({
        "email":"synthetic@example.invalid",
        "https://api.openai.com/auth":{
            "chatgpt_plan_type":"plus","chatgpt_user_id":"synthetic-user",
            "chatgpt_account_id":"synthetic-account"
        }
    }))?);
    let token = format!("{header}.{claims}.synthetic-signature");
    // Pinned login/src/auth/manager.rs loads this external-token variant but
    // never refreshes it through auth.openai.com. This is synthetic fixture
    // setup, not use of the internal account/login API or managed sign-in.
    // The model retains its separate loopback provider with no OpenAI auth;
    // hosted MCP/settings use only service.url, with analytics/OTEL disabled.
    std::fs::write(
        fixture.config.codex.home.join("auth.json"),
        serde_json::to_vec(&json!({
            "auth_mode":"chatgptAuthTokens","OPENAI_API_KEY":null,
            "tokens":{"id_token":token,"access_token":token,"refresh_token":"","account_id":"synthetic-account"},
            "last_refresh":chrono::Utc::now()
        }))?,
    )?;
    Ok(())
}

async fn bridge(
    session: &NativeSession,
    surface: &Value,
    method: &str,
    params: Value,
) -> anyhow::Result<Value> {
    api(&session.app,"POST",&format!("/v1/app-surfaces/{}/bridge",surface["id"].as_str().context("surface id")?),Some(json!({
        "id":"fixture-bridge","bridgeToken":surface["bridgeToken"],"revision":surface["revision"],"method":method,"params":params
    }))).await
}

async fn document(session: &NativeSession, surface: &Value) -> anyhow::Result<String> {
    let response = session
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(surface["documentUrl"].as_str().context("document URL")?)
                .body(Body::empty())?,
        )
        .await?;
    anyhow::ensure!(response.status() == StatusCode::OK);
    Ok(String::from_utf8(
        response.into_body().collect().await?.to_bytes().to_vec(),
    )?)
}

async fn imported(
    receiver: &mut broadcast::Receiver<kodex_gateway::store::EventEnvelope>,
) -> anyhow::Result<()> {
    loop {
        let event = receiver.recv().await?;
        if event.kind == "app_surface.session_upserted" {
            return Ok(());
        }
        anyhow::ensure!(
            event.kind != "gateway.warning",
            "native widget import warning: {}",
            event.payload
        );
    }
}

async fn exercise(
    fixture: &mut Fixture,
    service: &HostedService,
    session: &mut NativeSession,
) -> anyhow::Result<(String, Value)> {
    let project=api(&session.app,"POST","/v1/projects",Some(json!({"name":"Hosted native widget","roots":[{"path":fixture.workspace}],"idempotencyKey":"hosted-widget"}))).await?;
    let created = api(
        &session.app,
        "POST",
        "/v1/threads",
        Some(json!({"projectId":project["id"]})),
    )
    .await?;
    let thread = created["thread"]["id"]
        .as_str()
        .context("native thread id")?
        .to_owned();
    let mut events = session.state.events.subscribe();
    fixture.enqueue([
        ModelResponse::Items(vec![json!({"type":"function_call","call_id":CALL,"namespace":"mcp__codex_apps__best_buy","name":"_product_search","arguments":json!({"query":"lamp","link_id":"link_best_buy"}).to_string()})]),
        ModelResponse::message("The native hosted widget is ready."),
    ]);
    api(
        &session.app,
        "POST",
        &format!("/v1/threads/{thread}/input"),
        Some(json!({"input":[{"type":"text","text":"Find a fixture lamp"}]})),
    )
    .await?;
    service.state.resource_entered.notified().await;
    // The native resource response is still held. Native turn completion and
    // the canonical fallback must already be visible without a repairing GET.
    session.completed_turn(&thread, "completed").await?;
    let view = session.canonical_view(&thread).await?;
    let item = view["rows"]
        .as_array()
        .context("canonical rows")?
        .iter()
        .flat_map(|row| row["items"].as_array().into_iter().flatten())
        .find(|item| item["itemId"] == CALL)
        .context("canonical completed MCP item")?;
    anyhow::ensure!(item["status"] == "completed");
    anyhow::ensure!(item["payload"]["item"]["result"] == FALLBACK);
    anyhow::ensure!(api(
        &session.app,
        "GET",
        &format!("/v1/threads/{thread}/app-surface"),
        None
    )
    .await?["session"]
        .is_null());
    service.state.release_resource.notify_one();
    imported(&mut events).await?;
    let surface = api(
        &session.app,
        "GET",
        &format!("/v1/threads/{thread}/app-surface"),
        None,
    )
    .await?["session"]
        .clone();
    anyhow::ensure!(surface["provider"] == "mcp" && surface["status"] == "active");
    anyhow::ensure!(surface["fallbackContent"] == FALLBACK);
    let origin = &surface["provenance"]["mcp"];
    anyhow::ensure!(origin["itemId"] == CALL && origin["originCallId"] == CALL);
    anyhow::ensure!(
        origin["appContext"]["connectorId"] == "best_buy"
            && origin["appContext"]["linkId"] == "link_best_buy"
    );
    anyhow::ensure!(
        origin["mcpAppUi"] == json!({"resourceUri":WIDGET,"preferredModelDisplayMode":"inline"})
    );
    anyhow::ensure!(document(session, &surface).await? == HTML);
    anyhow::ensure!(surface["grants"]["tools"]
        .as_array()
        .context("tool grants")?
        .iter()
        .all(|grant| grant["tool"] == "best_buy_product_search"));
    anyhow::ensure!(
        surface["grants"]["resources"] == json!([{"server":"codex_apps","uri":OWN_RESOURCE}])
    );
    let before = service.calls("resources/read").len();
    let cached = bridge(session, &surface, "resources/read", json!({"uri":WIDGET})).await?;
    anyhow::ensure!(cached["result"]["contents"][0]["text"] == HTML && cached["error"].is_null());
    anyhow::ensure!(service.calls("resources/read").len() == before);
    let resource = bridge(
        session,
        &surface,
        "resources/read",
        json!({"uri":OWN_RESOURCE}),
    )
    .await?;
    anyhow::ensure!(resource["result"]["contents"][0]["text"] == "Own account selection");
    let called=bridge(session,&surface,"tools/call",json!({"name":"best_buy_product_search","arguments":{"query":"bridge lamp","link_id":"link_best_buy"},"_meta":{"connector_id":"walmart","link_id":"link_walmart"}})).await?;
    anyhow::ensure!(
        called["error"].is_null(),
        "allowed native bridge failed: {called}"
    );
    let calls = service.calls("tools/call");
    anyhow::ensure!(calls.len() == 2);
    anyhow::ensure!(
        calls[1]["params"]["_meta"]["connector_id"] == "best_buy"
            && calls[1]["params"]["_meta"]["link_id"] == "link_best_buy"
    );
    let reads = service.calls("resources/read").len();
    for (method, params) in [
        (
            "tools/call",
            json!({"name":"best_buy_product_search","arguments":{"link_id":"link_walmart"}}),
        ),
        (
            "tools/call",
            json!({"name":"walmart_product_search","arguments":{}}),
        ),
        ("resources/read", json!({"uri":FOREIGN_RESOURCE})),
    ] {
        let denied = bridge(session, &surface, method, params).await?;
        anyhow::ensure!(
            denied["error"]["code"] == -32000,
            "cross-scope bridge unexpectedly succeeded: {denied}"
        );
    }
    anyhow::ensure!(
        service.calls("tools/call").len() == 2 && service.calls("resources/read").len() == reads
    );
    Ok((thread, surface))
}

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_native_hosted_widget_origin_account_bridge_and_cached_reopen() -> anyhow::Result<()> {
    let mut fixture = Fixture::new().await?;
    let service = HostedService::start().await?;
    configure(&fixture, &service)?;
    let mut session = NativeSession::start(&fixture).await?;
    let result = timeout(
        Duration::from_secs(60),
        exercise(&mut fixture, &service, &mut session),
    )
    .await;
    session.shutdown().await?;
    drop(session);
    let (thread, surface) =
        result.context("native hosted widget proof exceeded observation bound")??;
    let reads = service.calls("resources/read").len();
    let calls = service.calls("tools/call").len();
    let reopened = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(20), async {
        let cached = api(
            &reopened.app,
            "GET",
            &format!("/v1/threads/{thread}/app-surface"),
            None,
        )
        .await?;
        anyhow::ensure!(
            cached["session"] == surface,
            "cold cached artifact changed token/revision/provenance"
        );
        anyhow::ensure!(document(&reopened, &surface).await? == HTML);
        let cached = bridge(&reopened, &surface, "resources/read", json!({"uri":WIDGET})).await?;
        anyhow::ensure!(cached["result"]["contents"][0]["text"] == HTML);
        anyhow::ensure!(reopened.native_loaded_threads().await?["data"] == json!([]));
        anyhow::ensure!(
            service.calls("resources/read").len() == reads
                && service.calls("tools/call").len() == calls
        );
        anyhow::Ok(())
    })
    .await;
    reopened.shutdown().await?;
    result.context("cold cached widget proof exceeded observation bound")??;
    anyhow::ensure!(
        service.state.observed.lock().unwrap().unexpected.is_empty(),
        "unexpected hosted service requests: {:?}",
        service.state.observed.lock().unwrap().unexpected
    );
    Ok(())
}
