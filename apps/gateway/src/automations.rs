use chrono::{DateTime, Utc};
use serde_json::json;
use tokio::time::{interval, Duration};

use crate::{
    api::AppState,
    app_server_api,
    error::{ApiError, ApiResult},
    queue_transfer,
    routes::automations::automation_to_dto,
    store::{Automation, AutomationRun, AutomationRunPhase as Phase, NewEvent},
};

mod recovery;
#[cfg(test)]
mod tests;

pub use recovery::recover_automations_after_restart;
pub const AUTOMATION_UPSERT_EVENT: &str = "automation.item_upsert";
pub const AUTOMATION_DELETE_EVENT: &str = "automation.item_deleted";
pub const AUTOMATION_RUN_UPDATED_EVENT: &str = "automation.run_updated";
pub const AUTOMATION_MIN_INTERVAL_SECONDS: i64 = 30;
const AUTOMATION_DUE_BATCH_LIMIT: i64 = 25;

pub fn start_automation_scheduler(state: AppState) {
    tokio::spawn(async move {
        let mut ticks = interval(Duration::from_secs(1));
        loop {
            ticks.tick().await;
            if let Err(error) = process_due_automations(&state, Utc::now()).await {
                tracing::debug!(%error, "automation scheduler tick failed");
            }
        }
    });
}

