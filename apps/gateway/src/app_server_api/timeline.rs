use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use super::{
    is_terminal_turn_status, ThreadItemSnapshot, ThreadLiveState, ThreadTurnSnapshot,
    TimelineItemUpsertPayload, TimelineUpdateSource,
};

pub(crate) const TIMELINE_PREVIEW_STRING_LIMIT: usize = 16_384;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTimelineWindowPage {
    pub older_cursor: Option<String>,
    pub newer_cursor: Option<String>,
    pub has_older: bool,
    pub limit: u32,
    pub loaded_turn_count: u32,
    #[serde(default, skip_serializing_if = "is_false")]
    pub reset_window: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTimelineSnapshot {
    pub view_revision: i64,
    pub active_turn_id: Option<String>,
    pub live_state: ThreadLiveState,
    pub pending_approval_requests: Vec<PendingTimelineRequestSummary>,
    pub pending_user_input_requests: Vec<PendingTimelineRequestSummary>,
    pub rows: Vec<ThreadTimelineRow>,
    pub turns: Vec<ThreadTimelineSnapshotTurn>,
    #[serde(default, skip_serializing)]
    #[schema(ignore)]
    pub items: Vec<ThreadTimelineSnapshotItem>,
}

impl ThreadTimelineSnapshot {
    pub(crate) fn from_turns(thread_id: &str, turns: &[ThreadTurnSnapshot]) -> Self {
        let mut display_order = 0;
        let mut items = Vec::new();
        let mut active_turn_id = None;
        let mut timeline_turns = Vec::new();
        for turn in turns {
            let turn_terminal = is_terminal_turn_status(&turn.status);
            if !turn_terminal {
                active_turn_id = Some(turn.id.clone());
            }
            timeline_turns.push(ThreadTimelineSnapshotTurn::from_turn(turn));
            for item in &turn.items {
                display_order += 1;
                items.push(ThreadTimelineSnapshotItem::from_turn_item(
                    thread_id,
                    turn,
                    item,
                    display_order,
                    turn_terminal,
                ));
            }
        }
        let rows = thread_timeline_rows_from_items(
            active_turn_id.as_deref(),
            live_state_from_turns(turns),
            &timeline_turns,
            &items,
        );
        Self {
            // Adapter-only snapshots start at zero; routes replace this with the gateway
            // projection high-water once gateway overlays are applied.
            view_revision: 0,
            active_turn_id,
            live_state: live_state_from_turns(turns),
            pending_approval_requests: Vec::new(),
            pending_user_input_requests: Vec::new(),
            rows,
            turns: timeline_turns,
            items,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTimelineRow {
    pub id: String,
    pub kind: String,
    pub turn_id: Option<String>,
    pub display_order: i64,
    pub status: String,
    pub timestamp_ms: Option<i64>,
    pub item: Option<ThreadTimelineSnapshotItem>,
    pub items: Vec<ThreadTimelineSnapshotItem>,
    pub file_changes: Vec<ThreadTimelineFileChangeEntry>,
    pub work: Option<ThreadTimelineWorkSummary>,
    pub collapsed_rows: Vec<ThreadTimelineWorkDetailRow>,
    pub divider_before: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTimelineWorkDetailRow {
    pub id: String,
    pub kind: String,
    pub turn_id: Option<String>,
    pub display_order: i64,
    pub status: String,
    pub timestamp_ms: Option<i64>,
    pub item: Option<ThreadTimelineSnapshotItem>,
    pub items: Vec<ThreadTimelineSnapshotItem>,
    pub file_changes: Vec<ThreadTimelineFileChangeEntry>,
    pub divider_before: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTimelineWorkSummary {
    pub state: String,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTimelineFileChangeEntry {
    pub id: String,
    pub path: String,
    pub action: String,
    pub additions: i64,
    pub deletions: i64,
    pub diff: String,
    pub item_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTimelineSnapshotTurn {
    pub id: String,
    pub status: String,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
}

impl ThreadTimelineSnapshotTurn {
    pub(crate) fn from_turn(turn: &ThreadTurnSnapshot) -> Self {
        Self {
            id: turn.id.clone(),
            status: turn.status.clone(),
            started_at: turn.started_at,
            completed_at: turn.completed_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PendingTimelineRequestSummary {
    pub id: String,
    pub request_id: String,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub method: String,
    pub status: String,
    pub request_kind: String,
    pub title: String,
    pub summary: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTimelineSnapshotItem {
    pub id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub item_type: String,
    pub status: String,
    pub display_order: i64,
    pub codex_method: String,
    pub timestamp_ms: Option<i64>,
    pub payload: TimelineItemUpsertPayload,
}

impl ThreadTimelineSnapshotItem {
    pub(crate) fn from_turn_item(
        thread_id: &str,
        turn: &ThreadTurnSnapshot,
        item: &ThreadItemSnapshot,
        display_order: i64,
        turn_terminal: bool,
    ) -> Self {
        let timestamp_ms = snapshot_item_timestamp_ms(turn, item);
        let codex_method = if turn_terminal {
            "item/completed"
        } else {
            "item/upsert"
        }
        .to_string();
        Self {
            id: canonical_timeline_item_id(&turn.id, &item.id),
            thread_id: thread_id.to_string(),
            turn_id: turn.id.clone(),
            item_id: item.id.clone(),
            item_type: item.item_type.clone(),
            status: if turn_terminal {
                "completed".to_string()
            } else {
                turn.status.clone()
            },
            display_order,
            codex_method,
            timestamp_ms,
            payload: TimelineItemUpsertPayload {
                source: TimelineUpdateSource::AppServerSnapshot,
                turn_id: turn.id.clone(),
                item_id: item.id.clone(),
                item: compact_timeline_item_payload(&item.raw_payload),
                item_snapshot: item.clone(),
            },
        }
    }
}

pub(crate) fn canonical_timeline_item_id(turn_id: &str, item_id: &str) -> String {
    format!("projection-{turn_id}-{item_id}")
}

pub(crate) fn thread_timeline_rows_from_items(
    active_turn_id: Option<&str>,
    live_state: ThreadLiveState,
    turns: &[ThreadTimelineSnapshotTurn],
    items: &[ThreadTimelineSnapshotItem],
) -> Vec<ThreadTimelineRow> {
    let mut ordered_items = items.to_vec();
    ordered_items.sort_by_key(|item| item.display_order);

    let mut rows = Vec::<ThreadTimelineWorkDetailRow>::new();
    let mut current_turn_key: Option<String> = None;
    let mut activity_items = Vec::<ThreadTimelineSnapshotItem>::new();
    let mut file_change_items = Vec::<ThreadTimelineSnapshotItem>::new();
    let mut turn_has_final_response_precursor = HashSet::<String>::new();

    fn flush_activity_items(
        rows: &mut Vec<ThreadTimelineWorkDetailRow>,
        activity_items: &mut Vec<ThreadTimelineSnapshotItem>,
        turn_has_final_response_precursor: &mut HashSet<String>,
    ) {
        if activity_items.is_empty() {
            return;
        }
        let row = activity_row(activity_items);
        turn_has_final_response_precursor.insert(row_turn_key_from_detail(&row));
        rows.push(row);
        activity_items.clear();
    }

    fn flush_file_change_items(
        rows: &mut Vec<ThreadTimelineWorkDetailRow>,
        file_change_items: &mut Vec<ThreadTimelineSnapshotItem>,
        turn_has_final_response_precursor: &mut HashSet<String>,
    ) {
        if file_change_items.is_empty() {
            return;
        }
        let row = file_changes_row(file_change_items);
        turn_has_final_response_precursor.insert(row_turn_key_from_detail(&row));
        rows.push(row);
        file_change_items.clear();
    }

    for item in ordered_items {
        let turn_key = timeline_item_turn_key(&item);
        if current_turn_key
            .as_ref()
            .is_some_and(|current| current != &turn_key)
        {
            flush_activity_items(
                &mut rows,
                &mut activity_items,
                &mut turn_has_final_response_precursor,
            );
            flush_file_change_items(
                &mut rows,
                &mut file_change_items,
                &mut turn_has_final_response_precursor,
            );
        }
        current_turn_key = Some(turn_key.clone());

        if normalized_thread_item_kind(&item) == "file_change" {
            file_change_items.push(item);
            continue;
        }

        if is_timeline_activity_item(&item) {
            activity_items.push(item);
            continue;
        }

        flush_activity_items(
            &mut rows,
            &mut activity_items,
            &mut turn_has_final_response_precursor,
        );
        if is_final_response_item(&item) {
            flush_file_change_items(
                &mut rows,
                &mut file_change_items,
                &mut turn_has_final_response_precursor,
            );
        }

        let mut row = item_row(item.clone());
        if is_final_response_item(&item) && turn_has_final_response_precursor.contains(&turn_key) {
            row.divider_before = Some("final_response".to_string());
        }
        if normalized_thread_item_kind(&item) != "user_message" && !is_final_response_item(&item) {
            turn_has_final_response_precursor.insert(turn_key);
        }
        rows.push(row);
    }

    flush_activity_items(
        &mut rows,
        &mut activity_items,
        &mut turn_has_final_response_precursor,
    );
    flush_file_change_items(
        &mut rows,
        &mut file_change_items,
        &mut turn_has_final_response_precursor,
    );

    insert_work_rows(rows, turns, active_turn_id, live_state)
}

fn insert_work_rows(
    rows: Vec<ThreadTimelineWorkDetailRow>,
    turns: &[ThreadTimelineSnapshotTurn],
    active_turn_id: Option<&str>,
    live_state: ThreadLiveState,
) -> Vec<ThreadTimelineRow> {
    let mut work_rows = turns
        .iter()
        .filter_map(|turn| {
            let is_active_turn = active_turn_id == Some(turn.id.as_str())
                && !matches!(
                    live_state,
                    ThreadLiveState::Idle | ThreadLiveState::NotLoaded
                );
            let is_terminal_turn = is_terminal_turn_status(&turn.status);
            if turn.started_at.is_none() && !is_active_turn {
                return None;
            }
            if !is_active_turn && !is_terminal_turn {
                return None;
            }
            Some((
                turn.id.clone(),
                ThreadTimelineRow {
                    id: format!("work-{}", turn.id),
                    kind: "work".to_string(),
                    turn_id: Some(turn.id.clone()),
                    display_order: i64::MAX,
                    status: if is_active_turn {
                        "running".to_string()
                    } else {
                        "completed".to_string()
                    },
                    timestamp_ms: None,
                    item: None,
                    items: Vec::new(),
                    file_changes: Vec::new(),
                    work: Some(ThreadTimelineWorkSummary {
                        state: if is_active_turn {
                            "running".to_string()
                        } else {
                            "completed".to_string()
                        },
                        started_at: turn.started_at,
                        completed_at: if is_active_turn {
                            None
                        } else {
                            turn.completed_at
                        },
                    }),
                    collapsed_rows: Vec::new(),
                    divider_before: None,
                },
            ))
        })
        .collect::<HashMap<_, _>>();

    if work_rows.is_empty() {
        return rows.into_iter().map(ThreadTimelineRow::from).collect();
    }

    let mut by_turn = HashMap::<String, Vec<ThreadTimelineWorkDetailRow>>::new();
    let mut turn_order = Vec::<String>::new();
    let mut ungrouped = Vec::<ThreadTimelineRow>::new();
    for row in rows {
        let Some(turn_id) = row.turn_id.clone() else {
            ungrouped.push(row.into());
            continue;
        };
        if !work_rows.contains_key(&turn_id) {
            ungrouped.push(row.into());
            continue;
        }
        if !by_turn.contains_key(&turn_id) {
            by_turn.insert(turn_id.clone(), Vec::new());
            turn_order.push(turn_id.clone());
        }
        by_turn
            .get_mut(&turn_id)
            .expect("turn bucket exists")
            .push(row);
    }

    let mut result = ungrouped;
    for turn_id in turn_order {
        let turn_rows = by_turn.remove(&turn_id).unwrap_or_default();
        let Some(work_row) = work_rows.remove(&turn_id) else {
            result.extend(turn_rows.into_iter().map(ThreadTimelineRow::from));
            continue;
        };
        result.extend(rows_for_turn_with_work_row(turn_rows, work_row));
    }
    result.sort_by_key(|row| row.display_order);
    result
}

fn rows_for_turn_with_work_row(
    rows: Vec<ThreadTimelineWorkDetailRow>,
    mut work_row: ThreadTimelineRow,
) -> Vec<ThreadTimelineRow> {
    let Some(first_work_index) = rows.iter().position(row_contains_work_precursor) else {
        return rows.into_iter().map(ThreadTimelineRow::from).collect();
    };
    let final_index = rows
        .iter()
        .enumerate()
        .find(|(index, row)| *index > first_work_index && row_is_final_response(row))
        .map(|(index, _)| index);
    if work_row.status == "completed" {
        if let Some(final_index) = final_index {
            let display_order = rows[first_work_index].display_order.saturating_add(1);
            let rows_after_user = rows[first_work_index + 1..].to_vec();
            let final_offset = final_index - first_work_index - 1;
            let mut work_detail_rows = rows_after_user
                .iter()
                .enumerate()
                .filter(|(index, row)| *index != final_offset && !row_is_prominent_turn_result(row))
                .map(|(_, row)| row.clone())
                .collect::<Vec<_>>();
            work_detail_rows.sort_by_key(|row| row.display_order);
            let prominent_rows = rows_after_user
                .iter()
                .enumerate()
                .filter(|(index, row)| *index != final_offset && row_is_prominent_turn_result(row))
                .map(|(_, row)| row.clone())
                .collect::<Vec<_>>();
            work_row.collapsed_rows = work_detail_rows;
            work_row.display_order = display_order;
            let mut result = rows[..first_work_index + 1]
                .iter()
                .cloned()
                .map(ThreadTimelineRow::from)
                .collect::<Vec<_>>();
            result.push(work_row);
            let mut final_row = rows[final_index].clone();
            final_row.divider_before = None;
            result.push(final_row.into());
            result.extend(prominent_rows.into_iter().map(ThreadTimelineRow::from));
            return result;
        }
    }

    work_row.display_order = rows[first_work_index].display_order.saturating_add(1);
    let mut result = rows[..first_work_index + 1]
        .iter()
        .cloned()
        .map(ThreadTimelineRow::from)
        .collect::<Vec<_>>();
    result.push(work_row);
    result.extend(
        rows[first_work_index + 1..]
            .iter()
            .cloned()
            .map(ThreadTimelineRow::from),
    );
    result
}

impl From<ThreadTimelineWorkDetailRow> for ThreadTimelineRow {
    fn from(row: ThreadTimelineWorkDetailRow) -> Self {
        Self {
            id: row.id,
            kind: row.kind,
            turn_id: row.turn_id,
            display_order: row.display_order,
            status: row.status,
            timestamp_ms: row.timestamp_ms,
            item: row.item,
            items: row.items,
            file_changes: row.file_changes,
            work: None,
            collapsed_rows: Vec::new(),
            divider_before: row.divider_before,
        }
    }
}

fn item_row(item: ThreadTimelineSnapshotItem) -> ThreadTimelineWorkDetailRow {
    let kind = normalized_thread_item_kind(&item);
    ThreadTimelineWorkDetailRow {
        id: format!("item-{}", item.id),
        kind,
        turn_id: Some(item.turn_id.clone()),
        display_order: row_display_order(item.display_order),
        status: item.status.clone(),
        timestamp_ms: item.timestamp_ms,
        item: Some(item),
        items: Vec::new(),
        file_changes: Vec::new(),
        divider_before: None,
    }
}

fn activity_row(items: &[ThreadTimelineSnapshotItem]) -> ThreadTimelineWorkDetailRow {
    let first = items.first().expect("activity row has at least one item");
    ThreadTimelineWorkDetailRow {
        id: format!("activity-{}", first.id),
        kind: "activity".to_string(),
        turn_id: Some(first.turn_id.clone()),
        display_order: row_display_order(first.display_order),
        status: first.status.clone(),
        timestamp_ms: first.timestamp_ms,
        item: None,
        items: items.to_vec(),
        file_changes: Vec::new(),
        divider_before: None,
    }
}

fn file_changes_row(items: &[ThreadTimelineSnapshotItem]) -> ThreadTimelineWorkDetailRow {
    let first = items
        .first()
        .expect("file changes row has at least one item");
    let entries = file_change_entries_for_items(items);
    ThreadTimelineWorkDetailRow {
        id: format!("file-changes-turn-{}", first.turn_id),
        kind: "file_changes".to_string(),
        turn_id: Some(first.turn_id.clone()),
        display_order: row_display_order(first.display_order),
        status: first.status.clone(),
        timestamp_ms: first.timestamp_ms,
        item: None,
        items: Vec::new(),
        file_changes: entries,
        divider_before: None,
    }
}

fn row_display_order(item_display_order: i64) -> i64 {
    item_display_order.saturating_mul(100)
}

fn row_turn_key_from_detail(row: &ThreadTimelineWorkDetailRow) -> String {
    row.turn_id
        .as_ref()
        .map(|turn_id| format!("turn-{turn_id}"))
        .unwrap_or_else(|| format!("row-{}", row.id))
}

fn timeline_item_turn_key(item: &ThreadTimelineSnapshotItem) -> String {
    format!("turn-{}", item.turn_id)
}

fn row_contains_work_precursor(row: &ThreadTimelineWorkDetailRow) -> bool {
    row.kind == "user_message"
}

fn row_is_final_response(row: &ThreadTimelineWorkDetailRow) -> bool {
    row.item.as_ref().is_some_and(is_final_response_item)
}

fn row_is_prominent_turn_result(row: &ThreadTimelineWorkDetailRow) -> bool {
    row.kind == "user_message" || row.kind == "image_generation" || row.kind == "context_compaction"
}

fn is_timeline_activity_item(item: &ThreadTimelineSnapshotItem) -> bool {
    matches!(
        normalized_thread_item_kind(item).as_str(),
        "collab_agent_tool_call"
            | "command_execution"
            | "dynamic_tool_call"
            | "image_view"
            | "mcp_tool_call"
            | "web_search_group"
    )
}

fn is_final_response_item(item: &ThreadTimelineSnapshotItem) -> bool {
    matches!(
        normalized_thread_item_kind(item).as_str(),
        "assistant_message" | "agent_message"
    ) && item.payload.item.phase.as_deref() == Some("final_answer")
}

fn normalized_thread_item_kind(item: &ThreadTimelineSnapshotItem) -> String {
    let item_type = item.item_type.to_ascii_lowercase().replace(['_', '-'], "");
    match item_type.as_str() {
        "agentmessage" | "assistantmessage" => "assistant_message",
        "collabagenttoolcall" => "collab_agent_tool_call",
        "commandexecution" => "command_execution",
        "contextcompaction" => "context_compaction",
        "dynamictoolcall" => "dynamic_tool_call",
        "enteredreviewmode" => "review_mode_started",
        "exitedreviewmode" => "review_mode_finished",
        "filechange" => "file_change",
        "hookprompt" => "hook_prompt",
        "imagegeneration" | "imagegenerationcall" => "image_generation",
        "imageview" => "image_view",
        "mcptoolcall" => "mcp_tool_call",
        "plan" => "plan",
        "reasoning" => "reasoning_summary",
        "usermessage" => "user_message",
        "websearch" => "web_search_group",
        _ => item.item_type.as_str(),
    }
    .to_string()
}

fn file_change_entries_for_items(
    items: &[ThreadTimelineSnapshotItem],
) -> Vec<ThreadTimelineFileChangeEntry> {
    let mut entries_by_key =
        HashMap::<(String, String), (i64, ThreadTimelineFileChangeEntry)>::new();
    for item in items {
        for mut entry in file_change_entries_for_item(item) {
            entry.path = normalize_file_change_path(&entry.path);
            let key = (entry.path.clone(), entry.action.clone());
            if let Some((first_order, existing)) = entries_by_key.get_mut(&key) {
                *first_order = (*first_order).min(item.display_order);
                existing.additions += entry.additions;
                existing.deletions += entry.deletions;
                append_unique_diff_chunk(&mut existing.diff, &entry.diff);
                existing.item_ids.extend(entry.item_ids);
            } else {
                entries_by_key.insert(key, (item.display_order, entry));
            }
        }
    }
    let mut entries = entries_by_key
        .into_iter()
        .map(|((path, action), (display_order, entry))| (display_order, path, action, entry))
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
            .then_with(|| left.2.cmp(&right.2))
    });
    entries.into_iter().map(|(_, _, _, entry)| entry).collect()
}

fn normalize_file_change_path(path: &str) -> String {
    let mut normalized = path.trim().replace('\\', "/");
    while normalized.contains("//") {
        normalized = normalized.replace("//", "/");
    }
    normalized.trim_start_matches("./").to_string()
}

fn append_unique_diff_chunk(existing: &mut String, incoming: &str) {
    if incoming.is_empty() || existing.split("\n\n").any(|chunk| chunk == incoming) {
        return;
    }
    if !existing.is_empty() {
        existing.push_str("\n\n");
    }
    existing.push_str(incoming);
}

fn file_change_entries_for_item(
    item: &ThreadTimelineSnapshotItem,
) -> Vec<ThreadTimelineFileChangeEntry> {
    let Some(changes) = item.payload.item.changes.as_ref().and_then(Value::as_array) else {
        let path = item.payload.item.path.clone().unwrap_or_default();
        let action = file_change_action_label(item.payload.item.action.as_ref());
        if path.is_empty() && action.is_empty() {
            return Vec::new();
        }
        let diff = item
            .payload
            .item
            .diff
            .clone()
            .or_else(|| item.payload.item.output.clone())
            .unwrap_or_default();
        let (additions, deletions) = diff_line_counts(&diff);
        return vec![ThreadTimelineFileChangeEntry {
            id: format!("file-change-{}-{path}-{action}", item.id),
            path,
            action,
            additions,
            deletions,
            diff,
            item_ids: vec![item.id.clone()],
        }];
    };

    changes
        .iter()
        .filter_map(|change| {
            let path = string_field(change, "path")?;
            let action = file_change_action_label(change.get("kind"));
            let diff = string_field(change, "diff").unwrap_or_default();
            let (additions, deletions) = diff_line_counts(&diff);
            Some(ThreadTimelineFileChangeEntry {
                id: format!("file-change-{}-{path}-{action}", item.id),
                path,
                action,
                additions,
                deletions,
                diff,
                item_ids: vec![item.id.clone()],
            })
        })
        .collect()
}

fn file_change_action_label(value: Option<&Value>) -> String {
    let raw = match value {
        Some(Value::Object(object)) => object
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        Some(Value::String(value)) => value.clone(),
        _ => String::new(),
    };
    let normalized = raw.to_ascii_lowercase();
    match normalized.as_str() {
        "add" | "added" => "Added".to_string(),
        "delete" | "deleted" | "remove" | "removed" => "Deleted".to_string(),
        "update" | "modify" | "modified" => "Modified".to_string(),
        _ if raw.is_empty() => String::new(),
        _ => {
            let mut chars = raw.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        }
    }
}

fn string_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TimelineDisplayItemPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub item_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changes: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receiver_thread_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agents_states: Option<Value>,
    #[serde(
        default,
        rename = "agent_nickname",
        skip_serializing_if = "Option::is_none"
    )]
    pub agent_nickname_snake: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_nickname: Option<String>,
    #[serde(
        default,
        rename = "agent_role",
        skip_serializing_if = "Option::is_none"
    )]
    pub agent_role_snake: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_path: Option<String>,
    #[serde(
        default,
        rename = "saved_path",
        skip_serializing_if = "Option::is_none"
    )]
    pub saved_path_snake: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revised_prompt: Option<String>,
    #[serde(
        default,
        rename = "revised_prompt",
        skip_serializing_if = "Option::is_none"
    )]
    pub revised_prompt_snake: Option<String>,
}

pub(crate) fn compact_timeline_item_payload(item: &Value) -> TimelineDisplayItemPayload {
    let Some(object) = item.as_object() else {
        return TimelineDisplayItemPayload::default();
    };
    TimelineDisplayItemPayload {
        id: display_string(object, "id"),
        item_type: display_string(object, "type"),
        status: display_string(object, "status"),
        phase: display_string(object, "phase"),
        text: display_string(object, "text"),
        message: display_string(object, "message"),
        content: display_value(object, "content"),
        summary: display_value(object, "summary"),
        review: display_string(object, "review"),
        command: display_string(object, "command"),
        cwd: display_string(object, "cwd"),
        output: display_string(object, "output")
            .or_else(|| display_string(object, "aggregatedOutput")),
        diff: display_string(object, "diff"),
        stdout: display_string(object, "stdout"),
        stderr: display_string(object, "stderr"),
        path: display_string(object, "path"),
        action: display_value(object, "action"),
        change: display_value(object, "change"),
        changes: display_value(object, "changes"),
        query: display_string(object, "query"),
        tool: display_string(object, "tool"),
        tool_name: display_string(object, "toolName"),
        name: display_string(object, "name"),
        arguments: display_value(object, "arguments"),
        args: display_value(object, "args"),
        result: display_string(object, "result"),
        receiver_thread_ids: object.get("receiverThreadIds").and_then(|value| {
            value.as_array().map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
        }),
        agents_states: display_value(object, "agentsStates"),
        agent_nickname_snake: display_string(object, "agent_nickname"),
        agent_nickname: display_string(object, "agentNickname"),
        agent_role_snake: display_string(object, "agent_role"),
        agent_role: display_string(object, "agentRole"),
        prompt: display_string(object, "prompt"),
        model: display_string(object, "model"),
        reasoning_effort: display_string(object, "reasoningEffort"),
        saved_path: display_string(object, "savedPath"),
        saved_path_snake: display_string(object, "saved_path"),
        revised_prompt: display_string(object, "revisedPrompt"),
        revised_prompt_snake: display_string(object, "revised_prompt"),
    }
}

fn display_string(object: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(compact_preview_string)
}

fn display_value(object: &serde_json::Map<String, Value>, key: &str) -> Option<Value> {
    object.get(key).map(compact_timeline_preview_value)
}

fn compact_timeline_preview_value(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(compact_preview_string(text)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(compact_timeline_preview_value)
                .collect::<Vec<_>>(),
        ),
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| (key.clone(), compact_timeline_preview_value(value)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn compact_preview_string(value: &str) -> String {
    if value.len() <= TIMELINE_PREVIEW_STRING_LIMIT {
        return value.to_string();
    }
    let mut end = TIMELINE_PREVIEW_STRING_LIMIT;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...[truncated]", &value[..end])
}

fn diff_line_counts(diff: &str) -> (i64, i64) {
    let mut additions = 0;
    let mut deletions = 0;
    for line in diff.lines() {
        if line.starts_with('+') && !line.starts_with("+++") {
            additions += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            deletions += 1;
        }
    }
    (additions, deletions)
}

fn live_state_from_turns(turns: &[ThreadTurnSnapshot]) -> ThreadLiveState {
    turns
        .iter()
        .rev()
        .find(|turn| !is_terminal_turn_status(&turn.status))
        .map(|turn| thread_live_state_from_turn_status(&turn.status))
        .unwrap_or(ThreadLiveState::Idle)
}

pub(crate) fn thread_live_state_from_turn_status(status: &str) -> ThreadLiveState {
    match status {
        "completed" | "failed" | "cancelled" | "canceled" | "interrupted" => ThreadLiveState::Idle,
        "unknown" => ThreadLiveState::NotLoaded,
        _ => ThreadLiveState::Streaming,
    }
}

fn snapshot_item_timestamp_ms(turn: &ThreadTurnSnapshot, item: &ThreadItemSnapshot) -> Option<i64> {
    let item_type = item.item_type.to_lowercase();
    if item_type.contains("user") {
        return turn.started_at.map(unix_seconds_to_ms);
    }
    if item_type.contains("agent") || item_type.contains("assistant") {
        return turn
            .completed_at
            .or(turn.started_at)
            .map(unix_seconds_to_ms);
    }
    turn.started_at.map(unix_seconds_to_ms)
}

fn unix_seconds_to_ms(seconds: i64) -> i64 {
    seconds.saturating_mul(1000)
}
