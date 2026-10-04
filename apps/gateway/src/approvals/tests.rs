use std::sync::{atomic::Ordering, Arc};

use axum::extract::{Query, State};
use serde_json::{json, Value};

use crate::{
    api::AppState,
    app_server::{tests::RecordingAppServer, InboundMessage},
    config::Config,
    events::ingest_inbound,
    routes::approvals::{list_approvals, ApprovalListQuery},
    store::Store,
};

async fn state() -> (AppState, Arc<RecordingAppServer>) {
    let server = Arc::new(RecordingAppServer::default());
    server.ready.store(true, Ordering::SeqCst);
    (
        AppState::new(
            Config::default(),
            Store::in_memory().await.unwrap(),
            server.clone(),
        ),
        server,
    )
}

async fn request(state: &AppState, id: &str) {
    ingest_inbound(InboundMessage::ServerRequest {
        request_id: id.to_string(),
        method: "item/commandExecution/requestApproval".to_string(),
        params: json!({"threadId":"thread-1", "turnId":"turn-1", "itemId":"item-1", "command":"printf proof"}),
    }, state).await.unwrap();
}

async fn snapshot(state: &AppState) -> Value {
    serde_json::to_value(
        list_approvals(
            State(state.clone()),
            Query(ApprovalListQuery {
                status: None,
                thread_id: None,
            }),
        )
        .await
        .unwrap()
        .0,
    )
    .unwrap()
}

#[tokio::test]
async fn startup_is_initialized_only_after_the_runtime_marker_is_saved() {
    let (state, _) = state().await;
    sqlx::query("create trigger reject_runtime_marker before insert on events begin select raise(abort, 'fixture rejects event'); end")
        .execute(state.store.pool()).await.unwrap();
    assert!(super::initialize(&state).await.is_err());
    sqlx::query("drop trigger reject_runtime_marker")
        .execute(state.store.pool())
        .await
        .unwrap();
    super::initialize(&state).await.unwrap();
    assert!(snapshot(&state).await["revision"].as_i64().unwrap() > 0);
    let marker_count = state
        .store
        .replay_events(None, None, None)
        .await
        .unwrap()
        .len();
    super::initialize(&state).await.unwrap();
    assert_eq!(
        state
            .store
            .replay_events(None, None, None)
            .await
            .unwrap()
            .len(),
        marker_count
    );
}

#[tokio::test]
async fn native_replay_keeps_one_public_approval() {
    let (state, _) = state().await;
    request(&state, "0").await;
    let initial = snapshot(&state).await;
    request(&state, "0").await;
    let replayed = snapshot(&state).await;
    assert_eq!(replayed["approvals"].as_array().unwrap().len(), 1);
    assert_eq!(
        initial["approvals"][0]["id"],
        replayed["approvals"][0]["id"]
    );
}

