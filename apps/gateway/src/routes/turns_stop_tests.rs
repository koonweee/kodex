use std::{sync::atomic::Ordering, sync::Arc};

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::{json, Value};
use tower::ServiceExt;

use crate::{
    api::{build_router, AppState},
    app_server::tests::RecordingAppServer,
    config::Config,
    store::Store,
};

async fn state() -> (AppState, Arc<RecordingAppServer>) {
    let native = Arc::new(RecordingAppServer::default());
    native.ready.store(true, Ordering::SeqCst);
    (
        AppState::new(
            Config::default(),
            Store::in_memory().await.unwrap(),
            native.clone(),
        ),
        native,
    )
}

fn goal(status: &str) -> Value {
    json!({"threadId":"thread-1", "objective":"Finish the feature", "status":status,
        "tokenBudget":10000, "tokensUsed":123, "timeUsedSeconds":45, "createdAt":1, "updatedAt":2})
}

fn summary(status: &str) -> Value {
    json!({"thread":{"id":"thread-1", "cwd":"/workspace", "createdAt":1, "updatedAt":1,
        "status":{"type":status, "activeFlags":[]}, "turns":[]}})
}

fn active_header() -> Value {
    json!({"data":[{"id":"fresh-turn", "status":"inProgress", "items":[]}],
        "nextCursor":null, "backwardsCursor":null})
}

async fn stop(state: AppState) -> (StatusCode, Value) {
    let response = build_router(state)
        .oneshot(
            Request::post("/v1/threads/thread-1/interrupt-current")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    (status, body)
}

#[tokio::test]
async fn stop_pauses_active_goal_before_resolving_and_interrupting_current_turn() {
    let (state, native) = state().await;
    native.queued_responses.lock().unwrap().extend([
        json!({"goal":goal("active")}),
        json!({"goal":goal("paused")}),
        summary("active"),
        active_header(),
        json!({}),
    ]);
    let (status, body) = stop(state.clone()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["interruptedTurnId"], "fresh-turn");
    let requests = native.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .map(|(method, _)| method.as_str())
            .collect::<Vec<_>>(),
        [
            "thread/goal/get",
            "thread/goal/set",
            "thread/read",
            "thread/turns/list",
            "turn/interrupt"
        ]
    );
    assert_eq!(
        requests[1].1,
        json!({"threadId":"thread-1", "status":"paused"})
    );
    assert_eq!(
        requests[4].1,
        json!({"threadId":"thread-1", "turnId":"fresh-turn"})
    );
    drop(requests);
    assert_eq!(
        state.store.latest_event_seq().await.unwrap(),
        0,
        "native notifications own goal convergence"
    );
}

#[tokio::test]
async fn stop_does_not_create_or_rewrite_absent_and_inactive_goals() {
    for goal_reply in [
        json!({}),
        json!({"goal":null}),
        json!({"goal":goal("paused")}),
        json!({"goal":goal("blocked")}),
        json!({"goal":goal("usageLimited")}),
        json!({"goal":goal("budgetLimited")}),
        json!({"goal":goal("complete")}),
    ] {
        let (state, native) = state().await;
        native.queued_responses.lock().unwrap().extend([
            goal_reply,
            summary("active"),
            active_header(),
            json!({}),
        ]);
        let (status, body) = stop(state).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["interruptedTurnId"], "fresh-turn");
        assert_eq!(
            native
                .requests
                .lock()
                .unwrap()
                .iter()
                .map(|(method, _)| method.clone())
                .collect::<Vec<_>>(),
            [
                "thread/goal/get",
                "thread/read",
                "thread/turns/list",
                "turn/interrupt"
            ]
        );
    }
}

