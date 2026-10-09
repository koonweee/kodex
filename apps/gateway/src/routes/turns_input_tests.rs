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
    fail_start: bool,
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
            "turn/start" if self.fail_start => {
                Err(ApiError::BadGateway("turn acknowledgment lost".into()))
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
fn alternate_input(client: &str) -> Value {
    json!({"input":[{"type":"text","text":"Alternate draft"}],"clientUserMessageId":client,"queueIfEmpty":true})
}

#[tokio::test]
async fn alternate_input_queues_with_attachments_when_native_queue_is_empty() {
    let native = Arc::new(NativeInput::default());
    let state = state(native.clone()).await;
    let mut events = state.events.subscribe();
    let mut body = alternate_input("alternate-with-file");
    body["attachments"] = json!([{"id":"upload","fileName":"notes.txt","extension":"txt",
        "relativePath":format!(".kodex/uploads/{THREAD}/notes.txt"),"sizeBytes":12}]);
    let (status, response) = send(&state, &format!("/v1/threads/{THREAD}/input"), body).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(response["disposition"], "queued");
    assert_eq!(
        response["queuedInput"]["clientUserMessageId"],
        "alternate-with-file"
    );
    assert!(response["queuedInput"]["input"][0]["text"]
        .as_str()
        .unwrap()
        .starts_with("Alternate draft"));
    assert!(response["queuedInput"]["input"][0]["text"]
        .as_str()
        .unwrap()
        .contains("notes.txt"));
    assert_eq!(
        events.recv().await.unwrap().kind,
        crate::queue::QUEUE_CHANGED_EVENT
    );
    let requests = native.requests.lock().unwrap();
    assert_eq!(
        requests[0],
        (
            "thread/queue/list".into(),
            json!({"threadId":THREAD,"cursor":null,"limit":1})
        )
    );
    assert_eq!(
        requests
            .iter()
            .filter(|(method, _)| method == "thread/queue/add")
            .count(),
        1
    );
    assert!(!requests.iter().any(|(method, _)| method == "turn/start"));
}

#[tokio::test]
async fn alternate_input_submits_options_and_attachments_without_changing_nonempty_queue() {
    let native = Arc::new(NativeInput::default());
    let original = existing_row();
    native.queue.lock().unwrap().push(original.clone());
    let state = state(native.clone()).await;
    let mut body = alternate_input("alternate-direct");
    body["model"] = json!("explicit-model");
    body["attachments"] = json!([{"id":"upload","fileName":"notes.txt","extension":"txt",
        "relativePath":format!(".kodex/uploads/{THREAD}/notes.txt"),"sizeBytes":12}]);
    let (status, response) = send(&state, &format!("/v1/threads/{THREAD}/input"), body).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(response["disposition"], "submitted");
    assert_eq!(*native.queue.lock().unwrap(), vec![original]);
    let requests = native.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .map(|(method, _)| method.as_str())
            .collect::<Vec<_>>(),
        vec!["thread/queue/list", "turn/start"]
    );
    let submitted = &requests[1].1;
    assert_eq!(submitted["clientUserMessageId"], "alternate-direct");
    assert_eq!(submitted["model"], "explicit-model");
    assert!(submitted["input"][0]["text"]
        .as_str()
        .unwrap()
        .contains("notes.txt"));
    assert!(submitted.get("expectedTurnId").is_none());
    assert!(submitted.get("queueIfEmpty").is_none());
}

