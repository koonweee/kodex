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
        self, timeline_skill_mentions_from_user_input, RawAppServerResponse, SkillMetadata,
        ThreadLiveState, TurnStartOptions, UserInput,
    },
    error::{ApiError, ApiResult},
    events, queue, skills, timeline_projection,
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

    if let Some(active_turn_id) = active_turn_id_for_submit(&state, &thread_id).await? {
        let pending_skill_mentions_id =
            insert_pending_skill_mentions(&state, &thread_id, &resolved.input, &resolved.skills)
                .await?;
        match app_server_api::client(&state.app_server)
            .turn_steer(
                thread_id.clone(),
                active_turn_id.clone(),
                resolved.input.clone(),
            )
            .await
        {
            Ok(response) => {
                record_pending_user_projection(
                    &state,
                    &thread_id,
                    &active_turn_id,
                    &resolved.input,
                )
                .await?;
                return Ok(Json(ThreadInputResponse {
                    disposition: ThreadInputDisposition::Steered,
                    queued_input: None,
                    raw_payload: Some(response.payload),
                }));
            }
            Err(error) if is_no_active_turn_error(&error) => {
                delete_pending_skill_mentions(&state, pending_skill_mentions_id.as_deref()).await?;
                timeline_projection::record_thread_live_state(
                    &state.thread_sessions,
                    &thread_id,
                    ThreadLiveState::Idle,
                    state.store.latest_event_seq().await?,
                )
                .await?;
            }
            Err(error) if is_non_steerable_error(&error) => {
                delete_pending_skill_mentions(&state, pending_skill_mentions_id.as_deref()).await?;
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
            Err(error) => {
                delete_pending_skill_mentions(&state, pending_skill_mentions_id.as_deref()).await?;
                return Err(error);
            }
        }
    }

    let pending_skill_mentions_id =
        insert_pending_skill_mentions(&state, &thread_id, &resolved.input, &resolved.skills)
            .await?;
    let response = match app_server_api::client(&state.app_server)
        .turn_start(thread_id.clone(), resolved.input.clone(), options)
        .await
    {
        Ok(response) => response,
        Err(error) => {
            delete_pending_skill_mentions(&state, pending_skill_mentions_id.as_deref()).await?;
            return Err(error);
        }
    };
    if let Some(turn_id) = pending_projection_turn_id(&response.payload) {
        record_pending_user_projection(&state, &thread_id, &turn_id, &resolved.input).await?;
    }
    Ok(Json(ThreadInputResponse {
        disposition: ThreadInputDisposition::Started,
        queued_input: None,
        raw_payload: Some(response.payload),
    }))
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
    let pending_skill_mentions_id =
        insert_pending_skill_mentions(&state, &thread_id, &resolved.input, &resolved.skills)
            .await?;
    let response = match app_server_api::client(&state.app_server)
        .turn_start(
            thread_id.clone(),
            resolved.input.clone(),
            request.options.clone(),
        )
        .await
    {
        Ok(response) => response,
        Err(error) => {
            if let Some(pending_id) = pending_skill_mentions_id.as_deref() {
                state
                    .store
                    .delete_pending_timeline_skill_mentions(pending_id)
                    .await?;
            }
            return Err(error);
        }
    };
    state
        .store
        .save_thread_turn_options(&thread_id, &request.options)
        .await?;
    if let Some(turn_id) = pending_projection_turn_id(&response.payload) {
        record_pending_user_projection(&state, &thread_id, &turn_id, &resolved.input).await?;
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
    let pending_skill_mentions_id =
        insert_pending_skill_mentions(&state, &thread_id, &resolved.input, &resolved.skills)
            .await?;
    let response = match app_server_api::client(&state.app_server)
        .turn_steer(thread_id.clone(), turn_id.clone(), resolved.input.clone())
        .await
    {
        Ok(response) => response,
        Err(error) => {
            if let Some(pending_id) = pending_skill_mentions_id.as_deref() {
                state
                    .store
                    .delete_pending_timeline_skill_mentions(pending_id)
                    .await?;
            }
            return Err(error);
        }
    };
    record_pending_user_projection(&state, &thread_id, &turn_id, &resolved.input).await?;
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

async fn insert_pending_skill_mentions(
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

async fn delete_pending_skill_mentions(
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

async fn active_turn_id_for_submit(state: &AppState, thread_id: &str) -> ApiResult<Option<String>> {
    if let Some(active_turn_id) = state.thread_sessions.active_turn_id(thread_id).await {
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
        .thread_sessions
        .refresh_from_turns(thread_id, &snapshot.turns, revision)
        .await;
    Ok(timeline.active_turn_id)
}

fn is_thread_not_materialized_before_first_user_message(error: &ApiError) -> bool {
    let ApiError::BadGateway(message) = error else {
        return false;
    };
    let normalized = message.to_ascii_lowercase();
    normalized.contains("not materialized yet") && normalized.contains("before first user message")
}

async fn record_pending_user_projection(
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
    if timeline_projection::record_pending_user_input(
        &state.thread_sessions,
        thread_id,
        turn_id,
        input,
        event.seq,
    )
    .await?
    .is_some()
    {
        let patch = events::timeline_projection_patch_event(state, thread_id).await?;
        let _ = state.events.send(patch);
    }
    Ok(())
}

fn pending_projection_turn_id(payload: &serde_json::Value) -> Option<String> {
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

fn is_no_active_turn_error(error: &ApiError) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    message.contains("no active turn")
        || message.contains("active turn")
            && (message.contains("missing") || message.contains("not found"))
}

fn is_non_steerable_error(error: &ApiError) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    message.contains("not steerable")
        || message.contains("activeturnnotsteerable")
        || message.contains("cannot steer")
        || message.contains("expectedturnid")
        || message.contains("expected turn")
}
