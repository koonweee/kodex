use super::{
    active_turn, advance, broadcast_changed, current_outcome, projection, uncertain,
    PromotionOutcome,
};
use crate::{
    api::AppState,
    app_server_api,
    error::{ApiError, ApiResult},
    store::QueueTransferPhase,
};

/// One explicit operation, guarded by the pre-add original active turn. Never
/// infer non-delivery from queue deletion or native history absence.
pub async fn promote(
    state: &AppState,
    thread_id: &str,
    native_queue_id: &str,
) -> ApiResult<PromotionOutcome> {
    let _guard = state.thread_input_locks.lock(thread_id).await;
    promote_locked(state, thread_id, native_queue_id, None).await
}

/// Select the native front row under the same exclusion as every Kodex queue
/// mutation. Never search ahead for a row with an eligible admission witness.
pub async fn promote_first(state: &AppState, thread_id: &str) -> ApiResult<PromotionOutcome> {
    let _guard = state.thread_input_locks.lock(thread_id).await;
    let page = app_server_api::client(&state.app_server)
        .queue_list(thread_id.into(), None, Some(1))
        .await?;
    let row = page
        .data
        .into_iter()
        .next()
        .ok_or_else(|| ApiError::Conflict("Native queue is empty".into()))?;
    let id = row.id.clone();
    promote_locked(state, thread_id, &id, Some(row)).await
}

/// Caller holds the thread input lock from selection through native handoff.
async fn promote_locked(
    state: &AppState,
    thread_id: &str,
    native_queue_id: &str,
    selected_row: Option<app_server_api::NativeQueuedSubmission>,
) -> ApiResult<PromotionOutcome> {
    if let Some(transfer) = state
        .store
        .get_queue_transfer_for_row(thread_id, native_queue_id)
        .await?
    {
        // Response recovery only: a second tab or lost browser reply may read
        // the same transfer, but cannot repeat any native mutation.
        return Ok(PromotionOutcome::Transfer { transfer });
    }
    let client = app_server_api::client(&state.app_server);
    client.check_direct_input_capability(thread_id).await?;
    let current = active_turn(&client, thread_id).await?;
    let claim = state.queue_admissions.claim_token(thread_id, native_queue_id, current.as_deref())
        .ok_or_else(|| ApiError::Conflict(
            "Queued message has no continuous original-turn context; leave it queued or send a new live correction".into()
        ))?;
    let original = claim.original_turn_id().to_owned();
    let row = match selected_row {
        Some(row) => row,
        None => client
            .queue_list(thread_id.into(), None, Some(100))
            .await?
            .data
            .into_iter()
            .find(|row| row.id == native_queue_id)
            .ok_or_else(|| {
                ApiError::Conflict("Native queued message is no longer available".into())
            })?,
    };
    if !state.queue_admissions.is_current(&claim) {
        return Err(ApiError::Conflict(
            "Original turn continuity was lost; native queue was left untouched".into(),
        ));
    }
    let transfer = state
        .store
        .create_queue_transfer(
            thread_id,
            &row.id,
            &row.client_user_message_id,
            &original,
            row.input,
        )
        .await?;
    broadcast_changed(state, thread_id).await?;
    if crate::automations::observe_queue_handoff_pending(state, thread_id, native_queue_id)
        .await
        .is_err()
    {
        return uncertain(
            state,
            &transfer,
            QueueTransferPhase::Deleting,
            "Producer bookkeeping could not be updated; native queue was left untouched",
        )
        .await;
    }

    if !state.queue_admissions.is_current(&claim) {
        return uncertain(
            state,
            &transfer,
            QueueTransferPhase::Deleting,
            "Original turn continuity was lost before deletion; native queue was left untouched",
        )
        .await;
    }

    match client
        .queue_delete(thread_id.into(), native_queue_id.into())
        .await
    {
        Ok(true) => {}
        Ok(false) => {
            return uncertain(
                state,
                &transfer,
                QueueTransferPhase::Deleting,
                "Native queue deletion did not confirm ownership; delivery is uncertain",
            )
            .await
        }
        Err(_) => {
            return uncertain(
                state,
                &transfer,
                QueueTransferPhase::Deleting,
                "Native queue deletion was not acknowledged; delivery is uncertain",
            )
            .await
        }
    }
    if let Some(outcome) = advance(
        state,
        &transfer,
        QueueTransferPhase::Deleting,
        QueueTransferPhase::Deleted,
        None,
    )
    .await?
    {
        return Ok(outcome);
    }
    if let Some(outcome) = advance(
        state,
        &transfer,
        QueueTransferPhase::Deleted,
        QueueTransferPhase::Steering,
        None,
    )
    .await?
    {
        return Ok(outcome);
    }
    // Reset/EOF ingestion never waits for this command lock. The phase CAS
    // above fences events observed before the native call; expectedTurnId is
    // the final native guard against a turn ending immediately afterwards.
    if !state.queue_admissions.is_current(&claim) {
        return uncertain(
            state,
            &transfer,
            QueueTransferPhase::Steering,
            "Original turn continuity was lost after deletion; delivery is uncertain",
        )
        .await;
    }
    let submission_revision = state.store.latest_event_seq().await?;
    match client
        .turn_steer_native_input(
            thread_id.into(),
            original,
            transfer.input.clone(),
            transfer.id.clone(),
        )
        .await
    {
        Ok(_) => {
            if !state.queue_admissions.is_current(&claim) {
                return uncertain(
                    state,
                    &transfer,
                    QueueTransferPhase::Steering,
                    "Runtime continuity was lost before the steering acknowledgement",
                )
                .await;
            }
            let stopped = advance(
                state,
                &transfer,
                QueueTransferPhase::Steering,
                QueueTransferPhase::Accepted,
                None,
            )
            .await?;
            if let Some(outcome) = stopped {
                return Ok(outcome);
            }
            // Native accepted input uses the ordinary canonical user-message
            // projection. Its recovery record remains until an exact receipt.
            projection::record_accepted(state, &transfer, submission_revision).await;
            current_outcome(state, &transfer).await
        }
        Err(_) => {
            uncertain(
                state,
                &transfer,
                QueueTransferPhase::Steering,
                "Native steering was not confirmed; delivery is uncertain",
            )
            .await
        }
    }
}
