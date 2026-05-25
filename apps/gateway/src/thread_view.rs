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
        canonical_timeline_item_id, thread_timeline_rows_from_items,
        timeline_skill_mentions_from_user_input, visible_text_from_thread_item,
        PendingTimelineRequestSummary, ThreadItemSnapshot, ThreadLiveState, ThreadTimelineRow,
        ThreadTimelineSnapshot, ThreadTimelineSnapshotItem, ThreadTimelineSnapshotTurn,
        ThreadTimelineWindowPage, ThreadTurnSnapshot, TimelineItemUpsertPayload,
        TimelineUpdateSource, UserInput,
    },
    error::ApiResult,
    store::Approval,
};

// ThreadView is the gateway-owned live projection of upstream app-server thread
// state. The app-server remains the durable transcript owner; this reducer only
// folds snapshots, live deltas, pending local input, and approvals into one
// canonical view for the browser. Browser clients should render snapshots and
// `thread_view.patch` rows from this module, not raw app-server item events.
pub const THREAD_VIEW_PATCH_EVENT_KIND: &str = "thread_view.patch";
pub const THREAD_VIEW_REFRESH_REQUIRED_EVENT_KIND: &str = "thread_view.refresh_required";

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadViewPatch {
    pub view_revision: i64,
    pub thread_id: String,
    pub active_turn_id: Option<String>,
    pub live_state: ThreadLiveState,
    pub pending_approval_requests: Vec<PendingTimelineRequestSummary>,
    pub pending_user_input_requests: Vec<PendingTimelineRequestSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<Vec<ThreadTimelineRow>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub upsert_rows: Vec<ThreadTimelineRow>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub remove_row_ids: Vec<String>,
    pub turns: Vec<ThreadTimelineSnapshotTurn>,
    pub items: Vec<ThreadTimelineSnapshotItem>,
}

#[derive(Debug, Clone, Default)]
pub struct ThreadViewStore {
    sessions: Arc<RwLock<HashMap<String, ThreadView>>>,
}

impl ThreadViewStore {
    pub async fn refresh_from_turns(
        &self,
        thread_id: &str,
        turns: &[ThreadTurnSnapshot],
        revision: i64,
    ) -> ThreadTimelineSnapshot {
        let mut sessions = self.sessions.write().await;
        let view = sessions.entry(thread_id.to_string()).or_default();
        let incoming_ids = turns
            .iter()
            .map(|turn| turn.id.clone())
            .collect::<HashSet<_>>();
        let mut next_turns = view
            .history_turns
            .iter()
            .filter(|turn| !incoming_ids.contains(&turn.id))
            .cloned()
            .collect::<Vec<_>>();
        next_turns.extend(turns.iter().cloned());
        view.history_turns = next_turns;
        if let Some(history_page) = &mut view.history_page {
            history_page.loaded_turn_count = view.history_turns.len() as u32;
        }
        let base = ThreadTimelineSnapshot::from_turns(thread_id, &view.history_turns);
        view.refresh_from_base(thread_id, base, revision)
    }

    pub async fn refresh_from_history_window(
        &self,
        thread_id: &str,
        turns: &[ThreadTurnSnapshot],
        mut history_page: Option<ThreadTimelineWindowPage>,
        revision: i64,
    ) -> ThreadTimelineSnapshot {
        let mut sessions = self.sessions.write().await;
        let view = sessions.entry(thread_id.to_string()).or_default();
        let reset_window = history_page
            .as_ref()
            .is_some_and(|history_page| history_page.reset_window);
        if reset_window {
            view.items.retain(|item| is_live_status(&item.status));
            let live_turn_ids = view
                .items
                .iter()
                .map(|item| item.turn_id.clone())
                .collect::<HashSet<_>>();
            view.turns.retain(|turn| live_turn_ids.contains(&turn.id));
        }
        let mut next_turns = Vec::new();
        if !reset_window {
            let incoming_ids = turns
                .iter()
                .map(|turn| turn.id.clone())
                .collect::<HashSet<_>>();
            next_turns = view
                .history_turns
                .iter()
                .filter(|turn| !incoming_ids.contains(&turn.id))
                .cloned()
                .collect::<Vec<_>>();
        }
        next_turns.extend(turns.iter().cloned());
        let existing_history_page = view.history_page.clone();
        if let Some(history_page) = &mut history_page {
            history_page.loaded_turn_count = next_turns.len() as u32;
            if let Some(existing) = existing_history_page.as_ref().filter(|_| !reset_window) {
                history_page.older_cursor = existing.older_cursor.clone();
                history_page.has_older = existing.has_older;
            }
            if existing_history_page
                .as_ref()
                .is_some_and(|existing| !existing.has_older && !reset_window)
            {
                history_page.older_cursor = None;
                history_page.has_older = false;
            }
        }
        view.history_turns = next_turns;
        view.history_page = history_page;
        let base = ThreadTimelineSnapshot::from_turns(thread_id, &view.history_turns);
        view.refresh_from_base(thread_id, base, revision)
    }

    pub async fn prepend_history_page(
        &self,
        thread_id: &str,
        turns: &[ThreadTurnSnapshot],
        mut history_page: Option<ThreadTimelineWindowPage>,
        revision: i64,
    ) -> ThreadTimelineSnapshot {
        let mut sessions = self.sessions.write().await;
        let view = sessions.entry(thread_id.to_string()).or_default();
        let mut next_turns = turns.to_vec();
        let mut seen = next_turns
            .iter()
            .map(|turn| turn.id.clone())
            .collect::<HashSet<_>>();
        next_turns.extend(
            view.history_turns
                .iter()
                .filter(|turn| seen.insert(turn.id.clone()))
                .cloned(),
        );
        if let Some(history_page) = &mut history_page {
            history_page.loaded_turn_count = next_turns.len() as u32;
        }
        view.history_turns = next_turns;
        view.history_page = history_page;
        let base = ThreadTimelineSnapshot::from_turns(thread_id, &view.history_turns);
        view.refresh_from_base(thread_id, base, revision)
    }

