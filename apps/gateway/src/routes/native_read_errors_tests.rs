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
};

#[tokio::test]
async fn native_history_failures_return_without_hidden_rollout_retries() {
    for message in [
        "app-server error -32603: failed to load rollout `/owned/thread.jsonl`",
        "app-server error -32603: failed to read thread: rollout at /owned/thread.jsonl is empty",
        "app-server error -32603: FAILED TO LOAD THREAD HISTORY",
    ] {
        let native = Arc::new(RecordingAppServer::default());
        native.ready.store(true, Ordering::SeqCst);
        native
            .queued_errors
            .lock()
            .unwrap()
            .push(ApiError::BadGateway(message.to_owned()));
        let app = build_router(AppState::new(
            Config::default(),
            Store::in_memory().await.unwrap(),
            native.clone(),
        ));
        let response = app
            .oneshot(
                Request::get("/v1/threads/thread-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY, "{message}");
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body["message"], message);
        assert_eq!(
            *native.requests.lock().unwrap(),
            vec![(
                "thread/read".to_owned(),
                json!({"threadId":"thread-1", "includeTurns":false})
            )]
        );
    }
}
