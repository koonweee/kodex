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
    app_server_api,
    config::Config,
    error::{ApiError, ApiResult},
    events::ingest_inbound,
    store::Store,
    thread_view,
};

const THREAD: &str = "revert-chat";
const OLD_CURSOR: &str = "opaque:before-revert/+==";

#[derive(Default)]
struct RevertNative {
    requests: Mutex<Vec<(String, Value)>>,
    reverted: AtomicBool,
    hold_next: AtomicBool,
    started: Notify,
    release: Notify,
}

impl RevertNative {
    async fn capture(&self, payload: Value) -> Value {
        if self.hold_next.swap(false, Ordering::SeqCst) {
            self.started.notify_one();
            self.release.notified().await;
        }
        payload
    }
}

#[async_trait]
impl AppServer for RevertNative {
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
        let reverted = self.reverted.load(Ordering::SeqCst);
        match method {
            "thread/read" => Ok(json!({"thread": summary(reverted)})),
            "thread/resume" => Ok(self
                .capture(json!({
                    "thread": summary(reverted), "model":"native-model",
                    "initialTurnsPage": page(reverted),
                }))
                .await),
            "thread/turns/list" if params["itemsView"] == "notLoaded" => Ok(json!({
                "data":[], "nextCursor":null, "backwardsCursor":null,
            })),
            "thread/turns/list" if params["itemsView"] == "full" => {
                Ok(self.capture(page(reverted)).await)
            }
            "turn/start" => Ok(self
                .capture(json!({"turn":{
                    "id":if reverted { "new-turn" } else { "removed-turn" },
                    "status":"inProgress",
                }}))
                .await),
            _ => Err(ApiError::BadGateway(format!(
                "unexpected native request: {method} {params}"
            ))),
        }
    }

    async fn respond(&self, _request_id: &str, _result: Value) -> ApiResult<()> {
        Err(ApiError::BadGateway("unexpected native response".into()))
    }
}

fn summary(reverted: bool) -> Value {
    json!({
        "id":THREAD, "cwd":"/execution", "modelProvider":"openai",
        "name":if reverted { "After revert" } else { "Before revert" },
        "status":{"type":"idle"}, "createdAt":1, "updatedAt":2, "turns":[],
    })
}

fn page(reverted: bool) -> Value {
    let retained = json!({"id":"retained-turn", "status":"completed", "items":[{
        "id":"retained-item", "type":"userMessage", "clientId":"retained-client",
        "content":[{"type":"text", "text":"Keep this message"}],
    }]});
    let removed = json!({"id":"removed-turn", "status":"completed", "items":[
        {"id":"removed-item", "type":"userMessage", "clientId":"removed-client",
            "content":[{"type":"text", "text":"Removed message"}]},
        {"id":"removed-app", "type":"mcpToolCall", "server":"reverted", "tool":"render",
            "status":"completed", "mcpAppResourceUri":"ui://reverted/app",
            "arguments":{}, "result":{"content":[{"type":"text", "text":"Removed app"}]}, "error":null},
    ]});
    json!({
        "data":if reverted { vec![retained] } else { vec![removed, retained] },
        "nextCursor":if reverted { Value::Null } else { json!(OLD_CURSOR) },
        "backwardsCursor":if reverted { Value::Null } else { json!("obsolete-newer") },
    })
}

async fn state() -> (AppState, Arc<RevertNative>) {
    let native = Arc::new(RevertNative::default());
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    (state, native)
}

