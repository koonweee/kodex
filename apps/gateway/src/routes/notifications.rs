use axum::{
    extract::{Path, State},
    routing::post,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::{api::AppState, error::ApiResult};

pub fn executor_router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/notifications/deliveries/claim",
            post(claim_notification_deliveries),
        )
        .route(
            "/v1/notifications/deliveries/{delivery_id}/outcome",
            post(complete_notification_delivery),
        )
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NotificationClaimRequest {
    #[serde(default = "default_claim_limit")]
    pub limit: i64,
}

fn default_claim_limit() -> i64 {
    10
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NotificationDeliveryClaim {
    pub delivery_id: String,
    pub claim_id: String,
    pub attempt_count: i64,
    pub payload: crate::notifications::NotificationPayload,
    pub delivered_subscription_ids: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NotificationClaimResponse {
    pub claims: Vec<NotificationDeliveryClaim>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NotificationOutcomeRequest {
    pub claim_id: String,
    #[serde(default)]
    pub delivered_subscription_ids: Vec<String>,
    #[serde(default)]
    pub temporary_failure_count: usize,
    #[serde(default)]
    pub stale_endpoint_count: usize,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NotificationOutcomeResponse {
    pub accepted: bool,
}

#[utoipa::path(post, path = "/v1/notifications/deliveries/claim", request_body = NotificationClaimRequest, responses((status = 200, body = NotificationClaimResponse)))]
pub async fn claim_notification_deliveries(
    State(state): State<AppState>,
    Json(request): Json<NotificationClaimRequest>,
) -> ApiResult<Json<NotificationClaimResponse>> {
    let claims = crate::notifications::claim_federated_deliveries(&state, request.limit).await?;
    Ok(Json(NotificationClaimResponse { claims }))
}

#[utoipa::path(post, path = "/v1/notifications/deliveries/{deliveryId}/outcome", request_body = NotificationOutcomeRequest, responses((status = 200, body = NotificationOutcomeResponse)))]
pub async fn complete_notification_delivery(
    State(state): State<AppState>,
    Path(delivery_id): Path<String>,
    Json(request): Json<NotificationOutcomeRequest>,
) -> ApiResult<Json<NotificationOutcomeResponse>> {
    let accepted = state
        .store
        .complete_federated_notification_claim(
            &delivery_id,
            &request.claim_id,
            &request.delivered_subscription_ids,
            request.temporary_failure_count,
            request.stale_endpoint_count,
            None,
        )
        .await?;
    Ok(Json(NotificationOutcomeResponse { accepted }))
}
