use axum::{
    extract::{Path, State},
    routing::post,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::{
    api::AppState,
    app_server_api::{self, CodexClient, RawAppServerResponse, TurnStartOptions, UserInput},
    error::{ApiError, ApiResult},
    queue, skills, turn_lifecycle,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/threads/{thread_id}/input", post(submit_thread_input))
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
    pub input: Vec<UserInput>,
    #[serde(flatten)]
    pub options: TurnStartOptions,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnSteerRequest {
    pub input: Vec<UserInput>,
}

pub type ThreadInputRequest = TurnStartRequest;

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadInputResponse {
    pub disposition: ThreadInputDisposition,
    pub queued_input: Option<crate::store::QueuedInput>,
    pub raw_payload: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ThreadInputDisposition {
    Started,
    Steered,
    Queued,
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/input", request_body = TurnStartRequest, responses((status = 200, body = ThreadInputResponse)))]
pub async fn submit_thread_input(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<ThreadInputRequest>,
) -> ApiResult<Json<ThreadInputResponse>> {
    let resolved =
        skills::resolve_turn_input_with_skills_for_thread(&state, &thread_id, request.input)
            .await?;
    let options = request.options;
    state
        .store
        .save_thread_turn_options(&thread_id, &options)
        .await?;

    let submit_guard = state.thread_input_locks.lock(&thread_id).await;
    if turn_lifecycle::routed_active_turn_id(&state, &thread_id)
        .await?
        .is_some()
    {
        let queued_input = queue::create_queued_input_with_source(
            &state,
            &thread_id,
            resolved.input,
            options,
            None,
            None,
        )
        .await?;
        return Ok(Json(ThreadInputResponse {
            disposition: ThreadInputDisposition::Queued,
            queued_input: Some(queued_input),
            raw_payload: None,
        }));
    }

    let pending_skill_mentions_id = turn_lifecycle::insert_pending_skill_mentions(
        &state,
        &thread_id,
        &resolved.input,
        &resolved.skills,
    )
    .await?;
    turn_lifecycle::record_turn_starting(&state, &thread_id).await?;
    drop(submit_guard);
    let response = match turn_start_resuming_missing_thread_once(
        &state,
        &thread_id,
        resolved.input.clone(),
        options,
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            turn_lifecycle::record_turn_start_failed(&state, &thread_id).await?;
            queue::trigger_queue_drain(state.clone(), thread_id.clone());
            turn_lifecycle::delete_pending_skill_mentions(
                &state,
                pending_skill_mentions_id.as_deref(),
            )
            .await?;
            return Err(error);
        }
    };
    let projection_turn_id = turn_lifecycle::pending_projection_turn_id(&response.payload);
    turn_lifecycle::record_turn_started(&state, &thread_id, projection_turn_id.as_deref()).await?;
    if let Some(turn_id) = projection_turn_id {
        turn_lifecycle::record_pending_user_projection(
            &state,
            &thread_id,
            &turn_id,
            &resolved.input,
        )
        .await?;
    }
    Ok(Json(ThreadInputResponse {
        disposition: ThreadInputDisposition::Started,
        queued_input: None,
        raw_payload: Some(response.payload),
    }))
}

async fn turn_start_resuming_missing_thread_once(
    state: &AppState,
    thread_id: &str,
    input: Vec<UserInput>,
    options: TurnStartOptions,
) -> ApiResult<RawAppServerResponse> {
    let client = app_server_api::client(&state.app_server);
    match client
        .turn_start(thread_id.to_string(), input.clone(), options.clone())
        .await
    {
        Ok(response) => Ok(response),
        Err(error) if app_server_error_mentions_missing_thread(&error) => {
            resume_thread_for_turn_start(state, &client, thread_id).await?;
            client
                .turn_start(thread_id.to_string(), input, options)
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
    let resolved =
        skills::resolve_turn_input_with_skills_for_thread(&state, &thread_id, request.input)
            .await?;
    let pending_skill_mentions_id = turn_lifecycle::insert_pending_skill_mentions(
        &state,
        &thread_id,
        &resolved.input,
        &resolved.skills,
    )
    .await?;
    let response = match turn_start_resuming_missing_thread_once(
        &state,
        &thread_id,
        resolved.input.clone(),
        request.options.clone(),
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            turn_lifecycle::delete_pending_skill_mentions(
                &state,
                pending_skill_mentions_id.as_deref(),
            )
            .await?;
            return Err(error);
        }
    };
    state
        .store
        .save_thread_turn_options(&thread_id, &request.options)
        .await?;
    if let Some(turn_id) = turn_lifecycle::pending_projection_turn_id(&response.payload) {
        turn_lifecycle::record_pending_user_projection(
            &state,
            &thread_id,
            &turn_id,
            &resolved.input,
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
    let resolved =
        skills::resolve_turn_input_with_skills_for_thread(&state, &thread_id, request.input)
            .await?;
    let pending_skill_mentions_id = turn_lifecycle::insert_pending_skill_mentions(
        &state,
        &thread_id,
        &resolved.input,
        &resolved.skills,
    )
    .await?;
    let response = match app_server_api::client(&state.app_server)
        .turn_steer(thread_id.clone(), turn_id.clone(), resolved.input.clone())
        .await
    {
        Ok(response) => response,
        Err(error) => {
            turn_lifecycle::delete_pending_skill_mentions(
                &state,
                pending_skill_mentions_id.as_deref(),
            )
            .await?;
            return Err(error);
        }
    };
    turn_lifecycle::record_pending_user_projection(&state, &thread_id, &turn_id, &resolved.input)
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
