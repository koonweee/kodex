//! Actual native OAuth against a local synthetic authorization/MCP service.
//! This does not exercise a real account, browser consent UI, or remote provider.

use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

use anyhow::Context;
use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Form, Json, Router,
};
use kodex_gateway::store::EventEnvelope;
use reqwest::Url;
use serde_json::{json, Value};
use tokio::{
    sync::broadcast,
    task::JoinHandle,
    time::{timeout, Duration},
};

use super::fixture::{api, Fixture, NativeSession};

const SERVER: &str = "local_oauth_proof";
const CLIENT_ID: &str = "kodex-local-proof";
const TOKEN: &str = "synthetic-local-mcp-access-token";

#[derive(Default)]
struct Observations {
    exchanges: Vec<BTreeMap<String, String>>,
    token_authorization: bool,
    authenticated_methods: Vec<String>,
}

#[derive(Clone)]
struct OAuthState {
    base_url: String,
    observations: Arc<Mutex<Observations>>,
}

struct OAuthService {
    state: OAuthState,
    task: JoinHandle<()>,
}

impl OAuthService {
    async fn start() -> anyhow::Result<Self> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let state = OAuthState {
            base_url: format!("http://{}", listener.local_addr()?),
            observations: Arc::default(),
        };
        // These metadata paths and the JSON MCP responses follow pinned 0.160
        // app-server/tests/suite/v2/mcp_server_status.rs. The native process,
        // callback listener, token exchange, credential store and client are real.
        let app = Router::new()
            .route(
                "/.well-known/oauth-authorization-server/mcp",
                get(authorization_metadata),
            )
            .route(
                "/.well-known/oauth-protected-resource/mcp",
                get(protected_resource),
            )
            .route("/token", post(exchange_token))
            .route("/mcp", post(mcp))
            .with_state(state.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("local OAuth service failed");
        });
        Ok(Self { state, task })
    }
}

