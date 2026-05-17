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
        TurnStartOptions, UserInput,
    },
    error::ApiResult,
    events, skills, timeline_projection,
};

pub fn router() -> Router<AppState> {
    Router::new()
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
        &state.store,
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
