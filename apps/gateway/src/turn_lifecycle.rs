use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex},
};

use tokio::sync::{Mutex, OwnedMutexGuard};

use crate::{
    api::AppState,
    app_server_api::{
        self, timeline_skill_mentions_from_user_input, SkillMetadata, ThreadLiveState, UserInput,
    },
    error::{ApiError, ApiResult},
    events,
    store::ThreadRuntimeState,
    thread_view,
};

const GATEWAY_PENDING_TURN_START_ID: &str = "__gateway_pending_turn_start__";

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

pub async fn current_active_turn_id(
    state: &AppState,
    thread_id: &str,
) -> ApiResult<Option<String>> {
    if let Some(active_turn_id) = state.thread_views.active_turn_id(thread_id).await {
        return Ok(Some(active_turn_id));
    }
    let snapshot = match app_server_api::client(&state.app_server)
        .thread_read(thread_id.to_string())
        .await
    {
        Ok(snapshot) => snapshot,
        Err(error) if is_thread_not_materialized_before_first_user_message(&error) => {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let revision = state.store.latest_event_seq().await?;
    let timeline = state
        .thread_views
        .refresh_from_turns(thread_id, &snapshot.turns, revision)
        .await;
    Ok(timeline.active_turn_id)
}

pub async fn refreshed_active_turn_id(
    state: &AppState,
    thread_id: &str,
) -> ApiResult<Option<String>> {
    let snapshot = match app_server_api::client(&state.app_server)
        .thread_read(thread_id.to_string())
        .await
    {
        Ok(snapshot) => snapshot,
        Err(error) if is_thread_not_materialized_before_first_user_message(&error) => {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let active_turn_id = snapshot.timeline.active_turn_id.clone();
    let revision = state.store.latest_event_seq().await?;
    let timeline = state
        .thread_views
        .refresh_from_turns(thread_id, &snapshot.turns, revision)
        .await;
    if active_turn_id.is_none() && timeline.active_turn_id.is_some() {
        record_idle_after_missing_active_turn(state, thread_id).await?;
    }
    Ok(active_turn_id)
}

pub async fn routed_active_turn_id(state: &AppState, thread_id: &str) -> ApiResult<Option<String>> {
    if let Some(runtime) = state.store.get_thread_runtime_state(thread_id).await? {
        match runtime.status.as_str() {
            "syncing" | "starting" | "draining" => {
                return Ok(Some(
                    runtime
                        .active_turn_id
                        .unwrap_or_else(|| GATEWAY_PENDING_TURN_START_ID.to_string()),
                ));
            }
            "idle" => {
                return refreshed_active_turn_id(state, thread_id).await;
            }
            _ => {}
        }
    }
    refreshed_active_turn_id(state, thread_id).await
}

pub async fn record_turn_starting(state: &AppState, thread_id: &str) -> ApiResult<()> {
    state
        .store
        .upsert_thread_runtime_state(ThreadRuntimeState {
            thread_id: thread_id.to_string(),
            status: "starting".to_string(),
            active_turn_id: None,
            updated_at: chrono::Utc::now(),
            last_event_seq: Some(state.store.latest_event_seq().await?),
        })
        .await
}

pub async fn record_turn_start_failed(state: &AppState, thread_id: &str) -> ApiResult<()> {
    state
        .store
        .upsert_thread_runtime_state(ThreadRuntimeState {
            thread_id: thread_id.to_string(),
            status: "idle".to_string(),
            active_turn_id: None,
            updated_at: chrono::Utc::now(),
            last_event_seq: Some(state.store.latest_event_seq().await?),
        })
        .await
}

pub async fn record_turn_started(
    state: &AppState,
    thread_id: &str,
    turn_id: Option<&str>,
) -> ApiResult<()> {
    state
        .store
        .upsert_thread_runtime_state(ThreadRuntimeState {
            thread_id: thread_id.to_string(),
            status: "active".to_string(),
            active_turn_id: turn_id.map(str::to_string),
            updated_at: chrono::Utc::now(),
            last_event_seq: Some(state.store.latest_event_seq().await?),
        })
        .await
}

pub async fn record_compaction_starting(state: &AppState, thread_id: &str) -> ApiResult<()> {
    state
        .store
        .upsert_thread_runtime_state(ThreadRuntimeState {
            thread_id: thread_id.to_string(),
            status: "syncing".to_string(),
            active_turn_id: None,
            updated_at: chrono::Utc::now(),
            last_event_seq: Some(state.store.latest_event_seq().await?),
        })
        .await
}

pub async fn record_idle_after_missing_active_turn(
    state: &AppState,
    thread_id: &str,
) -> ApiResult<()> {
    thread_view::record_thread_live_state(
        &state.thread_views,
        thread_id,
        ThreadLiveState::Idle,
        state.store.latest_event_seq().await?,
    )
    .await?;
    Ok(())
}

pub async fn record_pending_user_projection(
    state: &AppState,
    thread_id: &str,
    turn_id: &str,
    input: &[UserInput],
) -> ApiResult<()> {
    let event = state
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
        .await?;
    if let Some(patch) = thread_view::record_pending_user_input(
        &state.thread_views,
        thread_id,
        turn_id,
        input,
        event.seq,
    )
    .await?
    {
        let event = events::thread_view_patch_payload_event(state, patch).await?;
        let _ = state.events.send(event);
    }
    Ok(())
}

pub async fn insert_pending_skill_mentions(
    state: &AppState,
    thread_id: &str,
    input: &[UserInput],
    skills: &[SkillMetadata],
) -> ApiResult<Option<String>> {
    let Some((text, mentions)) = timeline_skill_mentions_from_user_input(input, skills) else {
        return Ok(None);
    };
    state
        .store
        .insert_pending_timeline_skill_mentions(thread_id, &text, &mentions)
        .await
}

pub async fn delete_pending_skill_mentions(
    state: &AppState,
    pending_id: Option<&str>,
) -> ApiResult<()> {
    if let Some(pending_id) = pending_id {
        state
            .store
            .delete_pending_timeline_skill_mentions(pending_id)
            .await?;
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

pub fn is_no_active_turn_error(error: &ApiError) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    message.contains("no active turn")
        || message.contains("active turn")
            && (message.contains("missing") || message.contains("not found"))
}

pub fn is_non_steerable_error(error: &ApiError) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    message.contains("not steerable")
        || message.contains("activeturnnotsteerable")
        || message.contains("cannot steer")
        || message.contains("no active turn")
        || message.contains("expectedturnid")
        || message.contains("expected turn")
}

fn is_thread_not_materialized_before_first_user_message(error: &ApiError) -> bool {
    let ApiError::BadGateway(message) = error else {
        return false;
    };
    let normalized = message.to_ascii_lowercase();
    normalized.contains("not materialized yet") && normalized.contains("before first user message")
}