pub async fn process_due_automations(state: &AppState, now: DateTime<Utc>) -> ApiResult<usize> {
    if !state.app_server.is_ready() {
        return Ok(0);
    }
    let batch = state
        .store
        .claim_due_automation_runs(now, AUTOMATION_DUE_BATCH_LIMIT)
        .await?;
    let count = batch.runs.len();
    let mut first_error = None;
    for id in batch.updated_automation_ids {
        let result = async {
            let automation = state.store.get_automation(&id).await?;
            broadcast_automation_upsert(state, &automation).await
        }
        .await;
        if let Err(error) = result {
            first_error.get_or_insert(error);
        }
    }
    for run in batch.runs {
        if let Err(error) = admit(state, run).await {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(count), Err)
}

pub async fn run_now(state: &AppState, automation_id: &str) -> ApiResult<AutomationRun> {
    let run = state.store.create_automation_run_now(automation_id).await?;
    admit(state, run).await
}

async fn admit(state: &AppState, run: AutomationRun) -> ApiResult<AutomationRun> {
    broadcast_run_update(state, &run).await;
    // Capture the current prompt once for this new admission. Recovery never
    // reads it again and no second queue payload is stored in the run record.
    let automation = match state.store.get_automation(&run.automation_id).await {
        Ok(automation) => automation,
        Err(error) => {
            return change(
                state,
                &run,
                Phase::Rejected,
                None,
                None,
                Some(&error.to_string()),
            )
            .await
        }
    };
    if let Err(error) = activate_target(state, &run.target_thread_id).await {
        return change(
            state,
            &run,
            Phase::Rejected,
            None,
            None,
            Some(&format!("Target thread is not resumable: {error}")),
        )
        .await;
    }
    let input = vec![json!({"type":"text", "text":automation.prompt, "text_elements":[]})];
    let row = match queue_transfer::enqueue(state, &run.target_thread_id, input, run.id.clone())
        .await
    {
        Ok(row) => row,
        Err(error) => {
            let (phase, message) = if matches!(
                error,
                ApiError::BadRequest(_) | ApiError::NotFound(_) | ApiError::UnsupportedMediaType(_)
            ) {
                (
                    Phase::Rejected,
                    "Native admission was rejected before submission",
                )
            } else {
                (
                    Phase::Uncertain,
                    "Native admission was not confirmed; no automatic resubmission will occur",
                )
            };
            return change(state, &run, phase, None, None, Some(message)).await;
        }
    };
    let queued = change(state, &run, Phase::Queued, Some(&row.id), None, None).await?;
    start_if_idle(state, &queued).await
}

pub(super) async fn activate_target(state: &AppState, thread_id: &str) -> ApiResult<()> {
    app_server_api::client(&state.app_server)
        .activate_input_target(thread_id)
        .await?;
    Ok(())
}

pub(super) async fn start_if_idle(
    state: &AppState,
    run: &AutomationRun,
) -> ApiResult<AutomationRun> {
    if run.phase != Phase::Queued {
        return state.store.get_automation_run(&run.id).await;
    }
    let Some(queue_id) = run.native_queue_id.as_ref() else {
        return state.store.get_automation_run(&run.id).await;
    };
    let _guard = state.thread_input_locks.lock(&run.target_thread_id).await;
    let client = app_server_api::client(&state.app_server);
    // Active work remains native queued work. Unknown read state cannot
    // authorize a start or turn an acknowledged admission into a retry error.
    if !matches!(
        queue_transfer::active_turn(&client, &run.target_thread_id).await,
        Ok(None)
    ) {
        return state.store.get_automation_run(&run.id).await;
    }
    let Some(starting) = state
        .store
        .transition_automation_run(
            &run.id,
            Phase::Queued,
            Phase::StartRequested,
            None,
            None,
            None,
        )
        .await?
    else {
        return state.store.get_automation_run(&run.id).await;
    };
    match client
        .queue_start(run.target_thread_id.clone(), Some(queue_id.clone()))
        .await
    {
        Ok(ack) => {
            change(
                state,
                &starting,
                Phase::Dispatched,
                None,
                ack.payload
                    .pointer("/turn/id")
                    .and_then(serde_json::Value::as_str),
                None,
            )
            .await
        }
        Err(_) => {
            change(
                state,
                &starting,
                Phase::Uncertain,
                None,
                None,
                Some("Native start was not confirmed; no automatic retry will occur"),
            )
            .await
        }
    }
}

pub(super) async fn change(
    state: &AppState,
    run: &AutomationRun,
    next: Phase,
    queue_id: Option<&str>,
    turn_id: Option<&str>,
    error: Option<&str>,
) -> ApiResult<AutomationRun> {
    if let Some(changed) = state
        .store
        .transition_automation_run(&run.id, run.phase, next, queue_id, turn_id, error)
        .await?
    {
        broadcast_run_update(state, &changed).await;
        Ok(changed)
    } else {
        state.store.get_automation_run(&run.id).await
    }
}

pub async fn observe_user_receipt(
    state: &AppState,
    thread: &str,
    turn: &str,
    client: Option<&str>,
) -> ApiResult<()> {
    if let Some(run) = state
        .store
        .settle_automation_run_delivery(thread, turn, client)
        .await?
    {
        broadcast_run_update(state, &run).await;
    }
    Ok(())
}

pub async fn observe_removed(
    state: &AppState,
    thread: &str,
    native_queue_id: &str,
) -> ApiResult<()> {
    if let Some(run) = state
        .store
        .remove_automation_run(thread, native_queue_id)
        .await?
    {
        broadcast_run_update(state, &run).await;
    }
    Ok(())
}

pub async fn observe_queue_handoff_pending(
    state: &AppState,
    thread: &str,
    native_queue_id: &str,
) -> ApiResult<()> {
    if let Some(run) = state
        .store
        .mark_automation_run_handoff_pending(thread, native_queue_id)
        .await?
    {
        broadcast_run_update(state, &run).await;
    }
    Ok(())
}

pub async fn observe_promoted_receipt(
    state: &AppState,
    thread: &str,
    native_queue_id: &str,
    turn: &str,
) -> ApiResult<()> {
    if let Some(run) = state
        .store
        .settle_automation_run_promotion(thread, native_queue_id, turn)
        .await?
    {
        broadcast_run_update(state, &run).await;
    }
    Ok(())
}

async fn broadcast_run_update(state: &AppState, run: &AutomationRun) {
    let result: ApiResult<()> = async {
        let event = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some(run.target_thread_id.clone()),
                turn_id: None,
                item_id: None,
                kind: AUTOMATION_RUN_UPDATED_EVENT.into(),
                codex_method: None,
                payload: json!({"automationId":run.automation_id}),
            })
            .await?;
        let _ = state.events.send(event);
        if run.scheduled_for.is_some() {
            if let Ok(automation) = state.store.get_automation(&run.automation_id).await {
                broadcast_automation_upsert(state, &automation).await?;
            }
        }
        Ok(())
    }
    .await;
    if let Err(error) = result {
        tracing::warn!(%error, "automation run refill was not published");
    }
}

pub async fn broadcast_automation_upsert(
    state: &AppState,
    automation: &Automation,
) -> ApiResult<()> {
    let event = state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: Some(automation.target_thread_id.clone()),
            turn_id: None,
            item_id: None,
            kind: AUTOMATION_UPSERT_EVENT.to_string(),
            codex_method: None,
            payload: serde_json::to_value(automation_to_dto(automation.clone()))?,
        })
        .await?;
    let _ = state.events.send(event);
    Ok(())
}

pub async fn broadcast_automation_delete(state: &AppState, id: &str) -> ApiResult<()> {
    let event = state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: None,
            turn_id: None,
            item_id: None,
            kind: AUTOMATION_DELETE_EVENT.to_string(),
            codex_method: None,
            payload: json!({ "id": id }),
        })
        .await?;
    let _ = state.events.send(event);
    Ok(())
}