    pub async fn history_page(&self, thread_id: &str) -> Option<ThreadTimelineWindowPage> {
        self.sessions
            .read()
            .await
            .get(thread_id)
            .and_then(|view| view.history_page.clone())
    }

    pub async fn patch_for_thread(&self, thread_id: &str) -> ThreadViewPatch {
        let sessions = self.sessions.read().await;
        sessions
            .get(thread_id)
            .map(ThreadView::to_patch)
            .unwrap_or_else(|| ThreadViewPatch {
                view_revision: 0,
                thread_id: thread_id.to_string(),
                active_turn_id: None,
                live_state: ThreadLiveState::Idle,
                pending_approval_requests: Vec::new(),
                pending_user_input_requests: Vec::new(),
                rows: Some(Vec::new()),
                upsert_rows: Vec::new(),
                remove_row_ids: Vec::new(),
                turns: Vec::new(),
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
        F: FnOnce(&mut ThreadView) -> R,
    {
        let mut sessions = self.sessions.write().await;
        let view = sessions.entry(thread_id.to_string()).or_default();
        view.thread_id = thread_id.to_string();
        view.revision = view.revision.max(revision);
        update(view)
    }
}

#[derive(Debug, Clone, Default)]
struct ThreadView {
    thread_id: String,
    revision: i64,
    active_turn_id: Option<String>,
    live_state: ThreadLiveState,
    pending_approval_requests: Vec<PendingTimelineRequestSummary>,
    pending_user_input_requests: Vec<PendingTimelineRequestSummary>,
    turns: Vec<ThreadTimelineSnapshotTurn>,
    items: Vec<ThreadTimelineSnapshotItem>,
    terminal_turn_ids: HashSet<String>,
    history_turns: Vec<ThreadTurnSnapshot>,
    history_page: Option<ThreadTimelineWindowPage>,
}

impl ThreadView {
    fn refresh_from_base(
        &mut self,
        thread_id: &str,
        mut base: ThreadTimelineSnapshot,
        revision: i64,
    ) -> ThreadTimelineSnapshot {
        let existing_items = std::mem::take(&mut self.items);
        let existing_turns = std::mem::take(&mut self.turns);
        let mut base_item_indexes = base
            .items
            .iter()
            .enumerate()
            .map(|(index, item)| (scoped_item_key(&item.turn_id, &item.item_id), index))
            .collect::<HashMap<_, _>>();
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
        let base_text_keys = base_text_counts.keys().cloned().collect::<HashSet<_>>();

        let mut display_order = base
            .items
            .iter()
            .map(|item| item.display_order)
            .max()
            .unwrap_or(0);
        for item in existing_items {
            let key = scoped_item_key(&item.turn_id, &item.item_id);
            if let Some(base_index) = base_item_indexes.get(&key).copied() {
                if should_preserve_live_item_over_snapshot(&item, &base.items[base_index]) {
                    let display_order = base.items[base_index].display_order;
                    let mut preserved_item = item.clone();
                    preserved_item.display_order = display_order;
                    base.items[base_index] = preserved_item;
                }
                continue;
            }
            if text_key_for_snapshot_item(&item).is_some_and(|key| base_text_keys.contains(&key)) {
                continue;
            }
            if consume_text_match(&item, &mut base_text_counts) {
                continue;
            }
            if is_prunable_empty_reasoning(&item) {
                continue;
            }
            if is_prunable_missing_context_compaction(&item, &base.turns) {
                continue;
            }
            if is_live_status(&item.status) && base.active_turn_id.is_none() {
                base.active_turn_id = Some(item.turn_id.clone());
                base.live_state = ThreadLiveState::Streaming;
            }
            display_order += 1;
            let mut item = item;
            item.display_order = display_order;
            let inserted_key = scoped_item_key(&item.turn_id, &item.item_id);
            base_keys.insert(inserted_key.clone());
            base_item_indexes.insert(inserted_key, base.items.len());
            base.items.push(item);
        }

        base.view_revision = self.revision.max(revision);
        base.pending_approval_requests = self.pending_approval_requests.clone();
        base.pending_user_input_requests = self.pending_user_input_requests.clone();
        merge_missing_turns(&mut base.turns, &existing_turns, &base.items);
        base.turns = ordered_turns_for_items(&base.turns, &base.items);
        base.rows = thread_timeline_rows_from_items(
            base.active_turn_id.as_deref(),
            base.live_state,
            &base.turns,
            &base.items,
        );
        self.thread_id = thread_id.to_string();
        self.revision = base.view_revision;
        self.active_turn_id = base.active_turn_id.clone();
        self.live_state = base.live_state;
        self.turns = base.turns.clone();
        self.items = base.items.clone();
        self.terminal_turn_ids = base
            .turns
            .iter()
            .filter(|turn| is_terminal_turn_status(&turn.status))
            .map(|turn| turn.id.clone())
            .collect();
        base
    }

    fn upsert_item(
        &mut self,
        thread_id: &str,
        turn_id: &str,
        item: Value,
        item_snapshot: ThreadItemSnapshot,
        item_status: Option<&str>,
        timestamp_ms: Option<i64>,
    ) {
        self.thread_id = thread_id.to_string();
        let status = item_status
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
            id: canonical_timeline_item_id(turn_id, &item_snapshot.id),
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
        if self.terminal_turn_ids.contains(turn_id) {
            return;
        }
        // App-server item completion is not turn completion. A turn remains live
        // until a turn snapshot or explicit runtime state marks it terminal.
        let turn_status = if is_terminal_turn_status(&status) {
            "running"
        } else {
            status.as_str()
        };
        self.upsert_turn_from_item(turn_id, turn_status);
        if is_live_status(turn_status) {
            self.active_turn_id = Some(turn_id.to_string());
            self.live_state = ThreadLiveState::Streaming;
        }
    }

    fn append_delta(&mut self, thread_id: &str, turn_id: &str, item_id: &str, delta: &str) {
        if self.terminal_turn_ids.contains(turn_id) {
            return;
        }
        self.thread_id = thread_id.to_string();
        let key = scoped_item_key(turn_id, item_id);
        let existing = self
            .items
            .iter()
            .find(|item| scoped_item_key(&item.turn_id, &item.item_id) == key);
        if existing.is_some_and(|item| is_terminal_turn_status(&item.status)) {
            return;
        }
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

    fn update_turn_status(&mut self, turn: &ThreadTurnSnapshot) -> bool {
        let terminal = is_terminal_turn_status(&turn.status);
        let newly_terminal = terminal && !self.terminal_turn_ids.contains(&turn.id);
        self.upsert_turn_from_snapshot(turn);
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
        if terminal {
            self.terminal_turn_ids.insert(turn.id.clone());
        } else {
            self.terminal_turn_ids.remove(&turn.id);
        }
        newly_terminal
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

    fn set_pending_requests(&mut self, approvals: &[Approval]) {
        let mut pending_approval_requests = Vec::new();
        let mut pending_user_input_requests = Vec::new();
        for approval in approvals
            .iter()
            .filter(|approval| approval.status == "pending")
        {
            let summary = pending_request_summary(approval);
            if summary.request_kind == "userInput" {
                pending_user_input_requests.push(summary);
            } else {
                pending_approval_requests.push(summary);
            }
        }
        pending_approval_requests.sort_by_key(|request| request.created_at);
        pending_user_input_requests.sort_by_key(|request| request.created_at);
        self.pending_approval_requests = pending_approval_requests;
        self.pending_user_input_requests = pending_user_input_requests;
    }

    fn upsert_pending_request(&mut self, approval: &Approval) {
        if approval.status != "pending" {
            self.remove_pending_request(&approval.id);
            return;
        }
        let summary = pending_request_summary(approval);
        let requests = if summary.request_kind == "userInput" {
            &mut self.pending_user_input_requests
        } else {
            &mut self.pending_approval_requests
        };
        if let Some(existing) = requests.iter_mut().find(|request| request.id == summary.id) {
            *existing = summary;
        } else {
            requests.push(summary);
            requests.sort_by_key(|request| request.created_at);
        }
    }

    fn remove_pending_request(&mut self, approval_id: &str) {
        self.pending_approval_requests
            .retain(|request| request.id != approval_id);
        self.pending_user_input_requests
            .retain(|request| request.id != approval_id);
    }

    fn to_snapshot(&self) -> ThreadTimelineSnapshot {
        let mut items = self.items.clone();
        items.sort_by_key(|item| item.display_order);
        let turns = self.turns_for_items(&items);
        let rows = thread_timeline_rows_from_items(
            self.active_turn_id.as_deref(),
            self.live_state,
            &turns,
            &items,
        );
        ThreadTimelineSnapshot {
            view_revision: self.revision,
            active_turn_id: self.active_turn_id.clone(),
            live_state: self.live_state,
            pending_approval_requests: self.pending_approval_requests.clone(),
            pending_user_input_requests: self.pending_user_input_requests.clone(),
            rows,
            turns,
            items,
        }
    }

    fn turn_patch(&self, turn_id: &str) -> ThreadViewPatch {
        let mut items = self
            .items
            .iter()
            .filter(|item| item.turn_id == turn_id)
            .cloned()
            .collect::<Vec<_>>();
        items.sort_by_key(|item| item.display_order);
        let mut turns = self
            .turns
            .iter()
            .filter(|turn| turn.id == turn_id)
            .cloned()
            .collect::<Vec<_>>();
        merge_missing_turns(&mut turns, &[], &items);
        let turns = ordered_turns_for_items(&turns, &items);
        let rows = thread_timeline_rows_from_items(
            self.active_turn_id.as_deref(),
            self.live_state,
            &turns,
            &items,
        );
        ThreadViewPatch {
            view_revision: self.revision,
            thread_id: self.thread_id.clone(),
            active_turn_id: self.active_turn_id.clone(),
            live_state: self.live_state,
            pending_approval_requests: self.pending_approval_requests.clone(),
            pending_user_input_requests: self.pending_user_input_requests.clone(),
            rows: None,
            upsert_rows: rows,
            remove_row_ids: Vec::new(),
            turns,
            items,
        }
    }

    fn to_patch(&self) -> ThreadViewPatch {
        let mut items = self.items.clone();
        items.sort_by_key(|item| item.display_order);
        let turns = self.turns_for_items(&items);
        let rows = thread_timeline_rows_from_items(
            self.active_turn_id.as_deref(),
            self.live_state,
            &turns,
            &items,
        );
        ThreadViewPatch {
            view_revision: self.revision,
            thread_id: self.thread_id.clone(),
            active_turn_id: self.active_turn_id.clone(),
            live_state: self.live_state,
            pending_approval_requests: self.pending_approval_requests.clone(),
            pending_user_input_requests: self.pending_user_input_requests.clone(),
            rows: Some(rows),
            upsert_rows: Vec::new(),
            remove_row_ids: Vec::new(),
            turns,
            items,
        }
    }

    fn turns_for_items(
        &self,
        items: &[ThreadTimelineSnapshotItem],
    ) -> Vec<ThreadTimelineSnapshotTurn> {
        let mut turns = self.turns.clone();
        merge_missing_turns(&mut turns, &[], items);
        ordered_turns_for_items(&turns, items)
    }

    fn upsert_turn_from_item(&mut self, turn_id: &str, status: &str) {
        let existing = self.turns.iter_mut().find(|turn| turn.id == turn_id);
        if let Some(existing) = existing {
            existing.status = status.to_string();
            existing.completed_at = if is_terminal_turn_status(status) {
                existing.completed_at
            } else {
                None
            };
            return;
        }
        self.turns.push(ThreadTimelineSnapshotTurn {
            id: turn_id.to_string(),
            status: status.to_string(),
            started_at: None,
            completed_at: None,
        });
    }

    fn upsert_turn_from_snapshot(&mut self, turn: &ThreadTurnSnapshot) {
        let terminal = is_terminal_turn_status(&turn.status);
        let existing_started_at = self
            .turns
            .iter()
            .find(|existing| existing.id == turn.id)
            .and_then(|existing| existing.started_at);
        let started_at = turn.started_at.or(existing_started_at);
        let completed_at = if terminal {
            normalize_completed_at(started_at, turn.completed_at)
        } else {
            None
        };
        let next_turn = ThreadTimelineSnapshotTurn {
            id: turn.id.clone(),
            status: turn.status.clone(),
            started_at,
            completed_at,
        };
        replace_or_push_turn(&mut self.turns, next_turn);
    }
}

fn merge_missing_turns(
    turns: &mut Vec<ThreadTimelineSnapshotTurn>,
    existing_turns: &[ThreadTimelineSnapshotTurn],
    items: &[ThreadTimelineSnapshotItem],
) {
    let mut known = turns
        .iter()
        .map(|turn| turn.id.clone())
        .collect::<HashSet<_>>();
    for turn in existing_turns {
        if known.insert(turn.id.clone()) {
            turns.push(turn.clone());
        }
    }
    for turn in timeline_turns_from_items(items) {
        if known.insert(turn.id.clone()) {
            turns.push(turn);
        }
    }
}

fn ordered_turns_for_items(
    turns: &[ThreadTimelineSnapshotTurn],
    items: &[ThreadTimelineSnapshotItem],
) -> Vec<ThreadTimelineSnapshotTurn> {
    let by_id = turns
        .iter()
        .map(|turn| (turn.id.as_str(), turn))
        .collect::<HashMap<_, _>>();
    let mut ordered = Vec::new();
    let mut seen = HashSet::new();
    for item in items {
        if !seen.insert(item.turn_id.clone()) {
            continue;
        }
        if let Some(turn) = by_id.get(item.turn_id.as_str()) {
            ordered.push((*turn).clone());
        }
    }
    for turn in turns {
        if seen.insert(turn.id.clone()) {
            ordered.push(turn.clone());
        }
    }
    ordered
}

fn timeline_turns_from_items(
    items: &[ThreadTimelineSnapshotItem],
) -> Vec<ThreadTimelineSnapshotTurn> {
    let mut turns = Vec::new();
    let mut seen = HashSet::new();
    for item in items {
        if !seen.insert(item.turn_id.clone()) {
            continue;
        }
        turns.push(ThreadTimelineSnapshotTurn {
            id: item.turn_id.clone(),
            status: item.status.clone(),
            started_at: None,
            completed_at: None,
        });
    }
    turns
}

fn replace_or_push_turn(
    turns: &mut Vec<ThreadTimelineSnapshotTurn>,
    turn: ThreadTimelineSnapshotTurn,
) {
    if let Some(existing) = turns.iter_mut().find(|existing| existing.id == turn.id) {
        *existing = turn;
    } else {
        turns.push(turn);
    }
}

fn normalize_completed_at(started_at: Option<i64>, completed_at: Option<i64>) -> Option<i64> {
    match (started_at, completed_at) {
        (Some(started_at), Some(completed_at)) => Some(completed_at.max(started_at)),
        (_, completed_at) => completed_at,
    }
}

pub async fn build_thread_timeline(
    sessions: &ThreadViewStore,
    thread_id: &str,
    turns: &[ThreadTurnSnapshot],
    revision: i64,
) -> ApiResult<ThreadTimelineSnapshot> {
    Ok(sessions
        .refresh_from_turns(thread_id, turns, revision)
        .await)
}

pub async fn build_thread_timeline_window(
    sessions: &ThreadViewStore,
    thread_id: &str,
    turns: &[ThreadTurnSnapshot],
    history_page: Option<ThreadTimelineWindowPage>,
    revision: i64,
) -> ApiResult<ThreadTimelineSnapshot> {
    Ok(sessions
        .refresh_from_history_window(thread_id, turns, history_page, revision)
        .await)
}

pub async fn prepend_thread_timeline_page(
    sessions: &ThreadViewStore,
    thread_id: &str,
    turns: &[ThreadTurnSnapshot],
    history_page: Option<ThreadTimelineWindowPage>,
    revision: i64,
) -> ApiResult<ThreadTimelineSnapshot> {
    Ok(sessions
        .prepend_history_page(thread_id, turns, history_page, revision)
        .await)
}

pub async fn record_pending_requests(
    sessions: &ThreadViewStore,
    thread_id: &str,
    approvals: &[Approval],
    revision: i64,
) -> ApiResult<ThreadTimelineSnapshot> {
    Ok(sessions
        .with_thread_view(thread_id, revision, |view| {
            view.set_pending_requests(approvals);
            view.to_snapshot()
        })
        .await)
}

pub async fn patch_for_thread(
    sessions: &ThreadViewStore,
    thread_id: &str,
) -> ApiResult<ThreadViewPatch> {
    Ok(sessions.patch_for_thread(thread_id).await)
}

pub async fn record_approval_created(
    sessions: &ThreadViewStore,
    approval: &Approval,
    updated_seq: i64,
) -> ApiResult<()> {
    let Some(thread_id) = approval.thread_id.as_deref() else {
        return Ok(());
    };
    sessions
        .with_thread_view(thread_id, updated_seq, |view| {
            view.upsert_pending_request(approval);
        })
        .await;
    Ok(())
}

pub async fn record_approval_resolved(
    sessions: &ThreadViewStore,
    approval: &Approval,
    updated_seq: i64,
) -> ApiResult<()> {
    let Some(thread_id) = approval.thread_id.as_deref() else {
        return Ok(());
    };
    sessions
        .with_thread_view(thread_id, updated_seq, |view| {
            view.remove_pending_request(&approval.id);
        })
        .await;
    Ok(())
}

pub async fn record_item_upsert(
    sessions: &ThreadViewStore,
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

fn pending_request_summary(approval: &Approval) -> PendingTimelineRequestSummary {
    PendingTimelineRequestSummary {
        id: approval.id.clone(),
        request_id: approval.request_id.clone(),
        thread_id: approval.thread_id.clone(),
        turn_id: approval.turn_id.clone(),
        item_id: approval.item_id.clone(),
        method: approval.method.clone(),
        status: approval.status.clone(),
        request_kind: request_kind(&approval.method).to_string(),
        title: request_title(approval),
        summary: request_summary(approval),
        created_at: approval.created_at,
    }
}

fn request_kind(method: &str) -> &'static str {
    if method == "item/tool/requestUserInput" {
        "userInput"
    } else {
        "approval"
    }
}

fn request_title(approval: &Approval) -> String {
    match approval.method.as_str() {
        "item/commandExecution/requestApproval" => "Command approval".to_string(),
        "item/fileChange/requestApproval" => "File change approval".to_string(),
        "item/permissions/requestApproval" => "Permission approval".to_string(),
        "mcpServer/elicitation/request" => approval
            .payload
            .get("serverName")
            .and_then(Value::as_str)
            .map(|server| format!("{server} request"))
            .unwrap_or_else(|| "MCP request".to_string()),
        "item/tool/requestUserInput" => approval
            .payload
            .get("questions")
            .and_then(Value::as_array)
            .and_then(|questions| questions.first())
            .and_then(|question| question.get("header").and_then(Value::as_str))
            .filter(|header| !header.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| "User input requested".to_string()),
        _ => "Approval requested".to_string(),
    }
}

fn request_summary(approval: &Approval) -> Option<String> {
    match approval.method.as_str() {
        "item/commandExecution/requestApproval" => {
            string_payload_field(&approval.payload, &["reason", "command"])
        }
        "item/fileChange/requestApproval" => {
            string_payload_field(&approval.payload, &["reason", "grantRoot"])
        }
        "item/permissions/requestApproval" => {
            string_payload_field(&approval.payload, &["reason", "cwd"])
        }
        "mcpServer/elicitation/request" => string_payload_field(&approval.payload, &["message"]),
        "item/tool/requestUserInput" => approval
            .payload
            .get("questions")
            .and_then(Value::as_array)
            .and_then(|questions| questions.first())
            .and_then(|question| question.get("question").and_then(Value::as_str))
            .filter(|question| !question.trim().is_empty())
            .map(str::to_string),
        _ => None,
    }
}

fn string_payload_field(payload: &Value, fields: &[&str]) -> Option<String> {
    fields.iter().find_map(|field| {
        payload
            .get(*field)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
    })
}

pub async fn record_item_delta(
    sessions: &ThreadViewStore,
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

pub async fn record_item_delta_patch(
    sessions: &ThreadViewStore,
    thread_id: &str,
    turn_id: &str,
    item_id: &str,
    delta: &str,
    updated_seq: i64,
) -> ApiResult<ThreadViewPatch> {
    let patch = sessions
        .with_thread_view(thread_id, updated_seq, |view| {
            view.append_delta(thread_id, turn_id, item_id, delta);
            view.turn_patch(turn_id)
        })
        .await;
    Ok(patch)
}

pub async fn record_turn_status(
    sessions: &ThreadViewStore,
    thread_id: &str,
    turn: &ThreadTurnSnapshot,
    updated_seq: i64,
) -> ApiResult<bool> {
    let newly_terminal = sessions
        .with_thread_view(thread_id, updated_seq, |view| view.update_turn_status(turn))
        .await;
    Ok(newly_terminal)
}

pub async fn record_thread_live_state(
    sessions: &ThreadViewStore,
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
    sessions: &ThreadViewStore,
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

fn should_preserve_live_item_over_snapshot(
    live_item: &ThreadTimelineSnapshotItem,
    snapshot_item: &ThreadTimelineSnapshotItem,
) -> bool {
    if !is_live_status(&live_item.status) || !is_live_status(&snapshot_item.status) {
        return false;
    }
    if live_item
        .timestamp_ms
        .zip(snapshot_item.timestamp_ms)
        .is_some_and(|(live_timestamp, snapshot_timestamp)| live_timestamp > snapshot_timestamp)
    {
        return true;
    }
    let Some(live_text) = text_for_timeline_item_match(live_item) else {
        return false;
    };
    let Some(snapshot_text) = text_for_timeline_item_match(snapshot_item) else {
        return !live_text.is_empty();
    };
    live_text.len() > snapshot_text.len() && live_text.starts_with(&snapshot_text)
}

fn text_key_for_snapshot_item(item: &ThreadTimelineSnapshotItem) -> Option<String> {
    let text = text_for_timeline_item_match(item)?;
    Some(scoped_text_key(&item.turn_id, &item.item_type, &text))
}

fn text_for_timeline_item_match(item: &ThreadTimelineSnapshotItem) -> Option<String> {
    visible_text_from_thread_item(&item.payload.item).or_else(|| {
        item.payload
            .item
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .map(str::to_string)
    })
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

fn is_prunable_missing_context_compaction(
    item: &ThreadTimelineSnapshotItem,
    turns: &[ThreadTimelineSnapshotTurn],
) -> bool {
    let item_type = item.item_type.to_ascii_lowercase().replace('_', "");
    item_type == "contextcompaction"
        && turns
            .iter()
            .find(|turn| turn.id == item.turn_id)
            .is_some_and(|turn| is_terminal_turn_status(&turn.status))
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

    fn final_agent_message_item(id: &str, text: &str) -> Value {
        json!({
            "id": id,
            "type": "agentMessage",
            "text": text,
            "phase": "final_answer",
        })
    }

    fn user_message_item(id: &str, text: &str) -> Value {
        json!({
            "id": id,
            "type": "userMessage",
            "content": [{"type": "text", "text": text}],
        })
    }

    fn file_change_item(id: &str, path: &str, diff: &str) -> Value {
        json!({
            "id": id,
            "type": "fileChange",
            "changes": [{
                "path": path,
                "kind": "update",
                "diff": diff,
            }],
        })
    }

    fn context_compaction_item(id: &str) -> Value {
        json!({
            "id": id,
            "type": "contextCompaction",
        })
    }

    #[tokio::test]
    async fn session_reconciles_pending_user_input_when_snapshot_materializes_item() {
        let sessions = ThreadViewStore::default();
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
        let sessions = ThreadViewStore::default();
        record_item_delta(&sessions, "thread-1", "turn-1", "agent-1", "Hello", 1)
            .await
            .unwrap();
        record_item_delta(&sessions, "thread-1", "turn-1", "agent-1", " world", 2)
            .await
            .unwrap();

        let patch = patch_for_thread(&sessions, "thread-1").await.unwrap();
        assert_eq!(patch.items.len(), 1);
        let rows = patch.rows.as_ref().expect("full patch rows");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, "assistant_message");
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
        assert_eq!(timeline.turns.len(), 1);
        assert_eq!(timeline.turns[0].started_at, Some(1));
        assert_eq!(timeline.turns[0].completed_at, Some(2));
        assert_eq!(timeline.active_turn_id, None);
    }

    #[tokio::test]
    async fn item_delta_patch_upserts_only_affected_turn_rows() {
        let sessions = ThreadViewStore::default();
        build_thread_timeline(
            &sessions,
            "thread-1",
            &[ThreadTurnSnapshot {
                id: "turn-0".to_string(),
                status: "completed".to_string(),
                started_at: Some(1),
                completed_at: Some(2),
                raw_payload: json!({}),
                items: vec![ThreadItemSnapshot::from_payload(&user_message_item(
                    "user-0", "Previous",
                ))
                .unwrap()],
            }],
            1,
        )
        .await
        .unwrap();

        let patch = record_item_delta_patch(&sessions, "thread-1", "turn-1", "agent-1", "Hello", 2)
            .await
            .unwrap();

        assert!(patch.rows.is_none());
        assert_eq!(patch.upsert_rows.len(), 1);
        assert_eq!(patch.upsert_rows[0].kind, "assistant_message");
        assert_eq!(patch.items.len(), 1);
        assert_eq!(patch.items[0].payload.item["text"], "Hello");
        assert_eq!(patch.turns.len(), 1);
        assert_eq!(patch.turns[0].id, "turn-1");
        assert_eq!(patch.active_turn_id.as_deref(), Some("turn-1"));

        let full_patch = patch_for_thread(&sessions, "thread-1").await.unwrap();
        assert!(full_patch
            .rows
            .as_ref()
            .expect("full patch rows")
            .iter()
            .any(|row| row.id == patch.upsert_rows[0].id));
    }

    #[tokio::test]
    async fn completed_turn_exposes_canonical_work_row_with_deduped_file_changes() {
        let sessions = ThreadViewStore::default();
        let completed_turn = ThreadTurnSnapshot {
            id: "turn-1".to_string(),
            status: "completed".to_string(),
            started_at: Some(10),
            completed_at: Some(20),
            raw_payload: json!({}),
            items: vec![
                ThreadItemSnapshot::from_payload(&user_message_item("user-1", "Edit src/a.rs"))
                    .unwrap(),
                ThreadItemSnapshot::from_payload(&file_change_item(
                    "file-1",
                    "./src/a.rs",
                    "--- a/src/a.rs\n+++ b/src/a.rs\n+one\n-two",
                ))
                .unwrap(),
                ThreadItemSnapshot::from_payload(&file_change_item(
                    "file-3",
                    "src/b.rs",
                    "--- a/src/b.rs\n+++ b/src/b.rs\n+side",
                ))
                .unwrap(),
                ThreadItemSnapshot::from_payload(&file_change_item(
                    "file-2",
                    "src/a.rs",
                    "--- a/src/a.rs\n+++ b/src/a.rs\n+three",
                ))
                .unwrap(),
                ThreadItemSnapshot::from_payload(&final_agent_message_item("agent-1", "Done"))
                    .unwrap(),
            ],
        };

        let timeline = build_thread_timeline(&sessions, "thread-1", &[completed_turn], 1)
            .await
            .unwrap();

        assert_eq!(
            timeline
                .rows
                .iter()
                .map(|row| row.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["user_message", "work", "assistant_message"]
        );
        let work = timeline
            .rows
            .iter()
            .find(|row| row.kind == "work")
            .expect("work row");
        assert_eq!(work.work.as_ref().unwrap().state, "completed");
        assert_eq!(
            work.collapsed_rows
                .iter()
                .map(|row| row.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["file_changes"]
        );
        let file_changes = &work.collapsed_rows[0].file_changes;
        assert_eq!(file_changes.len(), 2);
        assert_eq!(file_changes[0].path, "src/a.rs");
        assert_eq!(file_changes[0].action, "Modified");
        assert_eq!(
            file_changes[0].item_ids,
            vec!["projection-turn-1-file-1", "projection-turn-1-file-2"]
        );
        assert_eq!(file_changes[0].additions, 2);
        assert_eq!(file_changes[0].deletions, 1);
        assert_eq!(file_changes[1].path, "src/b.rs");
        assert_eq!(file_changes[1].additions, 1);
    }

    #[tokio::test]
    async fn live_item_activity_does_not_invent_turn_timestamps() {
        let sessions = ThreadViewStore::default();
        record_item_delta(&sessions, "thread-1", "turn-1", "agent-1", "Working", 1)
            .await
            .unwrap();

        let patch = patch_for_thread(&sessions, "thread-1").await.unwrap();

        assert_eq!(patch.live_state, ThreadLiveState::Streaming);
        assert_eq!(patch.active_turn_id.as_deref(), Some("turn-1"));
        assert_eq!(patch.turns.len(), 1);
        assert_eq!(patch.turns[0].id, "turn-1");
        assert_eq!(patch.turns[0].status, "running");
        assert_eq!(patch.turns[0].started_at, None);
        assert_eq!(patch.turns[0].completed_at, None);
    }

    #[tokio::test]
    async fn terminal_turn_status_preserves_turn_duration_in_live_patch() {
        let sessions = ThreadViewStore::default();
        record_item_delta(&sessions, "thread-1", "turn-1", "agent-1", "Working", 1)
            .await
            .unwrap();

        let completed_turn = ThreadTurnSnapshot {
            id: "turn-1".to_string(),
            status: "completed".to_string(),
            started_at: Some(10),
            completed_at: Some(15),
            raw_payload: json!({}),
            items: Vec::new(),
        };
        record_turn_status(&sessions, "thread-1", &completed_turn, 2)
            .await
            .unwrap();

        let patch = patch_for_thread(&sessions, "thread-1").await.unwrap();

        assert_eq!(patch.live_state, ThreadLiveState::Idle);
        assert_eq!(patch.turns.len(), 1);
        assert_eq!(patch.turns[0].id, "turn-1");
        assert_eq!(patch.turns[0].status, "completed");
        assert_eq!(patch.turns[0].started_at, Some(10));
        assert_eq!(patch.turns[0].completed_at, Some(15));
    }

    #[tokio::test]
    async fn item_completion_does_not_complete_active_turn() {
        let sessions = ThreadViewStore::default();
        let item = agent_message_item("agent-1", "partial");
        let item_snapshot = ThreadItemSnapshot::from_payload(&item).unwrap();

        record_item_upsert(
            &sessions,
            "thread-1",
            "turn-1",
            item,
            item_snapshot,
            Some("completed"),
            1,
        )
        .await
        .unwrap();

        let patch = patch_for_thread(&sessions, "thread-1").await.unwrap();
        assert_eq!(patch.active_turn_id.as_deref(), Some("turn-1"));
        assert_eq!(patch.live_state, ThreadLiveState::Streaming);
        assert_eq!(patch.items[0].status, "completed");
        assert_eq!(patch.turns[0].status, "running");
        assert_eq!(patch.turns[0].completed_at, None);
    }

    #[tokio::test]
    async fn session_ignores_late_delta_after_turn_completion() {
        let sessions = ThreadViewStore::default();
        record_item_delta(&sessions, "thread-1", "turn-1", "agent-1", "Done", 1)
            .await
            .unwrap();
        let completed_turn = ThreadTurnSnapshot {
            id: "turn-1".to_string(),
            status: "completed".to_string(),
            started_at: Some(1),
            completed_at: Some(2),
            raw_payload: json!({}),
            items: vec![
                ThreadItemSnapshot::from_payload(&agent_message_item("agent-1", "Done")).unwrap(),
            ],
        };
        record_turn_status(&sessions, "thread-1", &completed_turn, 2)
            .await
            .unwrap();

        record_item_delta(&sessions, "thread-1", "turn-1", "agent-1", " stale", 3)
            .await
            .unwrap();

        let patch = patch_for_thread(&sessions, "thread-1").await.unwrap();
        assert_eq!(patch.live_state, ThreadLiveState::Idle);
        assert_eq!(patch.active_turn_id, None);
        assert_eq!(patch.items[0].status, "completed");
        assert_eq!(patch.items[0].payload.item["text"], "Done");
    }

    #[tokio::test]
    async fn active_snapshot_does_not_truncate_newer_live_text() {
        let sessions = ThreadViewStore::default();
        record_item_delta(&sessions, "thread-1", "turn-1", "agent-1", "Hello", 1)
            .await
            .unwrap();
        record_item_delta(&sessions, "thread-1", "turn-1", "agent-1", " world", 2)
            .await
            .unwrap();

        let stale_active_turn = ThreadTurnSnapshot {
            id: "turn-1".to_string(),
            status: "inProgress".to_string(),
            started_at: Some(1),
            completed_at: None,
            raw_payload: json!({}),
            items: vec![
                ThreadItemSnapshot::from_payload(&agent_message_item("agent-1", "Hello")).unwrap(),
            ],
        };
        let timeline = build_thread_timeline(&sessions, "thread-1", &[stale_active_turn], 3)
            .await
            .unwrap();

        assert_eq!(timeline.items.len(), 1);
        assert_eq!(timeline.items[0].id, "projection-turn-1-agent-1");
        assert_eq!(timeline.items[0].payload.item["text"], "Hello world");
        assert_eq!(timeline.turns.len(), 1);
        assert_eq!(timeline.turns[0].started_at, Some(1));
        assert_eq!(timeline.turns[0].completed_at, None);
        assert_eq!(timeline.active_turn_id.as_deref(), Some("turn-1"));
    }

    #[tokio::test]
    async fn history_window_prepends_older_rows_without_deleting_live_tail() {
        let sessions = ThreadViewStore::default();
        let recent_turn = ThreadTurnSnapshot {
            id: "turn-2".to_string(),
            status: "completed".to_string(),
            started_at: Some(20),
            completed_at: Some(25),
            raw_payload: json!({}),
            items: vec![
                ThreadItemSnapshot::from_payload(&agent_message_item("agent-2", "Recent")).unwrap(),
            ],
        };
        build_thread_timeline_window(
            &sessions,
            "thread-1",
            &[recent_turn.clone()],
            Some(ThreadTimelineWindowPage {
                older_cursor: Some("older-1".to_string()),
                newer_cursor: None,
                has_older: true,
                limit: 50,
                loaded_turn_count: 1,
                reset_window: false,
            }),
            1,
        )
        .await
        .unwrap();
        record_item_delta(&sessions, "thread-1", "turn-3", "agent-3", "Live", 2)
            .await
            .unwrap();

        let older_turn = ThreadTurnSnapshot {
            id: "turn-1".to_string(),
            status: "completed".to_string(),
            started_at: Some(10),
            completed_at: Some(15),
            raw_payload: json!({}),
            items: vec![
                ThreadItemSnapshot::from_payload(&agent_message_item("agent-1", "Older")).unwrap(),
            ],
        };
        let timeline = prepend_thread_timeline_page(
            &sessions,
            "thread-1",
            &[older_turn],
            Some(ThreadTimelineWindowPage {
                older_cursor: None,
                newer_cursor: Some("newer-1".to_string()),
                has_older: false,
                limit: 50,
                loaded_turn_count: 1,
                reset_window: false,
            }),
            3,
        )
        .await
        .unwrap();

        assert_eq!(
            timeline
                .items
                .iter()
                .map(|item| item.payload.item["text"].as_str().unwrap_or(""))
                .collect::<Vec<_>>(),
            vec!["Older", "Recent", "Live"]
        );
        assert_eq!(timeline.active_turn_id.as_deref(), Some("turn-3"));
        assert_eq!(timeline.live_state, ThreadLiveState::Streaming);

        let refreshed = build_thread_timeline_window(
            &sessions,
            "thread-1",
            &[recent_turn],
            Some(ThreadTimelineWindowPage {
                older_cursor: Some("older-ignored".to_string()),
                newer_cursor: None,
                has_older: true,
                limit: 50,
                loaded_turn_count: 1,
                reset_window: false,
            }),
            4,
        )
        .await
        .unwrap();

        assert_eq!(
            refreshed
                .items
                .iter()
                .map(|item| item.payload.item["text"].as_str().unwrap_or(""))
                .collect::<Vec<_>>(),
            vec!["Older", "Recent", "Live"]
        );
        assert_eq!(refreshed.active_turn_id.as_deref(), Some("turn-3"));
    }

    #[tokio::test]
    async fn head_refresh_preserves_expanded_window_older_cursor() {
        let sessions = ThreadViewStore::default();
        let turn = |id: &str, text: &str| ThreadTurnSnapshot {
            id: id.to_string(),
            status: "completed".to_string(),
            started_at: None,
            completed_at: None,
            raw_payload: json!({}),
            items: vec![ThreadItemSnapshot::from_payload(&agent_message_item(
                &format!("agent-{id}"),
                text,
            ))
            .unwrap()],
        };
        let turn_4 = turn("turn-4", "Four");
        let turn_3 = turn("turn-3", "Three");
        let turn_2 = turn("turn-2", "Two");
        let turn_1 = turn("turn-1", "One");

        build_thread_timeline_window(
            &sessions,
            "thread-1",
            &[turn_3.clone(), turn_4.clone()],
            Some(ThreadTimelineWindowPage {
                older_cursor: Some("cursor-before-turn-3".to_string()),
                newer_cursor: None,
                has_older: true,
                limit: 2,
                loaded_turn_count: 2,
                reset_window: false,
            }),
            1,
        )
        .await
        .unwrap();

        prepend_thread_timeline_page(
            &sessions,
            "thread-1",
            &[turn_1.clone(), turn_2.clone()],
            Some(ThreadTimelineWindowPage {
                older_cursor: Some("cursor-before-turn-1".to_string()),
                newer_cursor: Some("cursor-before-turn-3".to_string()),
                has_older: true,
                limit: 2,
                loaded_turn_count: 4,
                reset_window: false,
            }),
            2,
        )
        .await
        .unwrap();

        build_thread_timeline_window(
            &sessions,
            "thread-1",
            &[turn_4.clone()],
            Some(ThreadTimelineWindowPage {
                older_cursor: Some("overlapping-head-cursor".to_string()),
                newer_cursor: None,
                has_older: true,
                limit: 1,
                loaded_turn_count: 1,
                reset_window: false,
            }),
            3,
        )
        .await
        .unwrap();

        let history_page = sessions.history_page("thread-1").await.unwrap();
        assert_eq!(
            history_page.older_cursor.as_deref(),
            Some("cursor-before-turn-1")
        );
        assert!(history_page.has_older);

        let refreshed = prepend_thread_timeline_page(
            &sessions,
            "thread-1",
            &[turn("turn-0", "Zero")],
            Some(ThreadTimelineWindowPage {
                older_cursor: None,
                newer_cursor: Some("cursor-before-turn-1".to_string()),
                has_older: false,
                limit: 1,
                loaded_turn_count: 5,
                reset_window: false,
            }),
            4,
        )
        .await
        .unwrap();

        assert_eq!(
            refreshed
                .items
                .iter()
                .map(|item| item.payload.item["text"].as_str().unwrap_or(""))
                .collect::<Vec<_>>(),
            vec!["Zero", "One", "Two", "Three", "Four"]
        );
        let history_page = sessions.history_page("thread-1").await.unwrap();
        assert_eq!(history_page.older_cursor, None);
        assert!(!history_page.has_older);
        assert_eq!(history_page.loaded_turn_count, 5);
    }

    #[tokio::test]
    async fn completed_snapshot_collapses_live_duplicate_assistant_text() {
        let sessions = ThreadViewStore::default();
        record_item_delta(&sessions, "thread-1", "turn-1", "item-2", "Done", 1)
            .await
            .unwrap();
        record_item_delta(&sessions, "thread-1", "turn-1", "msg-final", "Done", 2)
            .await
            .unwrap();

        let completed_turn = ThreadTurnSnapshot {
            id: "turn-1".to_string(),
            status: "completed".to_string(),
            started_at: Some(1),
            completed_at: Some(2),
            raw_payload: json!({}),
            items: vec![
                ThreadItemSnapshot::from_payload(&agent_message_item("item-2", "Done")).unwrap(),
            ],
        };
        let timeline = build_thread_timeline(&sessions, "thread-1", &[completed_turn], 3)
            .await
            .unwrap();

        assert_eq!(timeline.items.len(), 1);
        assert_eq!(timeline.items[0].item_id, "item-2");
        assert_eq!(timeline.items[0].payload.item["text"], "Done");
    }

    #[tokio::test]
    async fn completed_snapshot_prunes_missing_live_context_compaction_marker() {
        let sessions = ThreadViewStore::default();
        let compact_item = context_compaction_item("compact-1");
        let compact_snapshot = ThreadItemSnapshot::from_payload(&compact_item).unwrap();
        record_item_upsert(
            &sessions,
            "thread-1",
            "turn-1",
            compact_item,
            compact_snapshot,
            Some("running"),
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
            items: vec![
                ThreadItemSnapshot::from_payload(&json!({
                    "id": "user-1",
                    "type": "userMessage",
                    "content": [{"type": "text", "text": "Hello"}]
                }))
                .unwrap(),
                ThreadItemSnapshot::from_payload(&agent_message_item("agent-1", "Done")).unwrap(),
            ],
        };
        let timeline = build_thread_timeline(&sessions, "thread-1", &[completed_turn], 2)
            .await
            .unwrap();

        assert_eq!(
            timeline
                .items
                .iter()
                .map(|item| item.item_id.as_str())
                .collect::<Vec<_>>(),
            vec!["user-1", "agent-1"]
        );
        assert_eq!(timeline.live_state, ThreadLiveState::Idle);
        assert_eq!(timeline.active_turn_id, None);
    }
}
