use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::{json, Value};
use tokio::{
    sync::oneshot,
    time::{timeout, Duration},
};
use tower::ServiceExt;

use crate::{
    api::{build_router, AppState},
    app_server::AppServer,
    config::Config,
    error::{ApiError, ApiResult},
    store::Store,
};

#[derive(Default)]
struct Native {
    calls: Mutex<Vec<(String, Value)>>,
    created: Mutex<Vec<String>>,
    rows: Mutex<Vec<Value>>,
    lose_create_ack: bool,
    lose_add_ack: bool,
    add_gate: Mutex<Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>>,
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
        self.calls
            .lock()
            .unwrap()
            .push((method.into(), params.clone()));
        match method {
            "project/read" => Ok(json!({"project":{
                "id":"native-project", "name":"Fixture", "roots":[{"path":"/fixture"}],
                "metadata":{}, "position":0, "createdAt":1,"updatedAt":1,"recencyAt":null,
            }})),
            "thread/start" => {
                self.created.lock().unwrap().push("spawn-chat".into());
                if self.lose_create_ack {
                    Err(ApiError::BadGateway(
                        "native created chat, acknowledgement lost".into(),
                    ))
                } else {
                    Ok(json!({"thread":thread(),"cwd":"/fixture"}))
                }
            }
            "thread/read" => Ok(json!({"thread":thread()})),
            "thread/turns/list" => Ok(json!({"data":[],"nextCursor":null,"backwardsCursor":null})),
            "thread/queue/add" => {
                let row = json!({"id":"native-row", "input":params["input"], "clientUserMessageId":params["clientUserMessageId"]});
                self.rows.lock().unwrap().push(row.clone());
                let gate = self.add_gate.lock().unwrap().take();
                if let Some((started, release)) = gate {
                    let _ = started.send(());
                    release
                        .await
                        .map_err(|_| ApiError::BadGateway("fixture gate closed".into()))?;
                }
                if self.lose_add_ack {
                    Err(ApiError::BadGateway(
                        "native queued row, acknowledgement lost".into(),
                    ))
                } else {
                    Ok(json!({"queuedSubmission":row}))
                }
            }
            _ => Err(ApiError::BadGateway(format!(
                "unexpected Control RPC {method}"
            ))),
        }
    }

    async fn respond(&self, _: &str, _: Value) -> ApiResult<()> {
        Err(ApiError::BadGateway("unexpected approval".into()))
    }
}

fn thread() -> Value {
    json!({"id":"spawn-chat","cwd":"/fixture","status":{"type":"idle"},
        "createdAt":1,"updatedAt":1,"projectId":"native-project","canAcceptDirectInput":true})
}

async fn state(native: Native) -> (AppState, Arc<Native>) {
    let native = Arc::new(native);
    (
        AppState::new(
            Config::default(),
            Store::in_memory().await.unwrap(),
            native.clone(),
        ),
        native,
    )
}

async fn spawn(state: &AppState) -> (StatusCode, Value) {
    let response = build_router(state.clone())
        .oneshot(
            Request::post("/v1/self-control/thread-spawns")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "projectId":"native-project", "idempotencyKey":"single-attempt-key",
                        "input":[{"type":"text","text":"Do this once"}], "maxSelfControlDepth":2,
                        "source":{"sourceToolCallId":"spawn-tool"},
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn native_control_spawn_lost_create_or_add_ack_never_repeats_native_work_for_same_key() {
    for create in [true, false] {
        let (state, native) = state(Native {
            lose_create_ack: create,
            lose_add_ack: !create,
            ..Default::default()
        })
        .await;
        let (status, body) = spawn(&state).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY, "{body}");
        let before = native.calls.lock().unwrap().clone();
        let (status, body) = spawn(&state).await;
        assert_eq!(status, StatusCode::CONFLICT, "create={create}: {body}");
        assert_eq!(
            *native.calls.lock().unwrap(),
            before,
            "an uncertain prior attempt cannot authorize another native request"
        );
        assert_eq!(
            before
                .iter()
                .filter(|(method, _)| method == "thread/start")
                .count(),
            1
        );
        assert_eq!(native.rows.lock().unwrap().len(), usize::from(!create));
        assert_eq!(native.created.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn native_control_spawn_competing_same_key_calls_share_one_accepted_admission() {
    let (state, native) = state(Native::default()).await;
    let (started, waiting) = oneshot::channel();
    let (release, held) = oneshot::channel();
    *native.add_gate.lock().unwrap() = Some((started, held));
    let first_state = state.clone();
    let first = tokio::spawn(async move { spawn(&first_state).await });
    timeout(Duration::from_secs(2), waiting)
        .await
        .unwrap()
        .unwrap();
    let other = state.clone();
    let mut second = tokio::spawn(async move { spawn(&other).await });
    let early = timeout(Duration::from_millis(30), &mut second).await;
    let completed_early = early.is_ok();
    release.send(()).unwrap();
    let (first_status, first) = timeout(Duration::from_secs(2), first)
        .await
        .unwrap()
        .unwrap();
    let (second_status, second) = match early {
        Ok(result) => result.unwrap(),
        Err(_) => timeout(Duration::from_secs(2), second)
            .await
            .unwrap()
            .unwrap(),
    };
    assert!(
        !completed_early,
        "same-key admission must wait for the in-flight attempt"
    );
    assert_eq!(first_status, StatusCode::OK, "{first}");
    assert_eq!(second_status, StatusCode::OK, "{second}");
    assert_eq!(first["threadId"], "spawn-chat");
    assert_eq!(first["queuedSubmissionId"], "native-row");
    assert_eq!(first["remainingSelfControlDepth"], 1);
    assert_eq!(first["idempotentReplay"], false);
    assert_eq!(second["idempotentReplay"], true);
    for field in ["threadId", "queuedSubmissionId", "clientUserMessageId"] {
        assert_eq!(first[field], second[field]);
    }
    assert_eq!(
        first["clientUserMessageId"],
        native.rows.lock().unwrap()[0]["clientUserMessageId"]
    );
    assert!(first.get("input").is_none());
    assert!(first.get("thread").is_none());
    let events = state.store.replay_events(None, None, None).await.unwrap();
    let cached = events
        .iter()
        .find(|event| event.kind == "self_control.thread_spawned")
        .unwrap();
    assert!(!cached.payload.to_string().contains("Do this once"));
    let calls = native.calls.lock().unwrap();
    for method in ["thread/start", "thread/queue/add"] {
        assert_eq!(calls.iter().filter(|(name, _)| name == method).count(), 1);
    }
}

#[tokio::test]
async fn native_control_spawn_cache_publication_failure_preserves_current_ack_and_fences_replay() {
    let (state, native) = state(Native::default()).await;
    sqlx::query("CREATE TRIGGER reject_spawn_cache BEFORE INSERT ON events WHEN NEW.kind='self_control.thread_spawned' BEGIN SELECT RAISE(FAIL, 'fixture cache failure'); END")
        .execute(state.store.pool()).await.unwrap();
    let (status, accepted) = spawn(&state).await;
    assert_eq!(status, StatusCode::OK, "{accepted}");
    assert_eq!(accepted["threadId"], "spawn-chat");
    assert_eq!(accepted["queuedSubmissionId"], "native-row");
    assert_eq!(native.rows.lock().unwrap().len(), 1);
    let before = native.calls.lock().unwrap().clone();
    let (status, body) = spawn(&state).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(*native.calls.lock().unwrap(), before);
}