#[tokio::test]
async fn successful_response_write_waits_for_native_resolution() {
    let (state, server) = state().await;
    request(&state, "0").await;
    let initial = snapshot(&state).await;
    let id = initial["approvals"][0]["id"].as_str().unwrap();
    let response = super::decide_approval(&state, id, json!({"decision":"accept"}))
        .await
        .unwrap();
    assert_eq!(response.status, "responding");
    assert_eq!(server.responses.lock().unwrap().len(), 1);
    request(&state, "0").await;
    assert_eq!(
        snapshot(&state).await["approvals"][0]["status"],
        "responding"
    );
    ingest_inbound(
        InboundMessage::Notification {
            method: "serverRequest/resolved".to_string(),
            params: json!({"threadId":"thread-1", "requestId":0}),
        },
        &state,
    )
    .await
    .unwrap();
    assert!(snapshot(&state).await["approvals"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn external_native_resolution_retires_the_request_without_a_local_decision() {
    let (state, server) = state().await;
    request(&state, "\"0\"").await;
    let pending = snapshot(&state).await;
    let id = pending["approvals"][0]["id"].as_str().unwrap();
    ingest_inbound(
        InboundMessage::Notification {
            method: "serverRequest/resolved".to_string(),
            params: json!({"threadId":"thread-1", "requestId":"0"}),
        },
        &state,
    )
    .await
    .unwrap();
    assert!(snapshot(&state).await["approvals"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(server.responses.lock().unwrap().is_empty());
    let closed = super::get_approval(&state, id).await.unwrap();
    assert_eq!(closed.status, "resolved");
    assert!(closed.payload.is_null());
    assert!(closed.response.is_none());
}

#[tokio::test]
async fn native_requests_are_not_saved_as_approval_rows_or_replay_payloads() {
    let (state, _) = state().await;
    request(&state, "0").await;
    assert!(state
        .store
        .list_approvals(None, None)
        .await
        .unwrap()
        .is_empty());
    let events = state.store.replay_events(None, None, None).await.unwrap();
    assert!(events
        .iter()
        .all(|event| !event.payload.to_string().contains("printf proof")));
    let snapshot = snapshot(&state).await;
    assert!(snapshot["runtimeId"].is_string());
    assert!(snapshot["revision"].as_i64().unwrap() > 0);
}

#[tokio::test]
async fn native_ids_preserve_json_type_and_resolution_scope() {
    let (state, _) = state().await;
    request(&state, "0").await;
    request(&state, "\"0\"").await;
    super::resolve_native(&state, &json!({"requestId":0,"threadId":"wrong-thread"}))
        .await
        .unwrap();
    assert_eq!(
        snapshot(&state).await["approvals"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    super::resolve_native(&state, &json!({"requestId":0,"threadId":"thread-1"}))
        .await
        .unwrap();
    let remaining = snapshot(&state).await;
    assert_eq!(remaining["approvals"].as_array().unwrap().len(), 1);
    assert_eq!(remaining["approvals"][0]["requestId"], "\"0\"");
    request(&state, "0").await;
    assert_eq!(
        snapshot(&state).await["approvals"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

fn local_request() -> crate::store::NewApproval {
    crate::store::NewApproval {
        request_id: "local-grant".into(),
        thread_id: Some("thread-1".into()),
        turn_id: None,
        item_id: None,
        method: crate::routes::app_surfaces::APP_SURFACE_BRIDGE_APPROVAL_METHOD.into(),
        payload: json!({"sessionId":"surface-1", "revision":1, "server":"docs", "tool":"lookup"}),
    }
}

#[tokio::test]
async fn restart_and_disconnect_invalidate_native_ids_but_preserve_local_grants() {
    let (state, server) = state().await;
    super::initialize(&state).await.unwrap();
    let local = super::create_local(&state, local_request()).await.unwrap();
    request(&state, "0").await;
    let before = snapshot(&state).await;
    let old = before["approvals"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["source"] == "native")
        .unwrap();
    let old_id = old["id"].as_str().unwrap().to_string();
    ingest_inbound(InboundMessage::Disconnected, &state)
        .await
        .unwrap();
    let after = snapshot(&state).await;
    assert_eq!(after["approvals"].as_array().unwrap().len(), 1);
    assert_eq!(after["approvals"][0]["id"], local.id);
    assert!(after["revision"].as_i64() > before["revision"].as_i64());
    let unavailable = super::get_approval(&state, &old_id).await.unwrap();
    assert_eq!(unavailable.status, "unavailable");
    assert!(unavailable.payload.is_null());
    assert!(unavailable.response.is_none());
    assert!(
        super::decide_approval(&state, &old_id, json!({"decision":"accept"}))
            .await
            .is_err()
    );
    let hydrated = super::hydrate_thread_view(&state, "thread-1")
        .await
        .unwrap();
    assert_eq!(hydrated.pending_approval_requests.len(), 1);
    assert_eq!(hydrated.pending_approval_requests[0].id, local.id);

    let next = AppState::new(Config::default(), state.store.clone(), server.clone());
    super::initialize(&next).await.unwrap();
    request(&next, "0").await;
    let fresh = snapshot(&next).await;
    assert_ne!(fresh["runtimeId"], before["runtimeId"]);
    assert!(fresh["revision"].as_i64() > after["revision"].as_i64());
    assert!(super::get_approval(&next, &old_id).await.is_err());
    assert!(fresh["approvals"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["id"] != old_id));
    assert!(server.responses.lock().unwrap().is_empty());
}

#[tokio::test]
async fn only_local_grants_can_be_stored_and_native_resolution_cannot_grant_them() {
    let (state, server) = state().await;
    let mut native = local_request();
    native.method = "item/commandExecution/requestApproval".into();
    assert!(state.store.insert_approval(native).await.is_err());
    ingest_inbound(
        InboundMessage::ServerRequest {
            request_id: "0".into(),
            method: crate::routes::app_surfaces::APP_SURFACE_BRIDGE_APPROVAL_METHOD.into(),
            params: json!({"threadId":"thread-1"}),
        },
        &state,
    )
    .await
    .unwrap();
    assert_eq!(server.error_responses.lock().unwrap()[0].1.code, -32601);
    assert!(snapshot(&state).await["approvals"]
        .as_array()
        .unwrap()
        .is_empty());
    let local = super::create_local(&state, local_request()).await.unwrap();
    super::resolve_native(
        &state,
        &json!({"threadId":"thread-1","requestId":"local-grant"}),
    )
    .await
    .unwrap();
    assert_eq!(
        super::get_approval(&state, &local.id).await.unwrap().status,
        "pending"
    );
    let resolved = super::decide_approval(&state, &local.id, json!({"decision":"accept"}))
        .await
        .unwrap();
    assert_eq!(resolved.source, crate::store::ApprovalSource::GeneratedApp);
    assert_eq!(resolved.status, "resolved");
    assert_eq!(
        state.store.get_approval(&local.id).await.unwrap().response,
        Some(json!({"decision":"accept"}))
    );
    assert!(snapshot(&state).await["approvals"]
        .as_array()
        .unwrap()
        .is_empty());
    let closed = super::list_approvals(&state, Some("resolved".into()), None)
        .await
        .unwrap();
    assert_eq!(closed.approvals.len(), 1);
    assert_eq!(closed.approvals[0].id, local.id);
    assert!(server.responses.lock().unwrap().is_empty());
}

#[tokio::test]
async fn local_grant_decision_has_one_atomic_database_winner() {
    let (state, _) = state().await;
    let local = super::create_local(&state, local_request()).await.unwrap();
    let (first, second) = tokio::join!(
        state
            .store
            .resolve_approval(&local.id, json!({"decision":"accept"})),
        state
            .store
            .resolve_approval(&local.id, json!({"decision":"decline"})),
    );
    assert_ne!(first.is_ok(), second.is_ok());
    let winner = first.or(second).unwrap();
    let stored = state.store.get_approval(&local.id).await.unwrap();
    assert_eq!(stored.status, "resolved");
    assert_eq!(stored.response, winner.response);
}

#[derive(Default)]
struct ControlledResponseServer {
    calls: std::sync::atomic::AtomicUsize,
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
    fail: bool,
}

#[async_trait::async_trait]
impl crate::app_server::AppServer for ControlledResponseServer {
    fn is_ready(&self) -> bool {
        true
    }
    fn readiness_error(&self) -> Option<String> {
        None
    }
    async fn request(&self, _method: &str, _params: Value) -> crate::error::ApiResult<Value> {
        Err(crate::error::ApiError::AppServerUnavailable)
    }
    async fn respond(&self, _id: &str, _result: Value) -> crate::error::ApiResult<()> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_one();
        self.release.notified().await;
        if self.fail {
            Err(crate::error::ApiError::AppServerUnavailable)
        } else {
            Ok(())
        }
    }
}

async fn claimed_response(
    fail: bool,
) -> (
    AppState,
    Arc<ControlledResponseServer>,
    String,
    tokio::task::JoinHandle<crate::error::ApiResult<crate::store::Approval>>,
) {
    let server = Arc::new(ControlledResponseServer {
        fail,
        ..Default::default()
    });
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        server.clone(),
    );
    request(&state, "0").await;
    let id = snapshot(&state).await["approvals"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let task = tokio::spawn({
        let state = state.clone();
        let id = id.clone();
        async move { super::decide_approval(&state, &id, json!({"decision":"accept"})).await }
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), server.entered.notified())
        .await
        .unwrap();
    (state, server, id, task)
}

#[tokio::test]
async fn concurrent_decisions_and_early_native_resolution_send_only_once() {
    let (state, server, id, task) = claimed_response(false).await;
    assert!(
        super::decide_approval(&state, &id, json!({"decision":"decline"}))
            .await
            .is_err()
    );
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        super::resolve_native(&state, &json!({"requestId":0,"threadId":"thread-1"})),
    )
    .await
    .unwrap()
    .unwrap();
    server.release.notify_one();
    let response = task.await.unwrap().unwrap();
    assert_eq!(response.status, "resolved");
    assert_eq!(response.response, None);
    assert_eq!(server.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn ambiguous_write_failure_is_not_retried_or_reset_by_replay() {
    let (state, server, id, task) = claimed_response(true).await;
    server.release.notify_one();
    assert!(task.await.unwrap().is_err());
    request(&state, "0").await;
    assert_eq!(
        super::get_approval(&state, &id).await.unwrap().status,
        "responding"
    );
    assert!(
        super::decide_approval(&state, &id, json!({"decision":"accept"}))
            .await
            .is_err()
    );
    assert_eq!(server.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn failed_publication_before_native_write_keeps_the_request_answerable() {
    let (state, server) = state().await;
    request(&state, "0").await;
    let pending = snapshot(&state).await;
    let id = pending["approvals"][0]["id"].as_str().unwrap();
    sqlx::query("create trigger reject_approval_event before insert on events begin select raise(abort, 'fixture rejects event'); end")
        .execute(state.store.pool()).await.unwrap();
    assert!(
        super::decide_approval(&state, id, json!({"decision":"accept"}))
            .await
            .is_err()
    );
    assert!(server.responses.lock().unwrap().is_empty());
    let retained = super::get_approval(&state, id).await.unwrap();
    assert_eq!(retained.status, "pending");
    assert!(retained.response.is_none());
    sqlx::query("drop trigger reject_approval_event")
        .execute(state.store.pool())
        .await
        .unwrap();
    let submitted = super::decide_approval(&state, id, json!({"decision":"accept"}))
        .await
        .unwrap();
    assert_eq!(submitted.status, "responding");
    assert_eq!(server.responses.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn hydration_and_resolution_share_one_gate_and_advance_the_snapshot() {
    let (state, _) = state().await;
    request(&state, "0").await;
    let gate = state.approvals.inner.lock().await;
    let hydrate = tokio::spawn({
        let state = state.clone();
        async move {
            super::hydrate_thread_view(&state, "thread-1")
                .await
                .unwrap()
        }
    });
    tokio::task::yield_now().await;
    let resolve = tokio::spawn({
        let state = state.clone();
        async move {
            super::resolve_native(&state, &json!({"requestId":0,"threadId":"thread-1"}))
                .await
                .unwrap()
        }
    });
    tokio::task::yield_now().await;
    assert!(!hydrate.is_finished());
    assert!(!resolve.is_finished());
    drop(gate);
    let older = hydrate.await.unwrap();
    resolve.await.unwrap();
    let current = super::hydrate_thread_view(&state, "thread-1")
        .await
        .unwrap();
    assert_eq!(older.pending_approval_requests.len(), 1);
    assert!(current.pending_approval_requests.is_empty());
    assert!(current.view_revision > older.view_revision);
    assert!(super::list_approvals(&state, None, None)
        .await
        .unwrap()
        .approvals
        .is_empty());
}

#[tokio::test]
async fn lagged_sse_invalidates_the_approval_snapshot_at_the_existing_cursor() {
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    let (mut state, _) = state().await;
    state.events = tokio::sync::broadcast::channel(2).0;
    super::initialize(&state).await.unwrap();
    let before = snapshot(&state).await;
    let response = crate::build_router(state.clone())
        .oneshot(
            Request::get("/v1/events?includeGlobal=true")
                .header("accept", "text/event-stream")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    request(&state, "0").await;
    super::resolve_native(&state, &json!({"requestId":0,"threadId":"thread-1"}))
        .await
        .unwrap();
    let mut body = response.into_body();
    let frame = tokio::time::timeout(std::time::Duration::from_secs(2), body.frame())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .into_data()
        .unwrap();
    let frame = std::str::from_utf8(&frame).unwrap();
    let data = frame
        .lines()
        .find_map(|line| line.strip_prefix("data: "))
        .unwrap();
    let event: Value = serde_json::from_str(data).unwrap();
    assert_eq!(event["kind"], "approval.changed");
    assert_eq!(event["seq"], before["revision"]);
    assert_eq!(event["payload"], json!({"runtimeId":before["runtimeId"]}));
    let refreshed = snapshot(&state).await;
    assert!(refreshed["approvals"].as_array().unwrap().is_empty());
    assert!(refreshed["revision"].as_i64() > before["revision"].as_i64());
}
