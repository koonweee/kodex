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
        self, CodexClient, RawAppServerResponse, ThreadLiveState, TurnStartOptions, UserInput,
    },
    error::{ApiError, ApiResult},
    events, queue, skills, thread_view, turn_lifecycle,
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
    request.options.validate()?;
    let resolved =
        skills::resolve_turn_input_with_skills_for_thread(&state, &thread_id, request.input)
            .await?;
    let options = request.options;

    let submit_guard = state.thread_input_locks.lock(&thread_id).await;
    match turn_lifecycle::route_for_thread_input(&state, &thread_id).await? {
        turn_lifecycle::ThreadInputRoute::QueueBehindGatewayWork => {
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
        turn_lifecycle::ThreadInputRoute::Active { turn_id } => match submit_thread_input_as_steer(
            &state,
            &thread_id,
            &turn_id,
            &resolved.input,
            &resolved.skills,
        )
        .await
        {
            Ok(Some(response)) => return Ok(response),
            Ok(None) => {}
            Err(error) if turn_lifecycle::is_expected_turn_mismatch_error(&error) => {
                return Err(error);
            }
            Err(error) if turn_lifecycle::is_non_steerable_error(&error) => {
                return queue_rejected_steer_input(
                    &state,
                    &thread_id,
                    resolved.input,
                    options,
                    error,
                )
                .await;
            }
            Err(error) => return Err(error),
        },
        turn_lifecycle::ThreadInputRoute::Idle => {}
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
    state
        .title_generation
        .spawn_for_turn_start(state.clone(), thread_id.clone(), &resolved.input);
    Ok(Json(ThreadInputResponse {
        disposition: ThreadInputDisposition::Started,
        queued_input: None,
        raw_payload: Some(response.payload),
    }))
}

async fn submit_thread_input_as_steer(
    state: &AppState,
    thread_id: &str,
    expected_turn_id: &str,
    input: &[UserInput],
    skills: &[app_server_api::SkillMetadata],
) -> ApiResult<Option<Json<ThreadInputResponse>>> {
    let pending_skill_mentions_id =
        turn_lifecycle::insert_pending_skill_mentions(state, thread_id, input, skills).await?;
    match steer_thread_input_with_one_retry(state, thread_id, expected_turn_id, input).await {
        Ok((response, accepted_turn_id)) => {
            let projection_turn_id = turn_lifecycle::pending_projection_turn_id(&response.payload)
                .unwrap_or(accepted_turn_id);
            turn_lifecycle::record_pending_user_projection(
                state,
                thread_id,
                &projection_turn_id,
                input,
            )
            .await?;
            return Ok(Some(Json(ThreadInputResponse {
                disposition: ThreadInputDisposition::Steered,
                queued_input: None,
                raw_payload: Some(response.payload),
            })));
        }
        Err(error) if turn_lifecycle::is_no_active_turn_error(&error) => {
            turn_lifecycle::delete_pending_skill_mentions(
                state,
                pending_skill_mentions_id.as_deref(),
            )
            .await?;
            turn_lifecycle::record_idle_after_missing_active_turn(state, thread_id).await?;
            Ok(None)
        }
        Err(error) if turn_lifecycle::is_expected_turn_mismatch_error(&error) => {
            turn_lifecycle::delete_pending_skill_mentions(
                state,
                pending_skill_mentions_id.as_deref(),
            )
            .await?;
            Err(error)
        }
        Err(error) if turn_lifecycle::is_non_steerable_error(&error) => {
            turn_lifecycle::delete_pending_skill_mentions(
                state,
                pending_skill_mentions_id.as_deref(),
            )
            .await?;
            Err(error)
        }
        Err(error) => {
            turn_lifecycle::delete_pending_skill_mentions(
                state,
                pending_skill_mentions_id.as_deref(),
            )
            .await?;
            Err(error)
        }
    }
}

async fn steer_thread_input_with_one_retry(
    state: &AppState,
    thread_id: &str,
    expected_turn_id: &str,
    input: &[UserInput],
) -> ApiResult<(RawAppServerResponse, String)> {
    let client = app_server_api::client(&state.app_server);
    match client
        .turn_steer(
            thread_id.to_string(),
            expected_turn_id.to_string(),
            input.to_vec(),
        )
        .await
    {
        Ok(response) => Ok((response, expected_turn_id.to_string())),
        Err(error) if turn_lifecycle::is_no_active_turn_error(&error) => Err(error),
        Err(error) => {
            let Some(actual_turn_id) =
                turn_lifecycle::expected_turn_mismatch_actual_turn_id(&error)
            else {
                return Err(error);
            };
            turn_lifecycle::record_turn_started(state, thread_id, Some(&actual_turn_id)).await?;
            client
                .turn_steer(
                    thread_id.to_string(),
                    actual_turn_id.clone(),
                    input.to_vec(),
                )
                .await
                .map(|response| (response, actual_turn_id))
        }
    }
}

async fn queue_rejected_steer_input(
    state: &AppState,
    thread_id: &str,
    input: Vec<UserInput>,
    options: TurnStartOptions,
    error: ApiError,
) -> ApiResult<Json<ThreadInputResponse>> {
    let queued_input = queue::create_rejected_steer_input_with_source(
        state,
        thread_id,
        input,
        options,
        error.to_string(),
        None,
        None,
    )
    .await?;
    Ok(Json(ThreadInputResponse {
        disposition: ThreadInputDisposition::Queued,
        queued_input: Some(queued_input),
        raw_payload: None,
    }))
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
    request.options.validate()?;
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
    if let Some(turn_id) = turn_lifecycle::pending_projection_turn_id(&response.payload) {
        turn_lifecycle::record_pending_user_projection(
            &state,
            &thread_id,
            &turn_id,
            &resolved.input,
        )
        .await?;
    }
    state
        .title_generation
        .spawn_for_turn_start(state.clone(), thread_id.clone(), &resolved.input);
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
