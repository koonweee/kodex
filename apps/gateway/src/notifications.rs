use chrono::{Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::time::Duration;
use utoipa::ToSchema;

use crate::{
    api::AppState,
    app_server_api,
    error::ApiResult,
    store::{NewNotificationDelivery, NotificationDelivery},
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub badge_count: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_revision: Option<i64>,
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

const UNREAD_AGENT_MESSAGE_FALLBACK_THREAD_TITLE: &str = "New message";
const UNREAD_AGENT_MESSAGE_FALLBACK_BODY: &str = "Agent has a new message.";
const UNREAD_AGENT_MESSAGE_PREVIEW_MAX_CHARS: usize = 240;
const UNREAD_AGENT_MESSAGE_TITLE_MAX_CHARS: usize = 48;
const NOTIFICATION_PREVIEW_ITEM_LIMIT: u32 = 25;
const DELIVERY_CLAIM_LIMIT: i64 = 10;
const DELIVERY_PROCESSING_STALE_AFTER: ChronoDuration = ChronoDuration::minutes(5);
pub async fn enqueue_unread_agent_message_recheck(
    state: &AppState,
    thread_id: String,
    turn_id: Option<String>,
    delay: Duration,
) -> ApiResult<NotificationDelivery> {
    let available_at =
        Utc::now() + ChronoDuration::from_std(delay).unwrap_or_else(|_| ChronoDuration::zero());
    state
        .store
        .create_notification_delivery(NewNotificationDelivery {
            kind: NotificationKind::UnreadAgentMessage.as_str().to_string(),
            thread_id: Some(thread_id),
            turn_id,
            payload: None,
            available_at,
        })
        .await
}

pub async fn claim_federated_deliveries(
    state: &AppState,
    limit: i64,
) -> ApiResult<Vec<crate::routes::notifications::NotificationDeliveryClaim>> {
    let now = Utc::now();
    let claimed = state
        .store
        .claim_due_notification_deliveries_for_federator(
            limit.clamp(1, DELIVERY_CLAIM_LIMIT),
            now,
            now - DELIVERY_PROCESSING_STALE_AFTER,
        )
        .await?;
    let mut ready = Vec::new();
    for claim in claimed {
        match notification_payload_for_delivery(state, &claim.delivery).await {
            Ok(Some(payload)) => {
                ready.push(crate::routes::notifications::NotificationDeliveryClaim {
                    delivery_id: claim.delivery.id,
                    claim_id: claim.claim_id,
                    attempt_count: claim.delivery.attempt_count,
                    payload,
                    delivered_subscription_ids: claim.delivery.delivered_subscription_ids,
                })
            }
            Ok(None) => {
                state
                    .store
                    .complete_federated_notification_claim(
                        &claim.delivery.id,
                        &claim.claim_id,
                        &[],
                        0,
                        0,
                        None,
                    )
                    .await?;
            }
            Err(error) => {
                state
                    .store
                    .complete_federated_notification_claim(
                        &claim.delivery.id,
                        &claim.claim_id,
                        &[],
                        1,
                        0,
                        None,
                    )
                    .await?;
                tracing::warn!(delivery_id = claim.delivery.id, %error, "notification preview preparation failed");
            }
        }
    }
    Ok(ready)
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
            agent_message_payload_for_delivery(state, thread_id, delivery.turn_id.clone()).await
        }
        _ => Ok(None),
    }
}

async fn agent_message_payload_for_delivery(
    state: &AppState,
    thread_id: String,
    turn_id: Option<String>,
) -> ApiResult<Option<NotificationPayload>> {
    if !state.store.thread_notifications_enabled(&thread_id).await? {
        tracing::debug!(
            thread_id,
            reason = "disabled_by_thread_setting",
            "skipped unread agent message push notification"
        );
        return Ok(None);
    }

    let thread = app_server_api::client(&state.app_server)
        .thread_read_summary(thread_id.clone())
        .await?;
    if suppress_unread_agent_message_notification(&thread.raw_payload) {
        tracing::debug!(
            thread_id,
            reason = "suppressed_by_thread_source",
            "skipped unread agent message push notification"
        );
        return Ok(None);
    }

    if state.thread_presence.is_viewed(&thread_id) {
        tracing::debug!(
            thread_id,
            reason = "foreground_viewer_present",
            "skipped unread agent message push notification"
        );
        return Ok(None);
    }

    let body = agent_message_body_for_delivery(state, &thread_id, turn_id).await?;
    let badge = crate::read_state::unread_badge(state).await.ok();
    let thread_title = thread
        .name
        .as_deref()
        .and_then(notification_title_text)
        .unwrap_or_else(|| UNREAD_AGENT_MESSAGE_FALLBACK_THREAD_TITLE.to_string());
    let payload = NotificationPayload {
        kind: NotificationKind::UnreadAgentMessage,
        thread_id: Some(thread_id.clone()),
        title: thread_title.clone(),
        body: Some(body),
        route: format!("/threads/{thread_id}"),
        badge_count: badge.as_ref().map(|badge| badge.count),
        read_revision: badge.map(|badge| badge.read_revision),
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

async fn agent_message_body_for_delivery(
    state: &AppState,
    thread_id: &str,
    turn_id: Option<String>,
) -> ApiResult<String> {
    let Some(turn_id) = turn_id else {
        return Ok(UNREAD_AGENT_MESSAGE_FALLBACK_BODY.to_string());
    };
    let page = app_server_api::client(&state.app_server)
        .thread_items_list_page(
            thread_id.to_string(),
            Some(turn_id),
            None,
            app_server_api::SortDirection::Desc,
            Some(NOTIFICATION_PREVIEW_ITEM_LIMIT),
        )
        .await?;
    Ok(
        final_agent_message_preview(page.data.iter().map(|entry| &entry.item))
            .unwrap_or_else(|| UNREAD_AGENT_MESSAGE_FALLBACK_BODY.to_string()),
    )
}

fn final_agent_message_preview<'a>(
    items: impl Iterator<Item = &'a app_server_api::ThreadItemSnapshot>,
) -> Option<String> {
    let mut fallback = None;
    for item in items {
        if item.item_type != "agentMessage" {
            continue;
        }
        let Some(text) = item
            .raw_payload
            .get("text")
            .and_then(serde_json::Value::as_str)
            .and_then(notification_preview_text)
        else {
            continue;
        };
        if item
            .raw_payload
            .get("phase")
            .and_then(serde_json::Value::as_str)
            == Some("final_answer")
        {
            return Some(text);
        }
        if fallback.is_none() {
            fallback = Some(text);
        }
    }
    fallback
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

pub fn notification_planning_event_payload(thread_id: &str) -> serde_json::Value {
    json!({
        "kind": "unreadAgentMessage",
        "threadId": thread_id,
    })
}

#[cfg(test)]
mod tests;
