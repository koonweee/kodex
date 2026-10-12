use crate::{
    api::{build_control_router, AppState},
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
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use tokio::sync::Notify;
use tokio::time::{timeout, Duration};
use tower::ServiceExt;

struct Native {
    status: Mutex<String>,
    calls: Mutex<Vec<String>>,
    held: AtomicUsize,
    entered: Notify,
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
        self.calls.lock().unwrap().push(method.into());
        if params["threadId"] == "hung" {
            self.held.fetch_add(1, Ordering::SeqCst);
            struct Guard<'a>(&'a AtomicUsize);
            impl Drop for Guard<'_> {
                fn drop(&mut self) {
                    self.0.fetch_sub(1, Ordering::SeqCst);
                }
            }
            let _guard = Guard(&self.held);
            self.entered.notify_one();
            std::future::pending::<()>().await;
        }
        if params["threadId"] == "bad" {
            return Err(ApiError::NotFound("thread".into()));
        }
        let status = if params["threadId"] == "active" {
            "inProgress".into()
        } else {
            self.status.lock().unwrap().clone()
        };
        match method {
            "thread/read" => Ok(
                json!({"thread":{"id":params["threadId"],"cwd":"/tmp","status":if status == "attention" {json!({"type":"active","activeFlags":["waitingOnUserInput"]})} else if status.starts_with("active") {json!({"type":"active","activeFlags":[]})} else {json!({"type":"idle"})},"createdAt":1,"updatedAt":1,"turns":[]}}),
            ),
            "thread/turns/list" => {
                if status == "fresh" {
                    return Err(ApiError::NativeRpc(crate::app_server::JsonRpcError {code:-32600, message:format!("thread {} is not materialized yet; thread/turns/list is unavailable before first user message", params["threadId"].as_str().unwrap()),data:None}));
                }
                let turn_status = match status.as_str() {
                    "attention" => "inProgress",
                    "active_old" => "completed",
                    "race" if params["itemsView"] == "full" => {
                        *self.status.lock().unwrap() = "completed".into();
                        "inProgress"
                    }
                    "race" => "completed",
                    other => other,
                };
                Ok(
                    json!({"data":if matches!(status.as_str(), "empty"|"active_empty") {json!([])} else {json!([{"id":"turn-1","status":turn_status,"items":if params["itemsView"] == "full" {json!([{"id":"answer","type":"agentMessage","text":"Visible answer","phase":"final_answer"}])} else {json!([])}}])},"nextCursor":null}),
                )
            }
            _ => Err(ApiError::BadGateway(format!("unexpected {method}"))),
        }
    }

    async fn respond(&self, _: &str, _: Value) -> ApiResult<()> {
        panic!("observation wrote a response")
    }
}
async fn state(status: &str) -> (AppState, Arc<Native>) {
    let native = Arc::new(Native {
        status: Mutex::new(status.into()),
        calls: Mutex::new(Vec::new()),
        held: AtomicUsize::new(0),
        entered: Notify::new(),
    });
    (
        AppState::new(
            Config::default(),
            Store::in_memory().await.unwrap(),
            native.clone(),
        ),
        native,
    )
}
async fn wait(state: &AppState, input: Value) -> (StatusCode, Value) {
    let response = build_control_router(state.clone())
        .oneshot(
            Request::post("/v1/self-control/threads/wait")
                .header("content-type", "application/json")
                .body(Body::from(input.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
#[tokio::test]
async fn wait_threads_initial_completion_and_cursor_reuse_do_not_repeat_answer() {
    let (state, native) = state("completed").await;
    let (status, first) = wait(
        &state,
        json!({"targets":[{"threadId":"chat"}],"timeoutMs":0}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["status"], "matched");
    assert!(first.to_string().contains("Visible answer"));
    let (_, repeat) = wait(&state, json!({"targets":[{"threadId":"chat","afterCursor":first["results"][0]["cursor"]}],"timeoutMs":0})).await;
    assert_eq!(repeat["status"], "timeout");
    assert!(!repeat.to_string().contains("Visible answer"));
    assert!(native
        .calls
        .lock()
        .unwrap()
        .iter()
        .all(|method| matches!(method.as_str(), "thread/read" | "thread/turns/list")));
}
#[tokio::test]
async fn wait_threads_returns_partial_errors_and_native_attention() {
    let (state, _) = state("attention").await;
    let (status, body) = wait(
        &state,
        json!({"targets":[{"threadId":"bad"},{"threadId":"chat"}],"timeoutMs":0}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["results"][0]["condition"], "attention");
    assert_eq!(body["errors"][0]["threadId"], "bad");
    assert_eq!(body["status"], "matched");
}
#[tokio::test]
async fn wait_threads_empty_idle_is_not_completion_and_limits_are_validated() {
    let (state, native) = state("empty").await;
    for input in [
        json!({"targets":[],"timeoutMs":0}),
        json!({"targets":[{"threadId":"chat"}],"timeoutMs":60001}),
        json!({"targets":[{"threadId":"chat"},{"threadId":"chat"}],"timeoutMs":0}),
    ] {
        assert_eq!(wait(&state, input).await.0, StatusCode::BAD_REQUEST);
    }
    assert!(native.calls.lock().unwrap().is_empty());
    let (_, body) = wait(
        &state,
        json!({"targets":[{"threadId":"chat"}],"timeoutMs":0}),
    )
    .await;
    assert_eq!(body["status"], "timeout");
    assert_eq!(body["results"][0]["condition"], "idle");
}

#[tokio::test]
async fn wait_threads_recovers_missed_completion_events_and_returns_timeout_progress() {
    let (state, native) = state("inProgress").await;
    let (_, snapshot) = wait(
        &state,
        json!({"targets":[{"threadId":"chat"}],"timeoutMs":0}),
    )
    .await;
    assert_eq!(snapshot["status"], "timeout");
    assert!(snapshot.to_string().contains("Visible answer"));
    let copy = state.clone();
    let pending = tokio::spawn(async move {
        wait(
            &copy,
            json!({"targets":[{"threadId":"chat"}],"timeoutMs":2000}),
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    *native.status.lock().unwrap() = "completed".into();
    let (_, result) = timeout(Duration::from_secs(3), pending)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result["status"], "matched");
    assert_eq!(result["results"][0]["condition"], "completed");
}

#[tokio::test]
async fn wait_threads_restart_and_revert_explicitly_reset_cursors_without_repeating_final_text() {
    let (original, native) = state("completed").await;
    let (_, first) = wait(
        &original,
        json!({"targets":[{"threadId":"chat"}],"timeoutMs":0}),
    )
    .await;
    let restarted = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    let (_, reset) = wait(&restarted, json!({"targets":[{"threadId":"chat","afterCursor":first["results"][0]["cursor"]}],"timeoutMs":0})).await;
    assert_eq!(reset["results"][0]["reset"], true);
    assert!(!reset.to_string().contains("Visible answer"));
    *native.status.lock().unwrap() = "empty".into();
    crate::events::ingest_inbound(
        crate::app_server::InboundMessage::Notification {
            method: "thread/reverted".into(),
            params: json!({"threadId":"chat"}),
        },
        &restarted,
    )
    .await
    .unwrap();
    let (_, reverted) = wait(&restarted, json!({"targets":[{"threadId":"chat","afterCursor":reset["results"][0]["cursor"]}],"timeoutMs":0})).await;
    assert_eq!(reverted["results"][0]["reset"], true);
    assert_eq!(reverted["results"][0]["condition"], "idle");
    assert_eq!(reverted["results"][0]["progress"], json!([]));
}

#[tokio::test]
async fn wait_threads_invalid_cursors_are_per_target_and_do_not_hide_good_results() {
    let (state, _) = state("completed").await;
    let (_, result) = wait(&state, json!({"targets":[{"threadId":"one","afterCursor":"invalid"},{"threadId":"two"}],"timeoutMs":0})).await;
    assert_eq!(result["results"][0]["threadId"], "two");
    assert_eq!(result["errors"][0]["threadId"], "one");
    let (_, foreign) = wait(&state, json!({"targets":[{"threadId":"one","afterCursor":result["results"][0]["cursor"]}],"timeoutMs":0})).await;
    assert_eq!(foreign["status"], "error");
}

#[tokio::test]
async fn wait_threads_dropping_request_cleans_up_held_reads_and_subscription() {
    let (state, native) = state("inProgress").await;
    let receivers = state.events.receiver_count();
    let copy = state.clone();
    let pending = tokio::spawn(async move {
        wait(
            &copy,
            json!({"targets":[{"threadId":"hung"}],"timeoutMs":60000}),
        )
        .await
    });
    timeout(Duration::from_secs(2), native.entered.notified())
        .await
        .unwrap();
    assert_eq!(native.held.load(Ordering::SeqCst), 1);
    pending.abort();
    assert!(pending.await.unwrap_err().is_cancelled());
    timeout(Duration::from_secs(2), async {
        while native.held.load(Ordering::SeqCst) != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(state.events.receiver_count(), receivers);
}

#[tokio::test]
async fn wait_threads_hung_target_is_bounded_and_other_results_survive() {
    let (state, native) = state("completed").await;
    let (_, result) = timeout(
        Duration::from_secs(7),
        wait(
            &state,
            json!({"targets":[{"threadId":"hung"},{"threadId":"chat"}],"timeoutMs":0}),
        ),
    )
    .await
    .unwrap();
    assert_eq!(result["results"][0]["condition"], "completed");
    assert_eq!(result["errors"][0]["threadId"], "hung");
    assert_eq!(native.held.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn wait_threads_failure_interrupt_attention_receipts_and_pending_completion_are_explicit() {
    for condition in ["failed", "interrupted", "attention"] {
        let (state, _) = state(condition).await;
        let (_, first) = wait(
            &state,
            json!({"targets":[{"threadId":"chat"}],"timeoutMs":0}),
        )
        .await;
        assert_eq!(first["status"], "matched");
        assert_eq!(first["results"][0]["condition"], condition);
        let (_, repeat) = wait(&state, json!({"targets":[{"threadId":"chat","afterCursor":first["results"][0]["cursor"]}],"timeoutMs":0})).await;
        assert_eq!(repeat["status"], "timeout");
    }
    let (state, _) = state("completed").await;
    state
        .thread_views
        .observe_completion("chat", "newer-turn")
        .await;
    let (_, body) = wait(
        &state,
        json!({"targets":[{"threadId":"chat"}],"timeoutMs":0}),
    )
    .await;
    assert_eq!(body["status"], "error");
    assert!(!body.to_string().contains("Visible answer"));
}

#[tokio::test]
async fn wait_threads_fresh_and_active_metadata_do_not_deliver_old_completion() {
    for (native_status, condition) in [
        ("fresh", "idle"),
        ("active_empty", "inProgress"),
        ("active_old", "inProgress"),
    ] {
        let (state, _) = state(native_status).await;
        let (_, body) = wait(
            &state,
            json!({"targets":[{"threadId":"chat"}],"timeoutMs":0}),
        )
        .await;
        assert_eq!(body["status"], "timeout", "{body}");
        assert_eq!(body["results"][0]["condition"], condition);
        assert!(!body.to_string().contains("Visible answer"));
    }
}

#[tokio::test]
async fn wait_threads_reobserves_progress_races_within_deadline() {
    let (state, native) = state("race").await;
    let (_, body) = wait(
        &state,
        json!({"targets":[{"threadId":"chat"}],"timeoutMs":2000}),
    )
    .await;
    assert_eq!(body["status"], "matched", "{body}");
    assert!(body.to_string().contains("Visible answer"));
    assert!(
        native
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|method| *method == "thread/turns/list")
            .count()
            >= 4
    );
}

#[tokio::test]
async fn wait_threads_unrelated_token_events_do_not_amplify_polling() {
    let (state, native) = state("inProgress").await;
    let event = state
        .store
        .append_event(crate::store::NewEvent {
            project_id: None,
            thread_id: Some("unrelated".into()),
            turn_id: None,
            item_id: None,
            kind: "thread_view.item_delta".into(),
            codex_method: None,
            payload: json!({}),
        })
        .await
        .unwrap();
    let events = state.events.clone();
    let noise = tokio::spawn(async move {
        for _ in 0..80 {
            let _ = events.send(event.clone());
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    });
    let (_, body) = wait(
        &state,
        json!({"targets":[{"threadId":"chat"}],"timeoutMs":600}),
    )
    .await;
    noise.await.unwrap();
    assert_eq!(body["status"], "timeout");
    assert!(
        native
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|method| *method == "thread/read")
            .count()
            <= 3
    );
}

async fn add_local_attention(state: &AppState, id: usize) {
    state
        .store
        .insert_approval(crate::store::NewApproval {
            request_id: id.to_string(),
            thread_id: Some("chat".into()),
            turn_id: None,
            item_id: None,
            method: crate::routes::app_surfaces::APP_SURFACE_BRIDGE_APPROVAL_METHOD.into(),
            payload: json!({"sensitive":"must not appear"}),
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn wait_threads_attention_receipts_cover_all_bounded_requests_and_report_overflow() {
    let (state, _) = state("empty").await;
    for id in 0..20 {
        add_local_attention(&state, id).await;
    }
    let (_, first) = wait(
        &state,
        json!({"targets":[{"threadId":"chat"}],"timeoutMs":0}),
    )
    .await;
    assert_eq!(first["results"][0]["condition"], "attention");
    add_local_attention(&state, 20).await;
    let (_, added) = wait(&state, json!({"targets":[{"threadId":"chat","afterCursor":first["results"][0]["cursor"]}],"timeoutMs":0})).await;
    assert_eq!(added["status"], "matched");
    assert!(!added.to_string().contains("sensitive"));
    for id in 21..65 {
        add_local_attention(&state, id).await;
    }
    let (_, overflow) = wait(
        &state,
        json!({"targets":[{"threadId":"chat"}],"timeoutMs":0}),
    )
    .await;
    assert_eq!(overflow["status"], "error");
    assert_eq!(overflow["errors"][0]["error"]["retryable"], false);
    assert!(overflow["errors"][0]["error"]["message"]
        .as_str()
        .unwrap()
        .contains("64 pending"));
}

#[tokio::test]
async fn wait_threads_mixed_targets_keep_request_order_and_individual_progress() {
    let (state, _) = state("completed").await;
    let (_, body) = wait(&state, json!({"targets":[{"threadId":"active"},{"threadId":"done"},{"threadId":"bad"}],"timeoutMs":1000})).await;
    assert_eq!(body["status"], "matched");
    assert_eq!(body["results"][0]["threadId"], "active");
    assert_eq!(body["results"][0]["condition"], "inProgress");
    assert_eq!(body["results"][1]["threadId"], "done");
    assert_eq!(body["results"][1]["condition"], "completed");
    assert_eq!(body["errors"][0]["threadId"], "bad");
    assert_ne!(body["results"][0]["cursor"], body["results"][1]["cursor"]);
    let targets: Vec<_> = (0..9)
        .map(|id| json!({"threadId":id.to_string()}))
        .collect();
    assert_eq!(
        wait(&state, json!({"targets":targets,"timeoutMs":0}))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn wait_threads_active_baseline_does_not_redeliver_older_terminal_when_activity_disappears() {
    let (state, native) = state("active_old").await;
    let (_, active) = wait(
        &state,
        json!({"targets":[{"threadId":"chat"}],"timeoutMs":0}),
    )
    .await;
    assert_eq!(active["results"][0]["condition"], "inProgress");
    *native.status.lock().unwrap() = "completed".into();
    let (_, idle) = wait(&state, json!({"targets":[{"threadId":"chat","afterCursor":active["results"][0]["cursor"]}],"timeoutMs":0})).await;
    assert_eq!(idle["status"], "timeout");
    assert!(!idle.to_string().contains("Visible answer"));
}