#[tokio::test]
async fn stale_empty_tabs_serialize_alternate_inputs_and_share_authoritative_projections() {
    let native = Arc::new(NativeInput::default());
    let state = state(native.clone()).await;
    let mut first_tab_events = state.events.subscribe();
    let mut second_tab_events = state.events.subscribe();
    let path = format!("/v1/threads/{THREAD}/input");
    // Both tabs saw no queued input. The first admission changes the routing of
    // the other explicit attempt even though its browser hint is still empty.
    let (first, second) = tokio::join!(
        send(&state, &path, alternate_input("first-tab")),
        send(&state, &path, alternate_input("stale-second-tab")),
    );
    assert_eq!(first.0, StatusCode::OK);
    assert_eq!(second.0, StatusCode::OK);
    let (queued, submitted_id) = if first.1["disposition"] == "queued" {
        assert_eq!(second.1["disposition"], "submitted");
        (&first.1, "stale-second-tab")
    } else {
        assert_eq!(first.1["disposition"], "submitted");
        assert_eq!(second.1["disposition"], "queued");
        (&second.1, "first-tab")
    };
    assert_eq!(
        native.queue.lock().unwrap().as_slice(),
        &[queued["queuedInput"].clone()]
    );
    for events in [&mut first_tab_events, &mut second_tab_events] {
        let marker = events.recv().await.unwrap();
        assert_eq!(marker.kind, crate::queue::QUEUE_CHANGED_EVENT);
        assert_eq!(marker.thread_id.as_deref(), Some(THREAD));
        let projection = events.recv().await.unwrap();
        assert_eq!(projection.kind, "thread_view.patch");
        let patch: crate::thread_view_patch::ThreadViewPatch =
            serde_json::from_value(projection.payload).unwrap();
        assert!(patch
            .rows
            .unwrap()
            .iter()
            .filter_map(|row| row.item.as_ref())
            .any(|item| item.payload.client_id.as_deref() == Some(submitted_id)));
    }
    let snapshot = crate::thread_view::patch_for_thread(&state.thread_views, THREAD)
        .await
        .unwrap();
    assert!(snapshot
        .items
        .iter()
        .any(|item| item.payload.client_id.as_deref() == Some(submitted_id)));
    let requests = native.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .filter(|(method, _)| method == "thread/queue/list")
            .count(),
        2
    );
    assert_eq!(
        requests
            .iter()
            .filter(|(method, _)| method == "thread/queue/add")
            .count(),
        1
    );
    assert_eq!(
        requests
            .iter()
            .filter(|(method, _)| method == "turn/start")
            .count(),
        1
    );
}

#[tokio::test]
async fn stale_nonempty_tab_queues_after_native_work_is_removed_and_other_tab_refills() {
    let native = Arc::new(NativeInput::default());
    native.queue.lock().unwrap().push(existing_row());
    let state = state(native.clone()).await;
    // Another native client removes the front row after the browser saw it.
    native.queue.lock().unwrap().clear();
    let mut other_tab_events = state.events.subscribe();
    let (status, response) = send(
        &state,
        &format!("/v1/threads/{THREAD}/input"),
        alternate_input("stale-nonempty-tab"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(response["disposition"], "queued");
    assert_eq!(
        other_tab_events.recv().await.unwrap().kind,
        crate::queue::QUEUE_CHANGED_EVENT
    );
    let refill = build_router(state.clone())
        .oneshot(
            Request::get(format!("/v1/threads/{THREAD}/queued-inputs"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(refill.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&to_bytes(refill.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(
        body["queuedInputs"][0]["clientUserMessageId"],
        "stale-nonempty-tab"
    );
    assert_eq!(body["queuedInputs"].as_array().unwrap().len(), 1);
    assert!(!native
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|(method, _)| method == "turn/start"));
}

#[tokio::test]
async fn alternate_input_rejects_queued_overrides_and_conflicting_policies_before_writes() {
    for conflicting in [false, true] {
        let native = Arc::new(NativeInput::default());
        let state = state(native.clone()).await;
        let mut body = alternate_input("invalid-policy");
        if conflicting {
            body["queueIfPending"] = json!(true);
        } else {
            body["model"] = json!("explicit-model");
        }
        let (status, _) = send(&state, &format!("/v1/threads/{THREAD}/input"), body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let requests = native.requests.lock().unwrap();
        assert!(!requests
            .iter()
            .any(|(method, _)| method == "thread/queue/add" || method == "turn/start"));
        if conflicting {
            assert!(requests.is_empty());
        }
    }
}

#[tokio::test]
async fn alternate_input_failures_do_not_retry_or_change_routing() {
    for (fail_read, fail_add, fail_start) in [
        (true, false, false),
        (false, true, false),
        (false, false, true),
    ] {
        let native = Arc::new(NativeInput {
            fail_read,
            fail_add,
            fail_start,
            ..Default::default()
        });
        if fail_start {
            native.queue.lock().unwrap().push(existing_row());
        }
        let original = native.queue.lock().unwrap().clone();
        let state = state(native.clone()).await;
        let (status, _) = send(
            &state,
            &format!("/v1/threads/{THREAD}/input"),
            alternate_input("failed-alternate"),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(*native.queue.lock().unwrap(), original);
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
            usize::from(fail_add)
        );
        assert_eq!(
            requests
                .iter()
                .filter(|(method, _)| method == "turn/start")
                .count(),
            usize::from(fail_start)
        );
    }
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
