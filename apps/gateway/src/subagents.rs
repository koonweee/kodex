use serde::Serialize;
use serde_json::Value;
use utoipa::ToSchema;

use crate::{
    api::AppState,
    error::ApiResult,
    store::{EventEnvelope, NewEvent},
};

pub const THREAD_SUBAGENTS_CHANGED_EVENT: &str = "thread.subagents_changed";

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSubagentsChanged {
    #[schema(required = true)]
    pub changed_thread_id: Option<String>,
}

pub(crate) async fn native_change_event(
    state: &AppState,
    method: &str,
    params: &Value,
) -> ApiResult<Option<EventEnvelope>> {
    let lifecycle_changed = matches!(
        method,
        "thread/started"
            | "thread/status/changed"
            | "thread/closed"
            | "thread/deleted"
            | "thread/archived"
            | "thread/unarchived"
            | "thread/name/updated"
    );
    let hook_changed = matches!(method, "hook/started" | "hook/completed")
        && params
            .get("run")
            .and_then(|run| run.get("eventName"))
            .and_then(Value::as_str)
            .is_some_and(|event| matches!(event, "subagentStart" | "subagentStop"));
    if !lifecycle_changed && !hook_changed {
        return Ok(None);
    }
    // Status/closed notifications do not carry ancestry. A global refill marker
    // reaches every open ancestor without reconstructing the native spawn graph.
    state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: None,
            turn_id: None,
            item_id: None,
            kind: THREAD_SUBAGENTS_CHANGED_EVENT.into(),
            codex_method: Some(method.into()),
            payload: serde_json::to_value(ThreadSubagentsChanged {
                changed_thread_id: params
                    .get("threadId")
                    .or_else(|| params.get("thread").and_then(|thread| thread.get("id")))
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })?,
        })
        .await
        .map(Some)
}
