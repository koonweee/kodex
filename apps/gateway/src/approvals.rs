use std::{
    collections::{BTreeSet, HashMap},
    sync::Arc,
};

use chrono::Utc;
use serde_json::{json, Value};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{
    api::AppState,
    app_server_api::ThreadTimelineSnapshot,
    error::{ApiError, ApiResult},
    events_synthetic::synthetic_event,
    routes::approvals::ApprovalListResponse,
    schema::validate_approval_response,
    store::{Approval, ApprovalSource, NewApproval, NewEvent},
    thread_view,
};

pub const APPROVAL_CHANGED_EVENT: &str = "approval.changed";

/// A projection of requests from this immutable app-server connection, never a
/// durable native approval authority. Local generated-app grants remain in Store.
#[derive(Clone)]
pub struct ApprovalService {
    runtime_id: Arc<str>,
    inner: Arc<Mutex<RequestMirror>>,
}

struct RequestMirror {
    requests: HashMap<String, Approval>,
    revision: i64,
    initialized: bool,
    available: bool,
}

impl ApprovalService {
    pub fn runtime_id(&self) -> &str {
        &self.runtime_id
    }
}

impl Default for ApprovalService {
    fn default() -> Self {
        Self {
            runtime_id: Uuid::new_v4().to_string().into(),
            inner: Arc::new(Mutex::new(RequestMirror {
                requests: HashMap::new(),
                revision: 0,
                initialized: false,
                available: true,
            })),
        }
    }
}

pub async fn initialize(state: &AppState) -> ApiResult<()> {
    let mut mirror = state.approvals.inner.lock().await;
    if !mirror.initialized {
        publish_change(state, &mut mirror, BTreeSet::new()).await?;
        mirror.initialized = true;
    }
    Ok(())
}

pub async fn receive_native(state: &AppState, request: NewApproval) -> ApiResult<Approval> {
    if !crate::schema::is_supported_approval_method(&request.method) {
        return Err(ApiError::BadRequest(
            "unsupported native approval method".into(),
        ));
    }
    let request_id = canonical_request_id(&serde_json::from_str(&request.request_id)?)?;
    let mut mirror = state.approvals.inner.lock().await;
    if !mirror.available {
        return Err(ApiError::AppServerUnavailable);
    }
    if let Some(existing) = mirror.requests.get(&request_id) {
        return Ok(existing.clone());
    }
    let affected = request.thread_id.iter().cloned().collect();
    let approval = Approval {
        id: Uuid::new_v4().to_string(),
        source: ApprovalSource::Native,
        request_id: request_id.clone(),
        thread_id: request.thread_id,
        turn_id: request.turn_id,
        item_id: request.item_id,
        method: request.method,
        status: "pending".into(),
        payload: request.payload,
        response: None,
        created_at: Utc::now(),
        resolved_at: None,
    };
    mirror.requests.insert(request_id, approval.clone());
    publish_change(state, &mut mirror, affected).await?;
    Ok(approval)
}

pub async fn resolve_native(state: &AppState, params: &Value) -> ApiResult<()> {
    let request_id = canonical_request_id(params.get("requestId").unwrap_or(&Value::Null))?;
    let thread_id = params
        .get("threadId")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadGateway("native request resolution has no threadId".into()))?;
    let mut mirror = state.approvals.inner.lock().await;
    let Some(approval) = mirror.requests.get_mut(&request_id) else {
        return Ok(());
    };
    if approval.thread_id.as_deref() != Some(thread_id)
        || matches!(approval.status.as_str(), "resolved" | "unavailable")
    {
        return Ok(());
    }
    approval.status = "resolved".into();
    approval.resolved_at = Some(Utc::now());
    // The notification does not say which client answered, nor which decision won.
    approval.payload = Value::Null;
    approval.response = None;
    publish_change(state, &mut mirror, BTreeSet::from([thread_id.to_string()])).await
}

pub async fn runtime_unavailable(state: &AppState) -> ApiResult<()> {
    let mut mirror = state.approvals.inner.lock().await;
    if !mirror.available {
        return Ok(());
    }
    mirror.available = false;
    let mut affected = BTreeSet::new();
    for approval in mirror
        .requests
        .values_mut()
        .filter(|approval| is_outstanding(approval))
    {
        approval.status = "unavailable".into();
        approval.payload = Value::Null;
        approval.response = None;
        affected.extend(approval.thread_id.clone());
    }
    publish_change(state, &mut mirror, affected).await
}

pub async fn create_local(state: &AppState, request: NewApproval) -> ApiResult<Approval> {
    let mut mirror = state.approvals.inner.lock().await;
    let approval = state.store.insert_approval(request).await?;
    publish_change(
        state,
        &mut mirror,
        approval.thread_id.iter().cloned().collect(),
    )
    .await?;
    Ok(approval)
}

pub async fn list_approvals(
    state: &AppState,
    status: Option<String>,
    thread_id: Option<String>,
) -> ApiResult<ApprovalListResponse> {
    let mirror = state.approvals.inner.lock().await;
    let mut approvals = state
        .store
        .list_approvals(
            Some(status.clone().unwrap_or_else(|| "pending".into())),
            thread_id.clone(),
        )
        .await?;
    approvals.extend(
        mirror
            .requests
            .values()
            .filter(|approval| {
                thread_id
                    .as_ref()
                    .is_none_or(|thread_id| approval.thread_id.as_ref() == Some(thread_id))
                    && status
                        .as_ref()
                        .is_none_or(|status| &approval.status == status)
            })
            .cloned(),
    );
    if status.is_none() {
        approvals.retain(is_outstanding);
    }
    approvals.sort_by_key(|approval| std::cmp::Reverse((approval.created_at, approval.id.clone())));
    Ok(ApprovalListResponse {
        runtime_id: state.approvals.runtime_id.to_string(),
        revision: mirror.revision,
        approvals,
    })
}

