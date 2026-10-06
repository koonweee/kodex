use crate::{
    api::AppState,
    error::ApiResult,
    events,
    store::{QueueTransfer, QueueTransferPhase},
    thread_view, turn_lifecycle,
};

pub(super) async fn record_accepted(
    state: &AppState,
    transfer: &QueueTransfer,
    submission_revision: i64,
) {
    if let Err(error) = turn_lifecycle::record_pending_user_projection(
        state,
        &transfer.thread_id,
        &transfer.expected_turn_id,
        &transfer.id,
        &transfer.input,
        &[],
        submission_revision,
    )
    .await
    {
        // Projection failure cannot turn an acknowledged native write into a
        // retryable submission error. The transfer remains recoverable.
        tracing::warn!(%error, "failed to project accepted queued steering");
    }
    // A lifecycle invalidation or explicit reconciliation may precede insertion.
    // Check the exact operation, including a receipt that removed its record.
    // Later invalidations perform the same cleanup when they publish the change.
    let cleanup = async {
        if !state
            .store
            .get_queue_transfer(&transfer.id)
            .await?
            .is_some_and(|current| current.phase == QueueTransferPhase::Accepted)
        {
            discard(state, transfer).await?;
        }
        ApiResult::Ok(())
    }
    .await;
    if let Err(error) = cleanup {
        tracing::warn!(%error, "failed to discard settled queued steering projection");
    }
}

pub(super) async fn discard_uncertain(state: &AppState, thread_id: &str) -> ApiResult<()> {
    for transfer in state
        .store
        .list_queue_transfers(Some(thread_id))
        .await?
        .into_iter()
        .filter(|transfer| transfer.phase == QueueTransferPhase::Uncertain)
    {
        discard(state, &transfer).await?;
    }
    Ok(())
}

pub(super) async fn discard(state: &AppState, transfer: &QueueTransfer) -> ApiResult<()> {
    let thread_id = &transfer.thread_id;
    if let Some(patch) = thread_view::discard_pending_user_input(
        &state.thread_views, thread_id, &transfer.expected_turn_id, &transfer.id,
        async {
            Ok(state.store.append_event(crate::store::NewEvent {
                project_id: None, thread_id: Some(thread_id.clone()),
                turn_id: Some(transfer.expected_turn_id.clone()), item_id: None,
                kind: "timeline.pending_user_input".into(), codex_method: Some("turn/input".into()),
                payload: serde_json::json!({"threadId":thread_id,"turnId":transfer.expected_turn_id,"discarded":true}),
            }).await?.seq)
        },
    ).await? {
        let event = events::thread_view_patch_payload_event(state, patch).await?;
        let _ = state.events.send(event);
    }
    Ok(())
}
