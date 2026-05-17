use axum::{
    extract::{Path, State},
    routing::{delete, get, post},
    Json, Router,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use utoipa::ToSchema;

use crate::{
    api::AppState,
    app_server_api::{self, ThreadLiveState, TurnStartOptions, UserInput},
    error::{ApiError, ApiResult},
    skills,
    store::{
        EventEnvelope, NewEvent, QueuedInput, QueuedInputPriority, QueuedInputStatus,
        ThreadRuntimeState,
    },
    turn_lifecycle,
};

pub const QUEUE_UPSERT_EVENT: &str = "turn_queue.item_upsert";
pub const QUEUE_DELETE_EVENT: &str = "turn_queue.item_deleted";

#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueuedInputCreateRequest {
    pub input: Vec<UserInput>,
    #[serde(flatten)]
    pub options: TurnStartOptions,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueuedInputListResponse {
    pub queued_inputs: Vec<QueuedInput>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueuedInputResponse {
    pub queued_input: QueuedInput,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueuedInputDeleteResponse {
    pub id: String,
    pub thread_id: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/threads/{thread_id}/queued-inputs",
            get(list_queued_inputs).post(create_queued_input),
        )
        .route(
            "/v1/threads/{thread_id}/queued-inputs/{queue_id}/retry",
            post(retry_queued_input),
        )
        .route(
            "/v1/threads/{thread_id}/queued-inputs/{queue_id}/steer",
            post(steer_queued_input),
        )
        .route(
            "/v1/threads/{thread_id}/queued-inputs/{queue_id}",
            delete(delete_queued_input),
        )
}

#[utoipa::path(get, path = "/v1/threads/{threadId}/queued-inputs", responses((status = 200, body = QueuedInputListResponse)))]
pub async fn list_queued_inputs(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> ApiResult<Json<QueuedInputListResponse>> {
    let queued_inputs = state.store.list_queued_inputs(&thread_id).await?;
    Ok(Json(QueuedInputListResponse { queued_inputs }))
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/queued-inputs", request_body = QueuedInputCreateRequest, responses((status = 200, body = QueuedInputResponse)))]
pub async fn create_queued_input(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<QueuedInputCreateRequest>,
) -> ApiResult<Json<QueuedInputResponse>> {
    let input = skills::resolve_turn_input_for_thread(&state, &thread_id, request.input).await?;
    state
        .store
        .save_thread_turn_options(&thread_id, &request.options)
        .await?;
    let queued_input = state
        .store
        .create_queued_input(&thread_id, input, request.options)
        .await?;
    broadcast_queue_upsert(&state, &queued_input).await?;
    trigger_queue_drain(state.clone(), thread_id);
    Ok(Json(QueuedInputResponse { queued_input }))
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/queued-inputs/{queueId}/retry", responses((status = 200, body = QueuedInputResponse)))]
pub async fn retry_queued_input(
    State(state): State<AppState>,
    Path((thread_id, queue_id)): Path<(String, String)>,
) -> ApiResult<Json<QueuedInputResponse>> {
    let queued_input = state
        .store
        .requeue_queued_input(&thread_id, &queue_id)
        .await?;
    broadcast_queue_upsert(&state, &queued_input).await?;
    trigger_queue_drain(state.clone(), thread_id);
    Ok(Json(QueuedInputResponse { queued_input }))
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/queued-inputs/{queueId}/steer", responses((status = 200, body = QueuedInputResponse)))]
pub async fn steer_queued_input(
    State(state): State<AppState>,
    Path((thread_id, queue_id)): Path<(String, String)>,
) -> ApiResult<Json<QueuedInputResponse>> {
    let Some(active_turn_id) = turn_lifecycle::current_active_turn_id(&state, &thread_id).await?
    else {
        return Err(ApiError::BadRequest(format!(
            "thread {thread_id} has no active turn to steer"
        )));
    };
    let queued_input = state
        .store
        .claim_queued_input_for_steering(&thread_id, &queue_id)
        .await?;
    broadcast_queue_upsert(&state, &queued_input).await?;

    let resolved = match skills::resolve_turn_input_with_skills_for_thread(
        &state,
        &thread_id,
        queued_input.input.clone(),
    )
    .await
    {
        Ok(resolved) => resolved,
        Err(error) => {
            let failed = state
                .store
                .mark_queued_input_failed(&thread_id, &queue_id, error.to_string())
                .await?;
            broadcast_queue_upsert(&state, &failed).await?;
            return Err(error);
        }
    };
    let pending_skill_mentions_id = turn_lifecycle::insert_pending_skill_mentions(
        &state,
        &thread_id,
        &resolved.input,
        &resolved.skills,
    )
    .await?;
    let result = app_server_api::client(&state.app_server)
        .turn_steer(
            thread_id.clone(),
            active_turn_id.clone(),
            resolved.input.clone(),
        )
        .await;
    match result {
        Ok(_) => {
            turn_lifecycle::record_pending_user_projection(
                &state,
                &thread_id,
                &active_turn_id,
                &resolved.input,
            )
            .await?;
            let queued_input = state
                .store
                .mark_queued_input_pending_commit(
                    &thread_id,
                    &queue_id,
                    &active_turn_id,
                    None,
                    pending_skill_mentions_id.as_deref(),
                )
                .await?;
            broadcast_queue_upsert(&state, &queued_input).await?;
            Ok(Json(QueuedInputResponse { queued_input }))
        }
        Err(error) if turn_lifecycle::is_non_steerable_error(&error) => {
            turn_lifecycle::delete_pending_skill_mentions(
                &state,
                pending_skill_mentions_id.as_deref(),
            )
            .await?;
            let queued_input = state
                .store
                .mark_queued_input_rejected_steer(&thread_id, &queue_id, error.to_string())
                .await?;
            broadcast_queue_upsert(&state, &queued_input).await?;
            Err(ApiError::BadRequest(
                "active turn cannot accept steering; queued for next turn".to_string(),
            ))
        }
        Err(error) => {
            turn_lifecycle::delete_pending_skill_mentions(
                &state,
                pending_skill_mentions_id.as_deref(),
            )
            .await?;
            let queued_input = state
                .store
                .mark_queued_input_failed(&thread_id, &queue_id, error.to_string())
                .await?;
            broadcast_queue_upsert(&state, &queued_input).await?;
            Err(error)
        }
    }
}

#[utoipa::path(delete, path = "/v1/threads/{threadId}/queued-inputs/{queueId}", responses((status = 200, body = QueuedInputDeleteResponse)))]
pub async fn delete_queued_input(
    State(state): State<AppState>,
    Path((thread_id, queue_id)): Path<(String, String)>,
) -> ApiResult<Json<QueuedInputDeleteResponse>> {
    state
        .store
        .delete_queued_input(&thread_id, &queue_id)
        .await?;
    broadcast_queue_delete(&state, &thread_id, &queue_id).await?;
    Ok(Json(QueuedInputDeleteResponse {
        id: queue_id,
        thread_id,
    }))
}

pub async fn recover_queued_inputs(state: &AppState) -> ApiResult<()> {
    for queued_input in state.store.recover_queued_inputs_after_restart().await? {
        broadcast_queue_upsert(state, &queued_input).await?;
    }
    for thread_id in state.store.queued_thread_ids().await? {
        trigger_queue_drain(state.clone(), thread_id);
    }
    Ok(())
}

pub async fn create_queued_input_with_source(
    state: &AppState,
    thread_id: &str,
    input: Vec<UserInput>,
    options: TurnStartOptions,
    source_type: Option<&str>,
    source_id: Option<&str>,
) -> ApiResult<QueuedInput> {
    let queued_input = state
        .store
        .create_queued_input_with_source(thread_id, input, options, source_type, source_id)
        .await?;
    broadcast_queue_upsert(state, &queued_input).await?;
    trigger_queue_drain(state.clone(), thread_id.to_string());
    Ok(queued_input)
}

pub fn trigger_queue_drain(state: AppState, thread_id: String) {
    tokio::spawn(async move {
        if let Err(error) = drain_one_queued_input(&state, &thread_id).await {
            tracing::debug!(%error, thread_id, "queue drain skipped or failed");
        }
    });
}

pub async fn refresh_runtime_state(state: &AppState, runtime: ThreadRuntimeState) -> ApiResult<()> {
    state.store.upsert_thread_runtime_state(runtime).await?;
    Ok(())
}

pub async fn reconcile_pending_steer_commit_event(
    state: &AppState,
    thread_id: &str,
    turn_id: &str,
    item: &Value,
) -> ApiResult<Option<EventEnvelope>> {
    if !is_user_message_item(item) {
        return Ok(None);
    }
    let committed_key = pending_steer_compare_key_from_item(item);
    let Some(pending) = state
        .store
        .oldest_pending_commit_input(thread_id, turn_id)
        .await?
    else {
        return Ok(None);
    };
    if pending_steer_compare_key_from_inputs(&pending.input) != committed_key {
        tracing::debug!(
            thread_id,
            turn_id,
            queue_id = pending.id,
            "committed user message did not match front pending steer"
        );
        return Ok(None);
    }
    state
        .store
        .delete_queued_input_for_gateway(thread_id, &pending.id)
        .await?;
    append_queue_delete_event(state, thread_id, &pending.id)
        .await
        .map(Some)
}

pub async fn requeue_unmatched_pending_commit_input_events_for_turn(
    state: &AppState,
    thread_id: &str,
    turn_id: &str,
) -> ApiResult<Vec<EventEnvelope>> {
    let rows = state
        .store
        .requeue_pending_commit_inputs_for_turn(
            thread_id,
            turn_id,
            "Steer was accepted but not confirmed in committed history before the turn ended.",
        )
        .await?;
    let mut events = Vec::new();
    for row in rows {
        events.push(append_queue_upsert_event(state, &row).await?);
    }
    Ok(events)
}

pub async fn requeue_unmatched_pending_commit_input_events_for_thread(
    state: &AppState,
    thread_id: &str,
) -> ApiResult<Vec<EventEnvelope>> {
    let rows = state
        .store
        .requeue_pending_commit_inputs_for_thread(
            thread_id,
            "Steer was accepted but not confirmed in committed history before the thread became idle.",
        )
        .await?;
    let mut events = Vec::new();
    for row in rows {
        events.push(append_queue_upsert_event(state, &row).await?);
    }
    Ok(events)
}

async fn drain_one_queued_input(state: &AppState, thread_id: &str) -> ApiResult<()> {
    if !thread_is_idle_for_queue(state, thread_id).await? {
        return Ok(());
    }
    state
        .store
        .upsert_thread_runtime_state(ThreadRuntimeState {
            thread_id: thread_id.to_string(),
            status: "idle".to_string(),
            active_turn_id: None,
            updated_at: Utc::now(),
            last_event_seq: None,
        })
        .await?;
    if !state
        .store
        .claim_idle_thread_runtime_for_queue_drain(thread_id)
        .await?
    {
        return Ok(());
    }

    let Some(queued_input) = state.store.claim_next_queued_input(thread_id).await? else {
        state
            .store
            .clear_queue_drain_runtime_claim(thread_id)
            .await?;
        return Ok(());
    };
    broadcast_queue_upsert(state, &queued_input).await?;

    let resolved = match skills::resolve_turn_input_with_skills_for_thread(
        state,
        thread_id,
        queued_input.input.clone(),
    )
    .await
    {
        Ok(resolved) => resolved,
        Err(error) => {
            let failed = state
                .store
                .mark_queued_input_failed(thread_id, &queued_input.id, error.to_string())
                .await?;
            state
                .store
                .clear_queue_drain_runtime_claim(thread_id)
                .await?;
            broadcast_queue_upsert(state, &failed).await?;
            return Err(error);
        }
    };

    let pending_skill_mentions_id = turn_lifecycle::insert_pending_skill_mentions(
        state,
        thread_id,
        &resolved.input,
        &resolved.skills,
    )
    .await?;

    let result = app_server_api::client(&state.app_server)
        .turn_start(
            thread_id.to_string(),
            resolved.input.clone(),
            queued_input.options.clone(),
        )
        .await;
    match result {
        Ok(response) => {
            if let Some(turn_id) = turn_lifecycle::pending_projection_turn_id(&response.payload) {
                turn_lifecycle::record_pending_user_projection(
                    state,
                    thread_id,
                    &turn_id,
                    &resolved.input,
                )
                .await?;
            }
            state
                .store
                .delete_queued_input_for_gateway(thread_id, &queued_input.id)
                .await?;
            broadcast_queue_delete(state, thread_id, &queued_input.id).await?;
        }
        Err(error) => {
            turn_lifecycle::delete_pending_skill_mentions(
                state,
                pending_skill_mentions_id.as_deref(),
            )
            .await?;
            let failed = state
                .store
                .mark_queued_input_failed(thread_id, &queued_input.id, error.to_string())
                .await?;
            state
                .store
                .clear_queue_drain_runtime_claim(thread_id)
                .await?;
            broadcast_queue_upsert(state, &failed).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) async fn reconcile_thread_runtime_from_app_server(
    state: &AppState,
    thread_id: &str,
) -> ApiResult<Option<ThreadRuntimeState>> {
    let snapshot = app_server_api::client(&state.app_server)
        .thread_read(thread_id.to_string())
        .await?;
    let active_turn_id = snapshot
        .turns
        .iter()
        .find(|turn| !is_terminal_turn_status(&turn.status))
        .map(|turn| turn.id.clone());
    let runtime = ThreadRuntimeState {
        thread_id: thread_id.to_string(),
        status: if active_turn_id.is_some() {
            "active".to_string()
        } else {
            "idle".to_string()
        },
        active_turn_id,
        updated_at: Utc::now(),
        last_event_seq: None,
    };
    let runtime = state
        .store
        .upsert_thread_runtime_state_unless_draining(runtime)
        .await?;
    Ok(Some(runtime))
}

async fn thread_is_idle_for_queue(state: &AppState, thread_id: &str) -> ApiResult<bool> {
    match state.thread_sessions.live_state(thread_id).await {
        Some(ThreadLiveState::Streaming | ThreadLiveState::Syncing) => return Ok(false),
        Some(ThreadLiveState::Idle | ThreadLiveState::NotLoaded) => {}
        None => {}
    }
    if let Some(runtime) = state.store.get_thread_runtime_state(thread_id).await? {
        if runtime.status == "draining" {
            return Ok(false);
        }
    }
    let snapshot = app_server_api::client(&state.app_server)
        .thread_read(thread_id.to_string())
        .await?;
    let revision = state.store.latest_event_seq().await?;
    let timeline = state
        .thread_sessions
        .refresh_from_turns(thread_id, &snapshot.turns, revision)
        .await;
    Ok(timeline.active_turn_id.is_none() && timeline.live_state == ThreadLiveState::Idle)
}

#[cfg(test)]
fn is_terminal_turn_status(status: &str) -> bool {
    matches!(
        status.to_ascii_lowercase().as_str(),
        "completed" | "failed" | "cancelled" | "canceled" | "interrupted"
    )
}

async fn broadcast_queue_upsert(state: &AppState, queued_input: &QueuedInput) -> ApiResult<()> {
    let event = append_queue_upsert_event(state, queued_input).await?;
    let _ = state.events.send(event);
    Ok(())
}

async fn append_queue_upsert_event(
    state: &AppState,
    queued_input: &QueuedInput,
) -> ApiResult<EventEnvelope> {
    state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: Some(queued_input.thread_id.clone()),
            turn_id: None,
            item_id: None,
            kind: QUEUE_UPSERT_EVENT.to_string(),
            codex_method: None,
            payload: serde_json::to_value(queued_input)?,
        })
        .await
}

async fn broadcast_queue_delete(
    state: &AppState,
    thread_id: &str,
    queue_id: &str,
) -> ApiResult<()> {
    let event = append_queue_delete_event(state, thread_id, queue_id).await?;
    let _ = state.events.send(event);
    Ok(())
}

async fn append_queue_delete_event(
    state: &AppState,
    thread_id: &str,
    queue_id: &str,
) -> ApiResult<EventEnvelope> {
    state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: Some(thread_id.to_string()),
            turn_id: None,
            item_id: None,
            kind: QUEUE_DELETE_EVENT.to_string(),
            codex_method: None,
            payload: json!({
                "id": queue_id,
                "threadId": thread_id,
            }),
        })
        .await
}

#[derive(Debug, PartialEq, Eq)]
struct PendingSteerCompareKey {
    text: String,
    image_count: usize,
}

fn pending_steer_compare_key_from_inputs(input: &[UserInput]) -> PendingSteerCompareKey {
    let mut text = String::new();
    let mut image_count = 0;
    for item in input {
        match item {
            UserInput::Text {
                text: item_text, ..
            } => text.push_str(item_text),
            UserInput::Image { .. } | UserInput::LocalImage { .. } => image_count += 1,
            UserInput::Skill { .. } | UserInput::Mention { .. } => {}
        }
    }
    PendingSteerCompareKey { text, image_count }
}

fn pending_steer_compare_key_from_item(item: &Value) -> PendingSteerCompareKey {
    let content = item
        .get("content")
        .or_else(|| item.get("input"))
        .and_then(Value::as_array);
    let Some(content) = content else {
        return PendingSteerCompareKey {
            text: item
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            image_count: 0,
        };
    };
    let mut text = String::new();
    let mut image_count = 0;
    for part in content {
        match part.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(part_text) = part.get("text").and_then(Value::as_str) {
                    text.push_str(part_text);
                }
            }
            Some("image") | Some("localImage") => image_count += 1,
            _ => {}
        }
    }
    PendingSteerCompareKey { text, image_count }
}

fn is_user_message_item(item: &Value) -> bool {
    item.get("type")
        .or_else(|| item.get("itemType"))
        .and_then(Value::as_str)
        .is_some_and(|item_type| item_type == "userMessage")
}

impl QueuedInput {
    pub fn text_preview(&self) -> String {
        self.input
            .iter()
            .filter_map(|input| match input {
                UserInput::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    pub fn image_count(&self) -> usize {
        self.input
            .iter()
            .filter(|input| {
                matches!(
                    input,
                    UserInput::Image { .. } | UserInput::LocalImage { .. }
                )
            })
            .count()
    }
}

pub fn queued_input_status_schema_values() -> [QueuedInputStatus; 5] {
    [
        QueuedInputStatus::Queued,
        QueuedInputStatus::Submitting,
        QueuedInputStatus::Steering,
        QueuedInputStatus::PendingCommit,
        QueuedInputStatus::Failed,
    ]
}

pub fn queued_input_priority_schema_values() -> [QueuedInputPriority; 2] {
    [
        QueuedInputPriority::RejectedSteer,
        QueuedInputPriority::Normal,
    ]
}