#[tokio::test]
async fn stop_pauses_goal_even_between_native_continuation_turns() {
    let (state, native) = state().await;
    native.queued_responses.lock().unwrap().extend([
        json!({"goal":goal("active")}),
        json!({"goal":goal("paused")}),
        summary("idle"),
    ]);
    let (status, body) = stop(state).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["disposition"], "idle");
    assert_eq!(body["interruptedTurnId"], Value::Null);
    assert_eq!(
        native
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|(method, _)| method.clone())
            .collect::<Vec<_>>(),
        ["thread/goal/get", "thread/goal/set", "thread/read"]
    );
}

#[tokio::test]
async fn stop_still_interrupts_after_a_failed_goal_read_and_surfaces_the_failure() {
    let (state, native) = state().await;
    native.queued_responses.lock().unwrap().extend([
        json!({"goal":{}}),
        summary("active"),
        active_header(),
        json!({}),
    ]);
    let (status, _) = stop(state).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(
        native.requests.lock().unwrap().last().unwrap(),
        &(
            "turn/interrupt".into(),
            json!({"threadId":"thread-1", "turnId":"fresh-turn"})
        )
    );
}

#[tokio::test]
async fn stop_still_interrupts_after_an_ambiguous_pause_reply_without_retrying() {
    let (state, native) = state().await;
    native.queued_responses.lock().unwrap().extend([
        json!({"goal":goal("active")}),
        json!({}),
        summary("active"),
        active_header(),
        json!({}),
    ]);
    let (status, _) = stop(state).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    let requests = native.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .filter(|(method, _)| method == "thread/goal/set")
            .count(),
        1
    );
    assert_eq!(requests.last().unwrap().0, "turn/interrupt");
}

#[tokio::test]
async fn stop_supports_threads_where_native_goals_are_unavailable() {
    for message in [
        "goals feature is disabled",
        "ephemeral thread does not support goals: thread-1",
    ] {
        let (state, native) = state().await;
        native
            .queued_errors
            .lock()
            .unwrap()
            .push(crate::error::ApiError::NativeRpc(
                crate::app_server::JsonRpcError {
                    code: -32600,
                    message: message.into(),
                    data: None,
                },
            ));
        native.queued_responses.lock().unwrap().extend([
            summary("active"),
            active_header(),
            json!({}),
        ]);
        let (status, body) = stop(state).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["interruptedTurnId"], "fresh-turn");
        let requests = native.requests.lock().unwrap();
        assert!(!requests
            .iter()
            .any(|(method, _)| method == "thread/goal/set"));
        assert_eq!(requests.last().unwrap().0, "turn/interrupt");
    }
}

#[tokio::test]
async fn stop_does_not_hide_other_native_goal_errors() {
    for (code, message) in [
        (-32603, "goals feature is disabled"),
        (
            -32600,
            "ephemeral thread does not support goals: other-thread",
        ),
        (-32600, "thread not found: thread-1"),
        (-32601, "Method not found"),
    ] {
        let (state, native) = state().await;
        native
            .queued_errors
            .lock()
            .unwrap()
            .push(crate::error::ApiError::NativeRpc(
                crate::app_server::JsonRpcError {
                    code,
                    message: message.into(),
                    data: None,
                },
            ));
        native.queued_responses.lock().unwrap().extend([
            summary("active"),
            active_header(),
            json!({}),
        ]);
        let (status, _) = stop(state).await;
        assert_ne!(status, StatusCode::OK);
        assert_eq!(
            native.requests.lock().unwrap().last().unwrap().0,
            "turn/interrupt"
        );
    }
}

#[tokio::test]
async fn stop_rejects_a_goal_for_another_thread_without_pausing_it() {
    let (state, native) = state().await;
    let mut wrong_goal = goal("active");
    wrong_goal["threadId"] = json!("other-thread");
    native.queued_responses.lock().unwrap().extend([
        json!({"goal":wrong_goal}),
        summary("active"),
        active_header(),
        json!({}),
    ]);
    let (status, _) = stop(state).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    let requests = native.requests.lock().unwrap();
    assert!(!requests
        .iter()
        .any(|(method, _)| method == "thread/goal/set"));
    assert_eq!(requests.last().unwrap().0, "turn/interrupt");
}
