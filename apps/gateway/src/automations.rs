use chrono::{DateTime, Utc};
use serde_json::json;
use tokio::time::{interval, Duration};

use crate::{
    api::AppState,
    app_server_api::{self, TurnStartOptions, UserInput},
    error::ApiResult,
    queue,
    routes::automations::automation_to_dto,
    skills,
    store::{Automation, NewEvent},
};

pub const AUTOMATION_UPSERT_EVENT: &str = "automation.item_upsert";
pub const AUTOMATION_DELETE_EVENT: &str = "automation.item_deleted";
pub const AUTOMATION_MIN_INTERVAL_SECONDS: i64 = 30;
const AUTOMATION_DUE_BATCH_LIMIT: i64 = 25;
const AUTOMATION_AUTO_PAUSE_FAILURES: i64 = 5;
const AUTOMATION_QUEUE_SOURCE_TYPE: &str = "automation";

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

pub async fn recover_automations_after_restart(state: &AppState) -> ApiResult<()> {
    let automations = state
        .store
        .recover_pending_automation_runs_after_restart(
            AUTOMATION_QUEUE_SOURCE_TYPE,
            AUTOMATION_AUTO_PAUSE_FAILURES,
        )
        .await?;
    for automation in automations {
        broadcast_automation_upsert(state, &automation).await?;
    }
    Ok(())
}

pub async fn process_due_automations(state: &AppState, now: DateTime<Utc>) -> ApiResult<usize> {
    if !state.app_server.is_ready() {
        return Ok(0);
    }

    let runs = state
        .store
        .claim_due_automation_runs(now, AUTOMATION_DUE_BATCH_LIMIT)
        .await?;
    let mut processed = 0;
    for run in runs {
        processed += 1;
        let automation = state.store.automation_for_run(&run.id).await?;
        if let Err(error) =
            resume_automation_target_thread(state, &automation.target_thread_id).await
        {
            let automation = state
                .store
                .mark_automation_run_failed(
                    &run.id,
                    format!("Target thread is not resumable: {error}"),
                    AUTOMATION_AUTO_PAUSE_FAILURES,
                )
                .await?;
            broadcast_automation_upsert(state, &automation).await?;
            continue;
        }
        let options = latest_thread_options(state, &automation.target_thread_id).await?;
        let input = vec![UserInput::Text {
            text: automation.prompt.clone(),
            text_elements: Vec::new(),
        }];
        let input =
            match skills::resolve_turn_input_for_thread(state, &automation.target_thread_id, input)
                .await
            {
                Ok(input) => input,
                Err(error) => {
                    let automation = state
                        .store
                        .mark_automation_run_failed(
                            &run.id,
                            error.to_string(),
                            AUTOMATION_AUTO_PAUSE_FAILURES,
                        )
                        .await?;
                    broadcast_automation_upsert(state, &automation).await?;
                    continue;
                }
            };

        match queue::create_queued_input_with_source(
            state,
            &automation.target_thread_id,
            input,
            options,
            Some(AUTOMATION_QUEUE_SOURCE_TYPE),
            Some(&run.id),
        )
        .await
        {
            Ok(queued_input) => {
                let automation = state
                    .store
                    .mark_automation_run_queued(&run.id, &queued_input.id)
                    .await?;
                broadcast_automation_upsert(state, &automation).await?;
            }
            Err(error) => {
                let automation = state
                    .store
                    .mark_automation_run_failed(
                        &run.id,
                        error.to_string(),
                        AUTOMATION_AUTO_PAUSE_FAILURES,
                    )
                    .await?;
                broadcast_automation_upsert(state, &automation).await?;
            }
        }
    }
    Ok(processed)
}

async fn resume_automation_target_thread(state: &AppState, thread_id: &str) -> ApiResult<()> {
    app_server_api::client(&state.app_server)
        .thread_resume(thread_id.to_string(), json!({}))
        .await?;
    Ok(())
}

async fn latest_thread_options(state: &AppState, thread_id: &str) -> ApiResult<TurnStartOptions> {
    let settings = state
        .store
        .thread_composer_settings(&[thread_id.to_string()])
        .await?;
    Ok(settings
        .get(thread_id)
        .map(|settings| settings.to_turn_options())
        .unwrap_or_default())
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
