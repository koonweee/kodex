use serde_json::Value;

use crate::{
    api::AppState,
    error::{ApiError, ApiResult},
    events,
    schema::validate_approval_response,
    store::{Approval, NewEvent},
    thread_view,
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
    if claimed.method == crate::routes::app_surfaces::APP_SURFACE_BRIDGE_APPROVAL_METHOD {
        let resolved = state.store.finish_approval_resolution(approval_id).await?;
        emit_resolved_approval(state, resolved).await
    } else {
        resolve_app_server_approval(state, approval_id, claimed).await
    }
}

async fn resolve_app_server_approval(
    state: &AppState,
    approval_id: &str,
    claimed: Approval,
) -> ApiResult<Approval> {
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
    emit_resolved_approval(state, resolved).await
}

async fn emit_resolved_approval(state: &AppState, resolved: Approval) -> ApiResult<Approval> {
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
    thread_view::record_approval_resolved(&state.thread_views, &resolved, event.seq).await?;
    let _ = state.events.send(event);
    if let Some(thread_id) = resolved.thread_id.as_deref() {
        let patch = thread_view::lifecycle_patch_for_thread(&state.thread_views, thread_id).await?;
        let patch = events::thread_view_patch_payload_event(state, patch).await?;
        let _ = state.events.send(patch);
    }
    Ok(resolved)
}
