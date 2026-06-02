use crate::{
    app_server_api::{
        thread_timeline_rows_from_items, ThreadTimelineRow, ThreadTimelineSnapshotItem,
    },
    thread_view::{merge_missing_turns, ordered_turns_for_items, ThreadView, ThreadViewPatch},
};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

impl ThreadView {
    pub(crate) fn rows_for_turn(&self, turn_id: &str) -> Vec<ThreadTimelineRow> {
        let mut items = self
            .items
            .iter()
            .filter(|item| item.turn_id == turn_id)
            .cloned()
            .collect::<Vec<_>>();
        items.sort_by_key(|item| item.display_order);
        let turns = self.turns_for_patch_items(turn_id, &items);
        thread_timeline_rows_from_items(
            self.active_turn_id.as_deref(),
            self.live_state,
            &turns,
            &items,
        )
    }

    pub(crate) fn row_delta_or_turn_patch(
        &self,
        turn_id: &str,
        before_rows: Vec<ThreadTimelineRow>,
    ) -> ThreadViewPatch {
        let turn_patch = self.turn_patch(turn_id);
        let after_rows = turn_patch.rows.clone().unwrap_or_default();
        let changed_rows = changed_rows_by_id(&before_rows, &after_rows);
        let removed_row_ids = removed_row_ids_by_id(&before_rows, &after_rows);
        if changed_rows.is_empty() && removed_row_ids.is_empty() {
            return turn_patch;
        }
        if !is_semantically_safe_row_delta(&before_rows, &changed_rows, &removed_row_ids) {
            return turn_patch;
        }
        let row_delta = ThreadViewPatch::row_delta(
            self.revision,
            self.thread_id.clone(),
            self.active_turn_id.clone(),
            self.live_state,
            self.pending_approval_requests.clone(),
            self.pending_user_input_requests.clone(),
            changed_rows,
            removed_row_ids,
            vec![turn_id.to_string()],
            turn_patch.turns.clone(),
            turn_patch.items.clone(),
        );
        let row_delta_size = serde_json::to_vec(&row_delta).map(|bytes| bytes.len());
        let turn_patch_size = serde_json::to_vec(&turn_patch).map(|bytes| bytes.len());
        match (row_delta_size, turn_patch_size) {
            (Ok(delta_size), Ok(turn_size)) if delta_size < turn_size => row_delta,
            _ => turn_patch,
        }
    }

    pub(crate) fn turn_patch(&self, turn_id: &str) -> ThreadViewPatch {
        let mut items = self
            .items
            .iter()
            .filter(|item| item.turn_id == turn_id)
            .cloned()
            .collect::<Vec<_>>();
        items.sort_by_key(|item| item.display_order);
        let turns = self.turns_for_patch_items(turn_id, &items);
        let rows = self.rows_for_turn(turn_id);
        ThreadViewPatch::turn(
            self.revision,
            self.thread_id.clone(),
            self.active_turn_id.clone(),
            self.live_state,
            self.pending_approval_requests.clone(),
            self.pending_user_input_requests.clone(),
            rows,
            vec![turn_id.to_string()],
            turns,
            items,
        )
    }

    pub(crate) fn to_patch(&self) -> ThreadViewPatch {
        let mut items = self.items.clone();
        items.sort_by_key(|item| item.display_order);
        let turns = self.turns_for_items(&items);
        let rows = thread_timeline_rows_from_items(
            self.active_turn_id.as_deref(),
            self.live_state,
            &turns,
            &items,
        );
        ThreadViewPatch::full_snapshot(
            self.revision,
            self.thread_id.clone(),
            self.active_turn_id.clone(),
            self.live_state,
            self.pending_approval_requests.clone(),
            self.pending_user_input_requests.clone(),
            rows,
            turns,
            items,
        )
    }

    pub(crate) fn lifecycle_patch(&self) -> ThreadViewPatch {
        ThreadViewPatch::lifecycle(
            self.revision,
            self.thread_id.clone(),
            self.active_turn_id.clone(),
            self.live_state,
            self.pending_approval_requests.clone(),
            self.pending_user_input_requests.clone(),
        )
    }

    fn turns_for_patch_items(
        &self,
        turn_id: &str,
        items: &[ThreadTimelineSnapshotItem],
    ) -> Vec<crate::app_server_api::ThreadTimelineSnapshotTurn> {
        let mut turns = self
            .turns
            .iter()
            .filter(|turn| turn.id == turn_id)
            .cloned()
            .collect::<Vec<_>>();
        merge_missing_turns(&mut turns, &[], items);
        ordered_turns_for_items(&turns, items)
    }
}

fn is_semantically_safe_row_delta(
    before_rows: &[ThreadTimelineRow],
    changed_rows: &[ThreadTimelineRow],
    removed_row_ids: &[String],
) -> bool {
    if before_rows.is_empty() {
        return false;
    }
    if removed_row_ids.len() > 1 {
        return false;
    }
    if !removed_row_ids.is_empty() && !changed_rows.is_empty() {
        return false;
    }
    let before_by_id = before_rows
        .iter()
        .map(|row| (row.id.as_str(), row))
        .collect::<HashMap<_, _>>();
    changed_rows.iter().all(|row| {
        before_by_id
            .get(row.id.as_str())
            .is_none_or(|before| before.kind == row.kind && before.turn_id == row.turn_id)
    })
}

fn changed_rows_by_id(
    before_rows: &[ThreadTimelineRow],
    after_rows: &[ThreadTimelineRow],
) -> Vec<ThreadTimelineRow> {
    let before_by_id = before_rows
        .iter()
        .filter_map(|row| {
            serde_json::to_value(row)
                .ok()
                .map(|value| (row.id.as_str(), value))
        })
        .collect::<HashMap<_, Value>>();
    after_rows
        .iter()
        .filter(|row| {
            let Ok(after_value) = serde_json::to_value(row) else {
                return true;
            };
            before_by_id
                .get(row.id.as_str())
                .is_none_or(|before_value| before_value != &after_value)
        })
        .cloned()
        .collect()
}

fn removed_row_ids_by_id(
    before_rows: &[ThreadTimelineRow],
    after_rows: &[ThreadTimelineRow],
) -> Vec<String> {
    let after_ids = after_rows
        .iter()
        .map(|row| row.id.as_str())
        .collect::<HashSet<_>>();
    before_rows
        .iter()
        .filter(|row| !after_ids.contains(row.id.as_str()))
        .map(|row| row.id.clone())
        .collect()
}
