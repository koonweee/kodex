use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::app_server_api::{
    PendingTimelineRequestSummary, ThreadLiveState, ThreadTimelineRow, ThreadTimelineSnapshotItem,
    ThreadTimelineSnapshotTurn,
};

pub const THREAD_VIEW_PATCH_EVENT_KIND: &str = "thread_view.patch";
pub const THREAD_VIEW_REFRESH_REQUIRED_EVENT_KIND: &str = "thread_view.refresh_required";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ThreadViewPatchScope {
    FullSnapshot,
    Turn,
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
    pub pending_approval_requests: Vec<PendingTimelineRequestSummary>,
    pub pending_user_input_requests: Vec<PendingTimelineRequestSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<Vec<ThreadTimelineRow>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub upsert_rows: Vec<ThreadTimelineRow>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub remove_row_ids: Vec<String>,
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
            pending_approval_requests,
            pending_user_input_requests,
            rows: Some(rows),
            upsert_rows: Vec::new(),
            remove_row_ids: Vec::new(),
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
        upsert_rows: Vec<ThreadTimelineRow>,
        remove_row_ids: Vec<String>,
        turns: Vec<ThreadTimelineSnapshotTurn>,
        items: Vec<ThreadTimelineSnapshotItem>,
    ) -> Self {
        Self {
            scope: ThreadViewPatchScope::Turn,
            view_revision,
            thread_id,
            active_turn_id,
            live_state,
            pending_approval_requests,
            pending_user_input_requests,
            rows: None,
            upsert_rows,
            remove_row_ids,
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
            pending_approval_requests,
            pending_user_input_requests,
            rows: None,
            upsert_rows: Vec::new(),
            remove_row_ids: Vec::new(),
            turns: Vec::new(),
            items: Vec::new(),
        }
    }

    pub fn validate_scope(&self) -> Result<(), &'static str> {
        match self.scope {
            ThreadViewPatchScope::FullSnapshot => {
                if self.rows.is_none()
                    || !self.upsert_rows.is_empty()
                    || !self.remove_row_ids.is_empty()
                {
                    return Err("full_snapshot patches must carry rows and no upsert/remove rows");
                }
            }
            ThreadViewPatchScope::Turn => {
                if self.rows.is_some() {
                    return Err("turn patches must not carry full rows");
                }
            }
            ThreadViewPatchScope::Lifecycle => {
                if self.rows.is_some()
                    || !self.upsert_rows.is_empty()
                    || !self.remove_row_ids.is_empty()
                    || !self.turns.is_empty()
                    || !self.items.is_empty()
                {
                    return Err("lifecycle patches must not carry row, turn, or item payloads");
                }
            }
        }
        Ok(())
    }
}