impl Drop for OAuthService {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn authorization_metadata(State(state): State<OAuthState>) -> Json<Value> {
    Json(json!({
        "issuer": format!("{}/mcp", state.base_url),
        "authorization_endpoint": format!("{}/authorize", state.base_url),
        "token_endpoint": format!("{}/token", state.base_url),
        "authorization_response_iss_parameter_supported": false,
        "token_endpoint_auth_methods_supported": ["none"],
        "response_types_supported": ["code"],
        "code_challenge_methods_supported": ["S256"],
        "scopes_supported": ["fixture:read"],
    }))
}

async fn protected_resource(State(state): State<OAuthState>) -> Json<Value> {
    Json(json!({
        "resource": format!("{}/mcp", state.base_url),
        "authorization_servers": [format!("{}/mcp", state.base_url)],
    }))
}

async fn exchange_token(
    State(state): State<OAuthState>,
    headers: HeaderMap,
    Form(form): Form<BTreeMap<String, String>>,
) -> Json<Value> {
    let mut observations = state.observations.lock().unwrap();
    observations.token_authorization |= headers.contains_key(header::AUTHORIZATION);
    observations.exchanges.push(form);
    Json(json!({
        "access_token": TOKEN, "token_type": "Bearer", "expires_in": 3600,
    }))
}

async fn mcp(
    State(state): State<OAuthState>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    if headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        != Some(format!("Bearer {TOKEN}").as_str())
    {
        return (
            StatusCode::UNAUTHORIZED,
            [(
                header::WWW_AUTHENTICATE,
                format!(
                    "Bearer resource_metadata=\"{}/.well-known/oauth-protected-resource/mcp\"",
                    state.base_url,
                ),
            )],
        )
            .into_response();
    }
    let method = request["method"].as_str().unwrap_or_default();
    state
        .observations
        .lock()
        .unwrap()
        .authenticated_methods
        .push(method.into());
    let result = match method {
        "initialize" => json!({
            "protocolVersion": request["params"]["protocolVersion"],
            "capabilities": {"tools":{},"resources":{}},
            "serverInfo": {"name":"Local OAuth proof","version":"1"},
        }),
        "tools/list" => json!({"tools":[{
            "name":"authorized_read", "description":"Available only with the synthetic OAuth token",
            "inputSchema":{"type":"object","properties":{}},
        }]}),
        "resources/list" => json!({"resources":[]}),
        "resources/templates/list" => json!({"resourceTemplates":[]}),
        "notifications/initialized" | "notifications/cancelled" => {
            return StatusCode::ACCEPTED.into_response()
        }
        "ping" => json!({}),
        _ => return StatusCode::BAD_REQUEST.into_response(),
    };
    Json(json!({"jsonrpc":"2.0","id":request["id"],"result":result})).into_response()
}

async fn oauth_event(
    receiver: &mut broadcast::Receiver<EventEnvelope>,
) -> anyhow::Result<EventEnvelope> {
    timeout(Duration::from_secs(10), async {
        loop {
            let event = receiver.recv().await?;
            if event.kind == "mcp.oauth_login_completed" && event.payload["name"] == SERVER {
                return Ok(event);
            }
        }
    })
    .await
    .context("gateway OAuth completion was not published")?
}

async fn inventory(session: &NativeSession) -> anyhow::Result<Value> {
    let result = api(&session.app, "GET", "/v1/mcp/servers?detail=full", None).await?;
    result["servers"]
        .as_array()
        .and_then(|servers| servers.iter().find(|row| row["name"] == SERVER))
        .cloned()
        .context("configured local OAuth server is absent from native inventory")
}

async fn login(session: &mut NativeSession, service: &OAuthService) -> anyhow::Result<()> {
    let initial = inventory(session).await?;
    anyhow::ensure!(initial["authStatus"] == "notLoggedIn");
    anyhow::ensure!(initial["tools"]
        .as_object()
        .is_some_and(|tools| tools.is_empty()));
    let mut first = session.state.events.subscribe();
    let mut second = session.state.events.subscribe();
    let response = api(
        &session.app,
        "POST",
        &format!("/v1/mcp/servers/{SERVER}/oauth-login"),
        Some(json!({
            "scopes":["fixture:read"], "timeoutSecs":20,
        })),
    )
    .await?;
    let authorization = Url::parse(
        response["authorizationUrl"]
            .as_str()
            .context("native authorization URL")?,
    )?;
    anyhow::ensure!(authorization.origin().ascii_serialization() == service.state.base_url);
    anyhow::ensure!(authorization.path() == "/authorize");
    let parameters = authorization
        .query_pairs()
        .into_owned()
        .collect::<BTreeMap<_, _>>();
    anyhow::ensure!(parameters.get("client_id").map(String::as_str) == Some(CLIENT_ID));
    anyhow::ensure!(parameters.get("code_challenge_method").map(String::as_str) == Some("S256"));
    anyhow::ensure!(parameters
        .get("code_challenge")
        .is_some_and(|value| !value.is_empty()));
    anyhow::ensure!(parameters.get("scope").map(String::as_str) == Some("fixture:read"));
    anyhow::ensure!(!parameters.contains_key("client_secret"));
    let redirect = parameters
        .get("redirect_uri")
        .context("native callback URL")?;
    let mut callback = Url::parse(redirect)?;
    anyhow::ensure!(callback.scheme() == "http");
    anyhow::ensure!(matches!(
        callback.host_str(),
        Some("127.0.0.1" | "localhost" | "[::1]")
    ));
    let state = parameters.get("state").context("native OAuth state")?;
    anyhow::ensure!(!state.is_empty());
    // As in the pinned native test, simulate only the provider's authorization
    // response; the real app-server owns and validates this loopback listener.
    callback
        .query_pairs_mut()
        .append_pair("code", "local-authorized-code")
        .append_pair("state", state);
    reqwest::Client::builder()
        .no_proxy()
        .build()?
        .get(callback)
        .send()
        .await?
        .error_for_status()?;
    let completed = session
        .notification("mcpServer/oauthLogin/completed", "name", SERVER)
        .await?;
    anyhow::ensure!(completed["success"] == true && completed["error"].is_null());
    anyhow::ensure!(completed["threadId"].is_null());
    for receiver in [&mut first, &mut second] {
        let event = oauth_event(receiver).await?;
        anyhow::ensure!(event.thread_id.is_none());
        anyhow::ensure!(event.codex_method.as_deref() == Some("mcpServer/oauthLogin/completed"));
        anyhow::ensure!(event.payload == completed);
    }
    {
        let observed = service.state.observations.lock().unwrap();
        anyhow::ensure!(observed.exchanges.len() == 1);
        let form = &observed.exchanges[0];
        anyhow::ensure!(form.get("client_id").map(String::as_str) == Some(CLIENT_ID));
        anyhow::ensure!(form.get("grant_type").map(String::as_str) == Some("authorization_code"));
        anyhow::ensure!(form.get("code").map(String::as_str) == Some("local-authorized-code"));
        anyhow::ensure!(form.get("redirect_uri") == Some(redirect));
        anyhow::ensure!(form
            .get("code_verifier")
            .is_some_and(|value| !value.is_empty()));
        anyhow::ensure!(!observed.token_authorization);
    }
    // Successful native OAuth invalidates its MCP runtime. No test-injected
    // status, token file, reload result, or gateway event repairs this read.
    assert_authorized_inventory(session).await
}

async fn assert_authorized_inventory(session: &NativeSession) -> anyhow::Result<()> {
    let row = inventory(session).await?;
    anyhow::ensure!(
        row["authStatus"] == "oAuth",
        "native inventory did not report OAuth"
    );
    anyhow::ensure!(
        row["tools"]
            .as_object()
            .is_some_and(|tools| tools.values().any(|tool| tool["name"] == "authorized_read")),
        "authenticated native tool discovery was not reflected in inventory"
    );
    Ok(())
}

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_native_mcp_oauth_callback_inventory_and_cold_credentials_use_disposable_state(
) -> anyhow::Result<()> {
    let fixture = Fixture::new().await?;
    let service = OAuthService::start().await?;
    let config_file = fixture.config.codex.home.join("config.toml");
    let mut config = std::fs::read_to_string(&config_file)?;
    config.push_str(&format!(
        "\n[mcp_servers.{SERVER}]\nurl = \"{}/mcp\"\n[mcp_servers.{SERVER}.oauth]\nclient_id = \"{CLIENT_ID}\"\n",
        service.state.base_url,
    ));
    std::fs::write(config_file, config)?;
    let mut session = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(45), login(&mut session, &service)).await;
    session.shutdown().await?;
    drop(session);
    result.context("native OAuth proof exceeded observation bound")??;
    anyhow::ensure!(fixture
        .config
        .codex
        .home
        .join(".credentials.json")
        .is_file());
    let before = service
        .state
        .observations
        .lock()
        .unwrap()
        .authenticated_methods
        .len();
    let reopened = NativeSession::start(&fixture).await?;
    let result = timeout(
        Duration::from_secs(20),
        assert_authorized_inventory(&reopened),
    )
    .await;
    reopened.shutdown().await?;
    result.context("cold native OAuth inventory exceeded observation bound")??;
    let observed = service.state.observations.lock().unwrap();
    anyhow::ensure!(
        observed.exchanges.len() == 1,
        "cold reopen unexpectedly performed another OAuth exchange"
    );
    anyhow::ensure!(observed.authenticated_methods.len() > before);
    anyhow::ensure!(observed
        .authenticated_methods
        .iter()
        .any(|method| method == "tools/list"));
    anyhow::ensure!(!fixture.config.codex.home.join("auth.json").exists());
    Ok(())
}
