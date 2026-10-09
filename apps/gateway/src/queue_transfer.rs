//! Narrow coordination for the retained queued-row Send now action. Ordinary
//! queue contents, ordering and dispatch remain native-owned. Public commands
//! and retained producers share this coordinator; there is no ordinary drainer.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use crate::{
    api::AppState,
    app_server_api,
    error::{ApiError, ApiResult},
    store::{QueueTransfer, QueueTransferPhase},
};

pub const TRANSFER_CHANGED_EVENT: &str = "turn_queue.transfer_changed";

mod projection;
mod promotion;

pub use promotion::{promote, promote_first};

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum PromotionOutcome {
    /// The authoritative native queue has no front row to dispatch.
    Empty,
    /// Acknowledged native queue-start, or a receipt-settled steer transfer.
    Delivered {
        id: String,
    },
    Transfer {
        transfer: QueueTransfer,
    },
}

/// Shared explicit native queue-start dispatch. The caller holds the thread
/// input lock and checks native capability and unresolved row transfers first.
pub(crate) async fn start_locked(
    state: &AppState,
    thread_id: &str,
    native_queue_id: &str,
    probe: &crate::queue_steer_guard::QueueSteerProbe,
) -> ApiResult<app_server_api::RawAppServerResponse> {
    crate::automations::observe_queue_handoff_pending(state, thread_id, native_queue_id).await?;
    if !state.queue_steer_guards.is_probe_current(probe) {
        return Err(ApiError::Conflict(
            "Native lifecycle changed; queued message was left untouched".into(),
        ));
    }
    // Native queue-start owns atomic row consumption. Never delete/resubmit,
    // switch to steer on failure, or retry an unconfirmed start.
    let ack = app_server_api::client(&state.app_server)
        .queue_start(thread_id.into(), Some(native_queue_id.into()))
        .await?;
    if let Some(turn) = ack.payload.pointer("/turn/id").and_then(Value::as_str) {
        if let Err(error) =
            crate::automations::observe_promoted_receipt(state, thread_id, native_queue_id, turn)
                .await
        {
            tracing::warn!(%error, "failed to record acknowledged automation dispatch");
        }
    }
    Ok(ack)
}

/// Shared native queue submission for composer, Control and automation producers.
/// Producer bookkeeping must be persisted by its owner before calling this;
/// an ambiguous native add is never retried here. Nothing resumes an idle chat.
pub async fn enqueue(
    state: &AppState,
    thread_id: &str,
    input: Vec<Value>,
    client_id: String,
) -> ApiResult<app_server_api::NativeQueuedSubmission> {
    let _guard = state.thread_input_locks.lock(thread_id).await;
    enqueue_locked(state, thread_id, input, client_id).await
}

/// Caller must hold the shared thread input lock, including across any queue
/// routing read or explicit target activation preceding this admission.
pub(crate) async fn enqueue_locked(
    state: &AppState,
    thread_id: &str,
    input: Vec<Value>,
    client_id: String,
) -> ApiResult<app_server_api::NativeQueuedSubmission> {
    let client = app_server_api::client(&state.app_server);
    client.check_direct_input_capability(thread_id).await?;
    let row = match client.queue_add(thread_id.into(), input, client_id).await {
        Ok(row) => row,
        Err(error @ ApiError::BadRequest(_)) => return Err(error),
        Err(_) => return Err(ApiError::BadGateway(
            "Native queue admission was not confirmed. Delivery may have occurred; inspect the queue before explicitly submitting again. No automatic retry was made.".into()
        )),
    };
    Ok(row)
}

/// Presentation hint from native state; the mutation performs its own fenced
/// preflight. A failed read must not turn an acknowledged queue write into an
/// apparent submission failure or hide the durable queue itself.
pub(crate) async fn can_steer(state: &AppState, thread_id: &str) -> bool {
    let client = app_server_api::client(&state.app_server);
    if client
        .check_direct_input_capability(thread_id)
        .await
        .is_err()
    {
        return false;
    }
    active_turn(&client, thread_id)
        .await
        .ok()
        .flatten()
        .is_some()
}

