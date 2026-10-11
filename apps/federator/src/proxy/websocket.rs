use axum::{
    extract::{
        ws::{Message as BrowserMessage, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{header, HeaderMap, HeaderValue},
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;

use super::{
    ensure_binding_current, load_routable_binding, ProxyError, API_VERSION_HEADER,
    EXPECTED_INSTANCE_HEADER,
};
use crate::{
    registry::{self, ExecutorRecord, SUPPORTED_EXECUTOR_API_VERSION},
    State as FederatorState,
};

mod handshake;

const WEBSOCKET_SETUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const WEBSOCKET_CLOSE_HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);

pub(super) async fn proxy_terminal_websocket(
    State(state): State<FederatorState>,
    Path((executor_id, terminal_id)): Path<(String, String)>,
    Query(query): Query<TerminalWebSocketQuery>,
    headers: HeaderMap,
    mut ws: WebSocketUpgrade,
) -> Response {
    if query.api_version.as_deref() != Some(crate::trust::FEDERATOR_API_VERSION) {
        return ProxyError::client_update_required().into_response();
    }
    let requested_protocols = match handshake::requested_protocols(&headers) {
        Ok(protocols) => protocols,
        Err(error) => return error.into_response(),
    };
    match connect_terminal_websocket(&state, &executor_id, &terminal_id, requested_protocols).await
    {
        Ok((upstream, binding, changes, selected_protocol)) => {
            if let Some(protocol) = selected_protocol {
                ws.set_selected_protocol(protocol);
            }
            ws.on_upgrade(move |browser| bridge_websockets(browser, upstream, binding, changes))
                .into_response()
        }
        Err(error) => error.into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TerminalWebSocketQuery {
    api_version: Option<String>,
}

type UpstreamWebSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

pub(super) async fn connect_terminal_websocket(
    state: &FederatorState,
    executor_id: &str,
    terminal_id: &str,
    requested_protocols: Vec<String>,
) -> Result<
    (
        UpstreamWebSocket,
        ExecutorRecord,
        tokio::sync::broadcast::Receiver<crate::RegistryChange>,
        Option<HeaderValue>,
    ),
    ProxyError,
> {
    connect_terminal_websocket_with_timeout(
        state,
        executor_id,
        terminal_id,
        requested_protocols,
        WEBSOCKET_SETUP_TIMEOUT,
    )
    .await
}

pub(super) async fn connect_terminal_websocket_with_timeout(
    state: &FederatorState,
    executor_id: &str,
    terminal_id: &str,
    requested_protocols: Vec<String>,
    timeout: std::time::Duration,
) -> Result<
    (
        UpstreamWebSocket,
        ExecutorRecord,
        tokio::sync::broadcast::Receiver<crate::RegistryChange>,
        Option<HeaderValue>,
    ),
    ProxyError,
> {
    tokio::time::timeout(
        timeout,
        connect_terminal_websocket_inner(state, executor_id, terminal_id, requested_protocols),
    )
    .await
    .map_err(|_| ProxyError::upstream("Executor WebSocket setup timed out."))?
}

async fn connect_terminal_websocket_inner(
    state: &FederatorState,
    executor_id: &str,
    terminal_id: &str,
    requested_protocols: Vec<String>,
) -> Result<
    (
        UpstreamWebSocket,
        ExecutorRecord,
        tokio::sync::broadcast::Receiver<crate::RegistryChange>,
        Option<HeaderValue>,
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
    if !requested_protocols.is_empty() {
        request.headers_mut().insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_str(&requested_protocols.join(", "))
                .map_err(|_| ProxyError::upstream("Browser offered an invalid subprotocol."))?,
        );
    }
    let stream = handshake::wrap_executor_stream(tcp, &url).await?;
    let (upstream, response) =
        handshake::perform_executor_websocket_handshake(stream, request, &requested_protocols)
            .await?;
    if response
        .headers()
        .get(API_VERSION_HEADER)
        .is_none_or(|version| version != SUPPORTED_EXECUTOR_API_VERSION)
    {
        return Err(ProxyError::incompatible(
            "Executor WebSocket did not confirm the required API version.",
        ));
    }
    let selected_protocol =
        handshake::selected_subprotocol(response.headers(), &requested_protocols)?;
    ensure_binding_current(state, &binding).await?;
    Ok((upstream, binding, changes, selected_protocol))
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

pub(super) fn browser_to_upstream(
    message: BrowserMessage,
) -> tokio_tungstenite::tungstenite::Message {
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

pub(super) fn upstream_to_browser(
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
