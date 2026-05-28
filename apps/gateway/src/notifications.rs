use std::{collections::HashSet, sync::Arc};

use async_trait::async_trait;
use chrono::{Duration as ChronoDuration, Utc};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::time::{sleep, Duration};
use utoipa::ToSchema;
use web_push::{
    ContentEncoding, IsahcWebPushClient, SubscriptionInfo, VapidSignatureBuilder, WebPushClient,
    WebPushError, WebPushMessageBuilder,
};

use crate::{
    api::AppState,
    app_server_api,
    config::NotificationsConfig,
    error::ApiResult,
    store::{NewNotificationDelivery, NotificationDelivery, PushSubscription},
};

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPayload {
    pub kind: NotificationKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    pub route: String,
    pub badge_count: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum NotificationKind {
    UnreadAgentMessage,
    Test,
}

impl NotificationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnreadAgentMessage => "unreadAgentMessage",
            Self::Test => "test",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PushDeliveryOutcome {
    Sent,
    StaleEndpoint,
    TemporaryFailure,
}

const UNREAD_AGENT_MESSAGE_FALLBACK_THREAD_TITLE: &str = "New message";
const UNREAD_AGENT_MESSAGE_FALLBACK_BODY: &str = "Agent has a new message.";
const UNREAD_AGENT_MESSAGE_PREVIEW_MAX_CHARS: usize = 240;
const UNREAD_AGENT_MESSAGE_TITLE_MAX_CHARS: usize = 48;
const DELIVERY_CLAIM_LIMIT: i64 = 10;
const DELIVERY_MAX_ATTEMPTS: i64 = 3;
const DELIVERY_PROCESSING_STALE_AFTER: ChronoDuration = ChronoDuration::minutes(5);
const DELIVERY_WORKER_POLL_INTERVAL: Duration = Duration::from_secs(1);

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
            Err(error) if stale_endpoint_error(&error) => {
                tracing::warn!(%error, subscription_id = subscription.id, "stale push endpoint");
                PushDeliveryOutcome::StaleEndpoint
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

    pub async fn enqueue_unread_agent_message_recheck(
        &self,
        state: &AppState,
        thread_id: String,
        turn_id: Option<String>,
        delay: Duration,
    ) -> ApiResult<NotificationDelivery> {
        let available_at =
            Utc::now() + ChronoDuration::from_std(delay).unwrap_or_else(|_| ChronoDuration::zero());
        let delivery = state
            .store
            .create_notification_delivery(NewNotificationDelivery {
                kind: NotificationKind::UnreadAgentMessage.as_str().to_string(),
                thread_id: Some(thread_id),
                turn_id,
                payload: None,
                available_at,
            })
            .await?;
        Ok(delivery)
    }

    pub async fn enqueue_test_notification(
        &self,
        state: &AppState,
    ) -> ApiResult<NotificationDelivery> {
        let payload = NotificationPayload {
            kind: NotificationKind::Test,
            thread_id: None,
            title: "Kodex test notification".to_string(),
            body: Some("Push notifications are working.".to_string()),
            route: "/".to_string(),
            badge_count: 0,
        };
        let delivery = state
            .store
            .create_notification_delivery(NewNotificationDelivery {
                kind: NotificationKind::Test.as_str().to_string(),
                thread_id: None,
                turn_id: None,
                payload: Some(serde_json::to_value(payload)?),
                available_at: Utc::now(),
            })
            .await?;
        Ok(delivery)
    }

    pub fn start_delivery_worker(&self, state: AppState) {
        tokio::spawn(async move {
            loop {
                if let Err(error) = process_due_deliveries(state.clone()).await {
                    tracing::warn!(%error, "notification delivery worker tick failed");
                }
                sleep(DELIVERY_WORKER_POLL_INTERVAL).await;
            }
        });
    }

    pub async fn deliver_payload(
        &self,
        state: &AppState,
        payload: NotificationPayload,
    ) -> ApiResult<()> {
        self.deliver_payload_to_enabled_subscriptions(state, &payload, None, 1, &[])
            .await?;
        Ok(())
    }

    async fn deliver_payload_to_enabled_subscriptions(
        &self,
        state: &AppState,
        payload: &NotificationPayload,
        delivery_id: Option<&str>,
        attempt_count: i64,
        delivered_subscription_ids: &[String],
    ) -> ApiResult<DeliveryAttemptSummary> {
        let subscriptions = state.store.list_enabled_push_subscriptions().await?;
        let delivered_subscription_ids = delivered_subscription_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let mut summary = DeliveryAttemptSummary::default();
        for subscription in subscriptions {
            if delivered_subscription_ids.contains(subscription.id.as_str()) {
                continue;
            }
            let endpoint_host = endpoint_host(&subscription.endpoint);
            match self.sender.send(&subscription, payload).await {
                PushDeliveryOutcome::Sent => {
                    summary.sent_count += 1;
                    summary.sent_subscription_ids.push(subscription.id.clone());
                    tracing::debug!(
                        delivery_id,
                        attempt_count,
                        subscription_id = subscription.id,
                        endpoint_host,
                        "push notification delivery accepted"
                    );
                }
                PushDeliveryOutcome::TemporaryFailure => {
                    summary.temporary_failure_count += 1;
                    tracing::warn!(
                        delivery_id,
                        attempt_count,
                        subscription_id = subscription.id,
                        endpoint_host,
                        classification = "temporary",
                        "temporary push notification delivery failure"
                    );
                }
                PushDeliveryOutcome::StaleEndpoint => {
                    summary.stale_endpoint_count += 1;
                    tracing::warn!(
                        delivery_id,
                        attempt_count,
                        subscription_id = subscription.id,
                        endpoint_host,
                        classification = "stale_endpoint",
                        "disabling stale push notification subscription"
                    );
                    state
                        .store
                        .disable_push_subscription(&subscription.id)
                        .await?;
                }
            }
        }
        Ok(summary)
    }
}

#[derive(Debug, Default)]
struct DeliveryAttemptSummary {
    sent_count: usize,
    temporary_failure_count: usize,
    stale_endpoint_count: usize,
    sent_subscription_ids: Vec<String>,
}

pub async fn process_due_deliveries(state: AppState) -> ApiResult<()> {
    let now = Utc::now();
    let stale_before = now - DELIVERY_PROCESSING_STALE_AFTER;
    let deliveries = state
        .store
        .claim_due_notification_deliveries(DELIVERY_CLAIM_LIMIT, now, stale_before)
        .await?;
    for delivery in deliveries {
        if let Err(error) = process_delivery(state.clone(), delivery.clone()).await {
            let message = error.to_string();
            let should_retry = delivery.attempt_count < DELIVERY_MAX_ATTEMPTS;
            if should_retry {
                let available_at = Utc::now() + retry_delay(delivery.attempt_count);
                state
                    .store
                    .mark_notification_delivery_retry(
                        &delivery.id,
                        available_at,
                        message,
                        &delivery.delivered_subscription_ids,
                    )
                    .await?;
            } else {
                state
                    .store
                    .mark_notification_delivery_failed(
                        &delivery.id,
                        message,
                        None,
                        &delivery.delivered_subscription_ids,
                    )
                    .await?;
            }
        }
    }
    Ok(())
}

async fn process_delivery(state: AppState, delivery: NotificationDelivery) -> ApiResult<()> {
    let payload = notification_payload_for_delivery(&state, &delivery).await?;
    let Some(payload) = payload else {
        state
            .store
            .mark_notification_delivery_sent(
                &delivery.id,
                None,
                &delivery.delivered_subscription_ids,
            )
            .await?;
        return Ok(());
    };
    let payload_json = serde_json::to_value(&payload)?;
    let mut delivered_subscription_ids = delivery.delivered_subscription_ids.clone();
    let summary = state
        .notifications
        .deliver_payload_to_enabled_subscriptions(
            &state,
            &payload,
            Some(&delivery.id),
            delivery.attempt_count,
            &delivered_subscription_ids,
        )
        .await?;
    for subscription_id in summary.sent_subscription_ids {
        if !delivered_subscription_ids.contains(&subscription_id) {
            delivered_subscription_ids.push(subscription_id);
        }
    }
    if summary.temporary_failure_count > 0 {
        if delivery.attempt_count < DELIVERY_MAX_ATTEMPTS {
            let available_at = Utc::now() + retry_delay(delivery.attempt_count);
            state
                .store
                .mark_notification_delivery_retry(
                    &delivery.id,
                    available_at,
                    format!(
                        "{} temporary push delivery failure(s)",
                        summary.temporary_failure_count
                    ),
                    &delivered_subscription_ids,
                )
                .await?;
        } else {
            state
                .store
                .mark_notification_delivery_failed(
                    &delivery.id,
                    format!(
                        "{} temporary push delivery failure(s)",
                        summary.temporary_failure_count
                    ),
                    Some(&payload_json),
                    &delivered_subscription_ids,
                )
                .await?;
        }
        return Ok(());
    }
    if summary.stale_endpoint_count > 0 && delivered_subscription_ids.is_empty() {
        state
            .store
            .mark_notification_delivery_failed(
                &delivery.id,
                format!("{} stale push endpoint(s)", summary.stale_endpoint_count),
                Some(&payload_json),
                &delivered_subscription_ids,
            )
            .await?;
        return Ok(());
    }
    state
        .store
        .mark_notification_delivery_sent(
            &delivery.id,
            Some(&payload_json),
            &delivered_subscription_ids,
        )
        .await?;
    Ok(())
}

async fn notification_payload_for_delivery(
    state: &AppState,
    delivery: &NotificationDelivery,
) -> ApiResult<Option<NotificationPayload>> {
    if let Some(payload) = delivery.payload.clone() {
        return Ok(Some(serde_json::from_value(payload)?));
    }
    match delivery.kind.as_str() {
        "unreadAgentMessage" => {
            let Some(thread_id) = delivery.thread_id.clone() else {
                return Ok(None);
            };
            unread_agent_message_payload_if_still_unread(state, thread_id).await
        }
        _ => Ok(None),
    }
}

async fn unread_agent_message_payload_if_still_unread(
    state: &AppState,
    thread_id: String,
) -> ApiResult<Option<NotificationPayload>> {
    if !state.store.thread_notifications_enabled(&thread_id).await? {
        tracing::debug!(
            thread_id,
            reason = "disabled_by_thread_setting",
            "skipped unread agent message push notification"
        );
        return Ok(None);
    }

    let snapshot = app_server_api::client(&state.app_server)
        .thread_read(thread_id.clone())
        .await?;
    if suppress_unread_agent_message_notification(&snapshot.thread.raw_payload) {
        tracing::debug!(
            thread_id,
            reason = "suppressed_by_thread_source",
            "skipped unread agent message push notification"
        );
        return Ok(None);
    }

    let badge_count = unread_badge_count(&state, &thread_id)
        .await
        .unwrap_or(1)
        .max(1);
    let thread_title = snapshot
        .thread
        .name
        .as_deref()
        .and_then(notification_title_text)
        .unwrap_or_else(|| UNREAD_AGENT_MESSAGE_FALLBACK_THREAD_TITLE.to_string());
    let body = unread_agent_message_body(&snapshot);
    let payload = NotificationPayload {
        kind: NotificationKind::UnreadAgentMessage,
        thread_id: Some(thread_id.clone()),
        title: thread_title.clone(),
        body: Some(body),
        route: format!("/threads/{thread_id}"),
        badge_count,
    };
    Ok(Some(payload))
}

fn suppress_unread_agent_message_notification(thread: &serde_json::Value) -> bool {
    thread
        .get("source")
        .and_then(|source| source.get("subAgent"))
        .is_some()
        || thread
            .get("threadSource")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|source| matches!(source, "subagent" | "memory_consolidation"))
}