pub(crate) async fn active_turn(
    client: &app_server_api::CodexClient,
    thread_id: &str,
) -> ApiResult<Option<String>> {
    let page = match client
        .thread_turns_list_page(
            thread_id.into(),
            None,
            app_server_api::SortDirection::Desc,
            app_server_api::ThreadTurnItemsView::NotLoaded,
            Some(1),
        )
        .await
    {
        Ok(page) => page,
        Err(error)
            if app_server_api::is_thread_not_materialized_before_first_user_message(
                &error, thread_id,
            ) =>
        {
            return Ok(None)
        }
        Err(error) => return Err(error),
    };
    let Some(turn) = page.data.first() else {
        return Ok(None);
    };
    match turn.raw_payload.get("status").and_then(Value::as_str) {
        Some("inProgress") => Ok(Some(turn.id.clone())),
        Some("completed" | "interrupted" | "failed") => Ok(None),
        _ => Err(ApiError::BadGateway(
            "Native turn header has an invalid status".into(),
        )),
    }
}

/// None means the requested CAS succeeded. A receipt deletes the record;
/// reset/disconnect leaves an uncertain record. Neither permits further RPCs.
async fn advance(
    state: &AppState,
    transfer: &QueueTransfer,
    expected: QueueTransferPhase,
    next: QueueTransferPhase,
    error: Option<&str>,
) -> ApiResult<Option<PromotionOutcome>> {
    if state
        .store
        .advance_queue_transfer(&transfer.id, expected, next, error)
        .await?
        .is_some()
    {
        broadcast_changed(state, &transfer.thread_id).await?;
        Ok(None)
    } else {
        Ok(Some(current_outcome(state, transfer).await?))
    }
}

async fn uncertain(
    state: &AppState,
    transfer: &QueueTransfer,
    expected: QueueTransferPhase,
    message: &str,
) -> ApiResult<PromotionOutcome> {
    if let Some(outcome) = advance(
        state,
        transfer,
        expected,
        QueueTransferPhase::Uncertain,
        Some(message),
    )
    .await?
    {
        return Ok(outcome);
    }
    current_outcome(state, transfer).await
}

async fn current_outcome(
    state: &AppState,
    transfer: &QueueTransfer,
) -> ApiResult<PromotionOutcome> {
    Ok(match state.store.get_queue_transfer(&transfer.id).await? {
        Some(transfer) => PromotionOutcome::Transfer { transfer },
        None => PromotionOutcome::Delivered {
            id: transfer.id.clone(),
        },
    })
}

/// Explicit bounded recovery read. Only a unique exact fresh-operation receipt
/// in its intended native turn can settle; no cursor walk, chat activation,
/// queue deletion or replay is permitted by an absent or truncated page.
pub async fn reconcile(state: &AppState, transfer_id: &str) -> ApiResult<PromotionOutcome> {
    let transfer = state
        .store
        .get_queue_transfer(transfer_id)
        .await?
        .ok_or_else(|| ApiError::NotFound("Queue transfer is no longer available".into()))?;
    let page = app_server_api::client(&state.app_server)
        .thread_items_list_page(
            transfer.thread_id.clone(),
            Some(transfer.expected_turn_id.clone()),
            None,
            app_server_api::SortDirection::Desc,
            Some(25),
        )
        .await?;
    let matches = page
        .data
        .iter()
        .filter(|entry| {
            entry.item.item_type == "userMessage"
                && entry.item.client_id.as_deref() == Some(transfer.id.as_str())
        })
        .count();
    if matches == 1 {
        // Retain the transfer correlation until producer settlement succeeds.
        // A temporary bookkeeping error must not destroy its recovery witness.
        crate::automations::observe_promoted_receipt(
            state,
            &transfer.thread_id,
            &transfer.native_queue_id,
            &transfer.expected_turn_id,
        )
        .await?;
    }
    if matches == 1
        && state
            .store
            .settle_queue_transfer_delivery(
                &transfer.thread_id,
                &transfer.expected_turn_id,
                Some(&transfer.id),
            )
            .await?
    {
        projection::discard(state, &transfer).await?;
        broadcast_changed(state, &transfer.thread_id).await?;
        // The receipt may have been missed by live ingestion. Read the current
        // canonical view instead of projecting this bounded recovery page,
        // which could already be obsolete after a concurrent native revert.
        let event = crate::events_synthetic::thread_view_refresh_required_event(
            state.store.latest_event_seq().await?,
            transfer.thread_id.clone(),
            "queue_transfer_reconciled",
        )?;
        let _ = state.events.send(event);
    }
    current_outcome(state, &transfer).await
}

