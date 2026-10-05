use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex},
};

use tokio::sync::{Mutex, OwnedMutexGuard};

use crate::{
    api::AppState,
    app_server_api::{self, ThreadLiveState, TimelineFileAttachment, UserInput},
    error::ApiResult,
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
    let revision = state.store.latest_event_seq().await?;
    let snapshot = match app_server_api::client(&state.app_server)
        .thread_read(thread_id.to_string())
        .await
    {
        Ok(snapshot) => snapshot,
        Err(error)
            if app_server_api::is_thread_not_materialized_before_first_user_message(&error) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let active_turn_id = snapshot.timeline.active_turn_id.clone();
    let timeline = state
        .thread_views
        .refresh_from_turns(thread_id, &snapshot.turns, revision)
        .await?;
    if active_turn_id.is_none() && timeline.active_turn_id.is_some() {
        record_idle_after_missing_active_turn(state, thread_id).await?;
    }
    Ok(active_turn_id)
}

pub async fn record_idle_after_missing_active_turn(
    state: &AppState,
    thread_id: &str,
) -> ApiResult<()> {
    thread_view::record_thread_live_state(
        &state.thread_views,
        thread_id,
        ThreadLiveState::Idle,
        async {
            Ok(state
                .store
                .append_event(crate::store::NewEvent {
                    project_id: None,
                    thread_id: Some(thread_id.to_string()),
                    turn_id: None,
                    item_id: None,
                    kind: crate::events_replay::THREAD_VIEW_CURSOR_KIND.to_string(),
                    codex_method: None,
                    payload: serde_json::json!({"reason": "missing_active_turn"}),
                })
                .await?
                .seq)
        },
    )
    .await?;
    Ok(())
}

pub async fn record_pending_user_projection(
    state: &AppState,
    thread_id: &str,
    turn_id: &str,
    client_id: &str,
    input: &[UserInput],
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
