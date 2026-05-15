use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::time::{sleep, Duration};
use utoipa::ToSchema;
use web_push::{
    ContentEncoding, IsahcWebPushClient, SubscriptionInfo, VapidSignatureBuilder, WebPushClient,
    WebPushError, WebPushMessageBuilder,
};

use crate::{
    api::AppState, app_server_api, config::NotificationsConfig, error::ApiResult,
    store::PushSubscription,
};

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPayload {
    pub kind: NotificationKind,
    pub thread_id: String,
    pub title: String,
    pub route: String,
    pub badge_count: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum NotificationKind {
    UnreadAgentMessage,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PushDeliveryOutcome {
    Sent,
    PermanentFailure,
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

#[derive(Debug, Default)]
pub struct NoopPushSender;

#[async_trait]
impl PushSender for NoopPushSender {
    async fn send(
        &self,
        _subscription: &PushSubscription,
        _payload: &NotificationPayload,
    ) -> PushDeliveryOutcome {
        PushDeliveryOutcome::Sent
    }
}

pub struct WebPushSenderImpl {
    client: IsahcWebPushClient,
    private_key: String,
    subject: String,
}

impl WebPushSenderImpl {
    pub fn new(private_key: String, subject: String) -> Result<Self, WebPushError> {
        Ok(Self {
            client: IsahcWebPushClient::new()?,
            private_key,
            subject,
        })
    }

    async fn send_inner(
        &self,
        subscription: &PushSubscription,
        payload: &NotificationPayload,
    ) -> Result<(), WebPushError> {
        let subscription_info = SubscriptionInfo::new(
            subscription.endpoint.as_str(),
            subscription.p256dh.as_str(),
            subscription.auth.as_str(),
        );
        let mut signature =
            VapidSignatureBuilder::from_base64(&self.private_key, &subscription_info)?;
        signature.add_claim("sub", self.subject.as_str());
        let signature = signature.build()?;
        let content = serde_json::to_vec(payload).map_err(|_| WebPushError::InvalidResponse)?;
        let mut message = WebPushMessageBuilder::new(&subscription_info);
        message.set_payload(ContentEncoding::Aes128Gcm, &content);
        message.set_vapid_signature(signature);
        self.client.send(message.build()?).await
    }
}

#[async_trait]
impl PushSender for WebPushSenderImpl {
    async fn send(
        &self,
        subscription: &PushSubscription,
        payload: &NotificationPayload,
    ) -> PushDeliveryOutcome {
        match self.send_inner(subscription, payload).await {
            Ok(()) => PushDeliveryOutcome::Sent,
            Err(error) if permanent_delivery_error(&error) => {
                tracing::warn!(%error, subscription_id = subscription.id, "permanent push delivery failure");
                PushDeliveryOutcome::PermanentFailure
            }
            Err(error) => {
                tracing::warn!(%error, subscription_id = subscription.id, "temporary push delivery failure");
                PushDeliveryOutcome::TemporaryFailure
            }
        }
    }
}

#[derive(Clone)]
pub struct NotificationService {
    sender: Arc<dyn PushSender>,
}

impl NotificationService {
    pub fn new(sender: Arc<dyn PushSender>) -> Self {
        Self { sender }
    }

    pub fn noop() -> Self {
        Self::new(Arc::new(NoopPushSender))
    }

    pub fn from_config(config: &NotificationsConfig) -> Self {
        if config.vapid_public_key.is_none() {
            return Self::noop();
        }
        let Some(private_key) = config.vapid_private_key.clone() else {
            return Self::noop();
        };
        let Some(subject) = config.vapid_subject.clone() else {
            return Self::noop();
        };
        match WebPushSenderImpl::new(private_key, subject) {
            Ok(sender) => Self::new(Arc::new(sender)),
            Err(error) => {
                tracing::warn!(%error, "falling back to no-op push notification sender");
                Self::noop()
            }
        }
    }

    pub fn schedule_unread_agent_message_recheck(
        &self,
        state: AppState,
        thread_id: String,
        delay: Duration,
    ) {
        tokio::spawn(async move {
            if !delay.is_zero() {
                sleep(delay).await;
            }
            if let Err(error) = deliver_unread_agent_message_if_still_unread(state, thread_id).await
            {
                tracing::debug!(%error, "skipped unread agent message push notification");
            }
        });
    }

    pub async fn deliver_payload(
        &self,
        state: &AppState,
        payload: NotificationPayload,
    ) -> ApiResult<()> {
        let subscriptions = state.store.list_enabled_push_subscriptions().await?;
        for subscription in subscriptions {
            match self.sender.send(&subscription, &payload).await {
                PushDeliveryOutcome::Sent => {}
                PushDeliveryOutcome::TemporaryFailure => {
                    tracing::warn!(
                        subscription_id = subscription.id,
                        "temporary push notification delivery failure"
                    );
                }
                PushDeliveryOutcome::PermanentFailure => {
                    tracing::warn!(
                        subscription_id = subscription.id,
                        "disabling stale push notification subscription"
                    );
                    state
                        .store
                        .disable_push_subscription(&subscription.id)
                        .await?;
                }
            }
        }
        Ok(())
    }
}

async fn deliver_unread_agent_message_if_still_unread(
    state: AppState,
    thread_id: String,
) -> ApiResult<()> {
    let mut snapshot = app_server_api::client(&state.app_server)
        .thread_read(thread_id.clone())
        .await?;
    let states = state
        .store
        .thread_read_states(std::slice::from_ref(&thread_id))
        .await?;
    let seen = states
        .get(&thread_id)
        .map(|state| state.seen_completed_agent_turn_seq)
        .unwrap_or_default();
    snapshot
        .thread
        .apply_completed_agent_turn_read_state(snapshot.thread.last_completed_agent_turn_seq, seen);
    if !snapshot.thread.unread_completed_agent_turn {
        return Ok(());
    }

    let badge_count = unread_badge_count(&state, &thread_id)
        .await
        .unwrap_or(1)
        .max(1);
    let title = snapshot
        .thread
        .name
        .clone()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "Unread Kodex message".to_string());
    let payload = NotificationPayload {
        kind: NotificationKind::UnreadAgentMessage,
        thread_id: thread_id.clone(),
        title,
        route: format!("/threads/{thread_id}"),
        badge_count,
    };
    state.notifications.deliver_payload(&state, payload).await
}

async fn unread_badge_count(state: &AppState, fallback_thread_id: &str) -> ApiResult<i64> {
    let response = app_server_api::client(&state.app_server)
        .thread_list(None, None, None)
        .await?;
    let mut thread_ids: Vec<String> = response
        .threads
        .iter()
        .map(|thread| thread.id.clone())
        .collect();
    if !thread_ids.iter().any(|id| id == fallback_thread_id) {
        thread_ids.push(fallback_thread_id.to_string());
    }
    let states = state.store.thread_read_states(&thread_ids).await?;
    let mut count = 0;
    for mut thread in response.threads {
        let seen = states
            .get(&thread.id)
            .map(|state| state.seen_completed_agent_turn_seq)
            .unwrap_or_default();
        thread.apply_completed_agent_turn_read_state(thread.last_completed_agent_turn_seq, seen);
        if thread.unread_completed_agent_turn {
            count += 1;
        }
    }
    Ok(count)
}

pub fn notification_planning_event_payload(thread_id: &str) -> serde_json::Value {
    json!({
        "kind": "unreadAgentMessage",
        "threadId": thread_id,
    })
}

fn permanent_delivery_error(error: &WebPushError) -> bool {
    matches!(
        error,
        WebPushError::BadRequest(_)
            | WebPushError::EndpointNotFound(_)
            | WebPushError::EndpointNotValid(_)
            | WebPushError::InvalidCryptoKeys
            | WebPushError::InvalidUri
            | WebPushError::MissingCryptoKeys
    )
}
