use crate::{
    app_server_api::{thread_timeline_rows_from_items, ThreadTimelineSnapshotItem},
    thread_view::{merge_missing_turns, ordered_turns_for_items, ThreadView, ThreadViewPatch},
};

impl ThreadView {
    pub(crate) fn turn_patch(&self, turn_id: &str) -> ThreadViewPatch {
        let mut items = self
            .items
            .iter()
            .filter(|item| item.turn_id == turn_id)
            .cloned()
            .collect::<Vec<_>>();
        items.sort_by_key(|item| item.display_order);
        let turns = self.turns_for_patch_items(turn_id, &items);
        let rows = thread_timeline_rows_from_items(
            self.active_turn_id.as_deref(),
            self.live_state,
            &turns,
            &items,
        );
        ThreadViewPatch::turn(
            self.revision,
            self.thread_id.clone(),
            self.active_turn_id.clone(),
            self.live_state,
            self.pending_approval_requests.clone(),
            self.pending_user_input_requests.clone(),
            rows,
            Vec::new(),
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
