use std::collections::{HashMap, HashSet};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use utoipa::ToSchema;

use crate::{
    app_server_api::{
        timeline_skill_mentions_from_user_input, visible_text_from_thread_item, ThreadItemSnapshot,
        ThreadLiveState, ThreadTimelineSnapshot, ThreadTimelineSnapshotItem, ThreadTurnSnapshot,
        TimelineItemUpsertPayload, TimelineUpdateSource, UserInput,
    },
    error::ApiResult,
    store::{NewTimelineProjectionItemRecord, Store, TimelineProjectionItemRecord},
};

pub const TIMELINE_PROJECTION_PATCH_KIND: &str = "timeline.projection_patch";

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TimelineProjectionPatch {
    pub revision: i64,
    pub thread_id: String,
    pub active_turn_id: Option<String>,
    pub live_state: ThreadLiveState,
    pub items: Vec<ThreadTimelineSnapshotItem>,
}

pub async fn build_thread_timeline(
    store: &Store,
    thread_id: &str,
    turns: &[ThreadTurnSnapshot],
    revision: i64,
) -> ApiResult<ThreadTimelineSnapshot> {
    let mut snapshot = ThreadTimelineSnapshot::from_turns(thread_id, turns);
    let base_item_ids = snapshot
        .items
        .iter()
        .map(|item| scoped_item_key(&item.turn_id, &item.item_id))
        .collect::<HashSet<_>>();
    let mut base_text_counts =
        snapshot
            .items
            .iter()
            .filter_map(base_text_key)
            .fold(HashMap::new(), |mut counts, key| {
                *counts.entry(key).or_insert(0) += 1;
                counts
            });
    let overlays = store
        .timeline_projection_items_through_seq(thread_id, Some(revision))
        .await?;
    let mut display_order = snapshot
        .items
        .iter()
        .map(|item| item.display_order)
        .max()
        .unwrap_or(0);
    let mut reconciled_items = Vec::new();
    for overlay in overlays {
        if base_item_ids.contains(&scoped_item_key(&overlay.turn_id, &overlay.item_id)) {
            consume_base_text_match(&overlay, &mut base_text_counts);
            reconciled_items.push((overlay.turn_id, overlay.item_id));
            continue;
        }
        if consume_matching_materialized_overlay(&overlay, &mut base_text_counts) {
            reconciled_items.push((overlay.turn_id, overlay.item_id));
            continue;
        }
        if projection_item_is_prunable_empty_reasoning(&overlay) {
            reconciled_items.push((overlay.turn_id, overlay.item_id));
            continue;
        }
        display_order += 1;
        if projection_item_is_live(&overlay.status) && snapshot.active_turn_id.is_none() {
            snapshot.active_turn_id = Some(overlay.turn_id.clone());
        }
        if projection_item_is_live(&overlay.status) {
            snapshot.live_state = ThreadLiveState::Streaming;
        }
        snapshot
            .items
            .push(projection_record_to_snapshot_item(overlay, display_order));
    }
    if !reconciled_items.is_empty() {
        store
            .delete_timeline_projection_items(thread_id, &reconciled_items, revision)
            .await?;
    }
    snapshot.revision = revision;
    Ok(snapshot)
}

pub async fn projection_patch_for_thread(
    store: &Store,
    thread_id: &str,
) -> ApiResult<TimelineProjectionPatch> {
    let overlays = store.timeline_projection_items(thread_id).await?;
    let revision = overlays
        .iter()
        .map(|item| item.updated_seq)
        .max()
        .unwrap_or_else(|| 0);
    let active_turn_id = overlays
        .iter()
        .rev()
        .find(|item| projection_item_is_live(&item.status))
        .map(|item| item.turn_id.clone());
    let items = overlays
        .into_iter()
        .map(|item| {
            let display_order = item.updated_seq;
            projection_record_to_snapshot_item(item, display_order)
        })
        .collect::<Vec<_>>();
    let live_state = if active_turn_id.is_some() {
        ThreadLiveState::Streaming
    } else {
        ThreadLiveState::Idle
    };
    Ok(TimelineProjectionPatch {
        revision,
        thread_id: thread_id.to_string(),
        active_turn_id,
        live_state,
        items,
    })
}

