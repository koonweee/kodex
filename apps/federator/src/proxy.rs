use std::sync::OnceLock;

use axum::{
    body::Body,
    extract::{
        ws::{Message as BrowserMessage, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{header, HeaderMap, Method, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::{any, get},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};

use crate::{
    registry::{self, ExecutorRecord, ExecutorStatus, SUPPORTED_EXECUTOR_API_VERSION},
    State as FederatorState,
};

const EXPECTED_INSTANCE_HEADER: &str = "x-kodex-expected-instance";
const API_VERSION_HEADER: &str = "x-kodex-api-version";
const FRONTEND_UPDATE_PATH: &str = "/v1/frontend-updates";
const WEBSOCKET_SETUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const WEBSOCKET_CLOSE_HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);

pub fn router() -> Router<FederatorState> {
    Router::new()
        .route(
            "/v1/executors/{executor_id}/terminals/{terminal_id}/ws",
            get(proxy_terminal_websocket),
        )
        .route("/v1/executors/{executor_id}/{*path}", any(proxy_executor))
}

async fn proxy_terminal_websocket(
    State(state): State<FederatorState>,
    Path((executor_id, terminal_id)): Path<(String, String)>,
    Query(query): Query<TerminalWebSocketQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if query.api_version.as_deref() != Some(crate::trust::FEDERATOR_API_VERSION) {
        return ProxyError::client_update_required().into_response();
    }
    match connect_terminal_websocket(&state, &executor_id, &terminal_id).await {
        Ok((upstream, binding, changes)) => ws
            .on_upgrade(move |browser| bridge_websockets(browser, upstream, binding, changes))
            .into_response(),
        Err(error) => error.into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalWebSocketQuery {
    api_version: Option<String>,
}

type UpstreamWebSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect_terminal_websocket(
    state: &FederatorState,
    executor_id: &str,
    terminal_id: &str,
) -> Result<
    (
        UpstreamWebSocket,
        ExecutorRecord,
        tokio::sync::broadcast::Receiver<crate::RegistryChange>,
    ),
    ProxyError,
> {
    connect_terminal_websocket_with_timeout(
        state,
        executor_id,
        terminal_id,
        WEBSOCKET_SETUP_TIMEOUT,
    )
    .await
}

async fn connect_terminal_websocket_with_timeout(
    state: &FederatorState,
    executor_id: &str,
    terminal_id: &str,
    timeout: std::time::Duration,
) -> Result<
    (
        UpstreamWebSocket,
        ExecutorRecord,
        tokio::sync::broadcast::Receiver<crate::RegistryChange>,
    ),
    ProxyError,
> {
    tokio::time::timeout(
        timeout,
        connect_terminal_websocket_inner(state, executor_id, terminal_id),
    )
    .await
    .map_err(|_| ProxyError::upstream("Executor WebSocket setup timed out."))?
}

async fn connect_terminal_websocket_inner(
    state: &FederatorState,
    executor_id: &str,
    terminal_id: &str,
) -> Result<
    (
        UpstreamWebSocket,
        ExecutorRecord,
        tokio::sync::broadcast::Receiver<crate::RegistryChange>,
    ),
    ProxyError,
> {
    let changes = state.registry_changes.subscribe();
    let binding = load_routable_binding(state, executor_id).await?;
    let endpoint = registry::validate_executor_proxy_endpoint(&binding.base_url)
        .await
        .map_err(|error| ProxyError::upstream(error.message().to_string()))?;
    let tcp = connect_pinned(&endpoint.addresses).await?;
    let mut url = url::Url::parse(&endpoint.base_url).map_err(ProxyError::internal)?;
    url.set_scheme(if url.scheme() == "https" { "wss" } else { "ws" })
        .map_err(|_| ProxyError::internal("invalid executor WebSocket scheme"))?;
    url.set_path(&format!(
        "/v1/terminals/{}/ws",
        percent_encoding::utf8_percent_encode(terminal_id, percent_encoding::NON_ALPHANUMERIC)
    ));
    let mut request =
        tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
            url.as_str(),
        )
        .map_err(ProxyError::internal)?;
    request.headers_mut().insert(
        EXPECTED_INSTANCE_HEADER,
        binding
            .instance_id
            .parse()
            .map_err(|_| ProxyError::internal("invalid stored executor instance identity"))?,
    );
    request.headers_mut().insert(
        API_VERSION_HEADER,
        SUPPORTED_EXECUTOR_API_VERSION
            .parse()
            .expect("supported API version is a valid header value"),
    );
    let (upstream, response) =
        tokio_tungstenite::client_async_tls_with_config(request, tcp, None, None)
            .await
            .map_err(|error| ProxyError::upstream(format!("Executor WebSocket failed: {error}")))?;
    if response
        .headers()
        .get(API_VERSION_HEADER)
        .is_none_or(|version| version != SUPPORTED_EXECUTOR_API_VERSION)
    {
        return Err(ProxyError::incompatible(
            "Executor WebSocket did not confirm the required API version.",
        ));
    }
    ensure_binding_current(state, &binding).await?;
    Ok((upstream, binding, changes))
}

async fn load_routable_binding(
    state: &FederatorState,
    executor_id: &str,
) -> Result<ExecutorRecord, ProxyError> {
    let binding = state
        .store
        .get_executor(executor_id)
        .await
        .map_err(ProxyError::internal)?
        .ok_or_else(|| ProxyError::not_found("Executor not found."))?;
    if !binding.enabled {
        return Err(ProxyError::unavailable("Executor is disabled."));
    }
    if binding.api_version != SUPPORTED_EXECUTOR_API_VERSION
        || binding.status == ExecutorStatus::Incompatible
    {
        return Err(ProxyError::conflict(
            "Executor API/native version is incompatible.",
        ));
    }
    Ok(binding)
}

async fn connect_pinned(
    addresses: &[std::net::SocketAddr],
) -> Result<tokio::net::TcpStream, ProxyError> {
    let mut last_error = None;
    for address in addresses {
        match tokio::net::TcpStream::connect(address).await {
            Ok(stream) => return Ok(stream),
            Err(error) => last_error = Some(error.to_string()),
        }
    }
    Err(ProxyError::upstream(format!(
        "Executor WebSocket connection failed: {}",
        last_error.unwrap_or_else(|| "endpoint has no validated addresses".to_string())
    )))
}

async fn bridge_websockets(
    browser: WebSocket,
    upstream: UpstreamWebSocket,
    binding: ExecutorRecord,
    mut changes: tokio::sync::broadcast::Receiver<crate::RegistryChange>,
) {
    let (browser_sink, mut browser_stream) = browser.split();
    let (upstream_sink, mut upstream_stream) = upstream.split();
    let browser_sink = std::sync::Arc::new(tokio::sync::Mutex::new(browser_sink));
    let upstream_sink = std::sync::Arc::new(tokio::sync::Mutex::new(upstream_sink));
    let browser_to_executor = async {
        while let Some(Ok(message)) = browser_stream.next().await {
            let close = matches!(message, BrowserMessage::Close(_));
            upstream_sink
                .lock()
                .await
                .send(browser_to_upstream(message))
                .await
                .map_err(|error| error.to_string())?;
            if close {
                // axum's receive half automatically queues the browser's close
                // acknowledgement. Flush it through the split sink before the
                // bridge waits for the executor's half of the handshake.
                browser_sink
                    .lock()
                    .await
                    .flush()
                    .await
                    .map_err(|error| error.to_string())?;
                return Ok(true);
            }
        }
        Ok::<bool, String>(false)
    };
    let executor_to_browser = async {
        while let Some(Ok(message)) = upstream_stream.next().await {
            if let Some((message, close)) = upstream_to_browser(message) {
                browser_sink
                    .lock()
                    .await
                    .send(message)
                    .await
                    .map_err(|error| error.to_string())?;
                if close {
                    // tungstenite queues the executor's close acknowledgement
                    // while reading the frame. Flush it before ending this half.
                    upstream_sink
                        .lock()
                        .await
                        .flush()
                        .await
                        .map_err(|error| error.to_string())?;
                    return Ok(true);
                }
            }
        }
        Ok::<bool, String>(false)
    };
    tokio::pin!(browser_to_executor, executor_to_browser);
    enum CompletedDirection {
        Browser(Result<bool, String>),
        Executor(Result<bool, String>),
        BindingChanged,
    }
    let completed = {
        let binding_changed = wait_for_binding_change(&mut changes, &binding);
        tokio::pin!(binding_changed);
        tokio::select! {
            result = &mut browser_to_executor => CompletedDirection::Browser(result),
            result = &mut executor_to_browser => CompletedDirection::Executor(result),
            () = &mut binding_changed => CompletedDirection::BindingChanged,
        }
    };
    match completed {
        CompletedDirection::Browser(Ok(true)) => {
            let peer_close =
                tokio::time::timeout(WEBSOCKET_CLOSE_HANDSHAKE_TIMEOUT, &mut executor_to_browser);
            tokio::pin!(peer_close);
            tokio::select! {
                _ = &mut peer_close => {}
                () = wait_for_binding_change(&mut changes, &binding) => {}
            }
        }
        CompletedDirection::Executor(Ok(true)) => {
            let peer_close =
                tokio::time::timeout(WEBSOCKET_CLOSE_HANDSHAKE_TIMEOUT, &mut browser_to_executor);
            tokio::pin!(peer_close);
            tokio::select! {
                _ = &mut peer_close => {}
                () = wait_for_binding_change(&mut changes, &binding) => {}
            }
        }
        CompletedDirection::Browser(Ok(false) | Err(_))
        | CompletedDirection::Executor(Ok(false) | Err(_))
        | CompletedDirection::BindingChanged => {}
    }
    // Dropping both forwarding futures cancels any backpressured write before
    // either socket half is awaited again. The browser transport is revoked
    // immediately even when the executor never reads or completes a close.
}

async fn wait_for_binding_change(
    changes: &mut tokio::sync::broadcast::Receiver<crate::RegistryChange>,
    binding: &ExecutorRecord,
) {
    loop {
        match changes.recv().await {
            Ok(change)
                if change.executor_id == binding.id
                    && change
                        .generation
                        .map_or(true, |generation| generation > binding.generation) =>
            {
                return;
            }
            Ok(_) => continue,
            Err(_) => return,
        }
    }
}

fn browser_to_upstream(message: BrowserMessage) -> tokio_tungstenite::tungstenite::Message {
    use tokio_tungstenite::tungstenite::Message;
    match message {
        BrowserMessage::Text(value) => Message::Text(value.to_string().into()),
        BrowserMessage::Binary(value) => Message::Binary(value.to_vec().into()),
        BrowserMessage::Ping(value) => Message::Ping(value.to_vec().into()),
        BrowserMessage::Pong(value) => Message::Pong(value.to_vec().into()),
        BrowserMessage::Close(frame) => Message::Close(frame.map(|frame| {
            tokio_tungstenite::tungstenite::protocol::CloseFrame {
                code: frame.code.into(),
                reason: frame.reason.to_string().into(),
            }
        })),
    }
}

fn upstream_to_browser(
    message: tokio_tungstenite::tungstenite::Message,
) -> Option<(BrowserMessage, bool)> {
    use tokio_tungstenite::tungstenite::Message;
    Some(match message {
        Message::Text(value) => (BrowserMessage::Text(value.to_string().into()), false),
        Message::Binary(value) => (BrowserMessage::Binary(value.to_vec().into()), false),
        Message::Ping(value) => (BrowserMessage::Ping(value.to_vec().into()), false),
        Message::Pong(value) => (BrowserMessage::Pong(value.to_vec().into()), false),
        Message::Close(frame) => (
            BrowserMessage::Close(frame.map(|frame| axum::extract::ws::CloseFrame {
                code: frame.code.into(),
                reason: frame.reason.to_string().into(),
            })),
            true,
        ),
        Message::Frame(_) => return None,
    })
}

async fn proxy_executor(
    State(state): State<FederatorState>,
    Path((executor_id, path)): Path<(String, String)>,
    request: Request<Body>,
) -> Response {
    match proxy_executor_inner(&state, &executor_id, &path, request).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

async fn proxy_executor_inner(
    state: &FederatorState,
    executor_id: &str,
    path: &str,
    request: Request<Body>,
) -> Result<Response, ProxyError> {
    let registry_changes = state.registry_changes.subscribe();
    validate_proxy_path(path)?;
    let upstream_path = format!("/v1/{path}");
    if !allowlist().allows(request.method(), &upstream_path) {
        return Err(ProxyError::not_found(
            "The requested executor route is not exposed by the federator.",
        ));
    }

    let binding = load_routable_binding(state, executor_id).await?;

    // Resolve and constrain the endpoint for every routed request. The returned
    // client is pinned to that address set, so a later DNS answer cannot change
    // the peer used by this operation.
    let endpoint = registry::validate_executor_proxy_endpoint(&binding.base_url)
        .await
        .map_err(|error| ProxyError::upstream(error.message().to_string()))?;
    let mut upstream_url = url::Url::parse(&endpoint.base_url).map_err(ProxyError::internal)?;
    upstream_url.set_path(&upstream_path);
    upstream_url.set_query(request.uri().query());

    let (parts, body) = request.into_parts();
    let mut headers = parts.headers;
    remove_hop_by_hop_headers(&mut headers);
    headers.remove(header::HOST);
    headers.insert(
        EXPECTED_INSTANCE_HEADER,
        binding
            .instance_id
            .parse()
            .map_err(|_| ProxyError::internal("invalid stored executor instance identity"))?,
    );
    headers.insert(
        API_VERSION_HEADER,
        SUPPORTED_EXECUTOR_API_VERSION
            .parse()
            .expect("supported API version is a valid header value"),
    );
    let upstream = endpoint
        .client
        .request(parts.method, upstream_url)
        .headers(headers)
        .body(reqwest::Body::wrap_stream(body.into_data_stream()))
        .send()
        .await
        .map_err(|error| ProxyError::upstream(format!("Executor request failed: {error}")))?;

    if upstream
        .headers()
        .get(API_VERSION_HEADER)
        .is_none_or(|version| version != SUPPORTED_EXECUTOR_API_VERSION)
    {
        return Err(ProxyError::incompatible(
            "Executor response did not confirm the required API version.",
        ));
    }
    if upstream.status().is_redirection() {
        return Err(ProxyError::upstream(
            "Executor redirects are not permitted through the federator.",
        ));
    }
    ensure_binding_current(state, &binding).await?;

    let status = upstream.status();
    let mut response_headers = upstream.headers().clone();
    remove_hop_by_hop_headers(&mut response_headers);
    let body = generation_fenced_body(upstream, binding, registry_changes);
    let mut response = Response::new(body);
    *response.status_mut() = status;
    *response.headers_mut() = response_headers;
    Ok(response)
}

fn generation_fenced_body(
    upstream: reqwest::Response,
    binding: ExecutorRecord,
    mut registry_changes: tokio::sync::broadcast::Receiver<crate::RegistryChange>,
) -> Body {
    let stream = async_stream::stream! {
        let mut upstream = upstream.bytes_stream();
        loop {
            tokio::select! {
                biased;
                change = registry_changes.recv() => match change {
                    Ok(change)
                        if change.executor_id == binding.id
                            && change
                                .generation
                                .map_or(true, |generation| generation > binding.generation) =>
                    {
                        yield Err(std::io::Error::other(
                            "executor registration changed while streaming the response",
                        ));
                        break;
                    }
                    Ok(_) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        yield Err(std::io::Error::other(
                            "executor registry changes were missed while streaming the response",
                        ));
                        break;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        yield Err(std::io::Error::other(
                            "executor registry closed while streaming the response",
                        ));
                        break;
                    }
                },
                chunk = upstream.next() => match chunk {
                    Some(Ok(chunk)) => yield Ok(chunk),
                    Some(Err(error)) => {
                        yield Err(std::io::Error::other(error));
                        break;
                    }
                    None => break,
                }
            }
        }
    };
    Body::from_stream(stream)
}

async fn ensure_binding_current(
    state: &FederatorState,
    expected: &ExecutorRecord,
) -> Result<(), ProxyError> {
    let current = state
        .store
        .get_executor(&expected.id)
        .await
        .map_err(ProxyError::internal)?;
    if !current.is_some_and(|current| {
        current.enabled
            && current.generation == expected.generation
            && current.instance_id == expected.instance_id
            && current.base_url == expected.base_url
    }) {
        return Err(ProxyError::conflict(
            "Executor registration changed while the request was in flight.",
        ));
    }
    Ok(())
}

fn validate_proxy_path(path: &str) -> Result<(), ProxyError> {
    if path.is_empty()
        || path.split('/').any(|segment| {
            segment.is_empty()
                || matches!(segment, "." | "..")
                || segment.contains('\\')
                || segment.contains('\0')
        })
    {
        return Err(ProxyError::not_found("Invalid executor route."));
    }
    Ok(())
}

fn remove_hop_by_hop_headers(headers: &mut HeaderMap) {
    let connection_headers = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .filter_map(|name| name.trim().parse::<header::HeaderName>().ok())
        .collect::<Vec<_>>();
    for name in connection_headers {
        headers.remove(name);
    }
    for name in [
        header::CONNECTION,
        header::PROXY_AUTHENTICATE,
        header::PROXY_AUTHORIZATION,
        header::TE,
        header::TRAILER,
        header::TRANSFER_ENCODING,
        header::UPGRADE,
    ] {
        headers.remove(name);
    }
    headers.remove("keep-alive");
}

fn allowlist() -> &'static ExecutorRouteAllowlist {
    static ALLOWLIST: OnceLock<ExecutorRouteAllowlist> = OnceLock::new();
    ALLOWLIST.get_or_init(ExecutorRouteAllowlist::from_gateway_openapi)
}

struct ExecutorRouteAllowlist {
    rules: Vec<RouteRule>,
}

struct RouteRule {
    method: String,
    segments: Vec<RouteSegment>,
}

enum RouteSegment {
    Literal(String),
    Parameter,
    RestParameter,
}

impl ExecutorRouteAllowlist {
    fn from_gateway_openapi() -> Self {
        let contract = serde_json::to_value(kodex_gateway::executor_openapi())
            .expect("executor OpenAPI serializes");
        let paths = contract["paths"]
            .as_object()
            .expect("executor OpenAPI contains paths");
        let mut rules = Vec::new();
        for (path, item) in paths {
            if path == FRONTEND_UPDATE_PATH {
                continue;
            }
            let Some(item) = item.as_object() else {
                continue;
            };
            for method in ["get", "post", "put", "patch", "delete"] {
                if item.contains_key(method) {
                    rules.push(RouteRule {
                        method: method.to_string(),
                        segments: path
                            .trim_start_matches('/')
                            .split('/')
                            .map(|segment| {
                                if path.contains("/files/content/") && segment == "{filePath}" {
                                    RouteSegment::RestParameter
                                } else if segment.starts_with('{') && segment.ends_with('}') {
                                    RouteSegment::Parameter
                                } else {
                                    RouteSegment::Literal(segment.to_string())
                                }
                            })
                            .collect(),
                    });
                }
            }
        }
        Self { rules }
    }

    fn allows(&self, method: &Method, path: &str) -> bool {
        let method = if method == Method::HEAD {
            "get"
        } else {
            method.as_str()
        };
        let method = method.to_ascii_lowercase();
        let segments = path.trim_start_matches('/').split('/').collect::<Vec<_>>();
        self.rules.iter().any(|rule| {
            let has_rest = matches!(rule.segments.last(), Some(RouteSegment::RestParameter));
            rule.method == method
                && if has_rest {
                    segments.len() >= rule.segments.len()
                } else {
                    rule.segments.len() == segments.len()
                }
                && rule
                    .segments
                    .iter()
                    .zip(&segments)
                    .all(|(rule, actual)| match rule {
                        RouteSegment::Literal(expected) => expected == actual,
                        RouteSegment::Parameter | RouteSegment::RestParameter => !actual.is_empty(),
                    })
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProxyErrorBody {
    code: &'static str,
    message: String,
}

struct ProxyError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ProxyError {
    fn client_update_required() -> Self {
        Self::new(
            StatusCode::CONFLICT,
            "client_update_required",
            "Update Kodex before making changes.",
        )
    }
    fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "executor_route_not_found", message)
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "executor_unavailable",
            message,
        )
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, "executor_binding_changed", message)
    }

    fn incompatible(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, "executor_incompatible", message)
    }

    fn upstream(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, "executor_proxy_failed", message)
    }

    fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!(%error, "federator proxy failed");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "Federator proxy failed.",
        )
    }

    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
}

