use super::{normalized_thread_item_kind, ThreadTimelineSnapshotItem};
use serde_json::Value;

// Keep aligned with timeline/presentation.ts. Visibility and semantic boundaries
// differ: even empty user/assistant messages retain their conversation boundary.
// This is recomputed from canonical items on every projection, not cached state.
pub(super) fn is_transparent_separator(item: &ThreadTimelineSnapshotItem) -> bool {
    let payload = &item.payload.item;
    match normalized_thread_item_kind(item).as_str() {
        "reasoning_summary" => {
            !has_text(payload.text.as_deref())
                && !has_content(payload.content.as_ref())
                && !has_summary(payload.summary.as_ref())
        }
        "plan" => {
            !has_text(payload.text.as_deref())
                && !has_text(payload.message.as_deref())
                && !has_content(payload.content.as_ref())
        }
        "hook_prompt" => true,
        "user_message"
        | "assistant_message"
        | "context_compaction"
        | "review_mode_started"
        | "review_mode_finished"
        | "image_generation"
        | "warning"
        | "error"
        | "file_change"
        | "collab_agent_tool_call"
        | "command_execution"
        | "dynamic_tool_call"
        | "image_view"
        | "mcp_tool_call"
        | "web_search_group" => false,
        // Unsupported native items (including subAgentActivity) are diagnostics
        // only in the browser. Add a boundary here when adding a visible renderer.
        _ => true,
    }
}

fn has_text(text: Option<&str>) -> bool {
    text.is_some_and(|text| !text.is_empty())
}

fn has_content(content: Option<&Value>) -> bool {
    match content {
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(parts)) => parts.iter().any(|part| {
            if let Some(text) = part.as_str() {
                return !text.is_empty();
            }
            let kind = part
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_ascii_lowercase();
            !matches!(
                kind.as_str(),
                "image"
                    | "input_image"
                    | "inputimage"
                    | "local_image"
                    | "localimage"
                    | "mention"
                    | "skill"
            ) && (has_text(part.get("text").and_then(Value::as_str))
                || has_text(part.get("content").and_then(Value::as_str)))
        }),
        _ => false,
    }
}

fn has_summary(summary: Option<&Value>) -> bool {
    match summary {
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(parts)) => parts.iter().any(|part| has_summary(Some(part))),
        Some(Value::Object(fields)) => !fields.is_empty(),
        Some(Value::Bool(_) | Value::Number(_)) => true,
        _ => false,
    }
}
