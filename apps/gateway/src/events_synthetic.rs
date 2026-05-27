use chrono::Utc;
use serde::Serialize;
use serde_json::json;
use uuid::Uuid;

use crate::{
    error::ApiResult, store::EventEnvelope, thread_view::THREAD_VIEW_REFRESH_REQUIRED_EVENT_KIND,
};

pub(crate) fn thread_view_refresh_required_event(
    seq: i64,
    thread_id: String,
    reason: &str,
) -> ApiResult<EventEnvelope> {
    synthetic_event(
        seq,
        Some(thread_id.clone()),
        None,
        None,
        THREAD_VIEW_REFRESH_REQUIRED_EVENT_KIND,
        Some("thread_view/refresh_required"),
        json!({
            "threadId": thread_id,
            "reason": reason,
        }),
    )
}

pub(crate) fn synthetic_event(
    seq: i64,
    thread_id: Option<String>,
    turn_id: Option<String>,
    item_id: Option<String>,
    kind: &str,
    codex_method: Option<&str>,
    payload: impl Serialize,
) -> ApiResult<EventEnvelope> {
    Ok(EventEnvelope {
        seq,
        id: Uuid::new_v4().to_string(),
        received_at: Utc::now(),
        project_id: None,
        thread_id,
        turn_id,
        item_id,
        kind: kind.to_string(),
        codex_method: codex_method.map(str::to_string),
        payload: serde_json::to_value(payload)?,
    })
}
