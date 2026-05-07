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
    skills,
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
    let input = skills::resolve_turn_input_for_thread(&state, &thread_id, request.input).await?;
    let response = app_server_api::client(&state.app_server)
        .turn_start(thread_id.clone(), input, request.options.clone())
        .await?;
    state
        .store
        .save_thread_turn_options(&thread_id, &request.options)
        .await?;
    Ok(Json(response))
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/turns/{turnId}/steer", request_body = TurnSteerRequest, responses((status = 200, body = RawAppServerResponse)))]
pub async fn steer_turn(
    State(state): State<AppState>,
    Path((thread_id, turn_id)): Path<(String, String)>,
    Json(request): Json<TurnSteerRequest>,
) -> ApiResult<Json<RawAppServerResponse>> {
    let input = skills::resolve_turn_input_for_thread(&state, &thread_id, request.input).await?;
    Ok(Json(
        app_server_api::client(&state.app_server)
            .turn_steer(thread_id, turn_id, input)
            .await?,
    ))
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
