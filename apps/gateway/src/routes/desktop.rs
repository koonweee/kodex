use crate::api::AppState;
use axum::{
    extract::{ws::WebSocketUpgrade, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};

pub fn router() -> Router<AppState> {
    Router::new().route("/v1/desktop/ws", get(connect))
}

// Vite and Tailscale Serve retain the browser-facing Host. TLS may terminate
// outside the gateway, so use the Origin scheme with that exact host/port.
// No wildcard origins or forwarded-header fallback authorize a connection.
fn allowed_origin(headers: &HeaderMap) -> bool {
    if headers.get_all("origin").iter().count() != 1 || headers.get_all("host").iter().count() != 1
    {
        return false;
    }
    let Some(origin) = headers
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| reqwest::Url::parse(v).ok())
    else {
        return false;
    };
    if !matches!(origin.scheme(), "http" | "https")
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.path() != "/"
        || origin.query().is_some()
        || origin.fragment().is_some()
    {
        return false;
    }
    let Some(host) = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .filter(|v| {
            !v.is_empty()
                && v.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b".-:[]".contains(&b))
        })
    else {
        return false;
    };
    reqwest::Url::parse(&format!("{}://{host}", origin.scheme()))
        .is_ok_and(|served| served.origin() == origin.origin())
}

#[utoipa::path(get, path="/v1/desktop/ws", responses(
    (status=101, description="Authenticated local desktop RFB stream. Close 4400 is permanent; 4500 is retryable. Close reason is a JSON DesktopFailure enum value."),
    (status=403, description="Missing or mismatched WebSocket Origin")
))]
pub async fn connect(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, StatusCode> {
    if !allowed_origin(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    let config = state.config.desktop.clone();
    Ok(ws
        .max_message_size(1024 * 1024)
        .max_frame_size(1024 * 1024)
        .write_buffer_size(32 * 1024)
        .max_write_buffer_size(128 * 1024)
        .on_upgrade(move |socket| crate::desktop::socket::serve(socket, config))
        .into_response())
}
