//! Per-reader transcript detail policy; never mutates the shared canonical view.
#[cfg(test)]
use crate::thread_view::ThreadViewPatch;
use serde::Deserialize;
use utoipa::{IntoParams, ToSchema};

use crate::app_server_api::{
    timeline_item_is_diagnostic, timeline_json_item_is_diagnostic, ThreadTimelineRow,
    ThreadTimelineSnapshot, ThreadTimelineSnapshotItem, ThreadTimelineWorkDetailRow,
    TimelineDisplayItemPayload,
};

#[derive(Debug, Default, Clone, Copy, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct ThreadViewDeliveryQuery {
    #[param(required = false, default = false)]
    pub include_debug_events: bool,
    #[param(required = false, default = false)]
    pub include_command_outputs: bool,
}

impl ThreadViewDeliveryQuery {
    pub(crate) fn project_snapshot(self, snapshot: &mut ThreadTimelineSnapshot) {
        self.project_rows(&mut snapshot.rows);
        // Internal item indexes are not serialized, but response ownership should not
        // leave another copy of disabled details in an otherwise projected value.
        for item in &mut snapshot.items {
            self.project_item(item);
        }
    }

    #[cfg(test)]
    fn project_patch(self, patch: &mut ThreadViewPatch) {
        if let Some(rows) = &mut patch.rows {
            self.project_rows(rows);
        }
        for item in &mut patch.items {
            self.project_item(item);
        }
    }

    /// Canonical SSE is already serialized. Borrow its fields rather than rebuilding
    /// typed rows (and cloning large output strings) for each subscribed browser.
    pub(crate) fn project_patch_payload(self, payload: &mut serde_json::Value) {
        if self.include_debug_events && self.include_command_outputs {
            return;
        }
        if let Some(rows) = payload
            .get_mut("rows")
            .and_then(serde_json::Value::as_array_mut)
        {
            for row in rows {
                self.project_json_row(row);
            }
        }
    }

    fn project_json_row(self, row: &mut serde_json::Value) {
        if let Some(item) = row.get_mut("item") {
            self.project_json_item(item);
        }
        if let Some(items) = row
            .get_mut("items")
            .and_then(serde_json::Value::as_array_mut)
        {
            for item in items {
                self.project_json_item(item);
            }
        }
        if let Some(rows) = row
            .get_mut("collapsedRows")
            .and_then(serde_json::Value::as_array_mut)
        {
            for row in rows {
                self.project_json_row(row);
            }
        }
    }

    fn project_json_item(self, item: &mut serde_json::Value) {
        if item.is_null() {
            return;
        }
        let item_type = item
            .get("itemType")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let diagnostic = item
            .get("payload")
            .and_then(|payload| payload.get("item"))
            .is_none_or(|payload| timeline_json_item_is_diagnostic(item_type, payload));
        let command = item_type.to_ascii_lowercase().replace(['_', '-'], "") == "commandexecution";
        let Some(payload) = item.get_mut("payload") else {
            return;
        };
        if diagnostic && !self.include_debug_events {
            *payload = serde_json::json!({"item":{}});
        } else if !self.include_command_outputs && (diagnostic || command) {
            if let Some(fields) = payload
                .get_mut("item")
                .and_then(serde_json::Value::as_object_mut)
            {
                for key in ["output", "stdout", "stderr"] {
                    fields.remove(key);
                }
            } else {
                *payload = serde_json::json!({"item":{}});
            }
        }
    }

    fn project_rows(self, rows: &mut [ThreadTimelineRow]) {
        for row in rows {
            if let Some(item) = &mut row.item {
                self.project_item(item);
            }
            for item in &mut row.items {
                self.project_item(item);
            }
            for row in &mut row.collapsed_rows {
                self.project_detail(row);
            }
        }
    }

    fn project_detail(self, row: &mut ThreadTimelineWorkDetailRow) {
        if let Some(item) = &mut row.item {
            self.project_item(item);
        }
        for item in &mut row.items {
            self.project_item(item);
        }
    }

    fn project_item(self, item: &mut ThreadTimelineSnapshotItem) {
        let diagnostic = timeline_item_is_diagnostic(item);
        if diagnostic && !self.include_debug_events {
            // Keep row/turn membership and native identity for scoped patch bases.
            // A marker carries no diagnostic content and is not shown as a debug row.
            item.payload.item = TimelineDisplayItemPayload::default();
            item.payload.client_id = None;
            item.payload.skill_mentions.clear();
            item.payload.file_attachments.clear();
        } else if !self.include_command_outputs
            && (diagnostic
                || item.item_type.to_ascii_lowercase().replace(['_', '-'], "")
                    == "commandexecution")
        {
            item.payload.item.output = None;
            item.payload.item.stdout = None;
            item.payload.item.stderr = None;
        }
    }
}

#[cfg(test)]
#[path = "thread_view_delivery/tests.rs"]
mod tests;
