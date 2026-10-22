use axum::{
    extract::{Path, State},
    routing::get,
    Json, Router,
};
use serde_json::json;

use crate::{
    api::AppState,
    app_server_api,
    error::{ApiError, ApiResult},
    side_threads::{self, SideThreadCloseResponse, SideThreadEntry, SideThreadResponse},
};

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/v1/threads/{parent_thread_id}/side-thread",
        get(get_side_thread)
            .post(create_or_get_side_thread)
            .delete(close_side_thread),
    )
}

#[utoipa::path(
    post,
    path = "/v1/threads/{parentThreadId}/side-thread",
    responses((status = 200, body = SideThreadResponse))
)]
pub async fn create_or_get_side_thread(
    State(state): State<AppState>,
    Path(parent_thread_id): Path<String>,
) -> ApiResult<Json<SideThreadResponse>> {
    let _guard = state.side_threads.lock(&parent_thread_id).await;
    if let Some(entry) = state.side_threads.get_by_parent(&parent_thread_id) {
        return Ok(Json(
            side_threads::response_for_entry(&state, entry, true).await?,
        ));
    }
    if state
        .side_threads
        .parent_for_child(&parent_thread_id)
        .is_some()
    {
        return Err(ApiError::BadRequest(
            "nested side chats are not supported".into(),
        ));
    }

    let client = app_server_api::client(&state.app_server);
    let parent_thread = client.thread_read_summary(parent_thread_id.clone()).await?;
    if parent_thread.id != parent_thread_id {
        return Err(ApiError::BadGateway(
            "native side-chat parent read returned a different thread".into(),
        ));
    }
    let mut fork = client
        .thread_fork(
            parent_thread_id.clone(),
            json!({"ephemeral": true, "excludeTurns": true}),
        )
        .await?;
    if fork
        .thread
        .raw_payload
        .get("ephemeral")
        .and_then(|value| value.as_bool())
        != Some(true)
    {
        return Err(ApiError::BadGateway(
            "native side-chat fork was not ephemeral".into(),
        ));
    }
    if fork
        .thread
        .raw_payload
        .get("forkedFromId")
        .and_then(|value| value.as_str())
        .is_some_and(|forked_from| forked_from != parent_thread_id)
    {
        return Err(ApiError::BadGateway(
            "native side-chat fork returned a different parent".into(),
        ));
    }
    fork.thread.parent_thread_id = Some(parent_thread_id);
    let child_thread_id = fork.thread.id.clone();
    let entry = SideThreadEntry {
        parent_thread,
        thread: fork.thread,
    };
    let projection_revision = state.store.latest_event_seq().await?;
    state
        .thread_views
        .initialize_empty(&child_thread_id, projection_revision)
        .await;
    state.side_threads.insert(entry.clone());

    Ok(Json(
        side_threads::response_for_entry(&state, entry, false).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/v1/threads/{parentThreadId}/side-thread",
    responses(
        (status = 200, body = SideThreadResponse),
        (status = 404, body = crate::error::ApiErrorBody)
    )
)]
pub async fn get_side_thread(
    State(state): State<AppState>,
    Path(parent_thread_id): Path<String>,
) -> ApiResult<Json<SideThreadResponse>> {
    let _guard = state.side_threads.lock(&parent_thread_id).await;
    state
        .side_threads
        .get_by_parent(&parent_thread_id)
        .ok_or_else(|| ApiError::NotFound("side chat expired".into()))?;
    let client = app_server_api::client(&state.app_server);
    let entry = refresh_parent_summary(&state, &client, &parent_thread_id).await?;
    Ok(Json(
        side_threads::response_for_entry(&state, entry, true).await?,
    ))
}

async fn refresh_parent_summary(
    state: &AppState,
    client: &crate::app_server_api::CodexClient,
    parent_thread_id: &str,
) -> ApiResult<SideThreadEntry> {
    let parent_thread = client
        .thread_read_summary(parent_thread_id.to_string())
        .await?;
    if parent_thread.id != parent_thread_id {
        return Err(ApiError::BadGateway(
            "native side-chat parent read returned a different thread".into(),
        ));
    }
    state
        .side_threads
        .update_parent_summary(parent_thread_id, parent_thread)
        .ok_or_else(|| ApiError::NotFound("side chat expired".into()))
}

#[utoipa::path(
    delete,
    path = "/v1/threads/{parentThreadId}/side-thread",
    responses((status = 200, body = SideThreadCloseResponse))
)]
pub async fn close_side_thread(
    State(state): State<AppState>,
    Path(parent_thread_id): Path<String>,
) -> ApiResult<Json<SideThreadCloseResponse>> {
    let _guard = state.side_threads.lock(&parent_thread_id).await;
    let Some(entry) = state.side_threads.remove_by_parent(&parent_thread_id) else {
        return Ok(Json(SideThreadCloseResponse {
            closed: false,
            side_thread_id: None,
        }));
    };
    let child_thread_id = entry.thread.id.clone();
    side_threads::invalidate_pending_app_surfaces(&state, &child_thread_id).await;
    let broadcast_result = side_threads::broadcast_closed(&state, &entry, "closed").await;

    let client = app_server_api::client(&state.app_server);
    if let Some(turn_id) = state.thread_views.active_turn_id(&child_thread_id).await {
        if let Err(error) = client
            .turn_interrupt(child_thread_id.clone(), turn_id)
            .await
        {
            tracing::warn!(%error, side_thread_id = %child_thread_id, "failed to interrupt closing side chat");
        }
    }
    if let Err(error) = client.thread_unsubscribe(child_thread_id.clone()).await {
        tracing::warn!(%error, side_thread_id = %child_thread_id, "failed to unsubscribe closing side chat");
    }
    state.thread_views.remove(&child_thread_id).await;
    broadcast_result?;

    Ok(Json(SideThreadCloseResponse {
        closed: true,
        side_thread_id: Some(child_thread_id),
    }))
}
