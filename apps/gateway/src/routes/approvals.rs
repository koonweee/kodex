use axum::{
    extract::{Path, Query, State},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::{IntoParams, ToSchema};

use crate::{api::AppState, error::ApiResult, store::Approval};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/approvals", get(list_approvals))
        .route("/v1/approvals/{approval_id}", get(get_approval))
        .route(
            "/v1/approvals/{approval_id}/decision",
            post(decide_approval),
        )
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalListQuery {
    pub status: Option<String>,
    pub thread_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalListResponse {
    pub approvals: Vec<Approval>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalDecisionRequest {
    pub decision: Value,
}

#[utoipa::path(get, path = "/v1/approvals", params(ApprovalListQuery), responses((status = 200, body = ApprovalListResponse)))]
pub async fn list_approvals(
    State(state): State<AppState>,
    Query(query): Query<ApprovalListQuery>,
) -> ApiResult<Json<ApprovalListResponse>> {
    let approvals = state
        .store
        .list_approvals(query.status, query.thread_id)
        .await?;
    Ok(Json(ApprovalListResponse { approvals }))
}

#[utoipa::path(get, path = "/v1/approvals/{approvalId}", responses((status = 200, body = Approval)))]
pub async fn get_approval(
    State(state): State<AppState>,
    Path(approval_id): Path<String>,
) -> ApiResult<Json<Approval>> {
    Ok(Json(state.store.get_approval(&approval_id).await?))
}

#[utoipa::path(post, path = "/v1/approvals/{approvalId}/decision", request_body = ApprovalDecisionRequest, responses((status = 200, body = Approval)))]
pub async fn decide_approval(
    State(state): State<AppState>,
    Path(approval_id): Path<String>,
    Json(request): Json<ApprovalDecisionRequest>,
) -> ApiResult<Json<Approval>> {
    Ok(Json(
        crate::approvals::decide_approval(&state, &approval_id, request.decision).await?,
    ))
}