pub async fn broadcast_changed(state: &AppState, thread_id: &str) -> ApiResult<()> {
    projection::discard_uncertain(state, thread_id).await?;
    let event = state
        .store
        .append_event(crate::store::NewEvent {
            project_id: None,
            thread_id: Some(thread_id.into()),
            turn_id: None,
            item_id: None,
            kind: TRANSFER_CHANGED_EVENT.into(),
            codex_method: None,
            payload: serde_json::json!({"threadId":thread_id}),
        })
        .await?;
    let _ = state.events.send(event);
    Ok(())
}

/// Call before serial ingestion can await timeline or app-surface work. Native
/// user receipts settle by the fresh transfer operation ID, never a queue's
/// reusable original client ID. No native RPC or input lock is acquired here.
pub async fn observe_notification(state: &AppState, method: &str, params: &Value) -> ApiResult<()> {
    let Some(thread) = params.get("threadId").and_then(Value::as_str) else {
        return Ok(());
    };
    let changed = match method {
        "item/started" | "item/completed"
            if params.pointer("/item/type").and_then(Value::as_str) == Some("userMessage")
                && params.pointer("/item/id").and_then(Value::as_str).is_some() =>
        {
            let Some(turn) = params.get("turnId").and_then(Value::as_str) else {
                return Ok(());
            };
            let client_id = params.pointer("/item/clientId").and_then(Value::as_str);
            if let Some(id) = client_id {
                if let Some(transfer) = state.store.get_queue_transfer(id).await? {
                    if transfer.thread_id == thread && transfer.expected_turn_id == turn {
                        crate::automations::observe_promoted_receipt(
                            state,
                            thread,
                            &transfer.native_queue_id,
                            turn,
                        )
                        .await?;
                    }
                }
            }
            state
                .store
                .settle_queue_transfer_delivery(thread, turn, client_id)
                .await?
        }
        "turn/completed" => {
            let Some(turn) = params.pointer("/turn/id").and_then(Value::as_str) else {
                return Ok(());
            };
            state
                .store
                .invalidate_queue_transfers_for_turn(
                    thread,
                    turn,
                    "Turn ended before a native delivery receipt",
                )
                .await?
                > 0
        }
        "thread/reverted" | "thread/closed" | "thread/archived" | "thread/deleted" => {
            state
                .store
                .invalidate_queue_transfers(
                    Some(thread),
                    "Thread lifecycle changed before a native delivery receipt",
                )
                .await?
                > 0
        }
        "thread/status/changed"
            if matches!(
                params.pointer("/status/type").and_then(Value::as_str),
                Some("idle" | "notLoaded" | "systemError")
            ) =>
        {
            state
                .store
                .invalidate_queue_transfers(
                    Some(thread),
                    "Native thread stopped accepting the witnessed turn before a delivery receipt",
                )
                .await?
                > 0
        }
        _ => false,
    };
    if changed {
        broadcast_changed(state, thread).await?;
    }
    Ok(())
}

/// Gateway/native restart preserves content and uncertainty, never replays a
/// delete/steer or activates an ordinary queued chat.
pub async fn recover(state: &AppState) -> ApiResult<()> {
    let threads = state
        .store
        .invalidate_queue_transfers_for_restart(
            "Runtime continuity was lost before a native delivery receipt",
        )
        .await?;
    for thread in threads {
        broadcast_changed(state, &thread).await?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "queue_transfer/tests.rs"]
mod tests;

#[cfg(test)]
#[path = "queue_transfer/reconciliation_tests.rs"]
mod reconciliation_tests;
