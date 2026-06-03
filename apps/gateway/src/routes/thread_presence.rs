use axum::{
    body::Bytes,
    extract::{Path, State},
    http::StatusCode,
    routing::post,
    Router,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::{
    api::AppState,
    error::{ApiError, ApiResult},
};

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/v1/threads/{thread_id}/view-presence",
        post(update_thread_view_presence),
    )
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadViewPresenceRequest {
    pub client_id: String,
    pub visible: bool,
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/view-presence", request_body = ThreadViewPresenceRequest, responses((status = 204, description = "Thread view presence updated")))]
pub async fn update_thread_view_presence(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    body: Bytes,
) -> ApiResult<StatusCode> {
    let request: ThreadViewPresenceRequest = serde_json::from_slice(&body)
        .map_err(|error| ApiError::BadRequest(format!("invalid presence request: {error}")))?;
    let client_id = request.client_id.trim();
    if client_id.is_empty() {
        return Err(ApiError::BadRequest("clientId is required".to_string()));
    }
    state
        .thread_presence
        .record_view(client_id, &thread_id, request.visible);
    Ok(StatusCode::NO_CONTENT)
}