async fn request(
    state: &AppState,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let response = build_router(state.clone())
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

async fn seed_history(state: &AppState) {
    // Seed the canonical window before testing an overlapping native read.
    let detail = app_server_api::client(&state.app_server)
        .thread_read_history_window(THREAD.into(), 50)
        .await
        .unwrap();
    thread_view::build_thread_timeline_window(
        &state.thread_views,
        THREAD,
        &detail.turns,
        detail.history_page,
        0,
    )
    .await
    .unwrap();
}

async fn revert(state: &AppState, native: &RevertNative) {
    native.reverted.store(true, Ordering::SeqCst);
    ingest_inbound(
        InboundMessage::Notification {
            method: "thread/reverted".into(),
            params: json!({"threadId":THREAD}),
        },
        state,
    )
    .await
    .unwrap();
}

async fn assert_stale_read_fenced(method: &str, path: &str, seed: bool) {
    let (state, native) = state().await;
    if seed {
        seed_history(&state).await;
    }
    native.hold_next.store(true, Ordering::SeqCst);
    let old_state = state.clone();
    let method = method.to_string();
    let path = path.to_string();
    let pending = tokio::spawn(async move { request(&old_state, &method, &path, None).await });
    timeout(Duration::from_secs(2), native.started.notified())
        .await
        .unwrap();
    revert(&state, &native).await;
    native.release.notify_one();
    let (status, body) = timeout(Duration::from_secs(2), pending)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "a pre-revert response must not publish stale history or metadata: {body}"
    );
    assert!(body.get("thread").is_none());
    assert!(body.get("historyPage").is_none());
    assert!(
        native
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|(method, _)| !method.starts_with("mcp")),
        "history reads must not call MCP or import app surfaces"
    );
    assert!(state
        .store
        .latest_app_surface_session(THREAD)
        .await
        .unwrap()
        .is_none());

    let (status, fresh) = request(&state, "GET", &format!("/v1/threads/{THREAD}"), None).await;
    assert_eq!(status, StatusCode::OK, "{fresh}");
    assert_eq!(fresh["thread"]["name"], "After revert");
    assert_eq!(fresh["historyPage"]["hasOlder"], false);
    assert!(fresh["historyPage"]["olderCursor"].is_null());
    assert!(fresh["historyPage"]["newerCursor"].is_null());
    assert_eq!(
        fresh["timeline"]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["item"]["itemId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["retained-item"]
    );
}

#[tokio::test]
async fn native_revert_fences_a_detail_read_started_before_any_view_existed() {
    assert_stale_read_fenced("GET", &format!("/v1/threads/{THREAD}"), false).await;
}

#[tokio::test]
async fn native_revert_fences_an_attach_initial_page_with_tool_history() {
    assert_stale_read_fenced("POST", &format!("/v1/threads/{THREAD}/attach"), true).await;
}

#[tokio::test]
async fn native_revert_fences_an_older_page_and_discards_its_cursors() {
    assert_stale_read_fenced(
        "GET",
        &format!("/v1/threads/{THREAD}/timeline/pages?cursor=opaque%3Abefore-revert%2F%2B%3D%3D"),
        true,
    )
    .await;
}

#[tokio::test]
async fn native_revert_does_not_recreate_pending_input_from_a_late_accepted_ack() {
    let (state, native) = state().await;
    native.hold_next.store(true, Ordering::SeqCst);
    let old_state = state.clone();
    let pending = tokio::spawn(async move {
        request(&old_state, "POST", &format!("/v1/threads/{THREAD}/input"), Some(json!({
            "clientUserMessageId":"removed-client", "input":[{"type":"text", "text":"Accepted before revert"}],
        }))).await
    });
    timeout(Duration::from_secs(2), native.started.notified())
        .await
        .unwrap();
    revert(&state, &native).await;
    native.release.notify_one();
    let (status, ack) = timeout(Duration::from_secs(2), pending)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        status,
        StatusCode::OK,
        "native accepted input is not a retryable failure: {ack}"
    );
    assert_eq!(ack["payload"]["turn"]["id"], "removed-turn");
    let cleared = state.thread_views.patch_for_thread(THREAD).await;
    assert!(
        cleared.rows.unwrap().is_empty(),
        "late ACK recreated removed input"
    );
    assert!(cleared.active_turn_id.is_none());

    let (status, ack) = request(&state, "POST", &format!("/v1/threads/{THREAD}/input"), Some(json!({
        "clientUserMessageId":"new-client", "input":[{"type":"text", "text":"Submitted after revert"}],
    }))).await;
    assert_eq!(status, StatusCode::OK, "{ack}");
    assert_eq!(ack["payload"]["turn"]["id"], "new-turn");
    let current = serde_json::to_value(state.thread_views.patch_for_thread(THREAD).await).unwrap();
    let rows = current["rows"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["kind"] == "user_message")
        .collect::<Vec<_>>();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["item"]["payload"]["clientId"], "new-client");
    let calls = native.requests.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .map(|(method, params)| (
                method.as_str(),
                params["clientUserMessageId"].as_str().unwrap()
            ))
            .collect::<Vec<_>>(),
        vec![
            ("turn/start", "removed-client"),
            ("turn/start", "new-client")
        ]
    );
}
