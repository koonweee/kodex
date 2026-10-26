use super::turns::TurnStartRequest;
use crate::{
    api::AppState,
    app_server_api::{self, CodexClient, RawAppServerResponse, TurnStartOptions, UserInput},
    error::ApiResult,
    turn_lifecycle,
};

pub(super) async fn start_turn_with_admission(
    state: &AppState,
    thread_id: String,
    request: TurnStartRequest,
    resume_missing_thread: bool,
    admission_revision: Option<i64>,
) -> ApiResult<RawAppServerResponse> {
    let _guard = state.thread_input_locks.lock(&thread_id).await;
    start_turn_locked(
        state,
        thread_id,
        request,
        resume_missing_thread,
        admission_revision,
    )
    .await
}

pub(super) async fn start_turn_with_resume_policy(
    state: &AppState,
    thread_id: String,
    request: TurnStartRequest,
    resume_missing_thread: bool,
) -> ApiResult<RawAppServerResponse> {
    start_turn_with_admission(state, thread_id, request, resume_missing_thread, None).await
}

pub(super) async fn start_turn_locked(
    state: &AppState,
    thread_id: String,
    request: TurnStartRequest,
    resume_missing_thread: bool,
    admission_revision: Option<i64>,
) -> ApiResult<RawAppServerResponse> {
    request.options.validate()?;
    let client_id = request
        .client_user_message_id
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let attachments =
        app_server_api::validate_file_attachments_for_thread(&thread_id, request.attachments)?;
    let input = app_server_api::append_file_attachment_envelope(request.input, &attachments);
    let submission_revision = state.store.latest_event_seq().await?;
    let response = if resume_missing_thread {
        turn_start_resuming_missing_thread_once(
            state,
            &thread_id,
            input.clone(),
            request.options.clone(),
            client_id.clone(),
            admission_revision,
        )
        .await?
    } else {
        ensure_input_admission(state, &thread_id, admission_revision).await?;
        // Ephemeral forks cannot be resumed. The route captures this policy
        // before awaits so native close cannot turn it into a durable resume.
        app_server_api::client(&state.app_server)
            .turn_start(
                thread_id.clone(),
                input.clone(),
                request.options.clone(),
                Some(client_id.clone()),
            )
            .await?
    };
    if let Some(turn_id) = turn_lifecycle::pending_projection_turn_id(&response.payload) {
        turn_lifecycle::record_pending_user_projection(
            state,
            &thread_id,
            &turn_id,
            &client_id,
            &input,
            &attachments,
            submission_revision,
        )
        .await?;
    }
    Ok(response)
}

async fn turn_start_resuming_missing_thread_once(
    state: &AppState,
    thread_id: &str,
    input: Vec<UserInput>,
    options: TurnStartOptions,
    client_id: String,
    admission_revision: Option<i64>,
) -> ApiResult<RawAppServerResponse> {
    let client = app_server_api::client(&state.app_server);
    ensure_input_admission(state, thread_id, admission_revision).await?;
    match client
        .turn_start(
            thread_id.to_string(),
            input.clone(),
            options.clone(),
            Some(client_id.clone()),
        )
        .await
    {
        Ok(response) => Ok(response),
        Err(error) if app_server_api::is_thread_not_loaded_error(&error, thread_id) => {
            ensure_input_admission(state, thread_id, admission_revision).await?;
            resume_thread_for_turn_start(state, &client, thread_id).await?;
            ensure_input_admission(state, thread_id, admission_revision).await?;
            client
                .turn_start(thread_id.to_string(), input, options, Some(client_id))
                .await
        }
        Err(error) => Err(error),
    }
}

async fn resume_thread_for_turn_start(
    state: &AppState,
    client: &CodexClient,
    thread_id: &str,
) -> ApiResult<()> {
    tracing::info!(
        thread_id,
        "turn/start reported missing thread; resuming thread before retry"
    );
    let mut response = client
        .thread_resume(thread_id.to_string(), serde_json::json!({}))
        .await?;
    super::threads::apply_thread_command_response_state(state, &mut response).await
}

async fn ensure_input_admission(
    state: &AppState,
    thread_id: &str,
    revision: Option<i64>,
) -> ApiResult<()> {
    if let Some(revision) = revision {
        state
            .thread_views
            .ensure_history_current(thread_id, revision)
            .await?;
    }
    Ok(())
}
