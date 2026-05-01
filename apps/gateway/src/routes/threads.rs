use axum::{
    extract::{Path, Query, State},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::{IntoParams, ToSchema};

use crate::{
    api::AppState,
    app_server_api::{
        self, RawAppServerResponse, ThreadCommandResponse, ThreadDetailResponse, ThreadListResponse,
    },
    error::ApiResult,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/threads", get(list_threads).post(create_thread))
        .route("/v1/threads/{thread_id}", get(get_thread))
        .route("/v1/threads/{thread_id}/resume", post(resume_thread))
        .route("/v1/threads/{thread_id}/fork", post(fork_thread))
        .route("/v1/threads/{thread_id}/archive", post(archive_thread))
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListQuery {
    pub project_id: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateThreadRequest {
    pub project_id: String,
    #[serde(default)]
    pub payload: Value,
}

#[utoipa::path(get, path = "/v1/threads", params(ThreadListQuery), responses((status = 200, body = ThreadListResponse)))]
pub async fn list_threads(
    State(state): State<AppState>,
    Query(query): Query<ThreadListQuery>,
) -> ApiResult<Json<ThreadListResponse>> {
    let cwd = match query.project_id {
        Some(project_id) => Some(state.store.get_project(&project_id).await?.cwd),
        None => None,
    };

    Ok(Json(
        app_server_api::client(&state.app_server)
            .thread_list(cwd, query.cursor, query.limit)
            .await?,
    ))
}

#[utoipa::path(post, path = "/v1/threads", request_body = CreateThreadRequest, responses((status = 200, body = ThreadCommandResponse)))]
pub async fn create_thread(
    State(state): State<AppState>,
    Json(request): Json<CreateThreadRequest>,
) -> ApiResult<Json<ThreadCommandResponse>> {
    let project = state.store.get_project(&request.project_id).await?;
    Ok(Json(
        app_server_api::client(&state.app_server)
            .thread_start(project.id, project.cwd, request.payload)
            .await?,
    ))
}

#[utoipa::path(get, path = "/v1/threads/{threadId}", responses((status = 200, body = ThreadDetailResponse)))]
pub async fn get_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> ApiResult<Json<ThreadDetailResponse>> {
    Ok(Json(
        app_server_api::client(&state.app_server)
            .thread_read(thread_id)
            .await?,
    ))
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/resume", responses((status = 200, body = ThreadCommandResponse)))]
pub async fn resume_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(payload): Json<Value>,
) -> ApiResult<Json<ThreadCommandResponse>> {
    Ok(Json(
        app_server_api::client(&state.app_server)
            .thread_resume(thread_id, payload)
            .await?,
    ))
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/fork", responses((status = 200, body = ThreadCommandResponse)))]
pub async fn fork_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(payload): Json<Value>,
) -> ApiResult<Json<ThreadCommandResponse>> {
    Ok(Json(
        app_server_api::client(&state.app_server)
            .thread_fork(thread_id, payload)
            .await?,
    ))
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/archive", responses((status = 200, body = RawAppServerResponse)))]
pub async fn archive_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> ApiResult<Json<RawAppServerResponse>> {
    Ok(Json(
        app_server_api::client(&state.app_server)
            .thread_archive(thread_id)
            .await?,
    ))
}