pub async fn record_item_upsert(
    store: &Store,
    thread_id: &str,
    turn_id: &str,
    item: Value,
    mut item_snapshot: ThreadItemSnapshot,
    turn_status: Option<&str>,
    updated_seq: i64,
) -> ApiResult<()> {
    item_snapshot.raw_payload = item.clone();
    let status = turn_status
        .map(ToString::to_string)
        .unwrap_or_else(|| "running".to_string());
    store
        .upsert_timeline_projection_item(NewTimelineProjectionItemRecord {
            thread_id: thread_id.to_string(),
            turn_id: turn_id.to_string(),
            item_id: item_snapshot.id.clone(),
            item_type: item_snapshot.item_type.clone(),
            status,
            item,
            item_snapshot,
            timestamp_ms: Some(Utc::now().timestamp_millis()),
            updated_seq,
        })
        .await
}

pub async fn record_item_delta(
    store: &Store,
    thread_id: &str,
    turn_id: &str,
    item_id: &str,
    delta: &str,
    updated_seq: i64,
) -> ApiResult<()> {
    store
        .append_timeline_projection_item_delta(thread_id, turn_id, item_id, delta, updated_seq)
        .await
}

pub async fn record_turn_status(
    store: &Store,
    thread_id: &str,
    turn: &ThreadTurnSnapshot,
    updated_seq: i64,
) -> ApiResult<()> {
    store
        .update_timeline_projection_turn_status(thread_id, &turn.id, &turn.status, updated_seq)
        .await
}

pub async fn record_pending_user_input(
    store: &Store,
    thread_id: &str,
    turn_id: &str,
    input: &[UserInput],
    updated_seq: i64,
) -> ApiResult<Option<String>> {
    let Some((text, _mentions)) = timeline_skill_mentions_from_user_input(input, &[]) else {
        return Ok(None);
    };
    let Ok(content) = serde_json::to_value(input) else {
        return Ok(None);
    };
    let item_id = format!("pending-user-{updated_seq}");
    let item = json!({
        "id": item_id,
        "type": "userMessage",
        "content": content,
    });
    let mut item_snapshot = ThreadItemSnapshot::from_payload(&item)?;
    item_snapshot.raw_payload = item.clone();
    store
        .upsert_timeline_projection_item(NewTimelineProjectionItemRecord {
            thread_id: thread_id.to_string(),
            turn_id: turn_id.to_string(),
            item_id: item_id.clone(),
            item_type: item_snapshot.item_type.clone(),
            status: "running".to_string(),
            item,
            item_snapshot,
            timestamp_ms: Some(Utc::now().timestamp_millis()),
            updated_seq,
        })
        .await?;
    Ok(Some(text))
}

fn projection_record_to_snapshot_item(
    item: TimelineProjectionItemRecord,
    display_order: i64,
) -> ThreadTimelineSnapshotItem {
    ThreadTimelineSnapshotItem {
        id: format!("projection-{}-{}", item.turn_id, item.item_id),
        thread_id: item.thread_id.clone(),
        turn_id: item.turn_id.clone(),
        item_id: item.item_id.clone(),
        item_type: item.item_type.clone(),
        status: item.status.clone(),
        display_order,
        codex_method: "item/upsert".to_string(),
        timestamp_ms: item.timestamp_ms,
        payload: TimelineItemUpsertPayload {
            source: TimelineUpdateSource::GatewayStream,
            turn_id: item.turn_id,
            item_id: item.item_id,
            item: item.item,
            item_snapshot: item.item_snapshot,
        },
    }
}

fn scoped_item_key(turn_id: &str, item_id: &str) -> String {
    format!("{turn_id}\0{item_id}")
}

fn base_text_key(item: &ThreadTimelineSnapshotItem) -> Option<String> {
    let text = materialized_item_text(&item.payload.item)?;
    Some(scoped_text_key(&item.turn_id, &item.item_type, &text))
}

fn consume_matching_materialized_overlay(
    item: &TimelineProjectionItemRecord,
    base_text_counts: &mut HashMap<String, usize>,
) -> bool {
    let item_type = item.item_type.to_ascii_lowercase();
    if !item_type.contains("user") && projection_item_is_live(&item.status) {
        return false;
    }
    consume_base_text_match(item, base_text_counts)
}