impl IntoResponse for ProxyError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ProxyErrorBody {
                code: self.code,
                message: self.message,
            }),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use std::{
        convert::Infallible,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::Duration,
    };

    use axum::{
        body::Body,
        extract::{ws::WebSocketUpgrade, Path},
        http::HeaderValue,
        response::Response,
        routing::get,
        Router,
    };
    use http_body_util::BodyExt;
    use tokio::time::{sleep, timeout};

    use super::*;

    #[test]
    fn allowlist_comes_from_executor_contract_and_excludes_control() {
        let allowlist = ExecutorRouteAllowlist::from_gateway_openapi();
        assert!(allowlist.allows(&Method::GET, "/v1/projects"));
        assert!(allowlist.allows(&Method::POST, "/v1/threads/thread-1/input"));
        assert!(allowlist.allows(
            &Method::GET,
            "/v1/threads/thread-1/files/content/directory/assets/icon.svg"
        ));
        assert!(!allowlist.allows(&Method::GET, "/v1/self-control/status"));
        assert!(!allowlist.allows(&Method::GET, "/v1/federation/executors"));
        assert!(!allowlist.allows(&Method::POST, FRONTEND_UPDATE_PATH));
        assert!(!allowlist.allows(&Method::DELETE, "/v1/projects"));
    }

    #[test]
    fn traversal_and_ambiguous_segments_are_rejected() {
        for path in [
            "",
            "projects/../self-control",
            "projects//id",
            "projects\\id",
        ] {
            assert!(validate_proxy_path(path).is_err(), "{path}");
        }
    }

    #[test]
    fn websocket_close_code_and_reason_are_preserved_in_both_directions() {
        let upstream =
            browser_to_upstream(BrowserMessage::Close(Some(axum::extract::ws::CloseFrame {
                code: 4001,
                reason: "browser reason".into(),
            })));
        let tokio_tungstenite::tungstenite::Message::Close(Some(upstream)) = upstream else {
            panic!("expected close frame");
        };
        assert_eq!(u16::from(upstream.code), 4001);
        assert_eq!(upstream.reason, "browser reason");

        let (browser, close) = upstream_to_browser(tokio_tungstenite::tungstenite::Message::Close(
            Some(tokio_tungstenite::tungstenite::protocol::CloseFrame {
                code: 4002.into(),
                reason: "executor reason".into(),
            }),
        ))
        .unwrap();
        let BrowserMessage::Close(Some(browser)) = browser else {
            panic!("expected close frame");
        };
        assert!(close);
        assert_eq!(browser.code, 4002);
        assert_eq!(browser.reason, "executor reason");
    }

    #[tokio::test]
    async fn terminal_websocket_setup_has_one_total_deadline() {
        let upstream_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_address = upstream_listener.local_addr().unwrap();
        let accepted = tokio::spawn(async move {
            let (_socket, _) = upstream_listener.accept().await.unwrap();
            std::future::pending::<()>().await;
        });
        let dir = tempfile::tempdir().unwrap();
        let config = crate::config::Config {
            data_dir: dir.path().to_path_buf(),
            database_path: dir.path().join("federator.db"),
            ..crate::config::Config::default()
        };
        let (_instance, state) = crate::prepare(&config).await.unwrap();
        state
            .store
            .insert_executor(&ExecutorRecord {
                id: "executor-1".to_string(),
                generation: 1,
                display_name: "Executor".to_string(),
                base_url: format!("http://{upstream_address}"),
                instance_id: "executor-instance".to_string(),
                api_version: "4".to_string(),
                app_server_schema_version: "0.160.0".to_string(),
                enabled: true,
                status: ExecutorStatus::Ready,
                last_error: None,
                last_seen_at: 1,
                created_at: 1,
                updated_at: 1,
            })
            .await
            .unwrap();
        let error = connect_terminal_websocket_with_timeout(
            &state,
            "executor-1",
            "terminal-1",
            Duration::from_millis(50),
        )
        .await
        .err()
        .expect("stalled handshake times out");
        assert_eq!(error.code, "executor_proxy_failed");
        assert!(error.message.contains("setup timed out"));
        accepted.abort();
    }

    #[tokio::test]
    async fn terminal_websocket_is_bidirectional_and_generation_fenced() {
        let upstream_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_address = upstream_listener.local_addr().unwrap();
        let upstream_handshakes = Arc::new(AtomicUsize::new(0));
        let upstream_app = Router::new().route(
            "/v1/terminals/{terminal_id}/ws",
            get({
                let upstream_handshakes = upstream_handshakes.clone();
                move |Path(terminal_id): Path<String>, headers: HeaderMap, ws: WebSocketUpgrade| {
                    let upstream_handshakes = upstream_handshakes.clone();
                    async move {
                        upstream_handshakes.fetch_add(1, Ordering::SeqCst);
                        assert_eq!(headers[EXPECTED_INSTANCE_HEADER], "executor-instance");
                        assert_eq!(headers[API_VERSION_HEADER], "4");
                        let mut response = ws.on_upgrade(move |mut socket| async move {
                            if terminal_id == "blocked" {
                                std::future::pending::<()>().await;
                            }
                            if terminal_id == "executor-close" {
                                socket
                                    .send(BrowserMessage::Close(Some(
                                        axum::extract::ws::CloseFrame {
                                            code: 4002,
                                            reason: "executor reason".into(),
                                        },
                                    )))
                                    .await
                                    .unwrap();
                            }
                            while let Some(Ok(message)) = socket.recv().await {
                                if matches!(message, BrowserMessage::Close(_)) {
                                    break;
                                }
                                if socket.send(message).await.is_err() {
                                    break;
                                }
                            }
                        });
                        response
                            .headers_mut()
                            .insert(API_VERSION_HEADER, HeaderValue::from_static("4"));
                        response
                    }
                }
            }),
        );
        let upstream_task =
            tokio::spawn(
                async move { axum::serve(upstream_listener, upstream_app).await.unwrap() },
            );

        let public_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let public_address = public_listener.local_addr().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let config = crate::config::Config {
            data_dir: dir.path().to_path_buf(),
            database_path: dir.path().join("federator.db"),
            public_origin: format!("http://{public_address}"),
            ..crate::config::Config::default()
        };
        let (_instance, state) = crate::prepare(&config).await.unwrap();
        state
            .store
            .insert_executor(&ExecutorRecord {
                id: "executor-1".to_string(),
                generation: 1,
                display_name: "Executor".to_string(),
                base_url: format!("http://{upstream_address}"),
                instance_id: "executor-instance".to_string(),
                api_version: "4".to_string(),
                app_server_schema_version: "0.160.0".to_string(),
                enabled: true,
                status: ExecutorStatus::Ready,
                last_error: None,
                last_seen_at: 1,
                created_at: 1,
                updated_at: 1,
            })
            .await
            .unwrap();
        let changes = state.registry_changes.clone();
        let app = crate::primary_router(state, None, config.sandbox_public_url);
        let federator_task =
            tokio::spawn(async move { axum::serve(public_listener, app).await.unwrap() });

        let base_url =
            format!("ws://{public_address}/v1/executors/executor-1/terminals/terminal-1/ws");
        for suffix in ["", "?apiVersion=3"] {
            let mut request =
                tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
                    format!("{base_url}{suffix}"),
                )
                .unwrap();
            request.headers_mut().insert(
                header::ORIGIN,
                format!("http://{public_address}").parse().unwrap(),
            );
            let error = tokio_tungstenite::connect_async(request)
                .await
                .expect_err("missing or stale browser API version is rejected");
            let tokio_tungstenite::tungstenite::Error::Http(response) = error else {
                panic!("expected HTTP WebSocket rejection");
            };
            assert_eq!(response.status(), StatusCode::CONFLICT);
        }
        assert_eq!(upstream_handshakes.load(Ordering::SeqCst), 0);

        let url = format!("{base_url}?apiVersion=4");
        let mut request =
            tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
                url.as_str(),
            )
            .unwrap();
        request.headers_mut().insert(
            header::ORIGIN,
            format!("http://{public_address}").parse().unwrap(),
        );
        let (mut client, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        client
            .send(tokio_tungstenite::tungstenite::Message::Binary(
                b"terminal bytes".to_vec().into(),
            ))
            .await
            .unwrap();
        assert_eq!(
            client.next().await.unwrap().unwrap().into_data(),
            b"terminal bytes".as_slice()
        );
        assert_eq!(upstream_handshakes.load(Ordering::SeqCst), 1);

        let browser_close_url = format!(
            "ws://{public_address}/v1/executors/executor-1/terminals/browser-close/ws?apiVersion=4"
        );
        let mut browser_close_request =
            tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
                browser_close_url,
            )
            .unwrap();
        browser_close_request.headers_mut().insert(
            header::ORIGIN,
            format!("http://{public_address}").parse().unwrap(),
        );
        let (mut browser_close_client, _) = tokio_tungstenite::connect_async(browser_close_request)
            .await
            .unwrap();
        browser_close_client
            .send(tokio_tungstenite::tungstenite::Message::Close(Some(
                tokio_tungstenite::tungstenite::protocol::CloseFrame {
                    code: 4001.into(),
                    reason: "browser reason".into(),
                },
            )))
            .await
            .unwrap();
        let browser_close = timeout(Duration::from_secs(1), browser_close_client.next())
            .await
            .expect("executor close reply reaches the browser")
            .expect("executor sends a close reply")
            .unwrap();
        let tokio_tungstenite::tungstenite::Message::Close(Some(browser_close)) = browser_close
        else {
            panic!("expected browser close reply");
        };
        assert_eq!(u16::from(browser_close.code), 4001);
        assert_eq!(browser_close.reason, "browser reason");

        let executor_close_url = format!(
            "ws://{public_address}/v1/executors/executor-1/terminals/executor-close/ws?apiVersion=4"
        );
        let mut executor_close_request =
            tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
                executor_close_url,
            )
            .unwrap();
        executor_close_request.headers_mut().insert(
            header::ORIGIN,
            format!("http://{public_address}").parse().unwrap(),
        );
        let (mut executor_close_client, _) =
            tokio_tungstenite::connect_async(executor_close_request)
                .await
                .unwrap();
        let executor_close = timeout(Duration::from_secs(1), executor_close_client.next())
            .await
            .expect("executor close reaches the browser")
            .expect("executor sends a close")
            .unwrap();
        let tokio_tungstenite::tungstenite::Message::Close(Some(executor_close)) = executor_close
        else {
            panic!("expected executor close");
        };
        assert_eq!(u16::from(executor_close.code), 4002);
        assert_eq!(executor_close.reason, "executor reason");

        let blocked_url = format!(
            "ws://{public_address}/v1/executors/executor-1/terminals/blocked/ws?apiVersion=4"
        );
        let mut blocked_request =
            tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
                blocked_url.as_str(),
            )
            .unwrap();
        blocked_request.headers_mut().insert(
            header::ORIGIN,
            format!("http://{public_address}").parse().unwrap(),
        );
        let (blocked_client, _) = tokio_tungstenite::connect_async(blocked_request)
            .await
            .unwrap();
        assert_eq!(upstream_handshakes.load(Ordering::SeqCst), 4);
        let (mut blocked_sink, mut blocked_stream) = blocked_client.split();
        let blocked_sender = tokio::spawn(async move {
            let payload = vec![0_u8; 1024 * 1024];
            loop {
                if blocked_sink
                    .send(tokio_tungstenite::tungstenite::Message::Binary(
                        payload.clone().into(),
                    ))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        sleep(Duration::from_millis(50)).await;

        changes
            .send(crate::RegistryChange {
                revision: 2,
                executor_id: "executor-1".to_string(),
                generation: Some(2),
            })
            .unwrap();
        let closed = timeout(Duration::from_secs(1), client.next())
            .await
            .expect("generation change closes the WebSocket");
        assert!(
            closed.is_none()
                || closed
                    .is_some_and(|message| message.is_err()
                        || message.is_ok_and(|message| message.is_close()))
        );
        let blocked_closed = timeout(Duration::from_secs(1), blocked_stream.next())
            .await
            .expect("generation change interrupts a backpressured executor write");
        assert!(
            blocked_closed.is_none()
                || blocked_closed
                    .is_some_and(|message| message.is_err()
                        || message.is_ok_and(|message| message.is_close()))
        );

        blocked_sender.abort();
        federator_task.abort();
        upstream_task.abort();
    }

    #[tokio::test]
    async fn streaming_proxy_client_has_no_five_second_total_deadline() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().route(
            "/events",
            get(|| async {
                let stream = async_stream::stream! {
                    yield Ok::<_, Infallible>("data: first\n\n");
                    sleep(Duration::from_millis(5_100)).await;
                    yield Ok::<_, Infallible>("data: second\n\n");
                };
                Response::builder()
                    .header(header::CONTENT_TYPE, "text/event-stream")
                    .body(Body::from_stream(stream))
                    .unwrap()
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let endpoint = registry::validate_executor_proxy_endpoint(&format!("http://{address}"))
            .await
            .unwrap();
        let response = endpoint
            .client
            .get(format!("http://{address}/events"))
            .send()
            .await
            .unwrap();
        let mut body = response.bytes_stream();
        assert_eq!(body.next().await.unwrap().unwrap(), "data: first\n\n");
        assert_eq!(
            timeout(Duration::from_secs(6), body.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap(),
            "data: second\n\n"
        );
        server.abort();
    }

    #[tokio::test]
    async fn registry_generation_change_cancels_an_open_response_body() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().route(
            "/stream",
            get(|| async {
                let stream = async_stream::stream! {
                    yield Ok::<_, Infallible>("first");
                    sleep(Duration::from_secs(30)).await;
                    yield Ok::<_, Infallible>("second");
                };
                Body::from_stream(stream)
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let upstream = reqwest::Client::new()
            .get(format!("http://{address}/stream"))
            .send()
            .await
            .unwrap();
        let binding = ExecutorRecord {
            id: "executor-1".to_string(),
            generation: 1,
            display_name: "Executor".to_string(),
            base_url: format!("http://{address}"),
            instance_id: "instance-1".to_string(),
            api_version: SUPPORTED_EXECUTOR_API_VERSION.to_string(),
            app_server_schema_version: "0.160.0".to_string(),
            enabled: true,
            status: ExecutorStatus::Ready,
            last_error: None,
            last_seen_at: 1,
            created_at: 1,
            updated_at: 1,
        };
        let (changes, receiver) = tokio::sync::broadcast::channel(4);
        let mut body = generation_fenced_body(upstream, binding, receiver);
        assert_eq!(
            body.frame().await.unwrap().unwrap().into_data().unwrap(),
            "first"
        );
        changes
            .send(crate::RegistryChange {
                revision: 1,
                executor_id: "executor-1".to_string(),
                generation: Some(1),
            })
            .unwrap();
        assert!(timeout(Duration::from_millis(50), body.frame())
            .await
            .is_err());
        changes
            .send(crate::RegistryChange {
                revision: 2,
                executor_id: "executor-1".to_string(),
                generation: Some(2),
            })
            .unwrap();
        let frame = timeout(Duration::from_secs(1), body.frame())
            .await
            .expect("generation change must cancel the body")
            .expect("body reports the generation fence");
        assert!(frame.is_err());
        server.abort();
    }
}
