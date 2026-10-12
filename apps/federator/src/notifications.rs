use std::{collections::HashSet, sync::Arc, time::Duration};

use async_trait::async_trait;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{delete, get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;
use web_push::{
    ContentEncoding, IsahcWebPushClient, SubscriptionInfo, VapidSignatureBuilder, WebPushClient,
    WebPushError, WebPushMessageBuilder,
};

use crate::{config::NotificationsConfig, registry::ExecutorStatus, State as FederatorState};

const CLAIM_LIMIT: i64 = 10;
const MAX_ATTEMPTS: i64 = 3;
const STALE_AFTER_SECONDS: i64 = 300;
#[cfg(not(test))]
const SOURCE_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(test)]
const SOURCE_REQUEST_TIMEOUT: Duration = Duration::from_millis(100);
#[cfg(not(test))]
const PROVIDER_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
#[cfg(test)]
const PROVIDER_REQUEST_TIMEOUT: Duration = Duration::from_millis(100);

#[derive(Debug, Clone)]
pub struct PushSubscription {
    pub id: String,
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    pub user_agent: Option<String>,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPayload {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executor_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    pub route: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub badge_count: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_revision: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PushDeliveryOutcome {
    Sent,
    StaleEndpoint,
    TemporaryFailure,
}

#[async_trait]
pub trait PushSender: Send + Sync {
    async fn send(
        &self,
        subscription: &PushSubscription,
        payload: &NotificationPayload,
    ) -> PushDeliveryOutcome;
}

struct NoopPushSender;

#[async_trait]
impl PushSender for NoopPushSender {
    async fn send(&self, _: &PushSubscription, _: &NotificationPayload) -> PushDeliveryOutcome {
        PushDeliveryOutcome::Sent
    }
}

struct WebPushSenderImpl {
    client: IsahcWebPushClient,
    private_key: String,
    subject: String,
}

impl WebPushSenderImpl {
    fn new(private_key: String, subject: String) -> Result<Self, WebPushError> {
        Ok(Self {
            client: IsahcWebPushClient::new()?,
            private_key,
            subject,
        })
    }
}

#[async_trait]
impl PushSender for WebPushSenderImpl {
    async fn send(
        &self,
        subscription: &PushSubscription,
        payload: &NotificationPayload,
    ) -> PushDeliveryOutcome {
        let result = async {
            let info = SubscriptionInfo::new(
                subscription.endpoint.as_str(),
                subscription.p256dh.as_str(),
                subscription.auth.as_str(),
            );
            let mut signature = VapidSignatureBuilder::from_base64(&self.private_key, &info)?;
            signature.add_claim("sub", self.subject.as_str());
            let signature = signature.build()?;
            let content = serde_json::to_vec(payload).map_err(|_| WebPushError::InvalidResponse)?;
            let mut message = WebPushMessageBuilder::new(&info);
            message.set_payload(ContentEncoding::Aes128Gcm, &content);
            message.set_vapid_signature(signature);
            self.client.send(message.build()?).await
        }
        .await;
        match result {
            Ok(()) => PushDeliveryOutcome::Sent,
            Err(error) if stale_endpoint_error(&error) => PushDeliveryOutcome::StaleEndpoint,
            Err(_) => PushDeliveryOutcome::TemporaryFailure,
        }
    }
}

fn stale_endpoint_error(error: &WebPushError) -> bool {
    matches!(
        error,
        WebPushError::EndpointNotFound(_) | WebPushError::EndpointNotValid(_)
    )
}

#[derive(Clone)]
pub struct NotificationService {
    sender: Arc<dyn PushSender>,
    badge_probe_locks: Arc<
        tokio::sync::Mutex<
            std::collections::HashMap<String, std::sync::Weak<tokio::sync::Mutex<()>>>,
        >,
    >,
}

impl NotificationService {
    pub fn from_config(config: &NotificationsConfig) -> Self {
        let sender: Arc<dyn PushSender> = match (
            config.vapid_private_key.clone(),
            config.vapid_subject.clone(),
        ) {
            (Some(key), Some(subject)) => WebPushSenderImpl::new(key, subject)
                .map(|sender| Arc::new(sender) as Arc<dyn PushSender>)
                .unwrap_or_else(|_| Arc::new(NoopPushSender)),
            _ => Arc::new(NoopPushSender),
        };
        Self {
            sender,
            badge_probe_locks: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        }
    }

    #[cfg(test)]
    pub fn new(sender: Arc<dyn PushSender>) -> Self {
        Self {
            sender,
            badge_probe_locks: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        }
    }

    async fn badge_probe_lock(&self, executor_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.badge_probe_locks.lock().await;
        if let Some(lock) = locks.get(executor_id).and_then(std::sync::Weak::upgrade) {
            return lock;
        }
        locks.retain(|_, lock| lock.strong_count() > 0);
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        locks.insert(executor_id.to_string(), Arc::downgrade(&lock));
        lock
    }

    pub fn start_worker(
        &self,
        state: FederatorState,
        mut shutdown: tokio::sync::watch::Receiver<bool>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    changed = shutdown.changed() => {
                        if changed.is_err() || *shutdown.borrow() { break; }
                    }
                    result = process_delivery_tick(&state) => {
                        if let Err(error) = result {
                            tracing::warn!(%error, "federated notification worker tick failed");
                        }
                    }
                }
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(1)) => {},
                    changed = shutdown.changed() => {
                        if changed.is_err() || *shutdown.borrow() { break; }
                    }
                }
            }
        })
    }
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
    fn from(value: PushSubscription) -> Self {
        Self {
            id: value.id,
            endpoint: value.endpoint,
            user_agent: value.user_agent,
            enabled: value.enabled,
            created_at: DateTime::from_timestamp(value.created_at, 0)
                .unwrap_or(DateTime::<Utc>::UNIX_EPOCH),
            updated_at: DateTime::from_timestamp(value.updated_at, 0)
                .unwrap_or(DateTime::<Utc>::UNIX_EPOCH),
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

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BadgeSource {
    pub executor_id: String,
    pub count: i64,
    pub native_read_revision: i64,
    pub observed_at: i64,
    pub available: bool,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AggregateUnreadBadgeResponse {
    pub count: i64,
    pub read_revision: i64,
    pub complete: bool,
    pub sources: Vec<BadgeSource>,
}

pub fn router() -> Router<FederatorState> {
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
        .route("/v1/threads/unread-badge", get(unread_badge))
}

fn configured(state: &FederatorState) -> bool {
    state.notifications_config.vapid_public_key.is_some()
        && state.notifications_config.vapid_private_key.is_some()
        && state.notifications_config.vapid_subject.is_some()
}

#[utoipa::path(get, path = "/v1/notifications/status", responses((status = 200, body = NotificationStatusResponse)))]
pub async fn notification_status(
    State(state): State<FederatorState>,
) -> Json<NotificationStatusResponse> {
    let configured = configured(&state);
    Json(NotificationStatusResponse {
        configured,
        vapid_public_key: state.notifications_config.vapid_public_key.clone(),
        subscriptions_enabled: configured,
    })
}

#[utoipa::path(post, path = "/v1/notifications/subscriptions", request_body = PushSubscriptionUpsertRequest, responses((status = 201, body = PushSubscriptionUpsertResponse)))]
pub async fn upsert_push_subscription(
    State(state): State<FederatorState>,
    Json(request): Json<PushSubscriptionUpsertRequest>,
) -> Result<(StatusCode, Json<PushSubscriptionUpsertResponse>), NotificationError> {
    let endpoint = required(request.endpoint, "endpoint")?;
    let p256dh = required(request.keys.p256dh, "p256dh")?;
    let auth = required(request.keys.auth, "auth")?;
    let subscription = state
        .store
        .upsert_push_subscription(endpoint, p256dh, auth, request.user_agent)
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
    State(state): State<FederatorState>,
    Path(id): Path<String>,
) -> Result<Json<PushSubscriptionDeleteResponse>, NotificationError> {
    Ok(Json(PushSubscriptionDeleteResponse {
        subscription: state
            .store
            .disable_push_subscription_by_id(&id)
            .await?
            .map(Into::into),
    }))
}

#[utoipa::path(get, path = "/v1/notifications/subscription/current", params(CurrentPushSubscriptionQuery), responses((status = 200, body = CurrentPushSubscriptionResponse)))]
pub async fn current_push_subscription(
    State(state): State<FederatorState>,
    Query(query): Query<CurrentPushSubscriptionQuery>,
) -> Result<Json<CurrentPushSubscriptionResponse>, NotificationError> {
    let endpoint = required(query.endpoint, "endpoint")?;
    let subscription = state.store.push_subscription_by_endpoint(&endpoint).await?;
    Ok(Json(CurrentPushSubscriptionResponse {
        configured: configured(&state),
        subscribed: subscription.as_ref().is_some_and(|row| row.enabled),
        subscription: subscription.map(Into::into),
    }))
}

#[utoipa::path(delete, path = "/v1/notifications/subscription/current", params(CurrentPushSubscriptionQuery), responses((status = 200, body = CurrentPushSubscriptionResponse)))]
pub async fn delete_current_push_subscription(
    State(state): State<FederatorState>,
    Query(query): Query<CurrentPushSubscriptionQuery>,
) -> Result<Json<CurrentPushSubscriptionResponse>, NotificationError> {
    let endpoint = required(query.endpoint, "endpoint")?;
    let subscription = state
        .store
        .disable_push_subscription_by_endpoint(&endpoint)
        .await?;
    Ok(Json(CurrentPushSubscriptionResponse {
        configured: configured(&state),
        subscribed: false,
        subscription: subscription.map(Into::into),
    }))
}

#[utoipa::path(post, path = "/v1/notifications/test", responses((status = 200, body = TestNotificationResponse)))]
pub async fn test_notification(
    State(state): State<FederatorState>,
) -> Result<Json<TestNotificationResponse>, NotificationError> {
    let configured = configured(&state);
    let active = state.store.list_enabled_push_subscriptions().await?.len();
    if !configured || active == 0 {
        return Ok(Json(TestNotificationResponse {
            configured,
            active_subscription_count: active,
            enqueued: false,
            delivery_ids: vec![],
        }));
    }
    let payload = NotificationPayload {
        kind: "test".into(),
        executor_id: None,
        thread_id: None,
        title: "Kodex test notification".into(),
        body: Some("Push notifications are working.".into()),
        route: "/".into(),
        badge_count: None,
        read_revision: None,
    };
    let id = state.store.create_local_delivery(&payload).await?;
    Ok(Json(TestNotificationResponse {
        configured,
        active_subscription_count: active,
        enqueued: true,
        delivery_ids: vec![id],
    }))
}

#[utoipa::path(get, path = "/v1/threads/unread-badge", responses((status = 200, body = AggregateUnreadBadgeResponse)))]
pub async fn unread_badge(
    State(state): State<FederatorState>,
) -> Result<Json<AggregateUnreadBadgeResponse>, NotificationError> {
    Ok(Json(refresh_aggregate_badge(&state).await?))
}

fn required(value: String, field: &str) -> Result<String, NotificationError> {
    let value = value.trim().to_string();
    if value.is_empty() {
        Err(NotificationError::bad_request(format!(
            "{field} is required"
        )))
    } else {
        Ok(value)
    }
}

#[derive(Debug)]
pub struct NotificationError {
    status: StatusCode,
    message: String,
}

impl NotificationError {
    fn internal(error: impl std::fmt::Display) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: error.to_string(),
        }
    }
    fn bad_request(message: String) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message,
        }
    }
}

