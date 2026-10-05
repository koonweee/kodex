use std::sync::{
    atomic::{AtomicBool, Ordering},
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
    app_server_api::ThreadLiveState,
    config::Config,
    error::{ApiError, ApiResult},
    events::ingest_inbound,
    store::Store,
};

struct Native {
    status: Mutex<Value>,
    calls: Mutex<Vec<(String, Value)>>,
    hold_compact: AtomicBool,
    compact_entered: Notify,
    release_compact: Notify,
    compact_error: Mutex<Option<String>>,
}

impl Native {
    fn new(status: &str) -> Arc<Self> {
        Arc::new(Self {
            status: Mutex::new(json!({"type": status})),
            calls: Mutex::default(),
            hold_compact: AtomicBool::new(false),
            compact_entered: Notify::new(),
            release_compact: Notify::new(),
            compact_error: Mutex::default(),
        })
    }
}

#[async_trait]
impl AppServer for Native {
    fn is_ready(&self) -> bool {
        true
    }
    fn readiness_error(&self) -> Option<String> {
        None
    }

    async fn request(&self, method: &str, params: Value) -> ApiResult<Value> {
        self.calls.lock().unwrap().push((method.into(), params));
        match method {
            "thread/read" => Ok(json!({"thread": {
                "id":"native-chat", "cwd":"/workspace", "status":self.status.lock().unwrap().clone(),
                "createdAt":1, "updatedAt":2, "turns":[], "canAcceptDirectInput":true
            }})),
            "thread/compact/start" => {
                *self.status.lock().unwrap() = json!({"type":"active", "activeFlags":[]});
                self.compact_entered.notify_one();
                if self.hold_compact.load(Ordering::SeqCst) {
                    self.release_compact.notified().await;
                }
                if let Some(message) = self.compact_error.lock().unwrap().take() {
                    return Err(ApiError::BadGateway(message));
                }
                Ok(json!({}))
            }
            _ => Err(ApiError::BadGateway(format!(
                "unexpected native method {method}"
            ))),
        }
    }

    async fn respond(&self, _: &str, _: Value) -> ApiResult<()> {
        Ok(())
    }
}

async fn state(native: Arc<Native>) -> AppState {
    AppState::new(Config::default(), Store::in_memory().await.unwrap(), native)
}

async fn compact(state: AppState) -> (StatusCode, Value) {
    let response = build_router(state)
        .oneshot(
            Request::post("/v1/threads/native-chat/compact")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}

#[tokio::test]
async fn native_compaction_rejects_current_active_status_without_loading_history() {
    let native = Native::new("active");
    let state = state(native.clone()).await;
    let (status, body) = compact(state).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(
        *native.calls.lock().unwrap(),
        vec![(
            "thread/read".into(),
            json!({"threadId":"native-chat", "includeTurns":false})
        )]
    );
}

#[tokio::test]
async fn native_compaction_ack_does_not_fabricate_a_busy_projection_or_event() {
    let native = Native::new("idle");
    let state = state(native.clone()).await;
    let mut first = state.events.subscribe();
    let mut second = state.events.subscribe();
    let (status, body) = compact(state.clone()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, json!({"disposition":"started", "rawPayload":{}}));
    assert_eq!(
        *native.calls.lock().unwrap(),
        vec![
            (
                "thread/read".into(),
                json!({"threadId":"native-chat", "includeTurns":false})
            ),
            (
                "thread/compact/start".into(),
                json!({"threadId":"native-chat"})
            ),
        ]
    );
    assert_eq!(
        state
            .thread_views
            .patch_for_thread("native-chat")
            .await
            .live_state,
        ThreadLiveState::Idle
    );
    assert!(first.try_recv().is_err());
    assert!(second.try_recv().is_err());
}

#[tokio::test]
async fn native_compaction_waiting_request_rechecks_native_state_after_prior_ack() {
    let native = Native::new("idle");
    native.hold_compact.store(true, Ordering::SeqCst);
    let state = state(native.clone()).await;
    let first = tokio::spawn(compact(state.clone()));
    timeout(Duration::from_secs(1), native.compact_entered.notified())
        .await
        .unwrap();
    let mut second = tokio::spawn(compact(state));
    assert!(
        timeout(Duration::from_millis(50), &mut second)
            .await
            .is_err(),
        "second preflight must wait for the pending native command"
    );
    assert_eq!(native.calls.lock().unwrap().len(), 2);
    native.release_compact.notify_one();
    assert_eq!(first.await.unwrap().0, StatusCode::OK);
    assert_eq!(second.await.unwrap().0, StatusCode::CONFLICT);
    let calls = native.calls.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .map(|(method, _)| method.as_str())
            .collect::<Vec<_>>(),
        ["thread/read", "thread/compact/start", "thread/read"]
    );
}

#[tokio::test]
async fn native_compaction_late_ack_or_error_cannot_replace_native_completion() {
    for error in [None, Some("native compact request failed")] {
        let native = Native::new("idle");
        native.hold_compact.store(true, Ordering::SeqCst);
        *native.compact_error.lock().unwrap() = error.map(str::to_owned);
        let state = state(native.clone()).await;
        let command = tokio::spawn(compact(state.clone()));
        timeout(Duration::from_secs(1), native.compact_entered.notified())
            .await
            .unwrap();
        ingest_inbound(InboundMessage::Notification {
            method:"turn/completed".into(),
            params:json!({"threadId":"native-chat", "turn":{
                "id":"native-compaction", "status":"completed", "items":[], "itemsView":"notLoaded", "error":null
            }}),
        }, &state).await.unwrap();
        let completed = state.thread_views.patch_for_thread("native-chat").await;
        assert_eq!(completed.live_state, ThreadLiveState::Idle);
        native.release_compact.notify_one();
        let (status, _) = command.await.unwrap();
        assert_eq!(
            status,
            if error.is_some() {
                StatusCode::BAD_GATEWAY
            } else {
                StatusCode::OK
            }
        );
        assert_eq!(
            serde_json::to_value(state.thread_views.patch_for_thread("native-chat").await).unwrap(),
            serde_json::to_value(completed).unwrap()
        );
        assert_eq!(
            native.calls.lock().unwrap().len(),
            2,
            "no retry or completion-time native history read"
        );
    }
}

#[tokio::test]
async fn native_compaction_unknown_status_cannot_authorize_a_native_mutation() {
    let native = Native::new("unrecognized");
    let (status, _) = compact(state(native.clone()).await).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(native.calls.lock().unwrap().len(), 1);
}
