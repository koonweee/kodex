use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{delete, get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::{
    api::AppState,
    error::{ApiError, ApiResult},
    store::{NewPushSubscription, PushSubscription},
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/notifications/status", get(notification_status))
        .route(
            "/v1/notifications/subscriptions",
            post(upsert_push_subscription),
        )
        .route(
            "/v1/notifications/subscriptions/{subscription_id}",
            delete(delete_push_subscription),
        )
        .route(
            "/v1/notifications/subscription/current",
            get(current_push_subscription).delete(delete_current_push_subscription),
        )
        .route("/v1/notifications/test", post(test_notification))
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NotificationStatusResponse {
    pub configured: bool,
    pub vapid_public_key: Option<String>,
    pub subscriptions_enabled: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PushSubscriptionKeysRequest {
    pub p256dh: String,
    pub auth: String,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PushSubscriptionUpsertRequest {
    pub endpoint: String,
    pub keys: PushSubscriptionKeysRequest,
    pub user_agent: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PushSubscriptionResponse {
    pub id: String,
    pub endpoint: String,
    pub user_agent: Option<String>,
    pub enabled: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl From<PushSubscription> for PushSubscriptionResponse {
    fn from(subscription: PushSubscription) -> Self {
        Self {
            id: subscription.id,
            endpoint: subscription.endpoint,
            user_agent: subscription.user_agent,
            enabled: subscription.enabled,
            created_at: subscription.created_at,
            updated_at: subscription.updated_at,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PushSubscriptionUpsertResponse {
    pub subscription: PushSubscriptionResponse,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PushSubscriptionDeleteResponse {
    pub subscription: Option<PushSubscriptionResponse>,
}

#[derive(Debug, Serialize, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CurrentPushSubscriptionQuery {
    pub endpoint: String,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CurrentPushSubscriptionResponse {
    pub configured: bool,
    pub subscribed: bool,
    pub subscription: Option<PushSubscriptionResponse>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TestNotificationResponse {
    pub configured: bool,
    pub active_subscription_count: usize,
    pub enqueued: bool,
    pub delivery_ids: Vec<String>,
}

#[utoipa::path(get, path = "/v1/notifications/status", responses((status = 200, body = NotificationStatusResponse)))]
pub async fn notification_status(
    State(state): State<AppState>,
) -> ApiResult<Json<NotificationStatusResponse>> {
    let vapid_public_key = state.config.notifications.vapid_public_key.clone();
    let configured = notifications_configured(&state);
    Ok(Json(NotificationStatusResponse {
        configured,
        vapid_public_key,
        subscriptions_enabled: configured,
    }))
}

#[utoipa::path(post, path = "/v1/notifications/subscriptions", request_body = PushSubscriptionUpsertRequest, responses((status = 201, body = PushSubscriptionUpsertResponse)))]
pub async fn upsert_push_subscription(
    State(state): State<AppState>,
    Json(request): Json<PushSubscriptionUpsertRequest>,
) -> ApiResult<(StatusCode, Json<PushSubscriptionUpsertResponse>)> {
    let endpoint = request.endpoint.trim().to_string();
    let p256dh = request.keys.p256dh.trim().to_string();
    let auth = request.keys.auth.trim().to_string();
    if endpoint.is_empty() {
        return Err(ApiError::BadRequest("endpoint is required".to_string()));
    }
    if p256dh.is_empty() || auth.is_empty() {
        return Err(ApiError::BadRequest(
            "subscription keys are required".to_string(),
        ));
    }
    let subscription = state
        .store
        .upsert_push_subscription(NewPushSubscription {
            endpoint,
            p256dh,
            auth,
            user_agent: request.user_agent.filter(|value| !value.trim().is_empty()),
        })
        .await?;
    Ok((
        StatusCode::CREATED,
        Json(PushSubscriptionUpsertResponse {
            subscription: subscription.into(),
        }),
    ))
}

#[utoipa::path(delete, path = "/v1/notifications/subscriptions/{subscriptionId}", responses((status = 200, body = PushSubscriptionDeleteResponse)))]
pub async fn delete_push_subscription(
    State(state): State<AppState>,
    Path(subscription_id): Path<String>,
) -> ApiResult<Json<PushSubscriptionDeleteResponse>> {
    let subscription = state
        .store
        .disable_push_subscription(&subscription_id)
        .await?;
    Ok(Json(PushSubscriptionDeleteResponse {
        subscription: subscription.map(Into::into),
    }))
}

#[utoipa::path(get, path = "/v1/notifications/subscription/current", params(CurrentPushSubscriptionQuery), responses((status = 200, body = CurrentPushSubscriptionResponse)))]
pub async fn current_push_subscription(
    State(state): State<AppState>,
    Query(query): Query<CurrentPushSubscriptionQuery>,
) -> ApiResult<Json<CurrentPushSubscriptionResponse>> {
    let endpoint = validate_endpoint(query.endpoint)?;
    let status = state
        .store
        .get_push_subscription_status_by_endpoint(&endpoint)
        .await?;
    Ok(Json(CurrentPushSubscriptionResponse {
        configured: notifications_configured(&state),
        subscribed: status.subscribed,
        subscription: status.subscription.map(Into::into),
    }))
}

#[utoipa::path(delete, path = "/v1/notifications/subscription/current", params(CurrentPushSubscriptionQuery), responses((status = 200, body = CurrentPushSubscriptionResponse)))]
pub async fn delete_current_push_subscription(
    State(state): State<AppState>,
    Query(query): Query<CurrentPushSubscriptionQuery>,
) -> ApiResult<Json<CurrentPushSubscriptionResponse>> {
    let endpoint = validate_endpoint(query.endpoint)?;
    let subscription = state
        .store
        .disable_push_subscription_by_endpoint(&endpoint)
        .await?;
    Ok(Json(CurrentPushSubscriptionResponse {
        configured: notifications_configured(&state),
        subscribed: false,
        subscription: subscription.map(Into::into),
    }))
}

#[utoipa::path(post, path = "/v1/notifications/test", responses((status = 200, body = TestNotificationResponse)))]
pub async fn test_notification(
    State(state): State<AppState>,
) -> ApiResult<Json<TestNotificationResponse>> {
    let configured = notifications_configured(&state);
    if !configured {
        return Ok(Json(TestNotificationResponse {
            configured,
            active_subscription_count: 0,
            enqueued: false,
            delivery_ids: Vec::new(),
        }));
    }
    let active_subscription_count = state.store.list_enabled_push_subscriptions().await?.len();
    if active_subscription_count == 0 {
        return Ok(Json(TestNotificationResponse {
            configured,
            active_subscription_count,
            enqueued: false,
            delivery_ids: Vec::new(),
        }));
    }
    let delivery = state
        .notifications
        .enqueue_test_notification(&state)
        .await?;
    Ok(Json(TestNotificationResponse {
        configured,
        active_subscription_count,
        enqueued: true,
        delivery_ids: vec![delivery.id],
    }))
}

fn validate_endpoint(endpoint: String) -> ApiResult<String> {
    validate_non_empty(endpoint, "endpoint")
}

fn validate_non_empty(value: String, field: &str) -> ApiResult<String> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(ApiError::BadRequest(format!("{field} is required")));
    }
    Ok(value)
}

fn notifications_configured(state: &AppState) -> bool {
    state.config.notifications.vapid_public_key.is_some()
        && state.config.notifications.vapid_private_key.is_some()
        && state.config.notifications.vapid_subject.is_some()
}
