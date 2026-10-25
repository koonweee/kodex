use crate::{
    api::AppState,
    error::{ApiError, ApiErrorBody},
};
use axum::{
    extract::{ws::WebSocketUpgrade, DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};

pub fn router() -> Router<AppState> {
    Router::new().route("/v1/desktop/ws", get(connect)).route(
        "/v1/desktop/clipboard",
        post(write_clipboard).layer(DefaultBodyLimit::max(512 * 1024)),
    )
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

/// Explicit text for the gateway Mac's global clipboard. At most 64 KiB UTF-8.
#[derive(serde::Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct DesktopClipboardRequest {
    pub text: String,
}

#[utoipa::path(post, path="/v1/desktop/clipboard", request_body=DesktopClipboardRequest, responses(
    (status=204, description="Text written to the Mac clipboard; no key was sent"),
    (status=400, description="Empty or oversized UTF-8 text", body=ApiErrorBody),
    (status=403, description="Origin mismatch, unsupported platform or Desktop not configured"),
    (status=413, description="Encoded request body too large"),
    (status=502, description="Bounded native clipboard write failed", body=ApiErrorBody)
))]
pub async fn write_clipboard(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<DesktopClipboardRequest>,
) -> Response {
    let text = zeroize::Zeroizing::new(request.text);
    clipboard_response(
        &headers,
        &state.config.desktop,
        cfg!(target_os = "macos"),
        text,
        crate::desktop::clipboard::write,
    )
    .await
}

pub(super) async fn clipboard_response<F, Fut>(
    headers: &HeaderMap,
    config: &crate::desktop::DesktopConfig,
    supported: bool,
    text: zeroize::Zeroizing<String>,
    write: F,
) -> Response
where
    F: FnOnce(zeroize::Zeroizing<String>) -> Fut,
    Fut: std::future::Future<Output = Result<(), ApiError>>,
{
    if !allowed_origin(headers) || !supported || config.password().is_err() {
        return StatusCode::FORBIDDEN.into_response();
    }
    match write(text).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => error.into_response(),
    }
}
