use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};

use async_trait::async_trait;
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::{json, Value};
use tokio::{
    sync::Notify,
    time::{timeout, Duration},
};
use tower::ServiceExt;

use crate::{
    api::{build_router, AppState},
    app_server::{AppServer, InboundMessage},
    config::Config,
    error::{ApiError, ApiResult},
    events::ingest_inbound,
    store::Store,
};

const THREAD: &str = "native-history";
const ACTIVE_TURN: &str = "turn-latest";

fn user_item(id: &str, client_id: &str) -> Value {
    json!({
        "id": id, "type": "userMessage", "clientId": client_id,
        "content": [{"type": "text", "text": "Identical message 🧪"}]
    })
}

fn resume_response(active: bool, include_live_receipt: bool) -> Value {
    let mut active_items = vec![user_item("native-latest", "reused-client")];
    if include_live_receipt {
        active_items.push(user_item("native-live", "reused-client"));
    }
    json!({
        "thread": {
            "id": THREAD, "sessionId": "native-session", "cliVersion": "0.160.0",
            "cwd": "/workspace", "projectId": null, "ephemeral": false,
            "name": "Native history", "preview": "Identical message 🧪",
            "createdAt": 10, "updatedAt": 30, "source": "cli",
            "status": if active { json!({"type": "active", "activeFlags": []}) } else { json!({"type": "idle"}) },
            "modelProvider": "openai", "canAcceptDirectInput": true, "turns": []
        },
        "cwd": "/workspace", "model": "gpt-5.4", "modelProvider": "openai",
        "approvalPolicy": "never", "approvalsReviewer": "user",
        "sandbox": {"type": "dangerFullAccess"},
        "initialTurnsPage": {
            "data": [
                {"id": ACTIVE_TURN, "status": if active { "inProgress" } else { "completed" }, "startedAt": 30, "items": active_items},
                {"id": "turn-middle", "status": "completed", "startedAt": 20, "completedAt": 21,
                    "items": [user_item("native-middle", " opaque 客户端 ")]},
                {"id": "turn-oldest", "status": "completed", "startedAt": 10, "completedAt": 11,
                    "items": [user_item("native-oldest", "client-oldest")]}
            ],
            "nextCursor": "opaque:older/+==", "backwardsCursor": "opaque:newer/+=="
        }
    })
}

#[derive(Default)]
struct AttachNative {
    requests: Mutex<Vec<(String, Value)>>,
    resumes: AtomicUsize,
    persisted_pages: AtomicUsize,
    active: bool,
    hold_first: bool,
    first_started: Notify,
    release_first: Notify,
}

#[async_trait]
impl AppServer for AttachNative {
    fn is_ready(&self) -> bool {
        true
    }

    fn readiness_error(&self) -> Option<String> {
        None
    }

    async fn request(&self, method: &str, params: Value) -> ApiResult<Value> {
        self.requests
            .lock()
            .unwrap()
            .push((method.into(), params.clone()));
        match method {
            "thread/resume" => {
                let index = self.resumes.fetch_add(1, Ordering::SeqCst);
                let mut response = resume_response(self.active, index > 0);
                if self.active {
                    // Native 0.160 reconstructs active resume items with aliases;
                    // only the separate persisted page carries stable item IDs.
                    for (index, item) in response["initialTurnsPage"]["data"][0]["items"]
                        .as_array_mut()
                        .unwrap()
                        .iter_mut()
                        .enumerate()
                    {
                        item["id"] = json!(format!("item-{}", index + 1));
                    }
                    response["initialTurnsPage"]["nextCursor"] = json!("active-overlay-older");
                }
                Ok(response)
            }
            "thread/turns/list" if params["itemsView"] == "full" && self.active => {
                let index = self.persisted_pages.fetch_add(1, Ordering::SeqCst);
                let captured = resume_response(true, index > 0)["initialTurnsPage"].clone();
                if self.hold_first && index == 0 {
                    self.first_started.notify_one();
                    self.release_first.notified().await;
                }
                Ok(captured)
            }
            // Read-marker replacement is separate from transcript bootstrap.
            "thread/turns/list" if params["itemsView"] == "notLoaded" => Ok(json!({
                "data": [
                    {"id": ACTIVE_TURN, "status": if self.active { "inProgress" } else { "completed" }, "items": [], "itemsView": "notLoaded"},
                    {"id": "turn-middle", "status": "completed", "items": [], "itemsView": "notLoaded"},
                    {"id": "turn-oldest", "status": "completed", "items": [], "itemsView": "notLoaded"}
                ], "nextCursor": null, "backwardsCursor": null
            })),
            _ => Err(ApiError::BadGateway(format!(
                "unexpected native call: {method} {params}"
            ))),
        }
    }

