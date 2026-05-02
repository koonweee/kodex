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
        self, RawAppServerResponse, ThreadCommandResponse, ThreadDetailResponse,
        ThreadListResponse, ThreadSummary,
    },
    error::ApiResult,
    store::ThreadRead,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/threads", get(list_threads).post(create_thread))
        .route("/v1/threads/{thread_id}", get(get_thread))
        .route("/v1/threads/{thread_id}/resume", post(resume_thread))
        .route("/v1/threads/{thread_id}/fork", post(fork_thread))
        .route("/v1/threads/{thread_id}/archive", post(archive_thread))
        .route("/v1/threads/{thread_id}/seen", post(mark_thread_seen))
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approvals_reviewer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<String>,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Default, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarkThreadSeenRequest {
    #[serde(default)]
    pub seen_completed_agent_turn_seq: Option<i64>,
}

pub type MarkThreadSeenResponse = ThreadRead;

#[utoipa::path(get, path = "/v1/threads", params(ThreadListQuery), responses((status = 200, body = ThreadListResponse)))]
pub async fn list_threads(
    State(state): State<AppState>,
    Query(query): Query<ThreadListQuery>,
) -> ApiResult<Json<ThreadListResponse>> {
    let cwd = match query.project_id {
        Some(project_id) => Some(state.store.get_project(&project_id).await?.cwd),
        None => None,
    };

    let mut response = app_server_api::client(&state.app_server)
        .thread_list(cwd, query.cursor, query.limit)
        .await?;
    apply_thread_read_state(&state, &mut response.threads).await?;
    Ok(Json(response))
}

#[utoipa::path(post, path = "/v1/threads", request_body = CreateThreadRequest, responses((status = 200, body = ThreadCommandResponse)))]
pub async fn create_thread(
    State(state): State<AppState>,
    Json(request): Json<CreateThreadRequest>,
) -> ApiResult<Json<ThreadCommandResponse>> {
    let project = state.store.get_project(&request.project_id).await?;
    let payload = create_thread_payload(request);
    let mut response = app_server_api::client(&state.app_server)
        .thread_start(project.id, project.cwd, payload)
        .await?;
    apply_thread_read_state(&state, std::slice::from_mut(&mut response.thread)).await?;
    Ok(Json(response))
}

fn create_thread_payload(request: CreateThreadRequest) -> Value {
    let mut payload = request.payload;
    if let Some(model) = request.model {
        payload["model"] = Value::String(model);
    }
    if let Some(service_tier) = request.service_tier {
        payload["serviceTier"] = Value::String(service_tier);
    }
    if let Some(approval_policy) = request.approval_policy {
        payload["approvalPolicy"] = Value::String(approval_policy);
    }
    if let Some(approvals_reviewer) = request.approvals_reviewer {
        payload["approvalsReviewer"] = Value::String(approvals_reviewer);
    }
    if let Some(sandbox) = request.sandbox {
        payload["sandbox"] = Value::String(sandbox);
    }
    payload
}

#[utoipa::path(get, path = "/v1/threads/{threadId}", responses((status = 200, body = ThreadDetailResponse)))]
pub async fn get_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> ApiResult<Json<ThreadDetailResponse>> {
    let mut response = app_server_api::client(&state.app_server)
        .thread_read(thread_id)
        .await?;
    apply_thread_read_state(&state, std::slice::from_mut(&mut response.thread)).await?;
    Ok(Json(response))
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/resume", responses((status = 200, body = ThreadCommandResponse)))]
pub async fn resume_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(payload): Json<Value>,
) -> ApiResult<Json<ThreadCommandResponse>> {
    let mut response = app_server_api::client(&state.app_server)
        .thread_resume(thread_id, payload)
        .await?;
    apply_thread_read_state(&state, std::slice::from_mut(&mut response.thread)).await?;
    Ok(Json(response))
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/fork", responses((status = 200, body = ThreadCommandResponse)))]
pub async fn fork_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(payload): Json<Value>,
) -> ApiResult<Json<ThreadCommandResponse>> {
    let mut response = app_server_api::client(&state.app_server)
        .thread_fork(thread_id, payload)
        .await?;
    apply_thread_read_state(&state, std::slice::from_mut(&mut response.thread)).await?;
    Ok(Json(response))
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

#[utoipa::path(post, path = "/v1/threads/{threadId}/seen", request_body = MarkThreadSeenRequest, responses((status = 200, body = MarkThreadSeenResponse)))]
pub async fn mark_thread_seen(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    request: Option<Json<MarkThreadSeenRequest>>,
) -> ApiResult<Json<MarkThreadSeenResponse>> {
    let request = request.map(|Json(request)| request).unwrap_or_default();
    let snapshot = app_server_api::client(&state.app_server)
        .thread_read(thread_id.clone())
        .await?;
    let last_completed_agent_turn_seq = snapshot.thread.last_completed_agent_turn_seq.unwrap_or(0);
    let requested_seen_seq = request
        .seen_completed_agent_turn_seq
        .unwrap_or(last_completed_agent_turn_seq)
        .max(0);
    let seen_seq = requested_seen_seq.min(last_completed_agent_turn_seq);
    Ok(Json(
        state
            .store
            .mark_thread_seen_completed_agent_turns(&thread_id, seen_seq)
            .await?,
    ))
}

async fn apply_thread_read_state(state: &AppState, threads: &mut [ThreadSummary]) -> ApiResult<()> {
    let thread_ids = threads
        .iter()
        .map(|thread| thread.id.clone())
        .collect::<Vec<_>>();
    let read_states = state.store.thread_read_states(&thread_ids).await?;

    for thread in threads {
        let read_state = read_states.get(&thread.id);
        thread.apply_completed_agent_turn_read_state(
            thread.last_completed_agent_turn_seq,
            read_state
                .map(|state| state.seen_completed_agent_turn_seq)
                .unwrap_or(0),
        );
    }

    Ok(())
}