impl<E: Into<anyhow::Error>> From<E> for NotificationError {
    fn from(error: E) -> Self {
        Self::internal(error.into())
    }
}

impl axum::response::IntoResponse for NotificationError {
    fn into_response(self) -> axum::response::Response {
        (
            self.status,
            Json(serde_json::json!({"message": self.message})),
        )
            .into_response()
    }
}

#[derive(Debug)]
struct LocalDelivery {
    id: String,
    payload: NotificationPayload,
    delivered_subscription_ids: Vec<String>,
    attempt_count: i64,
}

impl crate::store::Store {
    async fn upsert_push_subscription(
        &self,
        endpoint: String,
        p256dh: String,
        auth: String,
        user_agent: Option<String>,
    ) -> anyhow::Result<PushSubscription> {
        let now = Utc::now().timestamp();
        sqlx::query("INSERT INTO push_subscriptions(id, endpoint, p256dh, auth, user_agent, enabled, created_at, updated_at) VALUES(?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, user_agent=excluded.user_agent, enabled=1, updated_at=excluded.updated_at")
            .bind(Uuid::new_v4().to_string()).bind(&endpoint).bind(p256dh).bind(auth).bind(user_agent).bind(now).bind(now).execute(&self.pool).await?;
        Ok(self
            .push_subscription_by_endpoint(&endpoint)
            .await?
            .expect("upserted subscription exists"))
    }

    async fn push_subscription_by_endpoint(
        &self,
        endpoint: &str,
    ) -> anyhow::Result<Option<PushSubscription>> {
        let row = sqlx::query("SELECT id, endpoint, p256dh, auth, user_agent, enabled, created_at, updated_at FROM push_subscriptions WHERE endpoint=?").bind(endpoint).fetch_optional(&self.pool).await?;
        row.map(decode_subscription).transpose()
    }

    async fn list_enabled_push_subscriptions(&self) -> anyhow::Result<Vec<PushSubscription>> {
        sqlx::query("SELECT id, endpoint, p256dh, auth, user_agent, enabled, created_at, updated_at FROM push_subscriptions WHERE enabled=1 ORDER BY created_at, id")
            .fetch_all(&self.pool).await?.into_iter().map(decode_subscription).collect()
    }

    async fn disable_push_subscription_by_id(
        &self,
        id: &str,
    ) -> anyhow::Result<Option<PushSubscription>> {
        self.disable_push_subscription("id", id).await
    }

    async fn disable_push_subscription_by_endpoint(
        &self,
        endpoint: &str,
    ) -> anyhow::Result<Option<PushSubscription>> {
        self.disable_push_subscription("endpoint", endpoint).await
    }

    async fn disable_push_subscription(
        &self,
        column: &str,
        value: &str,
    ) -> anyhow::Result<Option<PushSubscription>> {
        let now = Utc::now().timestamp();
        let query = format!("UPDATE push_subscriptions SET enabled=0, updated_at=? WHERE {column}=? RETURNING id, endpoint, p256dh, auth, user_agent, enabled, created_at, updated_at");
        sqlx::query(&query)
            .bind(now)
            .bind(value)
            .fetch_optional(&self.pool)
            .await?
            .map(decode_subscription)
            .transpose()
    }