    async fn respond(&self, _request_id: &str, _result: Value) -> ApiResult<()> {
        Err(ApiError::BadGateway("unexpected request response".into()))
    }
}

async fn state(active: bool, hold_first: bool) -> (AppState, Arc<AttachNative>) {
    let native = Arc::new(AttachNative {
        active,
        hold_first,
        ..Default::default()
    });
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    (state, native)
}

async fn attach(state: &AppState) -> (StatusCode, Value) {
    let response = build_router(state.clone())
        .oneshot(
            Request::post(format!("/v1/threads/{THREAD}/attach"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

fn user_rows(body: &Value) -> Vec<&Value> {
    body["timeline"]["rows"]
        .as_array()
        .expect("canonical timeline rows")
        .iter()
        .filter(|row| row["kind"] == "user_message")
        .map(|row| &row["item"])
        .collect()
}

fn assert_resume_bootstrap_calls(native: &AttachNative, expected_resumes: usize) {
    let calls = native.requests.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .filter(|(method, _)| method == "thread/resume")
            .count(),
        expected_resumes
    );
    assert_eq!(
        native.persisted_pages.load(Ordering::SeqCst),
        if native.active { expected_resumes } else { 0 },
        "each active rejoin needs exactly one stable-ID page; idle bootstrap uses its initial page"
    );
    for (method, params) in calls.iter() {
        match method.as_str() {
            "thread/resume" => assert_eq!(params, &json!({
                "threadId": THREAD, "excludeTurns": true,
                "initialTurnsPage": {"limit": 50, "sortDirection": "desc", "itemsView": "full"}
            })),
            "thread/turns/list" => {
                assert_eq!(params["threadId"], THREAD);
                if params["itemsView"] == "full" && native.active {
                    assert_eq!(params, &json!({
                        "threadId": THREAD, "cursor": null, "limit": 50,
                        "sortDirection": "desc", "itemsView": "full"
                    }));
                } else {
                    assert_eq!(params["itemsView"], "notLoaded", "read-state reconciliation uses bounded native headers");
                }
            }
            _ => panic!("bootstrap must not probe loaded state or fetch another transcript: {method} {params}"),
        }
    }
}

#[tokio::test]
async fn idle_native_attach_returns_chronological_resume_page_without_extra_history_reads() {
    let (state, native) = state(false, false).await;
    let (status, body) = attach(&state).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(
        body.get("disposition").is_none(),
        "attach must return the canonical view: {body}"
    );
    assert_eq!(body["thread"]["id"], THREAD);
    assert_eq!(body["thread"]["canAcceptDirectInput"], true);
    assert_eq!(body["liveState"], "idle");
    assert!(body["timeline"]["activeTurnId"].is_null());
    assert_eq!(
        body["timeline"]["turns"]
            .as_array()
            .unwrap()
            .iter()
            .map(|turn| turn["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["turn-oldest", "turn-middle", ACTIVE_TURN]
    );
    assert_eq!(body["historyPage"]["olderCursor"], "opaque:older/+==");
    assert_eq!(body["historyPage"]["newerCursor"], "opaque:newer/+==");
    assert_eq!(body["historyPage"]["hasOlder"], true);
    assert_eq!(body["historyPage"]["loadedTurnCount"], 3);
    let rows = user_rows(&body);
    assert_eq!(
        rows.iter()
            .map(|item| item["itemId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["native-oldest", "native-middle", "native-latest"]
    );
    assert_eq!(
        rows.iter()
            .map(|item| item["payload"]["clientId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["client-oldest", " opaque 客户端 ", "reused-client"]
    );
    for item in rows {
        assert_eq!(
            item["payload"]["item"]["content"][0]["text"],
            "Identical message 🧪"
        );
    }
    assert_resume_bootstrap_calls(&native, 1);
}

#[tokio::test]
async fn active_native_attach_uses_stable_page_ids_and_keeps_live_receipt_after_stale_page() {
    let (state, native) = state(true, true).await;
    let first_state = state.clone();
    let first = tokio::spawn(async move { attach(&first_state).await });
    timeout(Duration::from_secs(2), native.first_started.notified())
        .await
        .unwrap();

    ingest_inbound(InboundMessage::Notification {
        method: "item/completed".into(),
        params: json!({"threadId": THREAD, "turnId": ACTIVE_TURN, "item": user_item("native-live", "reused-client")}),
    }, &state).await.unwrap();
    let received_revision = state.store.latest_event_seq().await.unwrap();
    let second = attach(&state).await;
    native.release_first.notify_one();
    let first = timeout(Duration::from_secs(2), first)
        .await
        .unwrap()
        .unwrap();

    for (status, body) in [second, first] {
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["timeline"]["activeTurnId"], ACTIVE_TURN);
        assert_eq!(body["historyPage"]["olderCursor"], "opaque:older/+==");
        assert_eq!(body["historyPage"]["newerCursor"], "opaque:newer/+==");
        let rows = user_rows(&body);
        assert_eq!(
            rows.iter()
                .map(|item| item["itemId"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec![
                "native-oldest",
                "native-middle",
                "native-latest",
                "native-live"
            ]
        );
        assert_eq!(rows[2]["payload"]["clientId"], "reused-client");
        assert_eq!(rows[3]["payload"]["clientId"], "reused-client");
        assert!(body["timeline"]["viewRevision"].as_i64().unwrap() >= received_revision);
    }
    let current = state.thread_views.patch_for_thread(THREAD).await;
    assert_eq!(
        current
            .items
            .iter()
            .filter(|item| item.item_id == "native-live")
            .count(),
        1
    );
    assert_eq!(current.items.len(), 4);
    assert_resume_bootstrap_calls(&native, 2);
}

struct RejectedResumeNative {
    requests: Mutex<Vec<(String, Value)>>,
    resume_error: crate::app_server::JsonRpcError,
    readable: bool,
}

#[async_trait]
impl AppServer for RejectedResumeNative {
    fn is_ready(&self) -> bool {
        true
    }

    fn readiness_error(&self) -> Option<String> {
        None
    }

    async fn request(&self, method: &str, params: Value) -> ApiResult<Value> {
        self.requests.lock().unwrap().push((method.into(), params));
        match method {
            "thread/resume" => Err(ApiError::NativeRpc(self.resume_error.clone())),
            "thread/read" if self.readable => {
                let mut response = resume_response(false, false);
                response.as_object_mut().unwrap().remove("initialTurnsPage");
                Ok(json!({"thread": response["thread"]}))
            }
            "thread/read" => Err(ApiError::NativeRpc(crate::app_server::JsonRpcError {
                code: -32600, message: format!("thread not found: {THREAD}"), data: None,
            })),
            "thread/turns/list" => Err(ApiError::NativeRpc(crate::app_server::JsonRpcError {
                code: -32600, message: format!("thread {THREAD} is not materialized yet; thread/turns/list is unavailable before first user message"), data: None,
            })),
            _ => Err(ApiError::BadGateway(format!("unexpected native call: {method}"))),
        }
    }

    async fn respond(&self, _request_id: &str, _result: Value) -> ApiResult<()> {
        Err(ApiError::BadGateway("unexpected request response".into()))
    }
}

async fn rejected_resume_state(
    error: crate::app_server::JsonRpcError,
    readable: bool,
) -> (AppState, Arc<RejectedResumeNative>) {
    let native = Arc::new(RejectedResumeNative {
        requests: Mutex::default(),
        resume_error: error,
        readable,
    });
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    (state, native)
}

#[tokio::test]
async fn native_attach_reads_fresh_shell_only_after_exact_native_missing_rollout_rejection() {
    let (state, native) = rejected_resume_state(
        crate::app_server::JsonRpcError {
            code: -32600,
            message: format!("no rollout found for thread id {THREAD}"),
            data: Some(json!({"detail": "not materialized"})),
        },
        true,
    )
    .await;
    let (status, body) = attach(&state).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["thread"]["id"], THREAD);
    assert_eq!(body["thread"]["canAcceptDirectInput"], true);
    assert_eq!(body["liveState"], "idle");
    assert_eq!(body["timeline"]["rows"], json!([]));
    assert_eq!(body["historyPage"]["hasOlder"], false);
    assert!(body.get("disposition").is_none());
    let calls = native.requests.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .map(|(method, _)| method.as_str())
            .collect::<Vec<_>>(),
        vec![
            "thread/resume",
            "thread/read",
            "thread/turns/list",
            "thread/turns/list"
        ]
    );
    assert_eq!(
        calls[0].1,
        json!({
            "threadId": THREAD, "excludeTurns": true,
            "initialTurnsPage": {"limit": 50, "sortDirection": "desc", "itemsView": "full"}
        })
    );
    assert_eq!(
        calls[1].1,
        json!({"threadId": THREAD, "includeTurns": false})
    );
    assert_eq!(calls[2].1["itemsView"], "full");
    assert_eq!(calls[3].1["itemsView"], "notLoaded");
}

#[tokio::test]
async fn native_attach_cannot_fabricate_or_import_an_unknown_thread_after_missing_rollout() {
    let (state, native) = rejected_resume_state(
        crate::app_server::JsonRpcError {
            code: -32600,
            message: format!("no rollout found for thread id {THREAD}"),
            data: Some(json!({"detail": "not materialized"})),
        },
        false,
    )
    .await;
    let (status, body) = attach(&state).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{body}");
    assert_eq!(
        body["message"],
        format!("app-server error -32600: thread not found: {THREAD}")
    );
    assert!(body.get("thread").is_none());
    assert!(state.thread_views.live_state(THREAD).await.is_none());
    assert_eq!(
        native
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|(method, _)| method.clone())
            .collect::<Vec<_>>(),
        vec!["thread/resume", "thread/read"]
    );
}

#[tokio::test]
async fn native_attach_reports_the_exact_archived_resume_rejection_as_gone() {
    let (state, native) = rejected_resume_state(
        crate::app_server::JsonRpcError {
            code: -32600,
            message: format!(
                "session {THREAD} is archived. Run `codex unarchive {THREAD}` to unarchive it first."
            ),
            data: None,
        },
        true,
    )
    .await;

    let (status, body) = attach(&state).await;

    assert_eq!(status, StatusCode::GONE, "{body}");
    assert_eq!(body["code"], "thread_archived");
    assert_eq!(body["retryable"], false);
    assert_eq!(
        native
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|(method, _)| method.clone())
            .collect::<Vec<_>>(),
        vec!["thread/resume"]
    );
}

#[tokio::test]
async fn native_attach_does_not_hide_other_native_errors_with_history_fallback() {
    for error in [
        crate::app_server::JsonRpcError {
            code: -32601,
            message: "paginated_threads is not supported yet".into(),
            data: None,
        },
        crate::app_server::JsonRpcError {
            code: -32600,
            message: format!("no rollout found for thread id {THREAD}-other"),
            data: None,
        },
        crate::app_server::JsonRpcError {
            code: -32000,
            message: format!("upstream reported -32600: no rollout found for thread id {THREAD}"),
            data: None,
        },
        crate::app_server::JsonRpcError {
            code: -32600,
            message: format!(
                "session {THREAD}-other is archived. Run `codex unarchive {THREAD}-other` to unarchive it first."
            ),
            data: None,
        },
        crate::app_server::JsonRpcError {
            code: -32600,
            message: format!(
                "upstream: session {THREAD} is archived. Run `codex unarchive {THREAD}` to unarchive it first."
            ),
            data: None,
        },
        crate::app_server::JsonRpcError {
            code: -32000,
            message: format!(
                "session {THREAD} is archived. Run `codex unarchive {THREAD}` to unarchive it first."
            ),
            data: None,
        },
    ] {
        let (state, native) = rejected_resume_state(error.clone(), true).await;
        let (status, body) = attach(&state).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY, "{error:?}: {body}");
        assert_eq!(
            body["message"],
            format!("app-server error {}: {}", error.code, error.message)
        );
        assert!(state.thread_views.live_state(THREAD).await.is_none());
        let calls = native.requests.lock().unwrap();
        assert_eq!(
            calls.len(),
            1,
            "an unrelated rejection must not read or retry: {calls:?}"
        );
        assert_eq!(calls[0].0, "thread/resume");
    }
}
