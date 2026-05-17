use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::RwLock;
use utoipa::ToSchema;

use crate::{
    app_server_api::{
        timeline_skill_mentions_from_user_input, visible_text_from_thread_item, ThreadItemSnapshot,
        ThreadLiveState, ThreadTimelineSnapshot, ThreadTimelineSnapshotItem, ThreadTurnSnapshot,
        TimelineItemUpsertPayload, TimelineUpdateSource, UserInput,
    },
    error::ApiResult,
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

#[derive(Debug, Clone, Default)]
pub struct ThreadSessionStore {
    sessions: Arc<RwLock<HashMap<String, ThreadSessionView>>>,
}

impl ThreadSessionStore {
    pub async fn refresh_from_turns(
        &self,
        thread_id: &str,
        turns: &[ThreadTurnSnapshot],
        revision: i64,
    ) -> ThreadTimelineSnapshot {
        let base = ThreadTimelineSnapshot::from_turns(thread_id, turns);
        let mut sessions = self.sessions.write().await;
        let view = sessions.entry(thread_id.to_string()).or_default();
        view.refresh_from_base(thread_id, base, revision)
    }

    pub async fn patch_for_thread(&self, thread_id: &str) -> TimelineProjectionPatch {
        let sessions = self.sessions.read().await;
        sessions
            .get(thread_id)
            .map(ThreadSessionView::to_patch)
            .unwrap_or_else(|| TimelineProjectionPatch {
                revision: 0,
                thread_id: thread_id.to_string(),
                active_turn_id: None,
                live_state: ThreadLiveState::Idle,
                items: Vec::new(),
            })
    }

    pub async fn active_turn_id(&self, thread_id: &str) -> Option<String> {
        self.sessions
            .read()
            .await
            .get(thread_id)
            .and_then(|view| view.active_turn_id.clone())
    }

    pub async fn live_state(&self, thread_id: &str) -> Option<ThreadLiveState> {
        self.sessions
            .read()
            .await
            .get(thread_id)
            .map(|view| view.live_state)
    }

    async fn with_thread_view<F, R>(&self, thread_id: &str, revision: i64, update: F) -> R
    where
        F: FnOnce(&mut ThreadSessionView) -> R,
    {
        let mut sessions = self.sessions.write().await;
        let view = sessions.entry(thread_id.to_string()).or_default();
        view.thread_id = thread_id.to_string();
        view.revision = view.revision.max(revision);
        update(view)
    }
}

#[derive(Debug, Clone, Default)]
struct ThreadSessionView {
    thread_id: String,
    revision: i64,
    active_turn_id: Option<String>,
    live_state: ThreadLiveState,
    items: Vec<ThreadTimelineSnapshotItem>,
}

impl ThreadSessionView {
    fn refresh_from_base(
        &mut self,
        thread_id: &str,
        mut base: ThreadTimelineSnapshot,
        revision: i64,
    ) -> ThreadTimelineSnapshot {
        let existing_items = std::mem::take(&mut self.items);
        let mut base_keys = base
            .items
            .iter()
            .map(|item| scoped_item_key(&item.turn_id, &item.item_id))
            .collect::<HashSet<_>>();
        let mut base_text_counts = base
            .items
            .iter()
            .filter_map(text_key_for_snapshot_item)
            .fold(HashMap::new(), |mut counts, key| {
                *counts.entry(key).or_insert(0) += 1;
                counts
            });

        let mut display_order = base
            .items
            .iter()
            .map(|item| item.display_order)
            .max()
            .unwrap_or(0);
        for item in existing_items {
            if base_keys.contains(&scoped_item_key(&item.turn_id, &item.item_id)) {
                consume_text_match(&item, &mut base_text_counts);
                continue;
            }
            if consume_text_match(&item, &mut base_text_counts) {
                continue;
            }
            if is_prunable_empty_reasoning(&item) {
                continue;
            }
            if is_live_status(&item.status) && base.active_turn_id.is_none() {
                base.active_turn_id = Some(item.turn_id.clone());
                base.live_state = ThreadLiveState::Streaming;
            }
            display_order += 1;
            let mut item = item;
            item.display_order = display_order;
            base_keys.insert(scoped_item_key(&item.turn_id, &item.item_id));
            base.items.push(item);
        }

        base.revision = self.revision.max(revision);
        self.thread_id = thread_id.to_string();
        self.revision = base.revision;
        self.active_turn_id = base.active_turn_id.clone();
        self.live_state = base.live_state;
        self.items = base.items.clone();
        base
    }

    fn upsert_item(
        &mut self,
        thread_id: &str,
        turn_id: &str,
        item: Value,
        item_snapshot: ThreadItemSnapshot,
        turn_status: Option<&str>,
        timestamp_ms: Option<i64>,
    ) {
        self.thread_id = thread_id.to_string();
        let status = turn_status
            .map(ToString::to_string)
            .unwrap_or_else(|| "running".to_string());
        let key = scoped_item_key(turn_id, &item_snapshot.id);
        remove_materialized_pending_match(&mut self.items, turn_id, &item_snapshot, &item);
        let display_order = self
            .items
            .iter()
            .find(|existing| scoped_item_key(&existing.turn_id, &existing.item_id) == key)
            .map(|existing| existing.display_order)
            .unwrap_or_else(|| next_display_order(&self.items));
        let next_item = ThreadTimelineSnapshotItem {
            id: format!("projection-{turn_id}-{}", item_snapshot.id),
            thread_id: thread_id.to_string(),
            turn_id: turn_id.to_string(),
            item_id: item_snapshot.id.clone(),
            item_type: item_snapshot.item_type.clone(),
            status: status.clone(),
            display_order,
            codex_method: "item/upsert".to_string(),
            timestamp_ms,
            payload: TimelineItemUpsertPayload {
                source: TimelineUpdateSource::GatewayStream,
                turn_id: turn_id.to_string(),
                item_id: item_snapshot.id.clone(),
                item,
                item_snapshot,
            },
        };
        replace_or_push(&mut self.items, key, next_item);
        if is_live_status(&status) {
            self.active_turn_id = Some(turn_id.to_string());
            self.live_state = ThreadLiveState::Streaming;
        }
    }

    fn append_delta(&mut self, thread_id: &str, turn_id: &str, item_id: &str, delta: &str) {
        self.thread_id = thread_id.to_string();
        let key = scoped_item_key(turn_id, item_id);
        let existing = self
            .items
            .iter()
            .find(|item| scoped_item_key(&item.turn_id, &item.item_id) == key);
        let mut item = existing
            .map(|item| item.payload.item.clone())
            .unwrap_or_else(|| json!({"id": item_id, "type": "agentMessage", "text": ""}));
        let current = item
            .get("text")
            .and_then(Value::as_str)
            .or_else(|| item.get("delta").and_then(Value::as_str))
            .unwrap_or_default()
            .to_string();
        if let Some(object) = item.as_object_mut() {
            object.insert("id".to_string(), Value::String(item_id.to_string()));
            object.insert(
                "type".to_string(),
                Value::String("agentMessage".to_string()),
            );
            object.insert(
                "text".to_string(),
                Value::String(format!("{current}{delta}")),
            );
        }
        if let Ok(item_snapshot) = ThreadItemSnapshot::from_payload(&item) {
            self.upsert_item(
                thread_id,
                turn_id,
                item,
                item_snapshot,
                Some("running"),
                Some(Utc::now().timestamp_millis()),
            );
        }
    }

    fn update_turn_status(&mut self, turn: &ThreadTurnSnapshot) {
        let terminal = is_terminal_turn_status(&turn.status);
        for item in &mut self.items {
            if item.turn_id == turn.id {
                item.status = if terminal {
                    "completed".to_string()
                } else {
                    turn.status.clone()
                };
            }
        }
        if terminal && self.active_turn_id.as_deref() == Some(&turn.id) {
            self.active_turn_id = None;
            self.live_state = ThreadLiveState::Idle;
        } else if !terminal {
            self.active_turn_id = Some(turn.id.clone());
            self.live_state = ThreadLiveState::Streaming;
        }
    }

    fn set_live_state(
        &mut self,
        live_state: ThreadLiveState,
        updated_active_turn_id: Option<String>,
    ) {
        self.live_state = live_state;
        match live_state {
            ThreadLiveState::Idle | ThreadLiveState::NotLoaded => {
                self.active_turn_id = None;
            }
            ThreadLiveState::Streaming | ThreadLiveState::Syncing => {
                if updated_active_turn_id.is_some() || self.active_turn_id.is_none() {
                    self.active_turn_id = updated_active_turn_id;
                }
            }
        }
    }

    fn to_patch(&self) -> TimelineProjectionPatch {
        let mut items = self.items.clone();
        items.sort_by_key(|item| item.display_order);
        TimelineProjectionPatch {
            revision: self.revision,
            thread_id: self.thread_id.clone(),
            active_turn_id: self.active_turn_id.clone(),
            live_state: self.live_state,
            items,
        }
    }
}

pub async fn build_thread_timeline(
    sessions: &ThreadSessionStore,
    thread_id: &str,
    turns: &[ThreadTurnSnapshot],
    revision: i64,
) -> ApiResult<ThreadTimelineSnapshot> {
    Ok(sessions
        .refresh_from_turns(thread_id, turns, revision)
        .await)
}

pub async fn projection_patch_for_thread(
    sessions: &ThreadSessionStore,
    thread_id: &str,
) -> ApiResult<TimelineProjectionPatch> {
    Ok(sessions.patch_for_thread(thread_id).await)
}

pub async fn record_item_upsert(
    sessions: &ThreadSessionStore,
    thread_id: &str,
    turn_id: &str,
    item: Value,
    mut item_snapshot: ThreadItemSnapshot,
    turn_status: Option<&str>,
    updated_seq: i64,
) -> ApiResult<()> {
    item_snapshot.raw_payload = item.clone();
    sessions
        .with_thread_view(thread_id, updated_seq, |view| {
            view.upsert_item(
                thread_id,
                turn_id,
                item,
                item_snapshot,
                turn_status,
                Some(Utc::now().timestamp_millis()),
            );
        })
        .await;
    Ok(())
}

pub async fn record_item_delta(
    sessions: &ThreadSessionStore,
    thread_id: &str,
    turn_id: &str,
    item_id: &str,
    delta: &str,
    updated_seq: i64,
) -> ApiResult<()> {
    sessions
        .with_thread_view(thread_id, updated_seq, |view| {
            view.append_delta(thread_id, turn_id, item_id, delta);
        })
        .await;
    Ok(())
}

pub async fn record_turn_status(
    sessions: &ThreadSessionStore,
    thread_id: &str,
    turn: &ThreadTurnSnapshot,
    updated_seq: i64,
) -> ApiResult<()> {
    sessions
        .with_thread_view(thread_id, updated_seq, |view| {
            view.update_turn_status(turn);
        })
        .await;
    Ok(())
}

pub async fn record_thread_live_state(
    sessions: &ThreadSessionStore,
    thread_id: &str,
    live_state: ThreadLiveState,
    updated_seq: i64,
) -> ApiResult<()> {
    sessions
        .with_thread_view(thread_id, updated_seq, |view| {
            view.set_live_state(live_state, None);
        })
        .await;
    Ok(())
}

pub async fn record_pending_user_input(
    sessions: &ThreadSessionStore,
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
    sessions
        .with_thread_view(thread_id, updated_seq, |view| {
            view.upsert_item(
                thread_id,
                turn_id,
                item,
                item_snapshot,
                Some("running"),
                Some(Utc::now().timestamp_millis()),
            );
        })
        .await;
    Ok(Some(text))
}

fn replace_or_push(
    items: &mut Vec<ThreadTimelineSnapshotItem>,
    key: String,
    item: ThreadTimelineSnapshotItem,
) {
    if let Some(existing) = items
        .iter_mut()
        .find(|existing| scoped_item_key(&existing.turn_id, &existing.item_id) == key)
    {
        *existing = item;
    } else {
        items.push(item);
    }
}

fn remove_materialized_pending_match(
    items: &mut Vec<ThreadTimelineSnapshotItem>,
    turn_id: &str,
    item_snapshot: &ThreadItemSnapshot,
    raw_item: &Value,
) {
    if !item_snapshot.item_type.eq_ignore_ascii_case("userMessage") {
        return;
    }
    let Some(text) = visible_text_from_thread_item(raw_item) else {
        return;
    };
    let key = scoped_text_key(turn_id, &item_snapshot.item_type, &text);
    items.retain(|item| {
        if !item.item_id.starts_with("pending-user-") {
            return true;
        }
        text_key_for_snapshot_item(item).is_none_or(|pending_key| pending_key != key)
    });
}

fn consume_text_match(
    item: &ThreadTimelineSnapshotItem,
    base_text_counts: &mut HashMap<String, usize>,
) -> bool {
    let Some(key) = text_key_for_snapshot_item(item) else {
        return false;
    };
    let Some(count) = base_text_counts.get_mut(&key) else {
        return false;
    };
    if *count == 0 {
        return false;
    }
    *count -= 1;
    true
}

fn text_key_for_snapshot_item(item: &ThreadTimelineSnapshotItem) -> Option<String> {
    let text = visible_text_from_thread_item(&item.payload.item)?;
    Some(scoped_text_key(&item.turn_id, &item.item_type, &text))
}

fn scoped_item_key(turn_id: &str, item_id: &str) -> String {
    format!("{turn_id}\0{item_id}")
}

fn scoped_text_key(turn_id: &str, item_type: &str, text: &str) -> String {
    format!(
        "{turn_id}\0{}\0{}",
        item_type.to_ascii_lowercase(),
        text.trim()
    )
}

fn next_display_order(items: &[ThreadTimelineSnapshotItem]) -> i64 {
    items
        .iter()
        .map(|item| item.display_order)
        .max()
        .unwrap_or(0)
        + 1
}

fn is_live_status(status: &str) -> bool {
    !is_terminal_turn_status(status)
}

fn is_terminal_turn_status(status: &str) -> bool {
    matches!(
        status.to_ascii_lowercase().as_str(),
        "completed" | "failed" | "cancelled" | "canceled" | "interrupted"
    )
}

fn is_prunable_empty_reasoning(item: &ThreadTimelineSnapshotItem) -> bool {
    let item_type = item.item_type.to_ascii_lowercase();
    if item_type != "reasoning" || is_live_status(&item.status) {
        return false;
    }
    let content_empty = item
        .payload
        .item
        .get("content")
        .and_then(Value::as_array)
        .is_none_or(Vec::is_empty);
    let summary_empty = item
        .payload
        .item
        .get("summary")
        .and_then(Value::as_array)
        .is_none_or(Vec::is_empty);
    content_empty && summary_empty
}

impl Default for ThreadLiveState {
    fn default() -> Self {
        Self::Idle
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent_message_item(id: &str, text: &str) -> Value {
        json!({
            "id": id,
            "type": "agentMessage",
            "text": text,
        })
    }

    #[tokio::test]
    async fn session_reconciles_pending_user_input_when_snapshot_materializes_item() {
        let sessions = ThreadSessionStore::default();
        record_pending_user_input(
            &sessions,
            "thread-1",
            "turn-1",
            &[UserInput::Text {
                text: "Hello".to_string(),
                text_elements: Vec::new(),
            }],
            1,
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

        let timeline = build_thread_timeline(&sessions, "thread-1", &[completed_turn], 2)
            .await
            .unwrap();

        assert_eq!(timeline.items.len(), 1);
        assert_eq!(timeline.items[0].item_id, "user-1");
        assert_eq!(timeline.live_state, ThreadLiveState::Idle);
    }

    #[tokio::test]
    async fn session_applies_live_delta_then_snapshot_without_duplicate() {
        let sessions = ThreadSessionStore::default();
        record_item_delta(&sessions, "thread-1", "turn-1", "agent-1", "Hello", 1)
            .await
            .unwrap();
        record_item_delta(&sessions, "thread-1", "turn-1", "agent-1", " world", 2)
            .await
            .unwrap();

        let patch = projection_patch_for_thread(&sessions, "thread-1")
            .await
            .unwrap();
        assert_eq!(patch.items.len(), 1);
        assert_eq!(patch.items[0].payload.item["text"], "Hello world");
        assert_eq!(patch.active_turn_id.as_deref(), Some("turn-1"));

        let completed_turn = ThreadTurnSnapshot {
            id: "turn-1".to_string(),
            status: "completed".to_string(),
            started_at: Some(1),
            completed_at: Some(2),
            raw_payload: json!({}),
            items: vec![ThreadItemSnapshot::from_payload(&agent_message_item(
                "agent-1",
                "Hello world",
            ))
            .unwrap()],
        };
        let timeline = build_thread_timeline(&sessions, "thread-1", &[completed_turn], 3)
            .await
            .unwrap();

        assert_eq!(timeline.items.len(), 1);
        assert_eq!(timeline.items[0].item_id, "agent-1");
        assert_eq!(timeline.active_turn_id, None);
    }
}
