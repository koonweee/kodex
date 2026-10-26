use std::sync::{Arc, Mutex};

use crate::{
    api::{build_router, AppState},
    app_server::AppServer,
    config::Config,
    error::{ApiError, ApiResult},
    store::Store,
};
use async_trait::async_trait;
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::{json, Value};
use tower::ServiceExt;

struct NativeResume {
    head: Mutex<(String, String)>,
    requests: Mutex<Vec<(String, Value)>>,
    fail_start: bool,
    hold_header: Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>,
}
impl NativeResume {
    fn new(id: &str, status: &str) -> Self {
        Self {
            head: Mutex::new((id.into(), status.into())),
            requests: Mutex::new(vec![]),
            fail_start: false,
            hold_header: None,
        }
    }
}
#[async_trait]
impl AppServer for NativeResume {
    fn is_ready(&self) -> bool {
        true
    }
    fn readiness_error(&self) -> Option<String> {
        None
    }
    async fn request(&self, method: &str, params: Value) -> ApiResult<Value> {
        self.requests.lock().unwrap().push((method.into(), params));
        if method == "thread/turns/list" {
            if let Some((entered, release)) = &self.hold_header {
                let payload = {
                    let head = self.head.lock().unwrap();
                    json!({"data":[{"id":head.0,"status":head.1,"items":[]}],"nextCursor":null,"backwardsCursor":null})
                };
                entered.notify_one();
                release.notified().await;
                return Ok(payload);
            }
        }
        let mut head = self.head.lock().unwrap();
        match method {
            "thread/read" => Ok(
                json!({"thread":{"id":"chat","cwd":"/fixture","createdAt":1,"updatedAt":1,
                "status":{"type":if head.1 == "inProgress" { "active" } else { "idle" },"activeFlags":[]}}}),
            ),
            "thread/turns/list" => Ok(
                json!({"data":[{"id":head.0,"status":head.1,"items":[]}],"nextCursor":null,"backwardsCursor":null}),
            ),
            "turn/start" if self.fail_start => {
                Err(ApiError::BadGateway("acknowledgment lost".into()))
            }
            "turn/start" => {
                // Complete immediately, so a stale second tab must check the native head,
                // rather than merely checking whether a turn is currently active.
                *head = ("continuation".into(), "completed".into());
                Ok(json!({"turn":{"id":"continuation","status":"inProgress"}}))
            }
            _ => Err(ApiError::BadGateway(format!("unexpected method {method}"))),
        }
    }
    async fn respond(&self, _: &str, _: Value) -> ApiResult<()> {
        unreachable!()
    }
}
async fn state(native: Arc<NativeResume>) -> AppState {
    AppState::new(Config::default(), Store::in_memory().await.unwrap(), native)
}
async fn resume(state: AppState) -> (StatusCode, Value) {
    let response = build_router(state)
        .oneshot(
            Request::post("/v1/threads/chat/resume-turn")
                .header("content-type", "application/json")
                .body(Body::from(json!({"expectedTurnId":"stopped"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
        .unwrap_or(Value::Null);
    (status, body)
}
#[tokio::test]
async fn resumes_interrupted_turn_with_empty_native_input_and_no_pending_user_message() {
    let native = Arc::new(NativeResume::new("stopped", "interrupted"));
    let state = state(native.clone()).await;
    let (status, _) = resume(state.clone()).await;
    assert_eq!(status, StatusCode::OK);
    let requests = native.requests.lock().unwrap();
    assert_eq!(
        requests.iter().map(|(m, _)| m.as_str()).collect::<Vec<_>>(),
        ["thread/read", "thread/turns/list", "turn/start"]
    );
    assert_eq!(requests[1].1["limit"], 1);
    assert_eq!(requests[1].1["sortDirection"], "desc");
    assert_eq!(requests[1].1["itemsView"], "notLoaded");
    assert_eq!(requests[2].1["input"], json!([]));
    assert!(requests[2].1.get("model").is_none());
    drop(requests);
    assert_eq!(state.store.latest_event_seq().await.unwrap(), 0);
}
#[tokio::test]
async fn stale_or_non_interrupted_resume_never_submits_input() {
    for (id, status) in [
        ("stopped", "inProgress"),
        ("stopped", "completed"),
        ("stopped", "failed"),
        ("newer", "interrupted"),
    ] {
        let native = Arc::new(NativeResume::new(id, status));
        assert_eq!(
            resume(state(native.clone()).await).await.0,
            StatusCode::CONFLICT
        );
        assert!(!native
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|(m, _)| m == "turn/start"));
    }
}
#[tokio::test]
async fn two_tabs_resuming_the_same_stopped_head_start_only_one_continuation() {
    let native = Arc::new(NativeResume::new("stopped", "interrupted"));
    let state = state(native.clone()).await;
    let (first, second) = tokio::join!(resume(state.clone()), resume(state));
    let statuses = [first.0, second.0];
    assert!(statuses.contains(&StatusCode::OK));
    assert!(statuses.contains(&StatusCode::CONFLICT));
    assert_eq!(
        native
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, _)| m == "turn/start")
            .count(),
        1
    );
}
#[tokio::test]
async fn ambiguous_native_resume_write_is_not_retried() {
    let native = Arc::new(NativeResume {
        fail_start: true,
        ..NativeResume::new("stopped", "interrupted")
    });
    assert_eq!(
        resume(state(native.clone()).await).await.0,
        StatusCode::BAD_GATEWAY
    );
    assert_eq!(
        native
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, _)| m == "turn/start")
            .count(),
        1
    );
}

#[tokio::test]
async fn resume_serializes_head_validation_with_plain_input_and_app_messages() {
    for path in ["input", "turns", "app-message"] {
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let native = Arc::new(NativeResume {
            hold_header: Some((entered.clone(), release.clone())),
            ..NativeResume::new("stopped", "interrupted")
        });
        let state = state(native.clone()).await;
        let resuming = tokio::spawn(resume(state.clone()));
        entered.notified().await;
        let sending = tokio::spawn(async move {
            if path == "app-message" {
                return super::turns::start_turn_with_admission(
                    &state,
                    "chat".into(),
                    super::turns::TurnStartRequest {
                        client_user_message_id: Some("other".into()),
                        input: vec![crate::app_server_api::UserInput::Text {
                            text: "Other client".into(),
                            text_elements: vec![],
                        }],
                        attachments: vec![],
                        options: Default::default(),
                    },
                    true,
                    None,
                )
                .await
                .map(|_| StatusCode::OK)
                .unwrap();
            }
            build_router(state)
                .oneshot(
                    Request::post(format!("/v1/threads/chat/{path}"))
                        .header("content-type", "application/json")
                        .body(Body::from(
                            json!({"input":[{"type":"text","text":"Other client"}]}).to_string(),
                        ))
                        .unwrap(),
                )
                .await
                .unwrap()
                .status()
        });
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert!(
            !sending.is_finished(),
            "{path} bypassed the resume input exclusion"
        );
        release.notify_one();
        assert_eq!(resuming.await.unwrap().0, StatusCode::OK);
        assert_eq!(sending.await.unwrap(), StatusCode::OK);
        let requests = native.requests.lock().unwrap();
        let starts = requests
            .iter()
            .filter(|(m, _)| m == "turn/start")
            .collect::<Vec<_>>();
        assert_eq!(starts.len(), 2);
        assert_eq!(starts[0].1["input"], json!([]));
        assert_eq!(starts[1].1["input"][0]["text"], "Other client");
    }
}