fn consume_base_text_match(
    item: &TimelineProjectionItemRecord,
    base_text_counts: &mut HashMap<String, usize>,
) -> bool {
    let Some(text) = materialized_item_text(&item.item) else {
        return false;
    };
    let key = scoped_text_key(&item.turn_id, &item.item_type, &text);
    let Some(count) = base_text_counts.get_mut(&key) else {
        return false;
    };
    if *count == 0 {
        return false;
    }
    *count -= 1;
    true
}

fn scoped_text_key(turn_id: &str, item_type: &str, text: &str) -> String {
    format!("{}\0{}\0{}", turn_id, item_type.to_ascii_lowercase(), text)
}

fn materialized_item_text(item: &Value) -> Option<String> {
    if let Some(text) = visible_text_from_thread_item(item) {
        return Some(text);
    }
    for key in ["text", "message", "content", "summary"] {
        if let Some(text) = non_empty_string(item.get(key)) {
            return Some(text.to_string());
        }
    }
    if let Some(text) = item
        .get("summary")
        .and_then(Value::as_array)
        .and_then(|summary| content_array_text(summary))
    {
        return Some(text);
    }
    item.get("content")
        .and_then(Value::as_array)
        .and_then(|content| content_array_text(content))
}

fn content_array_text(content: &[Value]) -> Option<String> {
    let text = content
        .iter()
        .filter_map(|entry| {
            if let Some(text) = entry.as_str() {
                return Some(text.to_string());
            }
            let entry_type = entry
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_ascii_lowercase();
            if matches!(
                entry_type.as_str(),
                "image"
                    | "input_image"
                    | "inputimage"
                    | "local_image"
                    | "localimage"
                    | "mention"
                    | "skill"
            ) {
                return None;
            }
            non_empty_string(entry.get("text"))
                .or_else(|| non_empty_string(entry.get("content")))
                .map(str::to_string)
        })
        .collect::<Vec<_>>()
        .join("\n");
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn non_empty_string(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

fn projection_item_is_live(status: &str) -> bool {
    !matches!(
        status.to_ascii_lowercase().as_str(),
        "completed" | "failed" | "cancelled" | "canceled" | "interrupted"
    )
}

fn projection_item_is_prunable_empty_reasoning(item: &TimelineProjectionItemRecord) -> bool {
    !projection_item_is_live(&item.status)
        && item.item_type.eq_ignore_ascii_case("reasoning")
        && materialized_item_text(&item.item).is_none()
}

pub fn agent_message_item(item_id: &str, text: &str) -> Value {
    json!({
        "id": item_id,
        "type": "agentMessage",
        "text": text,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::store::Store;

    #[tokio::test]
    async fn projection_overlays_live_rows_without_replacing_completed_history() {
        let store = Store::in_memory().await.unwrap();
        let thread_id = "thread-1";
        let live_event = store
            .append_event(crate::store::NewEvent {
                project_id: None,
                thread_id: Some(thread_id.to_string()),
                turn_id: Some("turn-2".to_string()),
                item_id: Some("agent-live".to_string()),
                kind: "timeline.item_upsert".to_string(),
                codex_method: Some("item/upsert".to_string()),
                payload: json!({}),
            })
            .await
            .unwrap();
        let completed_turn = ThreadTurnSnapshot {
            id: "turn-1".to_string(),
            status: "completed".to_string(),
            started_at: Some(1),
            completed_at: Some(2),
            raw_payload: json!({}),
            items: vec![ThreadItemSnapshot::from_payload(&json!({
                "id": "agent-1",
                "type": "agentMessage",
                "text": "Done"
            }))
            .unwrap()],
        };
        let live_item = agent_message_item("agent-live", "Still working");
        let live_snapshot = ThreadItemSnapshot::from_payload(&live_item).unwrap();
        record_item_upsert(
            &store,
            thread_id,
            "turn-2",
            live_item,
            live_snapshot,
            Some("running"),
            live_event.seq,
        )
        .await
        .unwrap();

        let timeline = build_thread_timeline(&store, thread_id, &[completed_turn], 1)
            .await
            .unwrap();

        assert_eq!(timeline.revision, 1);
        assert_eq!(timeline.live_state, ThreadLiveState::Streaming);
        assert_eq!(timeline.active_turn_id.as_deref(), Some("turn-2"));
        assert_eq!(timeline.items.len(), 2);
        assert_eq!(timeline.items[0].item_id, "agent-1");
        assert_eq!(timeline.items[1].item_id, "agent-live");
        assert_eq!(
            timeline.items[1].payload.source,
            TimelineUpdateSource::GatewayStream
        );
    }

    #[tokio::test]
    async fn projection_revision_excludes_overlay_rows_newer_than_snapshot_high_water() {
        let store = Store::in_memory().await.unwrap();
        let thread_id = "thread-1";
        let included = store
            .append_event(crate::store::NewEvent {
                project_id: None,
                thread_id: Some(thread_id.to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("agent-included".to_string()),
                kind: "timeline.item_upsert".to_string(),
                codex_method: Some("item/upsert".to_string()),
                payload: json!({}),
            })
            .await
            .unwrap();
        record_item_delta(
            &store,
            thread_id,
            "turn-1",
            "agent-included",
            "Included",
            included.seq,
        )
        .await
        .unwrap();
        let high_water = store.latest_event_seq().await.unwrap();
        let newer = store
            .append_event(crate::store::NewEvent {
                project_id: None,
                thread_id: Some(thread_id.to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("agent-newer".to_string()),
                kind: "timeline.item_upsert".to_string(),
                codex_method: Some("item/upsert".to_string()),
                payload: json!({}),
            })
            .await
            .unwrap();
        record_item_delta(
            &store,
            thread_id,
            "turn-1",
            "agent-newer",
            "Newer",
            newer.seq,
        )
        .await
        .unwrap();

        let overlays = store
            .timeline_projection_items_through_seq(thread_id, Some(high_water))
            .await
            .unwrap();

        assert_eq!(overlays.len(), 1);
        assert_eq!(overlays[0].item_id, "agent-included");
    }

    #[tokio::test]
    async fn terminal_overlays_remain_until_app_server_history_contains_matching_items() {
        let store = Store::in_memory().await.unwrap();
        let thread_id = "thread-1";
        let live_event = store
            .append_event(crate::store::NewEvent {
                project_id: None,
                thread_id: Some(thread_id.to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("agent-1".to_string()),
                kind: "timeline.item_upsert".to_string(),
                codex_method: Some("item/upsert".to_string()),
                payload: json!({}),
            })
            .await
            .unwrap();
        let live_item = agent_message_item("agent-1", "Hello from the live stream");
        let live_snapshot = ThreadItemSnapshot::from_payload(&live_item).unwrap();
        record_item_upsert(
            &store,
            thread_id,
            "turn-1",
            live_item,
            live_snapshot,
            Some("running"),
            live_event.seq,
        )
        .await
        .unwrap();
        let terminal = store
            .append_event(crate::store::NewEvent {
                project_id: None,
                thread_id: Some(thread_id.to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: None,
                kind: "timeline.turn_upsert".to_string(),
                codex_method: Some("turn/upsert".to_string()),
                payload: json!({}),
            })
            .await
            .unwrap();
        let terminal_turn = ThreadTurnSnapshot {
            id: "turn-1".to_string(),
            status: "completed".to_string(),
            started_at: Some(1),
            completed_at: Some(2),
            raw_payload: json!({}),
            items: Vec::new(),
        };
        record_turn_status(&store, thread_id, &terminal_turn, terminal.seq)
            .await
            .unwrap();

        let stale_timeline = build_thread_timeline(&store, thread_id, &[], terminal.seq)
            .await
            .unwrap();

        assert_eq!(stale_timeline.revision, terminal.seq);
        assert_eq!(stale_timeline.live_state, ThreadLiveState::Idle);
        assert_eq!(stale_timeline.active_turn_id, None);
        assert_eq!(stale_timeline.items.len(), 1);
        assert_eq!(stale_timeline.items[0].item_id, "agent-1");
        assert_eq!(stale_timeline.items[0].status, "completed");

        let completed_turn = ThreadTurnSnapshot {
            id: "turn-1".to_string(),
            status: "completed".to_string(),
            started_at: Some(1),
            completed_at: Some(2),
            raw_payload: json!({}),
            items: vec![ThreadItemSnapshot::from_payload(&json!({
                "id": "agent-1",
                "type": "agentMessage",
                "text": "Hello from app-server history"
            }))
            .unwrap()],
        };

        let reconciled_timeline =
            build_thread_timeline(&store, thread_id, &[completed_turn], terminal.seq)
                .await
                .unwrap();
        let remaining_overlays = store.timeline_projection_items(thread_id).await.unwrap();

        assert_eq!(reconciled_timeline.items.len(), 1);
        assert_eq!(reconciled_timeline.items[0].item_id, "agent-1");
        assert!(remaining_overlays.is_empty());
    }

    #[tokio::test]
    async fn pending_user_overlay_reconciles_when_matching_user_item_materializes() {
        let store = Store::in_memory().await.unwrap();
        let thread_id = "thread-1";
        let pending = store
            .append_event(crate::store::NewEvent {
                project_id: None,
                thread_id: Some(thread_id.to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: None,
                kind: "timeline.pending_user_input".to_string(),
                codex_method: Some("turn/input".to_string()),
                payload: json!({}),
            })
            .await
            .unwrap();
        record_pending_user_input(
            &store,
            thread_id,
            "turn-1",
            &[UserInput::Text {
                text: "Hello".to_string(),
                text_elements: Vec::new(),
            }],
            pending.seq,
        )
        .await
        .unwrap();
        let completed_turn = ThreadTurnSnapshot {
            id: "turn-1".to_string(),
            status: "completed".to_string(),
            started_at: Some(1),
            completed_at: Some(2),
            raw_payload: json!({}),
            items: vec![ThreadItemSnapshot::from_payload(&json!({
                "id": "user-1",
                "type": "userMessage",
                "content": [{"type": "text", "text": "Hello"}]
            }))
            .unwrap()],
        };

        let timeline = build_thread_timeline(&store, thread_id, &[completed_turn], pending.seq)
            .await
            .unwrap();
        let remaining_overlays = store.timeline_projection_items(thread_id).await.unwrap();

        assert_eq!(timeline.items.len(), 1);
        assert_eq!(timeline.items[0].item_id, "user-1");
        assert!(remaining_overlays.is_empty());
    }

    #[tokio::test]
    async fn completed_stream_overlays_reconcile_when_app_server_uses_different_item_ids() {
        let store = Store::in_memory().await.unwrap();
        let thread_id = "thread-1";
        let user_event = store
            .append_event(crate::store::NewEvent {
                project_id: None,
                thread_id: Some(thread_id.to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("live-user-1".to_string()),
                kind: "timeline.item_upsert".to_string(),
                codex_method: Some("item/upsert".to_string()),
                payload: json!({}),
            })
            .await
            .unwrap();
        let live_user = json!({
            "id": "live-user-1",
            "type": "userMessage",
            "content": [{"type": "text", "text": "Search Google for OpenAI news"}]
        });
        record_item_upsert(
            &store,
            thread_id,
            "turn-1",
            live_user.clone(),
            ThreadItemSnapshot::from_payload(&live_user).unwrap(),
            Some("completed"),
            user_event.seq,
        )
        .await
        .unwrap();
        let agent_event = store
            .append_event(crate::store::NewEvent {
                project_id: None,
                thread_id: Some(thread_id.to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("live-agent-1".to_string()),
                kind: "timeline.item_upsert".to_string(),
                codex_method: Some("item/upsert".to_string()),
                payload: json!({}),
            })
            .await
            .unwrap();
        let live_agent = agent_message_item("live-agent-1", "Here are two OpenAI news items.");
        record_item_upsert(
            &store,
            thread_id,
            "turn-1",
            live_agent.clone(),
            ThreadItemSnapshot::from_payload(&live_agent).unwrap(),
            Some("completed"),
            agent_event.seq,
        )
        .await
        .unwrap();
        let completed_turn = ThreadTurnSnapshot {
            id: "turn-1".to_string(),
            status: "completed".to_string(),
            started_at: Some(1),
            completed_at: Some(2),
            raw_payload: json!({}),
            items: vec![
                ThreadItemSnapshot::from_payload(&json!({
                    "id": "item-1",
                    "type": "userMessage",
                    "content": [{"type": "text", "text": "Search Google for OpenAI news"}]
                }))
                .unwrap(),
                ThreadItemSnapshot::from_payload(&json!({
                    "id": "item-2",
                    "type": "agentMessage",
                    "text": "Here are two OpenAI news items."
                }))
                .unwrap(),
            ],
        };

        let timeline = build_thread_timeline(&store, thread_id, &[completed_turn], agent_event.seq)
            .await
            .unwrap();
        let remaining_overlays = store.timeline_projection_items(thread_id).await.unwrap();

        assert_eq!(timeline.items.len(), 2);
        assert_eq!(timeline.items[0].item_id, "item-1");
        assert_eq!(timeline.items[1].item_id, "item-2");
        assert!(remaining_overlays.is_empty());
    }

    #[tokio::test]
    async fn exact_id_reconciliation_consumes_text_match_one_for_one() {
        let store = Store::in_memory().await.unwrap();
        let thread_id = "thread-1";
        let exact_event = store
            .append_event(crate::store::NewEvent {
                project_id: None,
                thread_id: Some(thread_id.to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("agent-1".to_string()),
                kind: "timeline.item_upsert".to_string(),
                codex_method: Some("item/upsert".to_string()),
                payload: json!({}),
            })
            .await
            .unwrap();
        let exact_agent = agent_message_item("agent-1", "Repeated");
        record_item_upsert(
            &store,
            thread_id,
            "turn-1",
            exact_agent.clone(),
            ThreadItemSnapshot::from_payload(&exact_agent).unwrap(),
            Some("completed"),
            exact_event.seq,
        )
        .await
        .unwrap();
        let duplicate_event = store
            .append_event(crate::store::NewEvent {
                project_id: None,
                thread_id: Some(thread_id.to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("agent-2".to_string()),
                kind: "timeline.item_upsert".to_string(),
                codex_method: Some("item/upsert".to_string()),
                payload: json!({}),
            })
            .await
            .unwrap();
        let duplicate_agent = agent_message_item("agent-2", "Repeated");
        record_item_upsert(
            &store,
            thread_id,
            "turn-1",
            duplicate_agent.clone(),
            ThreadItemSnapshot::from_payload(&duplicate_agent).unwrap(),
            Some("completed"),
            duplicate_event.seq,
        )
        .await
        .unwrap();
        let completed_turn = ThreadTurnSnapshot {
            id: "turn-1".to_string(),
            status: "completed".to_string(),
            started_at: Some(1),
            completed_at: Some(2),
            raw_payload: json!({}),
            items: vec![ThreadItemSnapshot::from_payload(&json!({
                "id": "agent-1",
                "type": "agentMessage",
                "text": "Repeated"
            }))
            .unwrap()],
        };

        let timeline =
            build_thread_timeline(&store, thread_id, &[completed_turn], duplicate_event.seq)
                .await
                .unwrap();
        let remaining_overlays = store.timeline_projection_items(thread_id).await.unwrap();

        assert_eq!(timeline.items.len(), 2);
        assert_eq!(timeline.items[0].item_id, "agent-1");
        assert_eq!(timeline.items[1].item_id, "agent-2");
        assert_eq!(remaining_overlays.len(), 1);
        assert_eq!(remaining_overlays[0].item_id, "agent-2");
    }

    #[tokio::test]
    async fn terminal_empty_reasoning_overlays_are_pruned_but_summaries_remain() {
        let store = Store::in_memory().await.unwrap();
        let thread_id = "thread-1";
        let empty_event = store
            .append_event(crate::store::NewEvent {
                project_id: None,
                thread_id: Some(thread_id.to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("reasoning-empty".to_string()),
                kind: "timeline.item_upsert".to_string(),
                codex_method: Some("item/upsert".to_string()),
                payload: json!({}),
            })
            .await
            .unwrap();
        let empty_reasoning = json!({
            "id": "reasoning-empty",
            "type": "reasoning",
            "content": [],
            "summary": []
        });
        record_item_upsert(
            &store,
            thread_id,
            "turn-1",
            empty_reasoning.clone(),
            ThreadItemSnapshot::from_payload(&empty_reasoning).unwrap(),
            Some("completed"),
            empty_event.seq,
        )
        .await
        .unwrap();
        let summary_event = store
            .append_event(crate::store::NewEvent {
                project_id: None,
                thread_id: Some(thread_id.to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("reasoning-summary".to_string()),
                kind: "timeline.item_upsert".to_string(),
                codex_method: Some("item/upsert".to_string()),
                payload: json!({}),
            })
            .await
            .unwrap();
        let summary_reasoning = json!({
            "id": "reasoning-summary",
            "type": "reasoning",
            "content": [],
            "summary": [{"type": "summary_text", "text": "Need current sources."}]
        });
        record_item_upsert(
            &store,
            thread_id,
            "turn-1",
            summary_reasoning.clone(),
            ThreadItemSnapshot::from_payload(&summary_reasoning).unwrap(),
            Some("completed"),
            summary_event.seq,
        )
        .await
        .unwrap();

        let timeline = build_thread_timeline(&store, thread_id, &[], summary_event.seq)
            .await
            .unwrap();
        let remaining_overlays = store.timeline_projection_items(thread_id).await.unwrap();

        assert_eq!(timeline.items.len(), 1);
        assert_eq!(timeline.items[0].item_id, "reasoning-summary");
        assert_eq!(remaining_overlays.len(), 1);
        assert_eq!(remaining_overlays[0].item_id, "reasoning-summary");
    }

    #[tokio::test]
    async fn pending_user_overlay_keeps_accepted_turn_active_until_materialized() {
        let store = Store::in_memory().await.unwrap();
        let thread_id = "thread-1";
        let pending = store
            .append_event(crate::store::NewEvent {
                project_id: None,
                thread_id: Some(thread_id.to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: None,
                kind: "timeline.pending_user_input".to_string(),
                codex_method: Some("turn/input".to_string()),
                payload: json!({}),
            })
            .await
            .unwrap();
        record_pending_user_input(
            &store,
            thread_id,
            "turn-1",
            &[UserInput::Text {
                text: "Hello".to_string(),
                text_elements: Vec::new(),
            }],
            pending.seq,
        )
        .await
        .unwrap();

        let timeline = build_thread_timeline(&store, thread_id, &[], pending.seq)
            .await
            .unwrap();

        assert_eq!(timeline.active_turn_id.as_deref(), Some("turn-1"));
        assert_eq!(timeline.live_state, ThreadLiveState::Streaming);
        assert_eq!(timeline.items.len(), 1);
        assert_eq!(
            timeline.items[0].item_id,
            format!("pending-user-{}", pending.seq)
        );
        assert_eq!(timeline.items[0].status, "running");
    }

    #[tokio::test]
    async fn duplicate_pending_user_overlays_reconcile_one_for_one() {
        let store = Store::in_memory().await.unwrap();
        let thread_id = "thread-1";
        for seq in 1..=2 {
            let pending = store
                .append_event(crate::store::NewEvent {
                    project_id: None,
                    thread_id: Some(thread_id.to_string()),
                    turn_id: Some("turn-1".to_string()),
                    item_id: None,
                    kind: "timeline.pending_user_input".to_string(),
                    codex_method: Some("turn/input".to_string()),
                    payload: json!({}),
                })
                .await
                .unwrap();
            assert_eq!(pending.seq, seq);
            record_pending_user_input(
                &store,
                thread_id,
                "turn-1",
                &[UserInput::Text {
                    text: "Repeat".to_string(),
                    text_elements: Vec::new(),
                }],
                pending.seq,
            )
            .await
            .unwrap();
        }
        let partially_materialized_turn = ThreadTurnSnapshot {
            id: "turn-1".to_string(),
            status: "running".to_string(),
            started_at: Some(1),
            completed_at: None,
            raw_payload: json!({}),
            items: vec![ThreadItemSnapshot::from_payload(&json!({
                "id": "user-1",
                "type": "userMessage",
                "content": [{"type": "text", "text": "Repeat"}]
            }))
            .unwrap()],
        };

        let timeline = build_thread_timeline(&store, thread_id, &[partially_materialized_turn], 2)
            .await
            .unwrap();
        let remaining_overlays = store.timeline_projection_items(thread_id).await.unwrap();

        assert_eq!(timeline.items.len(), 2);
        assert_eq!(timeline.items[0].item_id, "user-1");
        assert_eq!(
            timeline.items[1].payload.item["content"][0]["text"],
            "Repeat"
        );
        assert_eq!(remaining_overlays.len(), 1);
        assert!(remaining_overlays[0].item_id.starts_with("pending-user-"));
    }
}
