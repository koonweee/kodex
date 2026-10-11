use super::{broadcast_run_update, change};
use crate::routes::{
    projects::settings_cwd,
    threads::{create_thread_payload, dated_chat_cwd, ThreadCreationOptions},
};
use crate::{
    api::AppState,
    app_server_api,
    error::{ApiError, ApiResult},
    store::{AutomationRun, AutomationRunPhase as Phase},
};
use serde_json::Value;

/// Called only for a newly claimed admission, never from restart recovery.
pub(super) async fn create_target(
    state: &AppState,
    run: AutomationRun,
) -> ApiResult<AutomationRun> {
    let new = run
        .new_thread
        .as_ref()
        .ok_or_else(|| ApiError::BadGateway("automation creation intent is missing".into()))?;
    let prepared = async {
        let cwd = match settings_cwd(state, new.project_id.as_deref(), new.cwd.clone()).await? {
            Some(cwd) => cwd,
            None => dated_chat_cwd(
                &state.config.projects.home_dir,
                "Chat",
                chrono::Local::now().date_naive(),
            )?,
        };
        let payload = create_thread_payload(&ThreadCreationOptions {
            model: new.model.clone(),
            effort: new.effort.clone(),
            service_tier: None,
            approval_policy: None,
            approvals_reviewer: None,
            permissions: None,
            sandbox: None,
            payload: Value::Null,
        })?;
        ApiResult::Ok((cwd, payload))
    }
    .await;
    let (cwd, payload) = match prepared {
        Ok(value) => value,
        Err(error) => {
            return change(
                state,
                &run,
                Phase::Rejected,
                None,
                None,
                Some(&format!("Chat creation was not submitted: {error}")),
            )
            .await
        }
    };
    let client = app_server_api::client(&state.app_server);
    let result = match &new.project_id {
        Some(project) => client.thread_start(project.clone(), cwd, payload).await,
        None => client.thread_start_in_cwd(cwd, payload).await,
    };
    let mut response = match result {
        Ok(response) => response,
        Err(_) => {
            return change(
                state,
                &run,
                Phase::Uncertain,
                None,
                None,
                Some("Chat creation was not confirmed; no automatic creation retry will occur"),
            )
            .await
        }
    };
    // Persist the native ID before another fallible operation or input write.
    let Some(bound) = state
        .store
        .bind_automation_run_thread(&run.id, &response.thread.id)
        .await?
    else {
        return state.store.get_automation_run(&run.id).await;
    };
    broadcast_run_update(state, &bound).await;
    let publication: ApiResult<()> = async {
        crate::read_state::catalog_changed(state, "thread/started", &response.thread.id).await?;
        crate::routes::threads::apply_thread_command_response_state(state, &mut response).await?;
        crate::routes::threads::broadcast_thread_upserted(
            state,
            if new.project_id.is_some() {
                crate::routes::threads::ThreadUpsertScope::Project
            } else {
                crate::routes::threads::ThreadUpsertScope::Chat
            },
            new.project_id.as_deref(),
            &response.thread,
        )
        .await?;
        Ok(())
    }
    .await;
    if let Err(error) = publication {
        tracing::warn!(%error, "automation chat catalog publication failed");
    }
    Ok(bound)
}
