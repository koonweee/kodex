use axum::{
    extract::{Path, State},
    routing::post,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::{
    api::AppState,
    app_server_api::{
        self, CodexClient, RawAppServerResponse, ThreadLiveState, TimelineFileAttachment,
        TurnStartOptions, UserInput,
    },
    error::{ApiError, ApiResult},
    events, queue, thread_view, turn_lifecycle,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/threads/{thread_id}/input", post(submit_thread_input))
        .route(
            "/v1/threads/{thread_id}/interrupt-current",
            post(interrupt_current_turn),
        )
        .route("/v1/threads/{thread_id}/compact", post(compact_thread))
        .route("/v1/threads/{thread_id}/turns", post(start_turn))
        .route(
            "/v1/threads/{thread_id}/turns/{turn_id}/steer",
            post(steer_turn),
        )
        .route(
            "/v1/threads/{thread_id}/turns/{turn_id}/interrupt",
            post(interrupt_turn),
        )
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_user_message_id: Option<String>,
    pub input: Vec<UserInput>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<TimelineFileAttachment>,
    #[serde(flatten)]
    pub options: TurnStartOptions,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnSteerRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_user_message_id: Option<String>,
    pub input: Vec<UserInput>,
}

pub type ThreadInputRequest = TurnStartRequest;

pub type ThreadInputResponse = RawAppServerResponse;

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadInterruptCurrentResponse {
    pub disposition: ThreadInterruptCurrentDisposition,
    pub interrupted_turn_id: Option<String>,
    pub raw_payload: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ThreadInterruptCurrentDisposition {
    Interrupted,
    Idle,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCompactResponse {
    pub disposition: ThreadCompactDisposition,
    pub raw_payload: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ThreadCompactDisposition {
    Started,
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/input", request_body = TurnStartRequest, responses((status = 200, body = ThreadInputResponse)))]
pub async fn submit_thread_input(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<ThreadInputRequest>,
) -> ApiResult<Json<ThreadInputResponse>> {
    // turn/start atomically chooses native start or steering. Browser/gateway
    // caches cannot decide that shared lifecycle boundary reliably.
    start_turn(State(state), Path(thread_id), Json(request)).await
}

#[utoipa::path(
    post,
    path = "/v1/threads/{threadId}/compact",
    responses(
        (status = 200, body = ThreadCompactResponse),
        (status = 409, body = crate::error::ApiErrorBody),
    )
)]
pub async fn compact_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> ApiResult<Json<ThreadCompactResponse>> {
    let submit_guard = state.thread_input_locks.lock(&thread_id).await;
    if turn_lifecycle::routed_active_turn_id(&state, &thread_id)
        .await?
        .is_some()
    {
        return Err(ApiError::Conflict(
            "cannot compact while a task is in progress".to_string(),
        ));
    }

    turn_lifecycle::record_compaction_starting(&state, &thread_id).await?;
    drop(submit_guard);
    let response = match app_server_api::client(&state.app_server)
        .thread_compact_start(thread_id.clone())
        .await
    {
        Ok(response) => response,
        Err(error) => {
            turn_lifecycle::record_turn_start_failed(&state, &thread_id).await?;
            queue::trigger_queue_drain(state.clone(), thread_id.clone());
            return Err(error);
        }
    };
    broadcast_thread_live_state(&state, &thread_id, ThreadLiveState::Syncing).await?;
    Ok(Json(ThreadCompactResponse {
        disposition: ThreadCompactDisposition::Started,
        raw_payload: Some(response.payload),
    }))
}

async fn broadcast_thread_live_state(
    state: &AppState,
    thread_id: &str,
    live_state: ThreadLiveState,
) -> ApiResult<()> {
    let patch = thread_view::record_thread_live_state(
        &state.thread_views,
        thread_id,
        live_state,
        state.store.latest_event_seq().await?,
    )
    .await?;
    let event = events::thread_view_patch_payload_event(state, patch).await?;
    let _ = state.events.send(event);
    Ok(())
}

async fn turn_start_resuming_missing_thread_once(
    state: &AppState,
    thread_id: &str,
    input: Vec<UserInput>,
    options: TurnStartOptions,
    client_id: String,
) -> ApiResult<RawAppServerResponse> {
    let client = app_server_api::client(&state.app_server);
    match client
        .turn_start(
            thread_id.to_string(),
            input.clone(),
            options.clone(),
            Some(client_id.clone()),
        )
        .await
    {
        Ok(response) => Ok(response),
        Err(error) if app_server_error_mentions_missing_thread(&error) => {
            resume_thread_for_turn_start(state, &client, thread_id).await?;
            client
                .turn_start(thread_id.to_string(), input, options, Some(client_id))
                .await
        }
        Err(error) => Err(error),
    }
}

async fn resume_thread_for_turn_start(
    state: &AppState,
    client: &CodexClient,
    thread_id: &str,
) -> ApiResult<()> {
    tracing::info!(
        thread_id,
        "turn/start reported missing thread; resuming thread before retry"
    );
    let mut response = client
        .thread_resume(thread_id.to_string(), serde_json::json!({}))
        .await?;
    super::threads::apply_thread_command_response_state(state, &mut response).await
}

fn app_server_error_mentions_missing_thread(error: &ApiError) -> bool {
    match error {
        ApiError::BadGateway(message) => message_mentions_missing_thread(message),
        _ => false,
    }
}

fn message_mentions_missing_thread(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    (message.contains("thread")
        && (message.contains("not found")
            || message.contains("no such")
            || message.contains("does not exist")
            || message.contains("unknown")))
        || message.contains("no rollout found for thread id")
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/turns", request_body = TurnStartRequest, responses((status = 200, body = RawAppServerResponse)))]
pub async fn start_turn(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<TurnStartRequest>,
) -> ApiResult<Json<RawAppServerResponse>> {
    request.options.validate()?;
    let client_id = request
        .client_user_message_id
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let attachments =
        app_server_api::validate_file_attachments_for_thread(&thread_id, request.attachments)?;
    let input = app_server_api::append_file_attachment_envelope(request.input, &attachments);
    let submission_revision = state.store.latest_event_seq().await?;
    let response = turn_start_resuming_missing_thread_once(
        &state,
        &thread_id,
        input.clone(),
        request.options.clone(),
        client_id.clone(),
    )
    .await?;
    if let Some(turn_id) = turn_lifecycle::pending_projection_turn_id(&response.payload) {
        turn_lifecycle::record_pending_user_projection(
            &state,
            &thread_id,
            &turn_id,
            &client_id,
            &input,
            &attachments,
            submission_revision,
        )
        .await?;
    }
    Ok(Json(response))
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/turns/{turnId}/steer", request_body = TurnSteerRequest, responses((status = 200, body = RawAppServerResponse)))]
pub async fn steer_turn(
    State(state): State<AppState>,
    Path((thread_id, turn_id)): Path<(String, String)>,
    Json(request): Json<TurnSteerRequest>,
) -> ApiResult<Json<RawAppServerResponse>> {
    let input = request.input;
    let client_id = request
        .client_user_message_id
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let submission_revision = state.store.latest_event_seq().await?;
    let response = app_server_api::client(&state.app_server)
        .turn_steer(
            thread_id.clone(),
            turn_id.clone(),
            input.clone(),
            Some(client_id.clone()),
        )
        .await?;
    turn_lifecycle::record_pending_user_projection(
        &state,
        &thread_id,
        &turn_id,
        &client_id,
        &input,
        &[],
        submission_revision,
    )
    .await?;
    Ok(Json(response))
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/turns/{turnId}/interrupt", responses((status = 200, body = RawAppServerResponse)))]
pub async fn interrupt_turn(
    State(state): State<AppState>,
    Path((thread_id, turn_id)): Path<(String, String)>,
) -> ApiResult<Json<RawAppServerResponse>> {
    Ok(Json(
        app_server_api::client(&state.app_server)
            .turn_interrupt(thread_id, turn_id)
            .await?,
    ))
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/interrupt-current", responses((status = 200, body = ThreadInterruptCurrentResponse)))]
pub async fn interrupt_current_turn(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> ApiResult<Json<ThreadInterruptCurrentResponse>> {
    let Some(active_turn_id) = turn_lifecycle::refreshed_active_turn_id(&state, &thread_id).await?
    else {
        return Ok(Json(ThreadInterruptCurrentResponse {
            disposition: ThreadInterruptCurrentDisposition::Idle,
            interrupted_turn_id: None,
            raw_payload: None,
        }));
    };
    let response = app_server_api::client(&state.app_server)
        .turn_interrupt(thread_id, active_turn_id.clone())
        .await?;
    Ok(Json(ThreadInterruptCurrentResponse {
        disposition: ThreadInterruptCurrentDisposition::Interrupted,
        interrupted_turn_id: Some(active_turn_id),
        raw_payload: Some(response.payload),
    }))
}
