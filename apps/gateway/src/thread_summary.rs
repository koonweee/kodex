use serde::Serialize;
use serde_json::Value;
use utoipa::ToSchema;

use crate::{
    api::AppState,
    error::ApiResult,
    store::{EventEnvelope, NewEvent},
};

pub const THREAD_SUMMARY_CHANGED_EVENT: &str = "thread.summary_changed";

/// A native metadata refill signal, not a title or sidebar membership projection.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummaryChanged {
    pub thread_id: String,
}

pub(crate) async fn native_change_event(
    state: &AppState,
    method: &str,
    params: &Value,
) -> ApiResult<Option<EventEnvelope>> {
    if method != "item/completed"
        || params.pointer("/item/type").and_then(Value::as_str) != Some("userMessage")
    {
        return Ok(None);
    }
    let Some(thread_id) = params.get("threadId").and_then(Value::as_str) else {
        return Ok(None);
    };
    // In the pinned paginated runtime, recording the accepted user item flushes
    // and projects native metadata before completion delivery. thread/start and
    // turn/start acknowledgments are too early to read the first user preview.
    // Keep RPCs out of serial ingestion: clients refill from native snapshots.
    state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: Some(thread_id.to_owned()),
            turn_id: None,
            item_id: None,
            kind: THREAD_SUMMARY_CHANGED_EVENT.into(),
            codex_method: Some(method.into()),
            payload: serde_json::to_value(ThreadSummaryChanged {
                thread_id: thread_id.to_owned(),
            })?,
        })
        .await
        .map(Some)
}

#[cfg(test)]
mod tests;
