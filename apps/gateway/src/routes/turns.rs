use axum::{
    extract::{Path, State},
    routing::post,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::{
    api::AppState,
    app_server_api::{self, RawAppServerResponse, TurnStartOptions, UserInput},
    error::ApiResult,
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

    if let Some(active_turn_id) = turn_lifecycle::current_active_turn_id(&state, &thread_id).await?
    {
        let pending_skill_mentions_id = turn_lifecycle::insert_pending_skill_mentions(
            &state,
            &thread_id,
            &resolved.input,
            &resolved.skills,
        )
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
                turn_lifecycle::record_pending_user_projection(
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
            Err(error) if turn_lifecycle::is_no_active_turn_error(&error) => {
                turn_lifecycle::delete_pending_skill_mentions(
                    &state,
                    pending_skill_mentions_id.as_deref(),
                )
                .await?;
                turn_lifecycle::record_idle_after_missing_active_turn(&state, &thread_id).await?;
            }
            Err(error) if turn_lifecycle::is_non_steerable_error(&error) => {
                turn_lifecycle::delete_pending_skill_mentions(
                    &state,
                    pending_skill_mentions_id.as_deref(),
                )
                .await?;
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
                turn_lifecycle::delete_pending_skill_mentions(
                    &state,
                    pending_skill_mentions_id.as_deref(),
                )
                .await?;
                return Err(error);
            }
        }
    }

    let pending_skill_mentions_id = turn_lifecycle::insert_pending_skill_mentions(
        &state,
        &thread_id,
        &resolved.input,
        &resolved.skills,
    )
    .await?;
    let response = match app_server_api::client(&state.app_server)
        .turn_start(thread_id.clone(), resolved.input.clone(), options)
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
    let pending_skill_mentions_id = turn_lifecycle::insert_pending_skill_mentions(
        &state,
        &thread_id,
        &resolved.input,
        &resolved.skills,
    )
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
