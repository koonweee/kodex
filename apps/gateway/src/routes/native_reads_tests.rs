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
    error::ApiError,
    store::Store,
    thread_view,
};

async fn state() -> (AppState, Arc<RecordingAppServer>) {
    let native = Arc::new(RecordingAppServer::default());
    native.ready.store(true, Ordering::SeqCst);
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    (state, native)
}

fn summary(status: &str) -> Value {
    json!({"thread": {
        "id":"thread-1", "cwd":"/workspace", "createdAt":1, "updatedAt":1,
        "status":{"type":status, "activeFlags":[]}, "turns":[]
    }})
}

fn headers(status: Value) -> Value {
    json!({"data":[{"id":"fresh-turn", "status":status, "items":[]}],
        "nextCursor":"older", "backwardsCursor":null})
}

async fn stale_projection(state: &AppState) {
    thread_view::record_item_delta(
        &state.thread_views,
        "thread-1",
        "stale-turn",
        "stale-item",
        "Existing transcript text",
        std::future::ready(Ok(1)),
    )
    .await
    .unwrap();
}

async fn stop(state: AppState, native: &RecordingAppServer) -> axum::response::Response {
    native
        .queued_responses
        .lock()
        .unwrap()
        .insert(0, json!({"goal":null}));
    build_router(state)
        .oneshot(
            Request::post("/v1/threads/thread-1/interrupt-current")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn body(response: axum::response::Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
}

#[tokio::test]
async fn file_preview_reads_only_native_metadata() {
    let (state, native) = state().await;
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("notes.md"), "# Preview\n").unwrap();
    let mut metadata = summary("idle");
    metadata["thread"]["cwd"] = json!(directory.path().display().to_string());
    native.queued_responses.lock().unwrap().push(metadata);
    let response = build_router(state)
        .oneshot(
            Request::get("/v1/threads/thread-1/files/preview?path=notes.md")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        &to_bytes(response.into_body(), usize::MAX).await.unwrap()[..],
        b"# Preview\n"
    );
    assert_eq!(
        *native.requests.lock().unwrap(),
        vec![(
            "thread/read".into(),
            json!({"threadId":"thread-1", "includeTurns":false})
        )]
    );
}

#[tokio::test]
async fn file_preview_maps_only_exact_native_missing_thread_failures() {
    for (error, expected) in [
        (
            ApiError::NativeRpc(crate::app_server::JsonRpcError {
                code: -32600,
                message: "thread not loaded: thread-1".into(),
                data: None,
            }),
            StatusCode::NOT_FOUND,
        ),
        (
            ApiError::NativeRpc(crate::app_server::JsonRpcError {
                code: -32600,
                message: "thread not found: thread-1".into(),
                data: None,
            }),
            StatusCode::NOT_FOUND,
        ),
        (
            ApiError::NativeRpc(crate::app_server::JsonRpcError {
                code: -32600,
                message: "no rollout found for thread id thread-1".into(),
                data: None,
            }),
            StatusCode::NOT_FOUND,
        ),
        (
            ApiError::BadGateway("thread read failed: unknown storage error".into()),
            StatusCode::BAD_GATEWAY,
        ),
        (
            ApiError::NativeRpc(crate::app_server::JsonRpcError {
                code: -32603,
                message: "thread not found: thread-1".into(),
                data: None,
            }),
            StatusCode::BAD_GATEWAY,
        ),
    ] {
        let (state, native) = state().await;
        native.queued_errors.lock().unwrap().push(error);
        let response = build_router(state)
            .oneshot(
                Request::get("/v1/threads/thread-1/files/preview?path=notes.md")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        assert_eq!(native.requests.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn stop_reads_native_active_header_without_replacing_transcript_projection() {
    let (state, native) = state().await;
    stale_projection(&state).await;
    let before = thread_view::patch_for_thread(&state.thread_views, "thread-1")
        .await
        .unwrap();
    native.queued_responses.lock().unwrap().extend([
        summary("active"),
        headers(json!("inProgress")),
        json!({}),
    ]);
    let response = stop(state.clone(), &native).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body(response).await["interruptedTurnId"], "fresh-turn");
    assert_eq!(
        *native.requests.lock().unwrap(),
        vec![
            ("thread/goal/get".into(), json!({"threadId":"thread-1"})),
            (
                "thread/read".into(),
                json!({"threadId":"thread-1", "includeTurns":false})
            ),
            (
                "thread/turns/list".into(),
                json!({"threadId":"thread-1", "cursor":null,
                "sortDirection":"desc", "itemsView":"notLoaded", "limit":1})
            ),
            (
                "turn/interrupt".into(),
                json!({"threadId":"thread-1", "turnId":"fresh-turn"})
            ),
        ]
    );
    let after = thread_view::patch_for_thread(&state.thread_views, "thread-1")
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(after).unwrap(),
        serde_json::to_value(before).unwrap()
    );
}

#[tokio::test]
async fn stop_ignores_stale_cached_turn_when_native_metadata_is_idle_or_unloaded() {
    for status in ["idle", "notLoaded", "systemError"] {
        let (state, native) = state().await;
        stale_projection(&state).await;
        native
            .queued_responses
            .lock()
            .unwrap()
            .push(summary(status));
        let response = stop(state, &native).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body(response).await["disposition"], "idle");
        assert_eq!(native.requests.lock().unwrap().len(), 2);
    }
}

#[tokio::test]
async fn stop_handles_native_turn_completion_between_metadata_and_header_reads() {
    let (state, native) = state().await;
    native
        .queued_responses
        .lock()
        .unwrap()
        .extend([summary("active"), headers(json!("completed"))]);
    let response = stop(state, &native).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body(response).await["disposition"], "idle");
    assert_eq!(native.requests.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn stop_rejects_invalid_native_turn_header_status() {
    for status in [Value::Null, json!("unknown"), json!({"type":"running"})] {
        let (state, native) = state().await;
        native
            .queued_responses
            .lock()
            .unwrap()
            .extend([summary("active"), headers(status)]);
        let response = stop(state, &native).await;
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(native.requests.lock().unwrap().len(), 3);
    }
}