fn unread_agent_message_body(snapshot: &app_server_api::ThreadDetailResponse) -> String {
    match final_agent_message_preview(snapshot) {
        Some(preview) => preview,
        None => UNREAD_AGENT_MESSAGE_FALLBACK_BODY.to_string(),
    }
}

fn final_agent_message_preview(snapshot: &app_server_api::ThreadDetailResponse) -> Option<String> {
    snapshot
        .turns
        .iter()
        .rev()
        .filter(|turn| is_terminal_turn_status(&turn.status))
        .find_map(final_agent_message_preview_from_turn)
}

fn final_agent_message_preview_from_turn(
    turn: &app_server_api::ThreadTurnSnapshot,
) -> Option<String> {
    let mut fallback = None;
    for item in turn.items.iter().rev() {
        if !is_agent_message_item(&item.item_type) {
            continue;
        }
        let Some(text) = agent_message_text(&item.raw_payload) else {
            continue;
        };
        if is_final_answer_item(&item.raw_payload) {
            return Some(text);
        }
        if fallback.is_none() {
            fallback = Some(text);
        }
    }
    fallback
}

fn is_agent_message_item(item_type: &str) -> bool {
    matches!(
        item_type.to_ascii_lowercase().as_str(),
        "agentmessage" | "agent_message" | "assistantmessage" | "assistant_message"
    )
}

