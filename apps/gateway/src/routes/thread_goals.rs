use axum::{
    extract::{Path, State},
    routing::get,
    Json, Router,
};
use serde::Serialize;
use utoipa::ToSchema;

use crate::{
    api::AppState,
    app_server_api::{
        self, ThreadGoalClearResponse, ThreadGoalGetResponse, ThreadGoalSetRequest,
        ThreadGoalSetResponse,
    },
    error::ApiResult,
};

pub const THREAD_GOAL_CHANGED_EVENT: &str = "thread.goal_changed";

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/v1/threads/{thread_id}/goal",
        get(get_thread_goal)
            .patch(set_thread_goal)
            .delete(clear_thread_goal),
    )
}

/// Refill the authoritative native goal; this marker carries no goal snapshot.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGoalChanged {
    pub thread_id: String,
}

#[utoipa::path(get, path = "/v1/threads/{threadId}/goal", responses((status = 200, body = ThreadGoalGetResponse)))]
pub async fn get_thread_goal(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> ApiResult<Json<ThreadGoalGetResponse>> {
    Ok(Json(
        app_server_api::client(&state.app_server)
            .thread_goal_get(thread_id)
            .await?,
    ))
}

#[utoipa::path(patch, path = "/v1/threads/{threadId}/goal", request_body = ThreadGoalSetRequest, responses((status = 200, body = ThreadGoalSetResponse)))]
pub async fn set_thread_goal(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<ThreadGoalSetRequest>,
) -> ApiResult<Json<ThreadGoalSetResponse>> {
    Ok(Json(
        app_server_api::client(&state.app_server)
            .thread_goal_set(thread_id, request)
            .await?,
    ))
}

#[utoipa::path(delete, path = "/v1/threads/{threadId}/goal", responses((status = 200, body = ThreadGoalClearResponse)))]
pub async fn clear_thread_goal(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> ApiResult<Json<ThreadGoalClearResponse>> {
    Ok(Json(
        app_server_api::client(&state.app_server)
            .thread_goal_clear(thread_id)
            .await?,
    ))
}
