use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::app_server_api::{
    PendingTimelineRequestSummary, ThreadLiveState, ThreadStatus, ThreadTimelineRow,
    ThreadTimelineSnapshotItem, ThreadTimelineSnapshotTurn,
};

pub const THREAD_VIEW_PATCH_EVENT_KIND: &str = "thread_view.patch";
pub const THREAD_VIEW_ITEM_DELTA_EVENT_KIND: &str = "thread_view.item_delta";
pub const THREAD_VIEW_REFRESH_REQUIRED_EVENT_KIND: &str = "thread_view.refresh_required";

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadViewItemDelta {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub delta: String,
    pub view_revision: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ThreadViewPatchScope {
    FullSnapshot,
    Turn,
    RowDelta,
    Lifecycle,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadViewPatch {
    pub scope: ThreadViewPatchScope,
    pub view_revision: i64,
    pub thread_id: String,
    pub active_turn_id: Option<String>,
    pub live_state: ThreadLiveState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_status: Option<ThreadStatus>,
    pub pending_approval_requests: Vec<PendingTimelineRequestSummary>,
    pub pending_user_input_requests: Vec<PendingTimelineRequestSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<Vec<ThreadTimelineRow>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub affected_turn_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub removed_row_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub turns: Vec<ThreadTimelineSnapshotTurn>,
    #[serde(default, skip_serializing)]
    #[schema(ignore)]
    pub items: Vec<ThreadTimelineSnapshotItem>,
}

impl ThreadViewPatch {
    pub(crate) fn full_snapshot(
        view_revision: i64,
        thread_id: String,
        active_turn_id: Option<String>,
        live_state: ThreadLiveState,
        pending_approval_requests: Vec<PendingTimelineRequestSummary>,
        pending_user_input_requests: Vec<PendingTimelineRequestSummary>,
        rows: Vec<ThreadTimelineRow>,
        turns: Vec<ThreadTimelineSnapshotTurn>,
        items: Vec<ThreadTimelineSnapshotItem>,
    ) -> Self {
        Self {
            scope: ThreadViewPatchScope::FullSnapshot,
            view_revision,
            thread_id,
            active_turn_id,
            live_state,
            thread_status: None,
            pending_approval_requests,
            pending_user_input_requests,
            rows: Some(rows),
            affected_turn_ids: Vec::new(),
            removed_row_ids: Vec::new(),
            turns,
            items,
        }
    }

    pub(crate) fn turn(
        view_revision: i64,
        thread_id: String,
        active_turn_id: Option<String>,
        live_state: ThreadLiveState,
        pending_approval_requests: Vec<PendingTimelineRequestSummary>,
        pending_user_input_requests: Vec<PendingTimelineRequestSummary>,
        rows: Vec<ThreadTimelineRow>,
        affected_turn_ids: Vec<String>,
        turns: Vec<ThreadTimelineSnapshotTurn>,
        items: Vec<ThreadTimelineSnapshotItem>,
    ) -> Self {
        Self {
            scope: ThreadViewPatchScope::Turn,
            view_revision,
            thread_id,
            active_turn_id,
            live_state,
            thread_status: None,
            pending_approval_requests,
            pending_user_input_requests,
            rows: Some(rows),
            affected_turn_ids,
            removed_row_ids: Vec::new(),
            turns,
            items,
        }
    }

    pub(crate) fn row_delta(
        view_revision: i64,
        thread_id: String,
        active_turn_id: Option<String>,
        live_state: ThreadLiveState,
        pending_approval_requests: Vec<PendingTimelineRequestSummary>,
        pending_user_input_requests: Vec<PendingTimelineRequestSummary>,
        rows: Vec<ThreadTimelineRow>,
        removed_row_ids: Vec<String>,
        affected_turn_ids: Vec<String>,
        turns: Vec<ThreadTimelineSnapshotTurn>,
        items: Vec<ThreadTimelineSnapshotItem>,
    ) -> Self {
        Self {
            scope: ThreadViewPatchScope::RowDelta,
            view_revision,
            thread_id,
            active_turn_id,
            live_state,
            thread_status: None,
            pending_approval_requests,
            pending_user_input_requests,
            rows: Some(rows),
            affected_turn_ids,
            removed_row_ids,
            turns,
            items,
        }
    }

    pub(crate) fn lifecycle(
        view_revision: i64,
        thread_id: String,
        active_turn_id: Option<String>,
        live_state: ThreadLiveState,
        pending_approval_requests: Vec<PendingTimelineRequestSummary>,
        pending_user_input_requests: Vec<PendingTimelineRequestSummary>,
    ) -> Self {
        Self {
            scope: ThreadViewPatchScope::Lifecycle,
            view_revision,
            thread_id,
            active_turn_id,
            live_state,
            thread_status: None,
            pending_approval_requests,
            pending_user_input_requests,
            rows: None,
            affected_turn_ids: Vec::new(),
            removed_row_ids: Vec::new(),
            turns: Vec::new(),
            items: Vec::new(),
        }
    }

    pub fn validate_scope(&self) -> Result<(), &'static str> {
        match self.scope {
            ThreadViewPatchScope::FullSnapshot => {
                if self.rows.is_none()
                    || !self.affected_turn_ids.is_empty()
                    || !self.removed_row_ids.is_empty()
                {
                    return Err(
                        "full_snapshot patches must carry rows and no affected turn or removed row ids",
                    );
                }
            }
            ThreadViewPatchScope::Turn => {
                if self.rows.is_none()
                    || self.affected_turn_ids.is_empty()
                    || !self.removed_row_ids.is_empty()
                {
                    return Err("turn patches must carry rows and affected turn ids only");
                }
            }
            ThreadViewPatchScope::RowDelta => {
                if self.affected_turn_ids.is_empty() {
                    return Err("row_delta patches must carry affected turn ids");
                }
                let rows = self.rows.as_deref().unwrap_or_default();
                if rows.is_empty() && self.removed_row_ids.is_empty() {
                    return Err("row_delta patches must carry changed rows or removed row ids");
                }
                if rows.iter().any(|row| {
                    row.turn_id
                        .as_ref()
                        .is_none_or(|turn_id| !self.affected_turn_ids.contains(turn_id))
                }) {
                    return Err("row_delta rows must belong to affected turn ids");
                }
            }
            ThreadViewPatchScope::Lifecycle => {
                if self.rows.is_some()
                    || !self.affected_turn_ids.is_empty()
                    || !self.removed_row_ids.is_empty()
                    || !self.turns.is_empty()
                    || !self.items.is_empty()
                {
                    return Err(
                        "lifecycle patches must not carry row, turn, removed row, or item payloads",
                    );
                }
            }
        }
        Ok(())
    }
}