fn is_terminal_turn_status(status: &str) -> bool {
    matches!(
        status.to_ascii_lowercase().as_str(),
        "completed" | "failed" | "cancelled" | "canceled" | "interrupted"
    )
}

fn is_final_answer_item(item: &serde_json::Value) -> bool {
    item.get("phase")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|phase| phase.eq_ignore_ascii_case("final_answer"))
}

fn agent_message_text(item: &serde_json::Value) -> Option<String> {
    string_field(item, &["text", "message"])
        .and_then(|text| notification_preview_text(&text))
        .or_else(|| {
            content_array_text(item.get("content"))
                .and_then(|text| notification_preview_text(&text))
        })
}

fn content_array_text(value: Option<&serde_json::Value>) -> Option<String> {
    let parts = value?
        .as_array()?
        .iter()
        .filter_map(|part| string_field(part, &["text", "content"]))
        .collect::<Vec<_>>();
    if parts.is_empty() {
        return None;
    }
    Some(parts.join(" "))
}

fn string_field(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(serde_json::Value::as_str))
        .map(str::to_string)
}

fn notification_preview_text(text: &str) -> Option<String> {
    notification_text(text, UNREAD_AGENT_MESSAGE_PREVIEW_MAX_CHARS)
}

fn notification_title_text(text: &str) -> Option<String> {
    notification_text(text, UNREAD_AGENT_MESSAGE_TITLE_MAX_CHARS)
}

fn notification_text(text: &str, max_chars: usize) -> Option<String> {
    let mut normalized = String::new();
    let mut previous_was_space = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            if !previous_was_space {
                normalized.push(' ');
                previous_was_space = true;
            }
            continue;
        }
        if ch.is_control() {
            continue;
        }
        normalized.push(ch);
        previous_was_space = false;
    }
    let normalized = normalized.trim();
    if normalized.is_empty() {
        return None;
    }
    Some(truncate_preview(normalized, max_chars))
}

fn truncate_preview(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_none() {
        return truncated;
    }
    let trimmed = truncated.trim_end();
    format!("{trimmed}...")
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

fn retry_delay(attempt_count: i64) -> ChronoDuration {
    ChronoDuration::seconds((attempt_count.max(1) * 2).min(30))
}

fn endpoint_host(endpoint: &str) -> Option<String> {
    Url::parse(endpoint)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
}

fn stale_endpoint_error(error: &WebPushError) -> bool {
    matches!(
        error,
        WebPushError::EndpointNotFound(_) | WebPushError::EndpointNotValid(_)
    )
}
