use axum::http::{header, HeaderMap, HeaderValue, StatusCode};

use super::super::ProxyError;
use super::UpstreamWebSocket;

pub(super) fn requested_protocols(headers: &HeaderMap) -> Result<Vec<String>, ProxyError> {
    let mut protocols = Vec::new();
    for value in headers.get_all(header::SEC_WEBSOCKET_PROTOCOL) {
        let value = value
            .to_str()
            .map_err(|_| ProxyError::upstream("Browser offered an invalid subprotocol."))?;
        for protocol in value.split(',').map(str::trim) {
            if !is_http_token(protocol) {
                return Err(ProxyError::upstream(
                    "Browser offered an invalid subprotocol.",
                ));
            }
            protocols.push(protocol.to_string());
        }
    }
    Ok(protocols)
}

fn is_http_token(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
}

pub(super) async fn wrap_executor_stream(
    tcp: tokio::net::TcpStream,
    url: &url::Url,
) -> Result<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>, ProxyError> {
    if url.scheme() == "ws" {
        return Ok(tokio_tungstenite::MaybeTlsStream::Plain(tcp));
    }
    let host = url
        .host_str()
        .ok_or_else(|| ProxyError::internal("executor WebSocket URL has no host"))?;
    let server_name = rustls::pki_types::ServerName::try_from(host.to_string())
        .map_err(|_| ProxyError::upstream("Executor WebSocket host is invalid for TLS."))?;
    let root_store =
        rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = rustls::ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth();
    let stream = tokio_rustls::TlsConnector::from(std::sync::Arc::new(config))
        .connect(server_name, tcp)
        .await
        .map_err(|error| ProxyError::upstream(format!("Executor WebSocket TLS failed: {error}")))?;
    Ok(tokio_tungstenite::MaybeTlsStream::Rustls(stream))
}

pub(super) async fn perform_executor_websocket_handshake(
    mut stream: tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    request: tokio_tungstenite::tungstenite::handshake::client::Request,
    requested_protocols: &[String],
) -> Result<
    (
        UpstreamWebSocket,
        tokio_tungstenite::tungstenite::handshake::client::Response,
    ),
    ProxyError,
> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_tungstenite::tungstenite::handshake::machine::TryParse;

    let (wire_request, key) =
        tokio_tungstenite::tungstenite::handshake::client::generate_request(request)
            .map_err(|error| ProxyError::upstream(format!("Invalid WebSocket request: {error}")))?;
    stream.write_all(&wire_request).await.map_err(|error| {
        ProxyError::upstream(format!("Executor WebSocket write failed: {error}"))
    })?;
    stream.flush().await.map_err(|error| {
        ProxyError::upstream(format!("Executor WebSocket flush failed: {error}"))
    })?;

    let mut received = Vec::with_capacity(2048);
    let (consumed, response) = loop {
        if received.len() >= 64 * 1024 {
            return Err(ProxyError::upstream(
                "Executor WebSocket handshake headers were too large.",
            ));
        }
        let read = stream.read_buf(&mut received).await.map_err(|error| {
            ProxyError::upstream(format!("Executor WebSocket read failed: {error}"))
        })?;
        if read == 0 {
            return Err(ProxyError::upstream(
                "Executor closed during the WebSocket handshake.",
            ));
        }
        match tokio_tungstenite::tungstenite::handshake::client::Response::try_parse(&received)
            .map_err(|error| {
                ProxyError::upstream(format!("Invalid executor WebSocket response: {error}"))
            })? {
            Some(parsed) => break parsed,
            None => continue,
        }
    };
    validate_websocket_response(&response, &key, requested_protocols)?;
    let tail = received.split_off(consumed);
    let websocket = tokio_tungstenite::WebSocketStream::from_partially_read(
        stream,
        tail,
        tokio_tungstenite::tungstenite::protocol::Role::Client,
        None,
    )
    .await;
    Ok((websocket, response))
}

fn validate_websocket_response(
    response: &tokio_tungstenite::tungstenite::handshake::client::Response,
    key: &str,
    requested_protocols: &[String],
) -> Result<(), ProxyError> {
    if response.status() != StatusCode::SWITCHING_PROTOCOLS
        || !header_has_token(response.headers(), header::UPGRADE, "websocket")
        || !header_has_token(response.headers(), header::CONNECTION, "upgrade")
    {
        return Err(ProxyError::upstream(
            "Executor returned an invalid WebSocket upgrade response.",
        ));
    }
    let expected_accept =
        tokio_tungstenite::tungstenite::handshake::derive_accept_key(key.as_bytes());
    if response
        .headers()
        .get(header::SEC_WEBSOCKET_ACCEPT)
        .is_none_or(|value| value.as_bytes() != expected_accept.as_bytes())
    {
        return Err(ProxyError::upstream(
            "Executor returned an invalid WebSocket accept key.",
        ));
    }
    if response
        .headers()
        .contains_key(header::SEC_WEBSOCKET_EXTENSIONS)
    {
        return Err(ProxyError::upstream(
            "Executor selected an unsupported WebSocket extension.",
        ));
    }
    selected_subprotocol(response.headers(), requested_protocols)?;
    Ok(())
}

fn header_has_token(headers: &HeaderMap, name: header::HeaderName, expected: &str) -> bool {
    headers.get_all(name).iter().any(|value| {
        value.to_str().is_ok_and(|value| {
            value
                .split(',')
                .any(|token| token.trim().eq_ignore_ascii_case(expected))
        })
    })
}

pub(super) fn selected_subprotocol(
    headers: &HeaderMap,
    requested_protocols: &[String],
) -> Result<Option<HeaderValue>, ProxyError> {
    let mut values = headers.get_all(header::SEC_WEBSOCKET_PROTOCOL).iter();
    let Some(selected) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(ProxyError::upstream(
            "Executor selected multiple WebSocket subprotocols.",
        ));
    }
    let selected_text = selected
        .to_str()
        .map_err(|_| ProxyError::upstream("Executor selected an invalid WebSocket subprotocol."))?;
    if !is_http_token(selected_text)
        || !requested_protocols
            .iter()
            .any(|offered| offered == selected_text)
    {
        return Err(ProxyError::upstream(
            "Executor selected a WebSocket subprotocol the browser did not offer.",
        ));
    }
    Ok(Some(selected.clone()))
}
