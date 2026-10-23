use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use utoipa::ToSchema;

use crate::{
    api::AppState,
    app_server_api::{self, ActivePermissionProfile, ThreadSettingsUpdateRequest},
    error::{ApiError, ApiResult},
};

pub const THREAD_SETTINGS_UPDATED_EVENT: &str = "thread.settings_updated";

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/v1/threads/{thread_id}/settings",
        get(get_thread_settings).patch(update_thread_settings),
    )
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSettingsResponse {
    pub model: String,
    pub effort: Option<String>,
    pub service_tier: Option<String>,
    pub active_permission_profile: Option<ActivePermissionProfile>,
}

/// An invalidation marker, never a replayable settings snapshot.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSettingsUpdated {
    pub thread_id: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ThreadSettingsUpdateResponse {}

#[utoipa::path(get, path = "/v1/threads/{threadId}/settings", responses((status = 200, body = ThreadSettingsResponse)))]
pub async fn get_thread_settings(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> ApiResult<Json<ThreadSettingsResponse>> {
    if let Some(entry) = state.side_threads.get_by_child(&thread_id) {
        return Ok(Json(ThreadSettingsResponse {
            model: entry.thread.model.ok_or_else(|| {
                ApiError::BadGateway("native side-chat metadata missing model".into())
            })?,
            effort: entry.thread.reasoning_effort,
            service_tier: entry.thread.service_tier,
            active_permission_profile: entry.thread.active_permission_profile,
        }));
    }
    if state.side_threads.is_closed_child(&thread_id) {
        return Err(ApiError::NotFound("side chat expired".into()));
    }
    // Resume without overrides reads the full native effective session settings.
    // thread/read only exposes model and effort; it cannot answer this query.
    let response = app_server_api::client(&state.app_server)
        .thread_resume(thread_id, json!({}))
        .await?;
    Ok(Json(ThreadSettingsResponse {
        model: response
            .model
            .ok_or_else(|| ApiError::BadGateway("thread/resume response missing model".into()))?,
        effort: response.reasoning_effort,
        service_tier: response.service_tier,
        active_permission_profile: response.active_permission_profile,
    }))
}

#[utoipa::path(patch, path = "/v1/threads/{threadId}/settings", request_body = ThreadSettingsUpdateRequest, responses((status = 202, description = "Native update queued; application is reported by thread.settings_updated", body = ThreadSettingsUpdateResponse)))]
pub async fn update_thread_settings(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<ThreadSettingsUpdateRequest>,
) -> ApiResult<(StatusCode, Json<ThreadSettingsUpdateResponse>)> {
    request.validate()?;
    if state.side_threads.is_closed_child(&thread_id) {
        return Err(ApiError::NotFound("side chat expired".into()));
    }
    app_server_api::client(&state.app_server)
        .thread_update_settings(thread_id, request)
        .await?;
    Ok((StatusCode::ACCEPTED, Json(ThreadSettingsUpdateResponse {})))
}
