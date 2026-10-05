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
        self, CodexClient, RawAppServerResponse, ThreadStatus, TimelineFileAttachment,
        TurnStartOptions, UserInput,
    },
    error::{ApiError, ApiResult},
    turn_lifecycle,
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
    let _submit_guard = state.thread_input_locks.lock(&thread_id).await;
    let client = app_server_api::client(&state.app_server);
    if client.thread_read_summary(thread_id.clone()).await?.status == ThreadStatus::Active {
        return Err(ApiError::Conflict(
            "cannot compact while a task is in progress".to_string(),
        ));
    }

    // Keep other Kodex compaction requests behind this admission check until the
    // native acknowledgement. Native lifecycle events own the visible state.
    let response = client.thread_compact_start(thread_id).await?;
    Ok(Json(ThreadCompactResponse {
        disposition: ThreadCompactDisposition::Started,
        raw_payload: Some(response.payload),
    }))
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
        Err(error) if app_server_api::is_thread_not_loaded_error(&error, thread_id) => {
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