pub async fn get_approval(state: &AppState, id: &str) -> ApiResult<Approval> {
    let mirror = state.approvals.inner.lock().await;
    get_locked(state, &mirror, id).await
}

async fn get_locked(state: &AppState, mirror: &RequestMirror, id: &str) -> ApiResult<Approval> {
    match mirror.requests.values().find(|approval| approval.id == id) {
        Some(approval) => Ok(approval.clone()),
        None => state.store.get_approval(id).await,
    }
}

pub async fn decide_approval(state: &AppState, id: &str, decision: Value) -> ApiResult<Approval> {
    let mut mirror = state.approvals.inner.lock().await;
    let approval = get_locked(state, &mirror, id).await?;
    if approval.status != "pending" {
        return Err(ApiError::BadRequest(format!(
            "approval {id} is not pending"
        )));
    }
    validate_approval_response(&approval.method, &decision)?;
    let affected = approval.thread_id.iter().cloned().collect();
    if approval.source == ApprovalSource::GeneratedApp {
        let resolved = state.store.resolve_approval(id, decision).await?;
        publish_change(state, &mut mirror, affected).await?;
        return Ok(resolved);
    }
    if !mirror.available || !state.app_server.is_ready() {
        return Err(ApiError::AppServerUnavailable);
    }
    let entry = mirror
        .requests
        .get_mut(&approval.request_id)
        .expect("native approval is in mirror");
    entry.status = "responding".into();
    entry.response = Some(decision.clone());
    if let Err(error) = publish_change(state, &mut mirror, affected).await {
        // No native write has started. Unlike a pipe error, this is safe to retry.
        mirror
            .requests
            .insert(approval.request_id.clone(), approval);
        return Err(error);
    }
    drop(mirror);

    // This writes a JSON-RPC response, not a request with an acknowledgement.
    // Never hold the projection lock while writing: resolution may arrive first.
    state
        .app_server
        .respond(&approval.request_id, decision)
        .await?;
    get_approval(state, id).await
}

/// Keep the approval gate through projection hydration. A detail request cannot
/// copy an older list back over a native resolution that arrived in the meantime.
pub async fn hydrate_thread_view(
    state: &AppState,
    thread_id: &str,
) -> ApiResult<ThreadTimelineSnapshot> {
    let mirror = state.approvals.inner.lock().await;
    hydrate_locked(state, &mirror, thread_id).await
}

async fn hydrate_locked(
    state: &AppState,
    mirror: &RequestMirror,
    thread_id: &str,
) -> ApiResult<ThreadTimelineSnapshot> {
    let mut approvals = state
        .store
        .list_approvals(Some("pending".into()), Some(thread_id.to_string()))
        .await?;
    approvals.extend(
        mirror
            .requests
            .values()
            .filter(|approval| {
                approval.thread_id.as_deref() == Some(thread_id) && is_outstanding(approval)
            })
            .cloned(),
    );
    thread_view::record_pending_requests(
        &state.thread_views,
        thread_id,
        &approvals,
        mirror.revision,
    )
    .await
}

async fn publish_change(
    state: &AppState,
    mirror: &mut RequestMirror,
    affected: BTreeSet<String>,
) -> ApiResult<()> {
    let event = state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: None,
            turn_id: None,
            item_id: None,
            kind: APPROVAL_CHANGED_EVENT.into(),
            codex_method: None,
            payload: json!({"runtimeId":state.approvals.runtime_id.as_ref()}),
        })
        .await?;
    mirror.revision = event.seq;
    let _ = state.events.send(event);
    for thread_id in affected {
        // Each projection needs its own cursor so SSE does not discard it as a
        // duplicate of the global invalidation. Only the cursor is durable.
        let cursor = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some(thread_id.clone()),
                turn_id: None,
                item_id: None,
                kind: crate::events_replay::THREAD_VIEW_CURSOR_KIND.into(),
                codex_method: None,
                payload: json!({}),
            })
            .await?;
        mirror.revision = cursor.seq;
        hydrate_locked(state, mirror, &thread_id).await?;
        let patch =
            thread_view::lifecycle_patch_for_thread(&state.thread_views, &thread_id).await?;
        let _ = state.events.send(synthetic_event(
            cursor.seq,
            Some(thread_id),
            patch.active_turn_id.clone(),
            None,
            thread_view::THREAD_VIEW_PATCH_EVENT_KIND,
            None,
            patch,
        )?);
    }
    Ok(())
}

fn is_outstanding(approval: &Approval) -> bool {
    matches!(approval.status.as_str(), "pending" | "responding")
}

fn canonical_request_id(value: &Value) -> ApiResult<String> {
    if value.is_string() || value.as_i64().is_some() {
        Ok(value.to_string())
    } else {
        Err(ApiError::BadGateway(
            "native request ID must be a string or signed integer".into(),
        ))
    }
}

#[cfg(test)]
mod tests;
