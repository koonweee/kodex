use axum::{
    body::Bytes,
    extract::{Path, State},
    routing::post,
    Json, Router,
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

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadViewPresenceResponse {
    pub thread_id: String,
    pub foreground_viewer_count: usize,
    pub viewed: bool,
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/view-presence", request_body = ThreadViewPresenceRequest, responses((status = 200, body = ThreadViewPresenceResponse)))]
pub async fn update_thread_view_presence(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    body: Bytes,
) -> ApiResult<Json<ThreadViewPresenceResponse>> {
    let request: ThreadViewPresenceRequest = serde_json::from_slice(&body)
        .map_err(|error| ApiError::BadRequest(format!("invalid presence request: {error}")))?;
    let client_id = request.client_id.trim();
    if client_id.is_empty() {
        return Err(ApiError::BadRequest("clientId is required".to_string()));
    }
    let snapshot = state
        .thread_presence
        .record_view(client_id, &thread_id, request.visible);
    Ok(Json(ThreadViewPresenceResponse {
        thread_id: snapshot.thread_id,
        foreground_viewer_count: snapshot.foreground_viewer_count,
        viewed: snapshot.viewed,
    }))
}
