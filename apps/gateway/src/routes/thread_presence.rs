use axum::{
    body::Bytes,
    extract::{Path, State},
    http::StatusCode,
    routing::{post, put},
    Router,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::{
    api::AppState,
    error::{ApiError, ApiResult},
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/threads/{thread_id}/view-presence",
            post(update_thread_view_presence),
        )
        .route(
            "/v1/thread-view-presence",
            put(replace_thread_view_presence),
        )
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadViewPresenceRequest {
    pub client_id: String,
    pub visible: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadViewPresenceSnapshotRequest {
    pub client_id: String,
    pub visible_thread_ids: Vec<String>,
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

#[utoipa::path(put, path = "/v1/thread-view-presence", request_body = ThreadViewPresenceSnapshotRequest, responses((status = 204, description = "Thread view presence snapshot replaced")))]
pub async fn replace_thread_view_presence(
    State(state): State<AppState>,
    body: Bytes,
) -> ApiResult<StatusCode> {
    let request: ThreadViewPresenceSnapshotRequest = serde_json::from_slice(&body)
        .map_err(|error| ApiError::BadRequest(format!("invalid presence request: {error}")))?;
    let client_id = request.client_id.trim();
    if client_id.is_empty() {
        return Err(ApiError::BadRequest("clientId is required".to_string()));
    }
    let visible_thread_ids = request
        .visible_thread_ids
        .into_iter()
        .map(|thread_id| thread_id.trim().to_string())
        .collect::<Vec<_>>();
    if visible_thread_ids.iter().any(String::is_empty) {
        return Err(ApiError::BadRequest(
            "visibleThreadIds must not contain empty thread ids".to_string(),
        ));
    }
    state
        .thread_presence
        .replace_views(client_id, visible_thread_ids);
    Ok(StatusCode::NO_CONTENT)
}
