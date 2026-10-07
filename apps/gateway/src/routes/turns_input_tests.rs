use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::{json, Value};
use tower::ServiceExt;

use crate::{
    api::{build_router, AppState},
    app_server::AppServer,
    config::Config,
    error::{ApiError, ApiResult},
    store::Store,
};

const THREAD: &str = "send-queue-chat";
#[derive(Default)]
struct NativeInput {
    requests: Mutex<Vec<(String, Value)>>,
    queue: Mutex<Vec<Value>>,
    fail_read: bool,
    fail_add: bool,
}
#[async_trait]
impl AppServer for NativeInput {
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
            "thread/queue/list" if self.fail_read => {
                Err(ApiError::BadGateway("native queue unavailable".into()))
            }
            "thread/queue/list" => Ok(
                json!({"data":self.queue.lock().unwrap().iter().take(1).cloned().collect::<Vec<_>>(),"nextCursor":null}),
            ),
            "thread/read" => Ok(
                json!({"thread":{"id":THREAD,"cwd":"/fixture","createdAt":1,"updatedAt":1,
                "status":{"type":"active","activeFlags":[]},"canAcceptDirectInput":true}}),
            ),
            "thread/queue/add" if self.fail_add => {
                Err(ApiError::BadGateway("acknowledgment lost".into()))
            }
            "thread/queue/add" => {
                let mut rows = self.queue.lock().unwrap();
                let row = json!({"id":format!("queued-{}",rows.len()+1),"input":params["input"],"clientUserMessageId":params["clientUserMessageId"]});
                rows.push(row.clone());
                Ok(json!({"queuedSubmission":row}))
            }
            "turn/start" => Ok(json!({"turn":{"id":"active-native-turn","status":"inProgress"}})),
            _ => Err(ApiError::BadGateway(format!("unexpected method {method}"))),
        }
    }
    async fn respond(&self, _id: &str, _value: Value) -> ApiResult<()> {
        unreachable!()
    }
}
fn existing_row() -> Value {
    json!({"id":"older-queued","input":[{"type":"text","text":"Older queued work"}],"clientUserMessageId":"older-attempt"})
}
async fn state(native: Arc<NativeInput>) -> AppState {
    AppState::new(Config::default(), Store::in_memory().await.unwrap(), native)
}
async fn send(state: &AppState, path: &str, body: Value) -> (StatusCode, Value) {
    let response = build_router(state.clone())
        .oneshot(
            Request::post(path)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
fn input(client: &str) -> Value {
    json!({"input":[{"type":"text","text":"New ordinary Send"}],"clientUserMessageId":client,"queueIfPending":true})
}

#[tokio::test]
async fn stale_tabs_send_from_current_native_queue_and_converge_through_queue_refills() {
    let native = Arc::new(NativeInput::default());
    let state = state(native.clone()).await;
    let mut events = state.events.subscribe();
    // Another native client adds work after both browsers last saw an empty queue.
    native.queue.lock().unwrap().push(existing_row());
    for client in ["first-tab", "stale-second-tab"] {
        let (status, body) = send(
            &state,
            &format!("/v1/threads/{THREAD}/input"),
            input(client),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["disposition"], "queued");
        assert_eq!(body["queuedInput"]["clientUserMessageId"], client);
        let event = events.recv().await.unwrap();
        assert_eq!(event.kind, crate::queue::QUEUE_CHANGED_EVENT);
        assert_eq!(event.thread_id.as_deref(), Some(THREAD));
    }
    let rows = native.queue.lock().unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0]["clientUserMessageId"], "older-attempt");
    assert_eq!(rows[1]["clientUserMessageId"], "first-tab");
    assert_eq!(rows[2]["clientUserMessageId"], "stale-second-tab");
    let requests = native.requests.lock().unwrap();
    assert!(!requests.iter().any(|(method, _)| method == "turn/start"));
    for (_, params) in requests
        .iter()
        .filter(|(method, _)| method == "thread/queue/list")
    {
        assert_eq!(*params, json!({"threadId":THREAD,"cursor":null,"limit":1}));
    }
}

