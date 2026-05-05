use axum::{
    extract::{Path, State},
    routing::{delete, get, post},
    Json, Router,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use utoipa::ToSchema;

use crate::{
    api::AppState,
    app_server_api::{self, TurnStartOptions, UserInput},
    error::{ApiError, ApiResult},
    store::{NewEvent, QueuedInput, QueuedInputPriority, QueuedInputStatus, ThreadRuntimeState},
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
    let queued_input = state
        .store
        .create_queued_input(&thread_id, request.input, request.options)
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

#[utoipa::path(post, path = "/v1/threads/{threadId}/queued-inputs/{queueId}/steer", responses((status = 200, body = QueuedInputDeleteResponse)))]
pub async fn steer_queued_input(
    State(state): State<AppState>,
    Path((thread_id, queue_id)): Path<(String, String)>,
) -> ApiResult<Json<QueuedInputDeleteResponse>> {
    let runtime = state.store.get_thread_runtime_state(&thread_id).await?;
    let runtime = match runtime {
        Some(runtime) if runtime.status == "active" && runtime.active_turn_id.is_none() => {
            reconcile_thread_runtime_from_app_server(&state, &thread_id).await?
        }
        Some(runtime) if runtime.status != "unknown" => Some(runtime),
        _ => reconcile_thread_runtime_from_app_server(&state, &thread_id).await?,
    };
    let Some(active_turn_id) = runtime.and_then(|runtime| runtime.active_turn_id) else {
        return Err(ApiError::BadRequest(format!(
            "thread {thread_id} has no active turn to steer"
        )));
    };
    let queued_input = state
        .store
        .claim_queued_input_for_steering(&thread_id, &queue_id)
        .await?;
    broadcast_queue_upsert(&state, &queued_input).await?;

    let result = app_server_api::client(&state.app_server)
        .turn_steer(
            thread_id.clone(),
            active_turn_id,
            queued_input.input.clone(),
        )
        .await;
    match result {
        Ok(_) => {
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
        Err(error) if is_non_steerable_error(&error) => {
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

pub fn trigger_queue_drain(state: AppState, thread_id: String) {
    tokio::spawn(async move {
        if let Err(error) = drain_one_queued_input(&state, &thread_id).await {
            tracing::debug!(%error, thread_id, "queue drain skipped or failed");
        }
    });
}

pub async fn refresh_runtime_and_maybe_drain(
    state: &AppState,
    thread_id: &str,
    runtime: ThreadRuntimeState,
) -> ApiResult<()> {
    state.store.upsert_thread_runtime_state(runtime).await?;
    if state
        .store
        .get_thread_runtime_state(thread_id)
        .await?
        .is_some_and(|runtime| runtime.status == "idle")
    {
        trigger_queue_drain(state.clone(), thread_id.to_string());
    }
    Ok(())
}

async fn drain_one_queued_input(state: &AppState, thread_id: &str) -> ApiResult<()> {
    let runtime = match state.store.get_thread_runtime_state(thread_id).await? {
        Some(runtime) if runtime.status == "idle" || runtime.status == "unknown" => {
            reconcile_thread_runtime_from_app_server(state, thread_id).await?
        }
        Some(runtime) => Some(runtime),
        _ => reconcile_thread_runtime_from_app_server(state, thread_id).await?,
    };
    if runtime.is_none_or(|runtime| runtime.status != "idle") {
        return Ok(());
    }
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

    let result = app_server_api::client(&state.app_server)
        .turn_start(
            thread_id.to_string(),
            queued_input.input.clone(),
            queued_input.options.clone(),
        )
        .await;
    match result {
        Ok(_) => {
            state
                .store
                .delete_queued_input(thread_id, &queued_input.id)
                .await?;
            broadcast_queue_delete(state, thread_id, &queued_input.id).await?;
        }
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
        }
    }
    Ok(())
}

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

fn is_terminal_turn_status(status: &str) -> bool {
    matches!(
        status.to_ascii_lowercase().as_str(),
        "completed" | "failed" | "cancelled" | "canceled" | "interrupted"
    )
}

async fn broadcast_queue_upsert(state: &AppState, queued_input: &QueuedInput) -> ApiResult<()> {
    let event = state
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
        .await?;
    let _ = state.events.send(event);
    Ok(())
}

async fn broadcast_queue_delete(
    state: &AppState,
    thread_id: &str,
    queue_id: &str,
) -> ApiResult<()> {
    let event = state
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
        .await?;
    let _ = state.events.send(event);
    Ok(())
}

fn is_non_steerable_error(error: &ApiError) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    message.contains("not steerable")
        || message.contains("activeturnnotsteerable")
        || message.contains("cannot steer")
        || message.contains("no active turn")
        || message.contains("expectedturnid")
        || message.contains("expected turn")
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

pub fn queued_input_status_schema_values() -> [QueuedInputStatus; 4] {
    [
        QueuedInputStatus::Queued,
        QueuedInputStatus::Submitting,
        QueuedInputStatus::Steering,
        QueuedInputStatus::Failed,
    ]
}

pub fn queued_input_priority_schema_values() -> [QueuedInputPriority; 2] {
    [
        QueuedInputPriority::RejectedSteer,
        QueuedInputPriority::Normal,
    ]
}
