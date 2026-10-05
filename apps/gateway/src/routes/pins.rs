use super::self_control::{audit_self_control, SelfControlSource};
use crate::{
    api::AppState,
    app_server_api::{self, ThreadListResponse},
    error::ApiResult,
    store::NewEvent,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use rmcp::schemars;
use serde::{Deserialize, Serialize};
use serde_json::json;
use utoipa::{IntoParams, ToSchema};

pub const THREAD_PINS_UPDATED_EVENT: &str = "thread.pins_updated";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/pinned-threads", get(list_pinned_threads))
        .route("/v1/threads/{thread_id}/pin", post(set_thread_pinned))
        .route(
            "/v1/self-control/threads/{thread_id}/pin",
            post(self_control_set_thread_pinned),
        )
}

#[derive(Debug, Deserialize, IntoParams, ToSchema, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PinnedThreadListQuery {
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadPinRequest {
    pub pinned: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_thread_id: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlThreadPinRequest {
    #[serde(flatten)]
    pub pin: ThreadPinRequest,
    #[serde(default)]
    pub source: SelfControlSource,
}

#[utoipa::path(get, path = "/v1/pinned-threads", params(PinnedThreadListQuery), responses((status = 200, body = ThreadListResponse)))]
pub async fn list_pinned_threads(
    State(state): State<AppState>,
    Query(query): Query<PinnedThreadListQuery>,
) -> ApiResult<Json<ThreadListResponse>> {
    Ok(Json(
        pinned_threads_response(&state, query.cursor, query.limit).await?,
    ))
}

pub(crate) async fn pinned_threads_response(
    state: &AppState,
    cursor: Option<String>,
    limit: Option<u32>,
) -> ApiResult<ThreadListResponse> {
    let mut response = app_server_api::client(&state.app_server)
        .pinned_thread_list(cursor, limit)
        .await?;
    super::threads::apply_thread_list_response_state(state, &mut response).await?;
    Ok(response)
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/pin", request_body = ThreadPinRequest, responses((status = 204)))]
pub async fn set_thread_pinned(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<ThreadPinRequest>,
) -> ApiResult<StatusCode> {
    app_server_api::client(&state.app_server)
        .thread_set_pinned(thread_id, request.pinned, request.before_thread_id)
        .await?;
    // Native 0.160.0 has no section notification; clients refill native pin reads.
    let event = state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: None,
            turn_id: None,
            item_id: None,
            kind: THREAD_PINS_UPDATED_EVENT.into(),
            codex_method: None,
            payload: json!({}),
        })
        .await?;
    let _ = state.events.send(event);
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(post, path = "/v1/self-control/threads/{threadId}/pin", request_body = SelfControlThreadPinRequest, responses((status = 204)))]
pub async fn self_control_set_thread_pinned(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<SelfControlThreadPinRequest>,
) -> ApiResult<StatusCode> {
    let status = set_thread_pinned(
        State(state.clone()),
        Path(thread_id.clone()),
        Json(request.pin),
    )
    .await?;
    audit_self_control(
        &state,
        None,
        Some(&thread_id),
        "self_control.thread_pin_updated",
        json!({"source":request.source.to_value()}),
    )
    .await?;
    Ok(status)
}