#[tokio::test]
async fn empty_current_queue_delegates_start_or_steer_to_native_without_browser_turn_ids() {
    let native = Arc::new(NativeInput::default());
    let state = state(native.clone()).await;
    // The last queued message has already begun; ordinary input may steer it.
    let (status, body) = send(
        &state,
        &format!("/v1/threads/{THREAD}/input"),
        input("same-explicit-attempt"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["disposition"], "submitted");
    assert_eq!(body["payload"]["turn"]["id"], "active-native-turn");
    assert!(body.get("queuedInput").is_none());
    let requests = native.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .map(|(method, _)| method.as_str())
            .collect::<Vec<_>>(),
        vec!["thread/queue/list", "turn/start"]
    );
    assert_eq!(
        requests[1].1["clientUserMessageId"],
        "same-explicit-attempt"
    );
    assert!(requests[1].1.get("expectedTurnId").is_none());
}

#[tokio::test]
async fn failed_queue_reads_never_fall_through_to_input_and_uncertain_adds_are_not_retried() {
    for fail_read in [true, false] {
        let native = Arc::new(NativeInput {
            fail_read,
            fail_add: !fail_read,
            ..Default::default()
        });
        native.queue.lock().unwrap().push(existing_row());
        let state = state(native.clone()).await;
        let (status, _) = send(
            &state,
            &format!("/v1/threads/{THREAD}/input"),
            input("failed-attempt"),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        let requests = native.requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .filter(|(method, _)| method == "thread/queue/list")
                .count(),
            1
        );
        assert_eq!(
            requests
                .iter()
                .filter(|(method, _)| method == "thread/queue/add")
                .count(),
            usize::from(!fail_read)
        );
        assert!(!requests.iter().any(|(method, _)| method == "turn/start"));
    }
}

#[tokio::test]
async fn queued_sends_preserve_attachments_and_explicit_attempt_identity() {
    let native = Arc::new(NativeInput::default());
    native.queue.lock().unwrap().push(existing_row());
    let state = state(native.clone()).await;
    let mut body = input("with-file");
    body["attachments"] = json!([{"id":"upload","fileName":"notes.txt","extension":"txt",
        "relativePath":format!(".kodex/uploads/{THREAD}/notes.txt"),"sizeBytes":12}]);
    let (status, response) = send(&state, &format!("/v1/threads/{THREAD}/input"), body).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(response["disposition"], "queued");
    let rows = native.queue.lock().unwrap();
    assert_eq!(rows[1]["clientUserMessageId"], "with-file");
    assert!(rows[1]["input"][0]["text"]
        .as_str()
        .unwrap()
        .contains("notes.txt"));
    assert!(rows[1]["input"][0]["text"]
        .as_str()
        .unwrap()
        .starts_with("New ordinary Send"));
}

#[tokio::test]
async fn queued_input_rejects_execution_overrides_and_explicit_turns_remain_direct() {
    let native = Arc::new(NativeInput::default());
    native.queue.lock().unwrap().push(existing_row());
    let state = state(native.clone()).await;
    let mut body = input("explicit-options");
    body["model"] = json!("explicit-model");
    let (status, _) = send(&state, &format!("/v1/threads/{THREAD}/input"), body.clone()).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(!native
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|(method, _)| method == "thread/queue/add"));
    native.requests.lock().unwrap().clear();
    let (status, _) = send(&state, &format!("/v1/threads/{THREAD}/turns"), body).await;
    assert_eq!(status, StatusCode::OK);
    let requests = native.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].0, "turn/start");
    assert_eq!(requests[0].1["model"], "explicit-model");
}

#[tokio::test]
async fn legacy_input_callers_keep_atomic_submission_even_with_queued_work() {
    for opt_out in [None, Some(false)] {
        let native = Arc::new(NativeInput::default());
        native.queue.lock().unwrap().push(existing_row());
        let state = state(native.clone()).await;
        let mut body = input("legacy-attempt");
        body.as_object_mut().unwrap().remove("queueIfPending");
        if let Some(flag) = opt_out {
            body["queueIfPending"] = json!(flag);
        }
        let (status, response) = send(&state, &format!("/v1/threads/{THREAD}/input"), body).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            response,
            json!({"payload":{"turn":{"id":"active-native-turn","status":"inProgress"}}})
        );
        let requests = native.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0, "turn/start");
        assert!(requests[0].1.get("queueIfPending").is_none());
        assert_eq!(native.queue.lock().unwrap().len(), 1);
    }
}
