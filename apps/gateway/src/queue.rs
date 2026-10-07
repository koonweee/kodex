//! Native ordinary queue projection. Only promotion transfers live in gateway
//! storage; no startup drainer, replay or admission retry owns these rows.
use axum::{
    extract::{Path, Query, State},
    routing::{delete, get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

use crate::{
    api::AppState,
    app_server_api::{self, NativeQueuedSubmission, RawAppServerResponse, TimelineFileAttachment},
    error::{ApiError, ApiResult},
    queue_transfer::{self, PromotionOutcome},
    store::{NewEvent, QueueTransfer},
};

pub const QUEUE_CHANGED_EVENT: &str = "turn_queue.changed";

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueuedInput {
    pub id: String,
    pub thread_id: String,
    pub client_user_message_id: String,
    pub input: Vec<Value>,
    pub attachments: Vec<TimelineFileAttachment>,
    /// Current native active-turn hint. The command captures and revalidates its target at request time.
    pub can_steer: bool,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueuedInputCreateRequest {
    pub input: Vec<Value>,
    #[serde(default)]
    pub attachments: Vec<TimelineFileAttachment>,
    #[serde(default)]
    pub client_user_message_id: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueuedInputUpdateRequest {
    pub input: Vec<Value>,
    #[serde(default)]
    pub attachments: Vec<TimelineFileAttachment>,
}

#[derive(Debug, Default, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueuedInputListQuery {
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueuedInputListResponse {
    pub queued_inputs: Vec<QueuedInput>,
    pub transfers: Vec<QueueTransfer>,
    pub next_cursor: Option<String>,
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
    pub deleted: bool,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueuedInputReorderRequest {
    pub queued_submission_ids: Vec<String>,
}

#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueuedInputStartRequest {
    pub queued_submission_id: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueueTransferDeleteResponse {
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
            "/v1/threads/{thread_id}/queued-inputs/reorder",
            post(reorder_queued_inputs),
        )
        .route(
            "/v1/threads/{thread_id}/queued-inputs/steer-first",
            post(steer_first_queued_input),
        )
        .route(
            "/v1/threads/{thread_id}/queued-inputs/start",
            post(start_queued_input),
        )
        .route(
            "/v1/threads/{thread_id}/queued-inputs/{queue_id}",
            delete(delete_queued_input).put(update_queued_input),
        )
        .route(
            "/v1/threads/{thread_id}/queued-inputs/{queue_id}/steer",
            post(steer_queued_input),
        )
        .route(
            "/v1/queue-transfers/{transfer_id}/reconcile",
            post(reconcile_queue_transfer),
        )
        .route(
            "/v1/queue-transfers/{transfer_id}",
            delete(dismiss_queue_transfer),
        )
}

#[utoipa::path(get, path = "/v1/threads/{threadId}/queued-inputs", params(QueuedInputListQuery), responses((status = 200, body = QueuedInputListResponse)))]
pub async fn list_queued_inputs(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Query(query): Query<QueuedInputListQuery>,
) -> ApiResult<Json<QueuedInputListResponse>> {
    let limit = query.limit.unwrap_or(100);
    if !(1..=100).contains(&limit) {
        return Err(ApiError::BadRequest(
            "Queue page limit must be between 1 and 100".into(),
        ));
    }
    let page = app_server_api::client(&state.app_server)
        .queue_list(thread_id.clone(), query.cursor, Some(limit))
        .await?;
    let can_steer = queue_transfer::can_steer(&state, &thread_id).await;
    let transfers = state.store.list_queue_transfers(Some(&thread_id)).await?;
    Ok(Json(QueuedInputListResponse {
        queued_inputs: page
            .data
            .into_iter()
            .map(|row| {
                let eligible = can_steer
                    && !transfers
                        .iter()
                        .any(|transfer| transfer.native_queue_id == row.id);
                project_row(&thread_id, row, eligible)
            })
            .collect(),
        transfers,
        next_cursor: page.next_cursor,
    }))
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/queued-inputs", request_body = QueuedInputCreateRequest, responses((status = 200, body = QueuedInputResponse)))]
pub async fn create_queued_input(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<QueuedInputCreateRequest>,
) -> ApiResult<Json<QueuedInputResponse>> {
    let input = prepare_input(&thread_id, request.input, request.attachments)?;
    let row = queue_transfer::enqueue(
        &state,
        &thread_id,
        input,
        request
            .client_user_message_id
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
    )
    .await?;
    // Publish a fresh native queue read after the acknowledged submission.
    broadcast_changed_best_effort(&state, &thread_id).await;
    Ok(Json(QueuedInputResponse {
        queued_input: project_row(
            &thread_id,
            row,
            queue_transfer::can_steer(&state, &thread_id).await,
        ),
    }))
}

#[utoipa::path(put, path = "/v1/threads/{threadId}/queued-inputs/{queueId}", request_body = QueuedInputUpdateRequest, responses((status = 200, body = QueuedInputResponse)))]
pub async fn update_queued_input(
    State(state): State<AppState>,
    Path((thread_id, queue_id)): Path<(String, String)>,
    Json(request): Json<QueuedInputUpdateRequest>,
) -> ApiResult<Json<QueuedInputResponse>> {
    let input = prepare_input(&thread_id, request.input, request.attachments)?;
    let _guard = state.thread_input_locks.lock(&thread_id).await;
    let client = app_server_api::client(&state.app_server);
    client.check_direct_input_capability(&thread_id).await?;
    ensure_not_transferring(&state, &thread_id, &queue_id).await?;
    let row = client
        .queue_update(thread_id.clone(), queue_id, input)
        .await?;
    broadcast_changed_best_effort(&state, &thread_id).await;
    Ok(Json(QueuedInputResponse {
        queued_input: project_row(
            &thread_id,
            row,
            queue_transfer::can_steer(&state, &thread_id).await,
        ),
    }))
}

#[utoipa::path(delete, path = "/v1/threads/{threadId}/queued-inputs/{queueId}", responses((status = 200, body = QueuedInputDeleteResponse)))]
pub async fn delete_queued_input(
    State(state): State<AppState>,
    Path((thread_id, queue_id)): Path<(String, String)>,
) -> ApiResult<Json<QueuedInputDeleteResponse>> {
    let _guard = state.thread_input_locks.lock(&thread_id).await;
    let client = app_server_api::client(&state.app_server);
    client.check_direct_input_capability(&thread_id).await?;
    ensure_not_transferring(&state, &thread_id, &queue_id).await?;
    crate::automations::observe_queue_handoff_pending(&state, &thread_id, &queue_id).await?;
    let result = client
        .queue_delete(thread_id.clone(), queue_id.clone())
        .await;
    broadcast_changed_best_effort(&state, &thread_id).await;
    let deleted = result?;
    if deleted {
        crate::automations::observe_removed(&state, &thread_id, &queue_id).await?;
    }
    Ok(Json(QueuedInputDeleteResponse {
        id: queue_id,
        thread_id,
        deleted,
    }))
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/queued-inputs/reorder", request_body = QueuedInputReorderRequest, responses((status = 200)))]
pub async fn reorder_queued_inputs(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<QueuedInputReorderRequest>,
) -> ApiResult<Json<Value>> {
    let _guard = state.thread_input_locks.lock(&thread_id).await;
    let client = app_server_api::client(&state.app_server);
    client.check_direct_input_capability(&thread_id).await?;
    let result = client
        .queue_reorder(thread_id.clone(), request.queued_submission_ids)
        .await;
    broadcast_changed_best_effort(&state, &thread_id).await;
    result?;
    Ok(Json(json!({})))
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/queued-inputs/start", request_body = QueuedInputStartRequest, responses((status = 200, body = RawAppServerResponse)))]
pub async fn start_queued_input(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<QueuedInputStartRequest>,
) -> ApiResult<Json<RawAppServerResponse>> {
    let _guard = state.thread_input_locks.lock(&thread_id).await;
    let client = app_server_api::client(&state.app_server);
    client.check_direct_input_capability(&thread_id).await?;
    let id = request.queued_submission_id;
    ensure_not_transferring(&state, &thread_id, &id).await?;
    crate::automations::observe_queue_handoff_pending(&state, &thread_id, &id).await?;
    let result = client
        .queue_start(thread_id.clone(), Some(id.clone()))
        .await;
    if let Ok(ack) = &result {
        if let Some(turn) = ack.payload.pointer("/turn/id").and_then(Value::as_str) {
            if let Err(error) =
                crate::automations::observe_promoted_receipt(&state, &thread_id, &id, turn).await
            {
                tracing::warn!(%error, "failed to record acknowledged automation dispatch");
            }
        }
    }
    broadcast_changed_best_effort(&state, &thread_id).await;
    Ok(Json(result?))
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/queued-inputs/steer-first", responses((status = 200, body = PromotionOutcome), (status = 409, description = "Queue is empty or its first message cannot be steered")))]
pub async fn steer_first_queued_input(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> ApiResult<Json<PromotionOutcome>> {
    let result = queue_transfer::promote_first(&state, &thread_id).await;
    broadcast_changed_best_effort(&state, &thread_id).await;
    Ok(Json(result?))
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/queued-inputs/{queueId}/steer", responses((status = 200, body = PromotionOutcome)))]
pub async fn steer_queued_input(
    State(state): State<AppState>,
    Path((thread_id, queue_id)): Path<(String, String)>,
) -> ApiResult<Json<PromotionOutcome>> {
    let result = queue_transfer::promote(&state, &thread_id, &queue_id).await;
    broadcast_changed_best_effort(&state, &thread_id).await;
    Ok(Json(result?))
}

#[utoipa::path(post, path = "/v1/queue-transfers/{transferId}/reconcile", responses((status = 200, body = PromotionOutcome)))]
pub async fn reconcile_queue_transfer(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<PromotionOutcome>> {
    Ok(Json(queue_transfer::reconcile(&state, &id).await?))
}

#[utoipa::path(delete, path = "/v1/queue-transfers/{transferId}", responses((status = 200, body = QueueTransferDeleteResponse)))]
pub async fn dismiss_queue_transfer(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<QueueTransferDeleteResponse>> {
    let transfer = state
        .store
        .get_queue_transfer(&id)
        .await?
        .ok_or_else(|| ApiError::NotFound("Queue transfer".into()))?;
    let _guard = state.thread_input_locks.lock(&transfer.thread_id).await;
    if !state.store.dismiss_uncertain_queue_transfer(&id).await? {
        return Err(ApiError::Conflict(
            "Only an uncertain transfer can be dismissed".into(),
        ));
    }
    queue_transfer::broadcast_changed(&state, &transfer.thread_id).await?;
    Ok(Json(QueueTransferDeleteResponse {
        id,
        thread_id: transfer.thread_id,
    }))
}

pub(crate) fn project_row(
    thread_id: &str,
    row: NativeQueuedSubmission,
    can_steer: bool,
) -> QueuedInput {
    QueuedInput {
        can_steer,
        attachments: app_server_api::file_attachments_from_user_content(&row.input),
        id: row.id,
        thread_id: thread_id.into(),
        client_user_message_id: row.client_user_message_id,
        input: row.input,
    }
}

fn prepare_input(
    thread_id: &str,
    mut input: Vec<Value>,
    attachments: Vec<TimelineFileAttachment>,
) -> ApiResult<Vec<Value>> {
    let attachments = app_server_api::validate_file_attachments_for_thread(thread_id, attachments)?;
    // Append the existing native text envelope without deserializing the other
    // native variants into the gateway's narrower composer input enum.
    for envelope in app_server_api::append_file_attachment_envelope(Vec::new(), &attachments) {
        input.push(serde_json::to_value(envelope)?);
    }
    Ok(input)
}

async fn ensure_not_transferring(state: &AppState, thread_id: &str, row_id: &str) -> ApiResult<()> {
    if state
        .store
        .get_queue_transfer_for_row(thread_id, row_id)
        .await?
        .is_some()
    {
        return Err(ApiError::Conflict(
            "Message has a promotion transfer; reconcile or recover that transfer".into(),
        ));
    }
    Ok(())
}

pub(crate) async fn broadcast_changed(state: &AppState, thread_id: &str) -> ApiResult<()> {
    let event = state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: Some(thread_id.into()),
            turn_id: None,
            item_id: None,
            kind: QUEUE_CHANGED_EVENT.into(),
            codex_method: None,
            payload: json!({"threadId":thread_id}),
        })
        .await?;
    let _ = state.events.send(event);
    Ok(())
}

#[cfg(test)]
#[path = "queue_transfer/http_tests.rs"]
mod http_tests;

pub(crate) async fn broadcast_changed_best_effort(state: &AppState, thread_id: &str) {
    if let Err(error) = broadcast_changed(state, thread_id).await {
        tracing::warn!(%error, thread_id, "failed to publish native queue refill");
    }
}

/// Publish after canonical lifecycle state so consumers can refill against the
/// completed ingestion boundary. No native RPC or input lock is acquired.
pub(crate) async fn observe_notification(state: &AppState, method: &str, params: &Value) {
    if matches!(
        method,
        "thread/queue/changed"
            | "turn/started"
            | "turn/completed"
            | "thread/status/changed"
            | "thread/reverted"
            | "thread/closed"
            | "thread/archived"
            | "thread/deleted"
    ) {
        if let Some(thread) = params.get("threadId").and_then(Value::as_str) {
            broadcast_changed_best_effort(state, thread).await;
        }
    }
}
