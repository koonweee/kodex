use serde_json::Value;

use crate::{
    api::AppState,
    error::{ApiError, ApiResult},
    events,
    schema::validate_approval_response,
    store::{Approval, NewEvent},
    thread_session_view,
};

pub async fn decide_approval(
    state: &AppState,
    approval_id: &str,
    decision: Value,
) -> ApiResult<Approval> {
    let approval = state.store.get_approval(approval_id).await?;
    if approval.status != "pending" {
        return Err(ApiError::BadRequest(format!(
            "approval {approval_id} is not pending"
        )));
    }
    validate_approval_response(&approval.method, &decision)?;

    let claimed = state
        .store
        .claim_approval_resolution(approval_id, decision)
        .await?;
    let decision = claimed.response.clone().unwrap_or(Value::Null);
    if let Err(error) = state
        .app_server
        .respond(&claimed.request_id, decision)
        .await
    {
        let _ = state.store.reset_approval_resolution(approval_id).await;
        return Err(error);
    }
    let resolved = state.store.finish_approval_resolution(approval_id).await?;
    let event = state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: resolved.thread_id.clone(),
            turn_id: resolved.turn_id.clone(),
            item_id: resolved.item_id.clone(),
            kind: "approval.resolved".to_string(),
            codex_method: Some(resolved.method.clone()),
            payload: serde_json::to_value(&resolved)?,
        })
        .await?;
    thread_session_view::record_approval_resolved(&state.thread_sessions, &resolved, event.seq)
        .await?;
    let _ = state.events.send(event);
    if let Some(thread_id) = resolved.thread_id.as_deref() {
        let patch = events::thread_session_view_patch_event(state, thread_id).await?;
        let _ = state.events.send(patch);
    }
    Ok(resolved)
}