    async fn create_local_delivery(&self, payload: &NotificationPayload) -> anyhow::Result<String> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp();
        sqlx::query("INSERT INTO notification_deliveries(id, payload_json, delivered_subscription_ids_json, status, attempt_count, available_at, created_at, updated_at) VALUES(?, ?, '[]', 'pending', 0, ?, ?, ?)")
            .bind(&id).bind(serde_json::to_string(payload)?).bind(now).bind(now).bind(now).execute(&self.pool).await?;
        Ok(id)
    }

    async fn claim_local_deliveries(&self) -> anyhow::Result<Vec<LocalDelivery>> {
        let now = Utc::now().timestamp();
        let stale = now - STALE_AFTER_SECONDS;
        let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM notification_deliveries WHERE (status='pending' AND available_at<=?) OR (status='processing' AND processing_started_at<=?) ORDER BY available_at, created_at, id LIMIT ?")
            .bind(now).bind(stale).bind(CLAIM_LIMIT).fetch_all(&self.pool).await?;
        let mut result = vec![];
        for id in ids {
            let row = sqlx::query("UPDATE notification_deliveries SET status='processing', attempt_count=attempt_count+1, processing_started_at=?, last_error=null, updated_at=? WHERE id=? AND ((status='pending' AND available_at<=?) OR (status='processing' AND processing_started_at<=?)) RETURNING id, payload_json, delivered_subscription_ids_json, attempt_count")
                .bind(now).bind(now).bind(id).bind(now).bind(stale).fetch_optional(&self.pool).await?;
            if let Some(row) = row {
                result.push(LocalDelivery {
                    id: row.try_get("id")?,
                    payload: serde_json::from_str(&row.try_get::<String, _>("payload_json")?)?,
                    delivered_subscription_ids: serde_json::from_str(
                        &row.try_get::<String, _>("delivered_subscription_ids_json")?,
                    )?,
                    attempt_count: row.try_get("attempt_count")?,
                });
            }
        }
        Ok(result)
    }

    async fn finish_local_delivery(
        &self,
        delivery: &LocalDelivery,
        summary: &DeliverySummary,
    ) -> anyhow::Result<()> {
        let now = Utc::now().timestamp();
        let mut delivered = delivery.delivered_subscription_ids.clone();
        for id in &summary.sent_ids {
            if !delivered.contains(id) {
                delivered.push(id.clone());
            }
        }
        let (status, available_at, sent_at, error) =
            if summary.temporary > 0 && delivery.attempt_count < MAX_ATTEMPTS {
                (
                    "pending",
                    now + (delivery.attempt_count.max(1) * 2).min(30),
                    None,
                    Some(format!(
                        "{} temporary push delivery failure(s)",
                        summary.temporary
                    )),
                )
            } else if summary.temporary > 0 {
                (
                    "failed",
                    now,
                    None,
                    Some(format!(
                        "{} temporary push delivery failure(s)",
                        summary.temporary
                    )),
                )
            } else if summary.stale > 0 && delivered.is_empty() {
                (
                    "failed",
                    now,
                    None,
                    Some(format!("{} stale push endpoint(s)", summary.stale)),
                )
            } else {
                ("sent", now, Some(now), None)
            };
        sqlx::query("UPDATE notification_deliveries SET status=?, available_at=?, delivered_subscription_ids_json=?, processing_started_at=null, sent_at=?, last_error=?, updated_at=? WHERE id=?")
            .bind(status).bind(available_at).bind(serde_json::to_string(&delivered)?).bind(sent_at).bind(error).bind(now).bind(&delivery.id).execute(&self.pool).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::VecDeque, sync::Mutex};

    use super::*;
    use crate::{config::Config, registry::ExecutorRecord};

    struct ScriptedSender {
        outcomes: Mutex<VecDeque<PushDeliveryOutcome>>,
        endpoints: Mutex<Vec<String>>,
        payloads: Mutex<Vec<NotificationPayload>>,
    }

    struct HeldSender {
        entered: tokio::sync::mpsc::UnboundedSender<()>,
    }

    struct SuccessThenHeldSender {
        calls: std::sync::atomic::AtomicUsize,
        entered: tokio::sync::mpsc::UnboundedSender<()>,
    }

    #[async_trait]
    impl PushSender for HeldSender {
        async fn send(&self, _: &PushSubscription, _: &NotificationPayload) -> PushDeliveryOutcome {
            let _ = self.entered.send(());
            std::future::pending().await
        }
    }

    #[async_trait]
    impl PushSender for SuccessThenHeldSender {
        async fn send(&self, _: &PushSubscription, _: &NotificationPayload) -> PushDeliveryOutcome {
            if self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                PushDeliveryOutcome::Sent
            } else {
                let _ = self.entered.send(());
                std::future::pending().await
            }
        }
    }

    #[async_trait]
    impl PushSender for ScriptedSender {
        async fn send(
            &self,
            subscription: &PushSubscription,
            payload: &NotificationPayload,
        ) -> PushDeliveryOutcome {
            self.endpoints
                .lock()
                .unwrap()
                .push(subscription.endpoint.clone());
            self.payloads.lock().unwrap().push(payload.clone());
            self.outcomes
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(PushDeliveryOutcome::Sent)
        }
    }

    async fn state_with_sender(
        outcomes: Vec<PushDeliveryOutcome>,
    ) -> (tempfile::TempDir, FederatorState, Arc<ScriptedSender>) {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::default();
        config.data_dir = dir.path().to_path_buf();
        config.database_path = dir.path().join("federator.db");
        config.notifications.vapid_public_key = Some("public".into());
        config.notifications.vapid_private_key = Some("private".into());
        config.notifications.vapid_subject = Some("mailto:test@example.com".into());
        let (_, mut state) = crate::prepare(&config).await.unwrap();
        let sender = Arc::new(ScriptedSender {
            outcomes: Mutex::new(outcomes.into()),
            endpoints: Mutex::new(vec![]),
            payloads: Mutex::new(vec![]),
        });
        state.notifications = NotificationService::new(sender.clone());
        (dir, state, sender)
    }

    #[tokio::test]
    async fn zero_executor_diagnostic_retries_only_unsent_recipients() {
        let (_dir, state, sender) = state_with_sender(vec![
            PushDeliveryOutcome::Sent,
            PushDeliveryOutcome::TemporaryFailure,
            PushDeliveryOutcome::Sent,
        ])
        .await;
        state
            .store
            .upsert_push_subscription("https://push/a".into(), "p".into(), "a".into(), None)
            .await
            .unwrap();
        state
            .store
            .upsert_push_subscription("https://push/b".into(), "p".into(), "a".into(), None)
            .await
            .unwrap();
        let payload = NotificationPayload {
            kind: "test".into(),
            executor_id: None,
            thread_id: None,
            title: "test".into(),
            body: None,
            route: "/".into(),
            badge_count: None,
            read_revision: None,
        };
        let id = state.store.create_local_delivery(&payload).await.unwrap();

        process_delivery_tick(&state).await.unwrap();
        sqlx::query("UPDATE notification_deliveries SET available_at=0 WHERE id=?")
            .bind(&id)
            .execute(&state.store.pool)
            .await
            .unwrap();
        process_delivery_tick(&state).await.unwrap();

        let row = sqlx::query("SELECT status, delivered_subscription_ids_json FROM notification_deliveries WHERE id=?").bind(id).fetch_one(&state.store.pool).await.unwrap();
        assert_eq!(row.try_get::<String, _>("status").unwrap(), "sent");
        let delivered: Vec<String> = serde_json::from_str(
            &row.try_get::<String, _>("delivered_subscription_ids_json")
                .unwrap(),
        )
        .unwrap();
        assert_eq!(delivered.len(), 2);
        let endpoints = sender.endpoints.lock().unwrap().clone();
        assert_eq!(endpoints.len(), 3);
        assert_ne!(endpoints[0], endpoints[1]);
        assert_eq!(endpoints[1], endpoints[2]);
    }

    #[tokio::test]
    async fn stalled_provider_is_bounded_and_local_delivery_remains_retryable() {
        let (_dir, mut state, _) = state_with_sender(vec![]).await;
        let (entered, mut entered_rx) = tokio::sync::mpsc::unbounded_channel();
        state.notifications = NotificationService::new(Arc::new(HeldSender { entered }));
        state
            .store
            .upsert_push_subscription("https://push/a".into(), "p".into(), "a".into(), None)
            .await
            .unwrap();
        let id = state
            .store
            .create_local_delivery(&NotificationPayload {
                kind: "test".into(),
                executor_id: None,
                thread_id: None,
                title: "test".into(),
                body: None,
                route: "/".into(),
                badge_count: None,
                read_revision: None,
            })
            .await
            .unwrap();

        tokio::time::timeout(Duration::from_secs(1), process_delivery_tick(&state))
            .await
            .expect("provider attempt must be bounded")
            .unwrap();
        entered_rx.recv().await.unwrap();
        let status: String =
            sqlx::query_scalar("SELECT status FROM notification_deliveries WHERE id=?")
                .bind(id)
                .fetch_one(&state.store.pool)
                .await
                .unwrap();
        assert_eq!(status, "pending");
    }

    #[tokio::test]
    async fn zero_executor_diagnostic_reclaims_processing_work_after_restart() {
        let (dir, state, _) = state_with_sender(vec![]).await;
        state
            .store
            .upsert_push_subscription("https://push/a".into(), "p".into(), "a".into(), None)
            .await
            .unwrap();
        let payload = NotificationPayload {
            kind: "test".into(),
            executor_id: None,
            thread_id: None,
            title: "test".into(),
            body: None,
            route: "/".into(),
            badge_count: None,
            read_revision: None,
        };
        let id = state.store.create_local_delivery(&payload).await.unwrap();
        sqlx::query("UPDATE notification_deliveries SET status='processing', attempt_count=1, processing_started_at=0 WHERE id=?").bind(&id).execute(&state.store.pool).await.unwrap();
        drop(state);

        let mut config = Config::default();
        config.data_dir = dir.path().to_path_buf();
        config.database_path = dir.path().join("federator.db");
        config.notifications.vapid_public_key = Some("public".into());
        config.notifications.vapid_private_key = Some("private".into());
        config.notifications.vapid_subject = Some("mailto:test@example.com".into());
        let (_, mut restarted) = crate::prepare(&config).await.unwrap();
        let sender = Arc::new(ScriptedSender {
            outcomes: Mutex::new(vec![PushDeliveryOutcome::Sent].into()),
            endpoints: Mutex::new(vec![]),
            payloads: Mutex::new(vec![]),
        });
        restarted.notifications = NotificationService::new(sender.clone());
        process_delivery_tick(&restarted).await.unwrap();

        let status: String =
            sqlx::query_scalar("SELECT status FROM notification_deliveries WHERE id=?")
                .bind(id)
                .fetch_one(&restarted.store.pool)
                .await
                .unwrap();
        assert_eq!(status, "sent");
        assert_eq!(sender.endpoints.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn stale_provider_endpoint_is_disabled_without_retrying_successful_recipient() {
        let (_dir, state, sender) = state_with_sender(vec![
            PushDeliveryOutcome::Sent,
            PushDeliveryOutcome::StaleEndpoint,
        ])
        .await;
        state
            .store
            .upsert_push_subscription("https://push/a".into(), "p".into(), "a".into(), None)
            .await
            .unwrap();
        state
            .store
            .upsert_push_subscription("https://push/b".into(), "p".into(), "a".into(), None)
            .await
            .unwrap();
        let payload = NotificationPayload {
            kind: "test".into(),
            executor_id: None,
            thread_id: None,
            title: "test".into(),
            body: None,
            route: "/".into(),
            badge_count: None,
            read_revision: None,
        };
        let id = state.store.create_local_delivery(&payload).await.unwrap();
        process_delivery_tick(&state).await.unwrap();

        let status: String =
            sqlx::query_scalar("SELECT status FROM notification_deliveries WHERE id=?")
                .bind(id)
                .fetch_one(&state.store.pool)
                .await
                .unwrap();
        assert_eq!(status, "sent");
        assert_eq!(
            state
                .store
                .list_enabled_push_subscriptions()
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(sender.endpoints.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn unavailable_badge_source_preserves_last_known_count_and_marks_coverage_incomplete() {
        let (_dir, state, _) = state_with_sender(vec![]).await;
        let executor = ExecutorRecord {
            id: "mac".into(),
            generation: 1,
            display_name: "Mac".into(),
            base_url: "http://127.0.0.1:9999".into(),
            instance_id: "instance-mac".into(),
            api_version: "4".into(),
            app_server_schema_version: "0.160.0".into(),
            enabled: true,
            status: ExecutorStatus::Ready,
            last_error: None,
            last_seen_at: 1,
            created_at: 1,
            updated_at: 1,
        };
        state.store.insert_executor(&executor).await.unwrap();
        state
            .store
            .record_badge_result(
                &executor,
                Ok(NativeBadge {
                    count: 7,
                    read_revision: 42,
                }),
            )
            .await
            .unwrap();
        state
            .store
            .record_badge_result(&executor, Err(anyhow::anyhow!("offline")))
            .await
            .unwrap();

        let badge = state.store.aggregate_badge().await.unwrap();
        assert_eq!(badge.count, 7);
        assert!(!badge.complete);
        assert_eq!(badge.sources[0].native_read_revision, 42);
        assert_eq!(badge.sources[0].error.as_deref(), Some("offline"));
    }

    #[tokio::test]
    async fn stale_generation_badge_result_cannot_overwrite_the_current_binding() {
        let (_dir, state, _) = state_with_sender(vec![]).await;
        let old = ExecutorRecord {
            id: "mac".into(),
            generation: 1,
            display_name: "Mac".into(),
            base_url: "http://127.0.0.1:9999".into(),
            instance_id: "instance-mac".into(),
            api_version: "4".into(),
            app_server_schema_version: "0.160.0".into(),
            enabled: true,
            status: ExecutorStatus::Ready,
            last_error: None,
            last_seen_at: 1,
            created_at: 1,
            updated_at: 1,
        };
        state.store.insert_executor(&old).await.unwrap();
        let current = state
            .store
            .update_executor_sparse("mac", Some("Renamed"), None, 2)
            .await
            .unwrap()
            .unwrap()
            .record;
        state
            .store
            .record_badge_result(
                &current,
                Ok(NativeBadge {
                    count: 2,
                    read_revision: 3,
                }),
            )
            .await
            .unwrap();
        state
            .store
            .record_badge_result(
                &old,
                Ok(NativeBadge {
                    count: 99,
                    read_revision: 100,
                }),
            )
            .await
            .unwrap();

        let badge = state.store.aggregate_badge().await.unwrap();
        assert_eq!(badge.count, 2);
        assert_eq!(badge.sources[0].native_read_revision, 3);
    }

    #[tokio::test]
    async fn lower_native_badge_revision_cannot_regress_same_generation_state() {
        let (_dir, state, _) = state_with_sender(vec![]).await;
        let executor = ExecutorRecord {
            id: "mac".into(),
            generation: 1,
            display_name: "Mac".into(),
            base_url: "http://127.0.0.1:9999".into(),
            instance_id: "instance-mac".into(),
            api_version: "4".into(),
            app_server_schema_version: "0.160.0".into(),
            enabled: true,
            status: ExecutorStatus::Ready,
            last_error: None,
            last_seen_at: 1,
            created_at: 1,
            updated_at: 1,
        };
        state.store.insert_executor(&executor).await.unwrap();
        state
            .store
            .record_badge_result(
                &executor,
                Ok(NativeBadge {
                    count: 2,
                    read_revision: 10,
                }),
            )
            .await
            .unwrap();
        state
            .store
            .record_badge_result(
                &executor,
                Ok(NativeBadge {
                    count: 99,
                    read_revision: 9,
                }),
            )
            .await
            .unwrap();

        let badge = state.store.aggregate_badge().await.unwrap();
        assert_eq!(badge.count, 2);
        assert_eq!(badge.sources[0].native_read_revision, 10);
    }

    #[tokio::test]
    async fn concurrent_badge_successes_are_serialized_per_executor() {
        use axum::{response::IntoResponse, Router};

        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (entered, mut entered_rx) = tokio::sync::mpsc::unbounded_channel();
        let (release, release_rx) = tokio::sync::oneshot::channel::<()>();
        let release_rx = Arc::new(tokio::sync::Mutex::new(Some(release_rx)));
        let app = Router::new().route(
            "/v1/threads/unread-badge",
            get({
                let calls = calls.clone();
                let release_rx = release_rx.clone();
                move || {
                    let calls = calls.clone();
                    let entered = entered.clone();
                    let release_rx = release_rx.clone();
                    async move {
                        let call = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        let _ = entered.send(call);
                        if call == 0 {
                            let receiver = release_rx.lock().await.take().unwrap();
                            let _ = receiver.await;
                            Json(serde_json::json!({"count": 1, "readRevision": 1})).into_response()
                        } else {
                            Json(serde_json::json!({"count": 2, "readRevision": 2})).into_response()
                        }
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let (_dir, state, _) = state_with_sender(vec![]).await;
        state
            .store
            .insert_executor(&ExecutorRecord {
                id: "mac".into(),
                generation: 1,
                display_name: "Mac".into(),
                base_url: format!("http://{address}"),
                instance_id: "instance-mac".into(),
                api_version: "4".into(),
                app_server_schema_version: "0.160.0".into(),
                enabled: true,
                status: ExecutorStatus::Ready,
                last_error: None,
                last_seen_at: 1,
                created_at: 1,
                updated_at: 1,
            })
            .await
            .unwrap();

        let first_state = state.clone();
        let first = tokio::spawn(async move { refresh_aggregate_badge(&first_state).await });
        assert_eq!(entered_rx.recv().await, Some(0));
        let second_state = state.clone();
        let second = tokio::spawn(async move { refresh_aggregate_badge(&second_state).await });
        assert!(
            tokio::time::timeout(Duration::from_millis(25), entered_rx.recv())
                .await
                .is_err()
        );
        release.send(()).unwrap();
        first.await.unwrap().unwrap();
        second.await.unwrap().unwrap();

        let badge = state.store.aggregate_badge().await.unwrap();
        assert_eq!(badge.count, 2);
        assert_eq!(badge.sources[0].native_read_revision, 2);
        server.abort();
    }

    #[tokio::test]
    async fn concurrent_badge_failure_cannot_arrive_after_a_newer_success() {
        use axum::{response::IntoResponse, Router};

        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (entered, mut entered_rx) = tokio::sync::mpsc::unbounded_channel();
        let (release, release_rx) = tokio::sync::oneshot::channel::<()>();
        let release_rx = Arc::new(tokio::sync::Mutex::new(Some(release_rx)));
        let app = Router::new().route(
            "/v1/threads/unread-badge",
            get({
                let calls = calls.clone();
                let release_rx = release_rx.clone();
                move || {
                    let calls = calls.clone();
                    let entered = entered.clone();
                    let release_rx = release_rx.clone();
                    async move {
                        let call = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        let _ = entered.send(call);
                        if call == 0 {
                            let receiver = release_rx.lock().await.take().unwrap();
                            let _ = receiver.await;
                            StatusCode::INTERNAL_SERVER_ERROR.into_response()
                        } else {
                            Json(serde_json::json!({"count": 4, "readRevision": 4})).into_response()
                        }
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let (_dir, state, _) = state_with_sender(vec![]).await;
        let executor = ExecutorRecord {
            id: "mac".into(),
            generation: 1,
            display_name: "Mac".into(),
            base_url: format!("http://{address}"),
            instance_id: "instance-mac".into(),
            api_version: "4".into(),
            app_server_schema_version: "0.160.0".into(),
            enabled: true,
            status: ExecutorStatus::Ready,
            last_error: None,
            last_seen_at: 1,
            created_at: 1,
            updated_at: 1,
        };
        state.store.insert_executor(&executor).await.unwrap();
        state
            .store
            .record_badge_result(
                &executor,
                Ok(NativeBadge {
                    count: 3,
                    read_revision: 3,
                }),
            )
            .await
            .unwrap();

        let first_state = state.clone();
        let first = tokio::spawn(async move { refresh_aggregate_badge(&first_state).await });
        assert_eq!(entered_rx.recv().await, Some(0));
        let second_state = state.clone();
        let second = tokio::spawn(async move { refresh_aggregate_badge(&second_state).await });
        assert!(
            tokio::time::timeout(Duration::from_millis(25), entered_rx.recv())
                .await
                .is_err()
        );
        release.send(()).unwrap();
        first.await.unwrap().unwrap();
        second.await.unwrap().unwrap();

        let badge = state.store.aggregate_badge().await.unwrap();
        assert_eq!(badge.count, 4);
        assert!(badge.complete);
        assert_eq!(badge.sources[0].native_read_revision, 4);
        server.abort();
    }

    #[tokio::test]
    async fn older_badge_failure_cannot_wait_on_another_source_then_overwrite_success() {
        use axum::{response::IntoResponse, Router};

        let a_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (a_entered, mut a_entered_rx) = tokio::sync::mpsc::unbounded_channel();
        let a_app = Router::new().route(
            "/v1/threads/unread-badge",
            get({
                let a_calls = a_calls.clone();
                move || {
                    let a_calls = a_calls.clone();
                    let a_entered = a_entered.clone();
                    async move {
                        let call = a_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        let _ = a_entered.send(call);
                        if call == 0 {
                            StatusCode::INTERNAL_SERVER_ERROR.into_response()
                        } else {
                            Json(serde_json::json!({"count": 6, "readRevision": 6})).into_response()
                        }
                    }
                }
            }),
        );
        let a_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let a_address = a_listener.local_addr().unwrap();
        let a_server = tokio::spawn(async move { axum::serve(a_listener, a_app).await.unwrap() });

        let (b_entered, mut b_entered_rx) = tokio::sync::mpsc::unbounded_channel();
        let (release_b, release_b_rx) = tokio::sync::oneshot::channel::<()>();
        let release_b_rx = Arc::new(tokio::sync::Mutex::new(Some(release_b_rx)));
        let b_app = Router::new().route(
            "/v1/threads/unread-badge",
            get({
                let release_b_rx = release_b_rx.clone();
                move || {
                    let b_entered = b_entered.clone();
                    let release_b_rx = release_b_rx.clone();
                    async move {
                        let _ = b_entered.send(());
                        if let Some(receiver) = release_b_rx.lock().await.take() {
                            let _ = receiver.await;
                        }
                        Json(serde_json::json!({"count": 1, "readRevision": 1}))
                    }
                }
            }),
        );
        let b_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let b_address = b_listener.local_addr().unwrap();
        let b_server = tokio::spawn(async move { axum::serve(b_listener, b_app).await.unwrap() });

        let (_dir, state, _) = state_with_sender(vec![]).await;
        for (id, address) in [("a", a_address), ("b", b_address)] {
            state
                .store
                .insert_executor(&ExecutorRecord {
                    id: id.into(),
                    generation: 1,
                    display_name: id.into(),
                    base_url: format!("http://{address}"),
                    instance_id: format!("instance-{id}"),
                    api_version: "4".into(),
                    app_server_schema_version: "0.160.0".into(),
                    enabled: true,
                    status: ExecutorStatus::Ready,
                    last_error: None,
                    last_seen_at: 1,
                    created_at: 1,
                    updated_at: 1,
                })
                .await
                .unwrap();
        }
        let first_state = state.clone();
        let first = tokio::spawn(async move { refresh_aggregate_badge(&first_state).await });
        assert_eq!(a_entered_rx.recv().await, Some(0));
        b_entered_rx.recv().await.unwrap();

        let second_state = state.clone();
        let second = tokio::spawn(async move { refresh_aggregate_badge(&second_state).await });
        assert_eq!(
            tokio::time::timeout(Duration::from_millis(50), a_entered_rx.recv())
                .await
                .unwrap(),
            Some(1)
        );
        release_b.send(()).unwrap();
        first.await.unwrap().unwrap();
        second.await.unwrap().unwrap();

        let badge = state.store.aggregate_badge().await.unwrap();
        let source = badge
            .sources
            .iter()
            .find(|source| source.executor_id == "a")
            .unwrap();
        assert!(source.available);
        assert_eq!(source.count, 6);
        assert_eq!(source.native_read_revision, 6);
        a_server.abort();
        b_server.abort();
    }

    #[tokio::test]
    async fn deleted_executor_is_not_retained_in_aggregate_badge_snapshot() {
        let (_dir, state, _) = state_with_sender(vec![]).await;
        let executor = ExecutorRecord {
            id: "mac".into(),
            generation: 1,
            display_name: "Mac".into(),
            base_url: "http://127.0.0.1:9999".into(),
            instance_id: "instance-mac".into(),
            api_version: "4".into(),
            app_server_schema_version: "0.160.0".into(),
            enabled: true,
            status: ExecutorStatus::Ready,
            last_error: None,
            last_seen_at: 1,
            created_at: 1,
            updated_at: 1,
        };
        state.store.insert_executor(&executor).await.unwrap();
        state
            .store
            .record_badge_result(
                &executor,
                Ok(NativeBadge {
                    count: 7,
                    read_revision: 9,
                }),
            )
            .await
            .unwrap();
        sqlx::query("DELETE FROM executors WHERE id=?")
            .bind(&executor.id)
            .execute(&state.store.pool)
            .await
            .unwrap();

        let badge = state.store.aggregate_badge().await.unwrap();
        assert_eq!(badge.count, 0);
        assert!(badge.complete);
        assert!(badge.sources.is_empty());
    }

    #[tokio::test]
    async fn executor_replacement_cancels_a_held_claim_before_delivery() {
        use axum::{routing::post, Router};

        let (entered, mut entered_rx) = tokio::sync::mpsc::unbounded_channel();
        let app = Router::new().route(
            "/v1/notifications/deliveries/claim",
            post(move || {
                let entered = entered.clone();
                async move {
                    let _ = entered.send(());
                    std::future::pending::<Json<serde_json::Value>>().await
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let (_dir, state, sender) = state_with_sender(vec![PushDeliveryOutcome::Sent]).await;
        let executor = ExecutorRecord {
            id: "linux".into(),
            generation: 1,
            display_name: "Linux".into(),
            base_url: format!("http://{address}"),
            instance_id: "instance-linux".into(),
            api_version: "4".into(),
            app_server_schema_version: "0.160.0".into(),
            enabled: true,
            status: ExecutorStatus::Ready,
            last_error: None,
            last_seen_at: 1,
            created_at: 1,
            updated_at: 1,
        };
        state.store.insert_executor(&executor).await.unwrap();
        let task_state = state.clone();
        let expected = executor.clone();
        let task = tokio::spawn(async move { process_executor(&task_state, &expected).await });
        entered_rx.recv().await.unwrap();
        let mutation = state
            .store
            .update_executor_sparse("linux", Some("Replacement"), None, 2)
            .await
            .unwrap()
            .unwrap();
        let _ = state.registry_changes.send(crate::RegistryChange {
            revision: mutation.registry_revision,
            executor_id: "linux".into(),
            generation: Some(mutation.record.generation),
        });

        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("registry change must cancel a held claim")
            .unwrap()
            .unwrap();
        assert!(sender.payloads.lock().unwrap().is_empty());
        server.abort();
    }

    #[tokio::test]
    async fn executor_replacement_reports_successes_before_a_held_provider_send() {
        use axum::{routing::post, Router};

        let outcome = Arc::new(Mutex::new(None::<serde_json::Value>));
        let captured = outcome.clone();
        let app = Router::new()
            .route("/v1/notifications/deliveries/claim", post(|| async { Json(serde_json::json!({"claims": [{"deliveryId": "delivery-1", "claimId": "claim-1", "attemptCount": 1, "deliveredSubscriptionIds": [], "payload": {"kind": "unreadAgentMessage", "threadId": "thread", "title": "Done", "route": "/threads/thread"}}]})) }))
            .route("/v1/notifications/deliveries/{id}/outcome", post(move |Json(body): Json<serde_json::Value>| { let captured = captured.clone(); async move { *captured.lock().unwrap() = Some(body); Json(serde_json::json!({"accepted": true})) } }))
            .route("/v1/threads/unread-badge", get(|| async { Json(serde_json::json!({"count": 1, "readRevision": 1})) }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let (_dir, mut state, _) = state_with_sender(vec![]).await;
        state
            .store
            .upsert_push_subscription("https://push/a".into(), "p".into(), "a".into(), None)
            .await
            .unwrap();
        state
            .store
            .upsert_push_subscription("https://push/b".into(), "p".into(), "a".into(), None)
            .await
            .unwrap();
        let (entered, mut entered_rx) = tokio::sync::mpsc::unbounded_channel();
        state.notifications = NotificationService::new(Arc::new(SuccessThenHeldSender {
            calls: std::sync::atomic::AtomicUsize::new(0),
            entered,
        }));
        let executor = ExecutorRecord {
            id: "linux".into(),
            generation: 1,
            display_name: "Linux".into(),
            base_url: format!("http://{address}"),
            instance_id: "instance-linux".into(),
            api_version: "4".into(),
            app_server_schema_version: "0.160.0".into(),
            enabled: true,
            status: ExecutorStatus::Ready,
            last_error: None,
            last_seen_at: 1,
            created_at: 1,
            updated_at: 1,
        };
        state.store.insert_executor(&executor).await.unwrap();
        let task_state = state.clone();
        let expected = executor.clone();
        let task = tokio::spawn(async move { process_executor(&task_state, &expected).await });
        entered_rx.recv().await.unwrap();
        let mutation = state
            .store
            .update_executor_sparse("linux", None, Some(false), 2)
            .await
            .unwrap()
            .unwrap();
        let _ = state.registry_changes.send(crate::RegistryChange {
            revision: mutation.registry_revision,
            executor_id: "linux".into(),
            generation: Some(mutation.record.generation),
        });

        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("registry change must cancel a held provider send")
            .unwrap()
            .unwrap();
        let outcome = outcome.lock().unwrap().clone().unwrap();
        assert_eq!(
            outcome["deliveredSubscriptionIds"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(outcome["temporaryFailureCount"], 1);
        server.abort();
    }

    #[tokio::test]
    async fn held_executor_source_does_not_block_other_sources_or_the_worker_tick() {
        use axum::{routing::post, Router};

        let held_app = Router::new().route(
            "/v1/notifications/deliveries/claim",
            post(|| async { std::future::pending::<Json<serde_json::Value>>().await }),
        );
        let held_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let held_address = held_listener.local_addr().unwrap();
        let held_server =
            tokio::spawn(async move { axum::serve(held_listener, held_app).await.unwrap() });
        let healthy_app = Router::new().route(
            "/v1/notifications/deliveries/claim",
            post(|| async { Json(serde_json::json!({"claims": []})) }),
        );
        let healthy_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let healthy_address = healthy_listener.local_addr().unwrap();
        let healthy_server =
            tokio::spawn(async move { axum::serve(healthy_listener, healthy_app).await.unwrap() });
        let (_dir, state, _) = state_with_sender(vec![]).await;
        for (id, address) in [("held", held_address), ("healthy", healthy_address)] {
            state
                .store
                .insert_executor(&ExecutorRecord {
                    id: id.into(),
                    generation: 1,
                    display_name: id.into(),
                    base_url: format!("http://{address}"),
                    instance_id: format!("instance-{id}"),
                    api_version: "4".into(),
                    app_server_schema_version: "0.160.0".into(),
                    enabled: true,
                    status: ExecutorStatus::Ready,
                    last_error: None,
                    last_seen_at: 1,
                    created_at: 1,
                    updated_at: 1,
                })
                .await
                .unwrap();
        }

        tokio::time::timeout(Duration::from_secs(1), process_executor_deliveries(&state))
            .await
            .expect("one held source must not stall the worker")
            .unwrap();
        held_server.abort();
        healthy_server.abort();
    }

    #[tokio::test]
    async fn executor_claim_delivery_is_qualified_and_reports_provider_outcome() {
        use axum::{extract::Path, http::HeaderMap, routing::post, Router};

        let outcome = Arc::new(Mutex::new(None::<serde_json::Value>));
        let captured = outcome.clone();
        let app = Router::new()
            .route(
                "/v1/notifications/deliveries/claim",
                post(|headers: HeaderMap| async move {
                    assert_eq!(headers["x-kodex-expected-instance"], "instance-linux");
                    Json(serde_json::json!({"claims": [{
                        "deliveryId": "delivery-1", "claimId": "claim-1", "attemptCount": 1,
                        "deliveredSubscriptionIds": [],
                        "payload": {"kind": "unreadAgentMessage", "threadId": "same-id", "title": "Done", "body": "Exact turn", "route": "/threads/same-id"}
                    }]}))
                }),
            )
            .route(
                "/v1/notifications/deliveries/{id}/outcome",
                post(move |Path(id): Path<String>, Json(body): Json<serde_json::Value>| {
                    let captured = captured.clone();
                    async move { assert_eq!(id, "delivery-1"); *captured.lock().unwrap() = Some(body); Json(serde_json::json!({"accepted": true})) }
                }),
            )
            .route("/v1/threads/unread-badge", get(|| async { Json(serde_json::json!({"count": 3, "readRevision": 9})) }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let (_dir, state, sender) = state_with_sender(vec![PushDeliveryOutcome::Sent]).await;
        state
            .store
            .upsert_push_subscription("https://push/a".into(), "p".into(), "a".into(), None)
            .await
            .unwrap();
        let executor = ExecutorRecord {
            id: "linux".into(),
            generation: 1,
            display_name: "Linux".into(),
            base_url: format!("http://{address}"),
            instance_id: "instance-linux".into(),
            api_version: "4".into(),
            app_server_schema_version: "0.160.0".into(),
            enabled: true,
            status: ExecutorStatus::Ready,
            last_error: None,
            last_seen_at: 1,
            created_at: 1,
            updated_at: 1,
        };
        state.store.insert_executor(&executor).await.unwrap();

        process_executor(&state, &executor).await.unwrap();

        let payloads = sender.payloads.lock().unwrap();
        assert_eq!(payloads.len(), 1);
        assert_eq!(payloads[0].executor_id.as_deref(), Some("linux"));
        assert_eq!(payloads[0].route, "/executors/linux/threads/same-id");
        assert_eq!(payloads[0].badge_count, Some(3));
        let outcome = outcome.lock().unwrap().clone().unwrap();
        assert_eq!(outcome["claimId"], "claim-1");
        assert_eq!(
            outcome["deliveredSubscriptionIds"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        server.abort();
    }

    #[tokio::test]
    async fn badge_state_without_a_captured_executor_job_never_creates_a_push() {
        use axum::{routing::post, Router};
        let app = Router::new()
            .route(
                "/v1/notifications/deliveries/claim",
                post(|| async { Json(serde_json::json!({"claims": []})) }),
            )
            .route(
                "/v1/threads/unread-badge",
                get(|| async { Json(serde_json::json!({"count": 8, "readRevision": 12})) }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let (_dir, state, sender) = state_with_sender(vec![PushDeliveryOutcome::Sent]).await;
        state
            .store
            .upsert_push_subscription("https://push/a".into(), "p".into(), "a".into(), None)
            .await
            .unwrap();
        let executor = ExecutorRecord {
            id: "linux".into(),
            generation: 1,
            display_name: "Linux".into(),
            base_url: format!("http://{address}"),
            instance_id: "instance-linux".into(),
            api_version: "4".into(),
            app_server_schema_version: "0.160.0".into(),
            enabled: true,
            status: ExecutorStatus::Ready,
            last_error: None,
            last_seen_at: 1,
            created_at: 1,
            updated_at: 1,
        };
        process_executor(&state, &executor).await.unwrap();
        assert!(sender.payloads.lock().unwrap().is_empty());
        server.abort();
    }
}

fn decode_subscription(row: sqlx::sqlite::SqliteRow) -> anyhow::Result<PushSubscription> {
    Ok(PushSubscription {
        id: row.try_get("id")?,
        endpoint: row.try_get("endpoint")?,
        p256dh: row.try_get("p256dh")?,
        auth: row.try_get("auth")?,
        user_agent: row.try_get("user_agent")?,
        enabled: row.try_get::<i64, _>("enabled")? != 0,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

#[derive(Default)]
struct DeliverySummary {
    sent_ids: Vec<String>,
    temporary: usize,
    stale: usize,
    cancelled: bool,
}

async fn deliver(
    state: &FederatorState,
    payload: &NotificationPayload,
    already: &[String],
) -> anyhow::Result<DeliverySummary> {
    let mut summary = DeliverySummary::default();
    let already = already.iter().map(String::as_str).collect::<HashSet<_>>();
    for subscription in state.store.list_enabled_push_subscriptions().await? {
        if already.contains(subscription.id.as_str()) {
            continue;
        }
        let outcome = tokio::time::timeout(
            PROVIDER_REQUEST_TIMEOUT,
            state.notifications.sender.send(&subscription, payload),
        )
        .await
        .unwrap_or(PushDeliveryOutcome::TemporaryFailure);
        match outcome {
            PushDeliveryOutcome::Sent => summary.sent_ids.push(subscription.id),
            PushDeliveryOutcome::TemporaryFailure => summary.temporary += 1,
            PushDeliveryOutcome::StaleEndpoint => {
                summary.stale += 1;
                state
                    .store
                    .disable_push_subscription_by_id(&subscription.id)
                    .await?;
            }
        }
    }
    Ok(summary)
}

async fn deliver_executor(
    state: &FederatorState,
    executor: &crate::registry::ExecutorRecord,
    registry_changes: &mut tokio::sync::broadcast::Receiver<crate::RegistryChange>,
    payload: &NotificationPayload,
    already: &[String],
) -> anyhow::Result<DeliverySummary> {
    let mut summary = DeliverySummary::default();
    let already = already.iter().map(String::as_str).collect::<HashSet<_>>();
    for subscription in state.store.list_enabled_push_subscriptions().await? {
        if already.contains(subscription.id.as_str()) {
            continue;
        }
        if !binding_is_current(state, executor).await? {
            summary.temporary += 1;
            summary.cancelled = true;
            return Ok(summary);
        }
        let send = tokio::time::timeout(
            PROVIDER_REQUEST_TIMEOUT,
            state.notifications.sender.send(&subscription, payload),
        );
        let outcome = tokio::select! {
            biased;
            _ = wait_for_binding_change(registry_changes, executor) => {
                summary.temporary += 1;
                summary.cancelled = true;
                return Ok(summary);
            },
            result = send => result.unwrap_or(PushDeliveryOutcome::TemporaryFailure),
        };
        match outcome {
            PushDeliveryOutcome::Sent => summary.sent_ids.push(subscription.id),
            PushDeliveryOutcome::TemporaryFailure => summary.temporary += 1,
            PushDeliveryOutcome::StaleEndpoint => {
                summary.stale += 1;
                state
                    .store
                    .disable_push_subscription_by_id(&subscription.id)
                    .await?;
            }
        }
    }
    Ok(summary)
}

pub async fn process_delivery_tick(state: &FederatorState) -> anyhow::Result<()> {
    for delivery in state.store.claim_local_deliveries().await? {
        let summary = deliver(
            state,
            &delivery.payload,
            &delivery.delivered_subscription_ids,
        )
        .await?;
        state
            .store
            .finish_local_delivery(&delivery, &summary)
            .await?;
    }
    process_executor_deliveries(state).await?;
    Ok(())
}

async fn process_executor_deliveries(state: &FederatorState) -> anyhow::Result<()> {
    let (_, executors) = state.store.executor_registry_snapshot().await?;
    let executors = executors
        .into_iter()
        .filter(|row| row.enabled && row.status != ExecutorStatus::Incompatible)
        .collect::<Vec<_>>();
    let mut tasks = tokio::task::JoinSet::new();
    for executor in executors {
        let state = state.clone();
        tasks.spawn(async move {
            if let Err(error) = process_executor(&state, &executor).await {
                tracing::debug!(executor_id = executor.id, %error, "executor notification source unavailable");
            }
        });
        if tasks.len() >= 4 {
            let _ = tasks.join_next().await;
        }
    }
    while tasks.join_next().await.is_some() {}
    Ok(())
}

async fn process_executor(
    state: &FederatorState,
    executor: &crate::registry::ExecutorRecord,
) -> anyhow::Result<()> {
    let mut registry_changes = state.registry_changes.subscribe();
    if !binding_is_current(state, executor).await? {
        return Ok(());
    }
    let claim = async {
        let endpoint = crate::registry::validate_executor_proxy_endpoint(&executor.base_url)
            .await
            .map_err(|error| anyhow::anyhow!(error.message().to_string()))?;
        let url = format!(
            "{}/v1/notifications/deliveries/claim",
            endpoint.base_url.trim_end_matches('/')
        );
        let body = Ok::<_, anyhow::Error>(
            endpoint
                .client
                .post(url)
                .header("x-kodex-api-version", crate::trust::FEDERATOR_API_VERSION)
                .header("x-kodex-expected-instance", &executor.instance_id)
                .json(&serde_json::json!({"limit": CLAIM_LIMIT}))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?,
        )?;
        Ok::<_, anyhow::Error>((endpoint, body))
    };
    let (endpoint, body): (
        crate::registry::ValidatedEndpoint,
        kodex_gateway::routes::notifications::NotificationClaimResponse,
    ) = tokio::select! {
        biased;
        _ = wait_for_binding_change(&mut registry_changes, executor) => return Ok(()),
        result = tokio::time::timeout(SOURCE_REQUEST_TIMEOUT, claim) => {
            result.map_err(|_| anyhow::anyhow!("executor notification claim timed out"))??
        }
    };
    for claim in body.claims {
        if !binding_is_current(state, executor).await? {
            return Ok(());
        }
        let mut payload = NotificationPayload {
            kind: match claim.payload.kind {
                kodex_gateway::notifications::NotificationKind::UnreadAgentMessage => {
                    "unreadAgentMessage"
                }
                kodex_gateway::notifications::NotificationKind::Test => "test",
            }
            .into(),
            executor_id: Some(executor.id.clone()),
            thread_id: claim.payload.thread_id,
            title: claim.payload.title,
            body: claim.payload.body,
            route: if claim.payload.route.starts_with('/') {
                format!("/executors/{}{}", executor.id, claim.payload.route)
            } else {
                "/".into()
            },
            badge_count: claim.payload.badge_count,
            read_revision: claim.payload.read_revision,
        };
        if let Ok(badge) = refresh_aggregate_badge(state).await {
            payload.badge_count = Some(badge.count);
            payload.read_revision = Some(badge.read_revision);
        }
        let summary = deliver_executor(
            state,
            executor,
            &mut registry_changes,
            &payload,
            &claim.delivered_subscription_ids,
        )
        .await?;
        let cancelled = summary.cancelled;
        let outcome_url = format!(
            "{}/v1/notifications/deliveries/{}/outcome",
            endpoint.base_url.trim_end_matches('/'),
            claim.delivery_id
        );
        tokio::time::timeout(
            SOURCE_REQUEST_TIMEOUT,
            endpoint.client.post(outcome_url).header("x-kodex-api-version", crate::trust::FEDERATOR_API_VERSION).header("x-kodex-expected-instance", &executor.instance_id).json(&serde_json::json!({"claimId": claim.claim_id, "deliveredSubscriptionIds": summary.sent_ids, "temporaryFailureCount": summary.temporary, "staleEndpointCount": summary.stale})).send(),
        )
        .await
        .map_err(|_| anyhow::anyhow!("executor notification outcome timed out"))??
        .error_for_status()?;
        if cancelled {
            return Ok(());
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeBadge {
    count: i64,
    read_revision: i64,
}

pub async fn refresh_aggregate_badge(
    state: &FederatorState,
) -> anyhow::Result<AggregateUnreadBadgeResponse> {
    let (_, executors) = state.store.executor_registry_snapshot().await?;
    let active = executors
        .into_iter()
        .filter(|row| row.enabled && row.status != ExecutorStatus::Incompatible)
        .collect::<Vec<_>>();
    let results = stream::iter(active)
        .map(|executor: crate::registry::ExecutorRecord| async move {
            let probe_lock = state.notifications.badge_probe_lock(&executor.id).await;
            let _probe_guard = probe_lock.lock().await;
            let result = tokio::time::timeout(SOURCE_REQUEST_TIMEOUT, async {
                let endpoint =
                    crate::registry::validate_executor_proxy_endpoint(&executor.base_url)
                        .await
                        .map_err(|error| anyhow::anyhow!(error.message().to_string()))?;
                let url = format!(
                    "{}/v1/threads/unread-badge",
                    endpoint.base_url.trim_end_matches('/')
                );
                let badge = endpoint
                    .client
                    .get(url)
                    .header("x-kodex-api-version", crate::trust::FEDERATOR_API_VERSION)
                    .header("x-kodex-expected-instance", &executor.instance_id)
                    .send()
                    .await?
                    .error_for_status()?
                    .json::<NativeBadge>()
                    .await?;
                Ok::<_, anyhow::Error>(badge)
            })
            .await
            .map_err(|_| anyhow::anyhow!("executor unread badge timed out"))
            .and_then(|result| result);
            state.store.record_badge_result(&executor, result).await
        })
        .buffer_unordered(4)
        .collect::<Vec<_>>()
        .await;
    for result in results {
        result?;
    }
    state.store.aggregate_badge().await
}

impl crate::store::Store {
    async fn record_badge_result(
        &self,
        executor: &crate::registry::ExecutorRecord,
        result: anyhow::Result<NativeBadge>,
    ) -> anyhow::Result<()> {
        let now = Utc::now().timestamp();
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let current: Option<(i64, String, String, bool, String)> = sqlx::query_as(
            "SELECT generation, instance_id, base_url, enabled, status FROM executors WHERE id=?",
        )
        .bind(&executor.id)
        .fetch_optional(&mut *transaction)
        .await?;
        if !current.is_some_and(|(generation, instance_id, base_url, enabled, status)| {
            enabled
                && status != ExecutorStatus::Incompatible.as_str()
                && generation == executor.generation
                && instance_id == executor.instance_id
                && base_url == executor.base_url
        }) {
            transaction.commit().await?;
            return Ok(());
        }
        let applied = match result {
            Ok(badge) => {
                sqlx::query("INSERT INTO executor_badges(executor_id,generation,count,native_read_revision,observed_at,last_error) VALUES(?,?,?,?,?,null) ON CONFLICT(executor_id) DO UPDATE SET generation=excluded.generation,count=excluded.count,native_read_revision=excluded.native_read_revision,observed_at=excluded.observed_at,last_error=null WHERE executor_badges.generation!=excluded.generation OR executor_badges.native_read_revision<=excluded.native_read_revision")
                .bind(&executor.id).bind(executor.generation).bind(badge.count).bind(badge.read_revision).bind(now).execute(&mut *transaction).await?.rows_affected() > 0
            }
            Err(error) => {
                sqlx::query(
                    "UPDATE executor_badges SET last_error=? WHERE executor_id=? AND generation=?",
                )
                .bind(error.to_string())
                .bind(&executor.id)
                .bind(executor.generation)
                .execute(&mut *transaction)
                .await?
                .rows_affected() > 0
            }
        };
        if !applied {
            transaction.commit().await?;
            return Ok(());
        }
        sqlx::query(
            "UPDATE federation_meta SET value=CAST(value AS INTEGER)+1 WHERE key='badge_revision'",
        )
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    async fn aggregate_badge(&self) -> anyhow::Result<AggregateUnreadBadgeResponse> {
        let mut transaction = self.pool.begin().await?;
        let revision: i64 = sqlx::query_scalar(
            "SELECT CAST(value AS INTEGER) FROM federation_meta WHERE key='badge_revision'",
        )
        .fetch_one(&mut *transaction)
        .await?;
        let active: Vec<(String, i64)> = sqlx::query_as(
            "SELECT id,generation FROM executors WHERE enabled=1 AND status!=? ORDER BY id",
        )
        .bind(ExecutorStatus::Incompatible.as_str())
        .fetch_all(&mut *transaction)
        .await?;
        let mut sources = vec![];
        for (executor_id, generation) in active {
            let row = sqlx::query("SELECT count,native_read_revision,observed_at,last_error FROM executor_badges WHERE executor_id=? AND generation=?").bind(&executor_id).bind(generation).fetch_optional(&mut *transaction).await?;
            if let Some(row) = row {
                sources.push(BadgeSource {
                    executor_id,
                    count: row.try_get("count")?,
                    native_read_revision: row.try_get("native_read_revision")?,
                    observed_at: row.try_get("observed_at")?,
                    available: row.try_get::<Option<String>, _>("last_error")?.is_none(),
                    error: row.try_get("last_error")?,
                });
            } else {
                sources.push(BadgeSource {
                    executor_id,
                    count: 0,
                    native_read_revision: 0,
                    observed_at: 0,
                    available: false,
                    error: Some("Unread badge has not been observed.".into()),
                });
            }
        }
        let response = AggregateUnreadBadgeResponse {
            count: sources.iter().map(|source| source.count).sum(),
            read_revision: revision,
            complete: sources.iter().all(|source| source.available),
            sources,
        };
        transaction.commit().await?;
        Ok(response)
    }
}

async fn wait_for_binding_change(
    changes: &mut tokio::sync::broadcast::Receiver<crate::RegistryChange>,
    expected: &crate::registry::ExecutorRecord,
) {
    loop {
        match changes.recv().await {
            Ok(change)
                if change.executor_id == expected.id
                    && change.generation != Some(expected.generation) =>
            {
                return;
            }
            Ok(_) => continue,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_))
            | Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
        }
    }
}

async fn binding_is_current(
    state: &FederatorState,
    expected: &crate::registry::ExecutorRecord,
) -> anyhow::Result<bool> {
    Ok(state
        .store
        .get_executor(&expected.id)
        .await?
        .is_some_and(|current| {
            current.enabled
                && current.generation == expected.generation
                && current.instance_id == expected.instance_id
                && current.base_url == expected.base_url
        }))
}
