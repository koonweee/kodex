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

/// One explicit handoff targets the native turn active during this request.
/// Queue age and enqueue-time runtime context do not determine eligibility.
pub async fn promote(
    state: &AppState,
    thread_id: &str,
    native_queue_id: &str,
) -> ApiResult<PromotionOutcome> {
    let _guard = state.thread_input_locks.lock(thread_id).await;
    if let Some(transfer) = state
        .store
        .get_queue_transfer_for_row(thread_id, native_queue_id)
        .await?
    {
        // Repeated requests recover the outcome without repeating native calls.
        return Ok(PromotionOutcome::Transfer { transfer });
    }
    promote_locked(state, thread_id, Some(native_queue_id)).await
}

/// Select the current native front row under the shared Kodex input lock.
/// An unresolved handoff at the front never permits skipping to a later row.
pub async fn promote_first(state: &AppState, thread_id: &str) -> ApiResult<PromotionOutcome> {
    let _guard = state.thread_input_locks.lock(thread_id).await;
    promote_locked(state, thread_id, None).await
}

async fn promote_locked(
    state: &AppState,
    thread_id: &str,
    native_queue_id: Option<&str>,
) -> ApiResult<PromotionOutcome> {
    // Register before any native preflight read so observed lifecycle changes
    // cannot authorize deletion using a late response from an earlier runtime.
    let probe = state.queue_steer_guards.begin_probe(thread_id);
    let client = app_server_api::client(&state.app_server);
    client.check_direct_input_capability(thread_id).await?;
    let current = active_turn(&client, thread_id).await?;
    let claim = state
        .queue_steer_guards
        .capture_after_probe(probe, current.as_deref())
        .ok_or_else(|| {
            ApiError::Conflict(
                "No continuous active turn is available to steer; native queue was left untouched"
                    .into(),
            )
        })?;
    let target = claim.turn_id().to_owned();
    let mut cursor = None;
    let mut seen_cursors = std::collections::HashSet::new();
    let row = loop {
        let page = client
            .queue_list(
                thread_id.into(),
                cursor,
                Some(if native_queue_id.is_some() { 100 } else { 1 }),
            )
            .await?;
        if !state.queue_steer_guards.is_current(&claim) {
            return Err(ApiError::Conflict(
                "Active turn continuity was lost; native queue was left untouched".into(),
            ));
        }
        if let Some(row) = page
            .data
            .into_iter()
            .find(|row| native_queue_id.is_none_or(|id| row.id == id))
        {
            break row;
        }
        match page.next_cursor {
            Some(next) if native_queue_id.is_some() => {
                if !seen_cursors.insert(next.clone()) {
                    return Err(ApiError::BadGateway(
                        "Native queue repeated its page cursor".into(),
                    ));
                }
                cursor = Some(next);
            }
            _ => {
                return Err(ApiError::Conflict(
                    "Native queued message is no longer available".into(),
                ))
            }
        }
    };
    if let Some(transfer) = state
        .store
        .get_queue_transfer_for_row(thread_id, &row.id)
        .await?
    {
        return Ok(PromotionOutcome::Transfer { transfer });
    }
    if !state.queue_steer_guards.is_current(&claim) {
        return Err(ApiError::Conflict(
            "Active turn continuity was lost; native queue was left untouched".into(),
        ));
    }
    let native_queue_id = row.id.as_str();
    let transfer = state
        .store
        .create_queue_transfer(
            thread_id,
            &row.id,
            &row.client_user_message_id,
            &target,
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

    if !state.queue_steer_guards.is_current(&claim) {
        return uncertain(
            state,
            &transfer,
            QueueTransferPhase::Deleting,
            "Active turn continuity was lost before deletion; native queue was left untouched",
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
    if !state.queue_steer_guards.is_current(&claim) {
        return uncertain(
            state,
            &transfer,
            QueueTransferPhase::Steering,
            "Active turn continuity was lost after deletion; delivery is uncertain",
        )
        .await;
    }
    let submission_revision = state.store.latest_event_seq().await?;
    match client
        .turn_steer_native_input(
            thread_id.into(),
            target,
            transfer.input.clone(),
            transfer.id.clone(),
        )
        .await
    {
        Ok(_) => {
            if !state.queue_steer_guards.is_current(&claim) {
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
