use axum::{
    extract::{Path, State},
    Json,
};
use serde::Deserialize;
use utoipa::ToSchema;

use super::{turns::TurnStartRequest, turns_start::start_turn_locked};
use crate::{
    api::AppState,
    app_server_api::{
        self, RawAppServerResponse, SortDirection, ThreadStatus, ThreadTurnItemsView,
        TurnStartOptions,
    },
    error::{ApiError, ApiResult},
};

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResumeInterruptedTurnRequest {
    /// The interrupted native turn displayed by the client. A changed head requires a refill.
    pub expected_turn_id: String,
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/resume-turn", request_body = ResumeInterruptedTurnRequest,
    responses((status = 200, body = RawAppServerResponse), (status = 409, body = crate::error::ApiErrorBody)))]
pub async fn resume_interrupted_turn(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<ResumeInterruptedTurnRequest>,
) -> ApiResult<Json<RawAppServerResponse>> {
    let resume_missing_thread = !state.side_threads.is_side_or_closed_child(&thread_id);
    let _guard = state.thread_input_locks.lock(&thread_id).await;
    let client = app_server_api::client(&state.app_server);
    let summary = client.thread_read_summary(thread_id.clone()).await?;
    if !matches!(summary.status, ThreadStatus::Idle | ThreadStatus::NotLoaded) {
        return Err(ApiError::Conflict(
            "The conversation is no longer idle. Refresh before resuming.".into(),
        ));
    }
    // A bounded native header read also rejects a stale second tab after a quick
    // continuation has already completed. No local stopped flag or retry ledger.
    let page = client
        .thread_turns_list_page(
            thread_id.clone(),
            None,
            SortDirection::Desc,
            ThreadTurnItemsView::NotLoaded,
            Some(1),
        )
        .await?;
    if !page
        .data
        .first()
        .is_some_and(|head| head.id == request.expected_turn_id && head.status == "interrupted")
    {
        return Err(ApiError::Conflict(
            "The interrupted turn has changed. Refresh before resuming.".into(),
        ));
    }
    Ok(Json(
        start_turn_locked(
            &state,
            thread_id,
            TurnStartRequest {
                client_user_message_id: None,
                input: vec![],
                attachments: vec![],
                options: TurnStartOptions::default(),
            },
            resume_missing_thread,
            None,
        )
        .await?,
    ))
}
