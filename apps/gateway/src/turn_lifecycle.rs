use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex},
};

use tokio::sync::{Mutex, OwnedMutexGuard};

use crate::{
    api::AppState,
    app_server_api::{
        self, SortDirection, ThreadStatus, ThreadTurnItemsView, TimelineFileAttachment,
    },
    error::{ApiError, ApiResult},
    events, thread_view,
};

#[derive(Clone, Default)]
pub struct ThreadInputLocks {
    inner: Arc<StdMutex<HashMap<String, Arc<Mutex<()>>>>>,
}

impl ThreadInputLocks {
    pub async fn lock(&self, thread_id: &str) -> OwnedMutexGuard<()> {
        let lock = self
            .inner
            .lock()
            .unwrap()
            .entry(thread_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        lock.lock_owned().await
    }
}

pub async fn refreshed_active_turn_id(
    state: &AppState,
    thread_id: &str,
) -> ApiResult<Option<String>> {
    let client = app_server_api::client(&state.app_server);
    let thread = client.thread_read_summary(thread_id.to_string()).await?;
    if thread.id != thread_id {
        return Err(ApiError::BadGateway(
            "native Stop metadata returned a different thread".into(),
        ));
    }
    if thread.status != ThreadStatus::Active {
        return Ok(None);
    }
    // Only the latest native header is needed to select Stop's target. A
    // header is not a transcript snapshot and must never replace live rows.
    let page = match client
        .thread_turns_list_page(
            thread_id.to_string(),
            None,
            SortDirection::Desc,
            ThreadTurnItemsView::NotLoaded,
            Some(1),
        )
        .await
    {
        Ok(page) => page,
        Err(error)
            if app_server_api::is_thread_not_materialized_before_first_user_message(
                &error, thread_id,
            ) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let turn = page.data.first().ok_or_else(|| {
        ApiError::BadGateway(
            "native Stop metadata is active but the turn header is unavailable".into(),
        )
    })?;
    match turn
        .raw_payload
        .get("status")
        .and_then(serde_json::Value::as_str)
    {
        Some("inProgress") => Ok(Some(turn.id.clone())),
        Some("completed" | "interrupted" | "failed") => Ok(None),
        _ => Err(ApiError::BadGateway(
            "native Stop header has a missing or invalid required status".into(),
        )),
    }
}

pub async fn record_pending_user_projection(
    state: &AppState,
    thread_id: &str,
    turn_id: &str,
    client_id: &str,
    input: &[impl serde::Serialize],
    attachments: &[TimelineFileAttachment],
    submission_revision: i64,
) -> ApiResult<()> {
    if state
        .thread_views
        .ensure_history_current(thread_id, submission_revision)
        .await
        .is_err()
    {
        return Ok(());
    }
    if let Some(patch) = thread_view::record_pending_user_input(
        &state.thread_views,
        thread_id,
        turn_id,
        client_id,
        input,
        attachments,
        (submission_revision, async {
            Ok(state
                .store
                .append_event(crate::store::NewEvent {
                    project_id: None,
                    thread_id: Some(thread_id.to_string()),
                    turn_id: Some(turn_id.to_string()),
                    item_id: None,
                    kind: "timeline.pending_user_input".to_string(),
                    codex_method: Some("turn/input".to_string()),
                    payload: serde_json::json!({ "threadId": thread_id, "turnId": turn_id }),
                })
                .await?
                .seq)
        }),
    )
    .await?
    {
        let event = events::thread_view_patch_payload_event(state, patch).await?;
        let _ = state.events.send(event);
    }
    Ok(())
}

pub fn pending_projection_turn_id(payload: &serde_json::Value) -> Option<String> {
    payload
        .get("turnId")
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            payload
                .get("turn")
                .and_then(|turn| turn.get("id"))
                .and_then(serde_json::Value::as_str)
        })
        .map(str::to_string)
}
