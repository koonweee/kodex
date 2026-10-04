use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{patch, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use utoipa::ToSchema;

use super::{
    self_control::{audit_self_control, SelfControlMutationRequest, SelfControlSource},
    thread_sections::{
        self, CreateThreadSectionRequest, MoveThreadToSectionRequest, ThreadSectionResponse,
        UpdateThreadSectionRequest,
    },
};
use crate::{api::AppState, error::ApiResult};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/self-control/thread-sections", post(create_section))
        .route(
            "/v1/self-control/thread-sections/{section_id}",
            patch(update_section).delete(delete_section),
        )
        .route(
            "/v1/self-control/threads/{thread_id}/section",
            post(move_thread),
        )
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlCreateThreadSectionRequest {
    #[serde(flatten)]
    pub section: CreateThreadSectionRequest,
    #[serde(default)]
    pub source: SelfControlSource,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlUpdateThreadSectionRequest {
    #[serde(flatten)]
    pub section: UpdateThreadSectionRequest,
    #[serde(default)]
    pub source: SelfControlSource,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlMoveThreadToSectionRequest {
    #[serde(flatten)]
    pub placement: MoveThreadToSectionRequest,
    #[serde(default)]
    pub source: SelfControlSource,
}

#[utoipa::path(post, path = "/v1/self-control/thread-sections", request_body = SelfControlCreateThreadSectionRequest, responses((status = 201, body = ThreadSectionResponse)))]
pub async fn create_section(
    State(state): State<AppState>,
    Json(request): Json<SelfControlCreateThreadSectionRequest>,
) -> ApiResult<(StatusCode, Json<ThreadSectionResponse>)> {
    let response =
        thread_sections::create_thread_section(State(state.clone()), Json(request.section)).await?;
    audit_self_control(
        &state,
        None,
        None,
        "self_control.thread_section_created",
        json!({"sectionId":response.1.section.id,"source":request.source.to_value()}),
    )
    .await?;
    Ok(response)
}

#[utoipa::path(patch, path = "/v1/self-control/thread-sections/{sectionId}", request_body = SelfControlUpdateThreadSectionRequest, responses((status = 200, body = ThreadSectionResponse)))]
pub async fn update_section(
    State(state): State<AppState>,
    Path(section_id): Path<String>,
    Json(request): Json<SelfControlUpdateThreadSectionRequest>,
) -> ApiResult<Json<ThreadSectionResponse>> {
    let response = thread_sections::update_thread_section(
        State(state.clone()),
        Path(section_id.clone()),
        Json(request.section),
    )
    .await?;
    audit_self_control(
        &state,
        None,
        None,
        "self_control.thread_section_updated",
        json!({"sectionId":section_id,"source":request.source.to_value()}),
    )
    .await?;
    Ok(response)
}

#[utoipa::path(delete, path = "/v1/self-control/thread-sections/{sectionId}", request_body = SelfControlMutationRequest, responses((status = 204)))]
pub async fn delete_section(
    State(state): State<AppState>,
    Path(section_id): Path<String>,
    request: Option<Json<SelfControlMutationRequest>>,
) -> ApiResult<StatusCode> {
    let source = request
        .map(|Json(request)| request.source)
        .unwrap_or_default();
    let status =
        thread_sections::delete_thread_section(State(state.clone()), Path(section_id.clone()))
            .await?;
    audit_self_control(
        &state,
        None,
        None,
        "self_control.thread_section_deleted",
        json!({"sectionId":section_id,"source":source.to_value()}),
    )
    .await?;
    Ok(status)
}

#[utoipa::path(post, path = "/v1/self-control/threads/{threadId}/section", request_body = SelfControlMoveThreadToSectionRequest, responses((status = 204)))]
pub async fn move_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<SelfControlMoveThreadToSectionRequest>,
) -> ApiResult<StatusCode> {
    let status = thread_sections::move_thread_to_section(
        State(state.clone()),
        Path(thread_id.clone()),
        Json(request.placement),
    )
    .await?;
    audit_self_control(
        &state,
        None,
        Some(&thread_id),
        "self_control.thread_section_moved",
        json!({"source":request.source.to_value()}),
    )
    .await?;
    Ok(status)
}
