use std::sync::Arc;

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
    (
        AppState::new(
            Config::default(),
            Store::in_memory().await.unwrap(),
            native.clone(),
        ),
        native,
    )
}

async fn request(state: &AppState, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
    let response = build_router(state.clone())
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}

#[tokio::test]
async fn native_identity_submission_uses_atomic_start_and_preserves_opaque_ids() {
    for (path, native_method) in [
        ("/v1/threads/native-chat/input", "turn/start"),
        ("/v1/threads/native-chat/turns", "turn/start"),
        (
            "/v1/threads/native-chat/turns/native-turn/steer",
            "turn/steer",
        ),
    ] {
        let (state, native) = state().await;
        *native.next_response.lock().unwrap() = Some(if native_method == "turn/start" {
            json!({"turn":{"id":"native-turn","status":"inProgress"}})
        } else {
            json!({"turnId":"native-turn"})
        });
        let client_id = " opaque 客户端 ID ";
        let (status, body) = request(
            &state,
            "POST",
            path,
            json!({
                "input":[{"type":"text","text":"same message"}],
                "clientUserMessageId":client_id
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            body.as_object().unwrap().keys().collect::<Vec<_>>(),
            vec!["payload"]
        );
        let calls = native.requests.lock().unwrap();
        assert_eq!(
            calls.len(),
            1,
            "atomic submission must not read local/native state or retry: {calls:?}"
        );
        assert_eq!(calls[0].0, native_method);
        assert_eq!(calls[0].1["clientUserMessageId"], client_id);
    }
}

#[tokio::test]
async fn native_identity_omitted_ids_get_distinct_gateway_ids_without_retrying_rejection() {
    let (state, native) = state().await;
    for _ in 0..2 {
        let (status, body) = request(
            &state,
            "POST",
            "/v1/threads/native-chat/turns",
            json!({"input":[{"type":"text","text":"same"}]}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    let ids = native
        .requests
        .lock()
        .unwrap()
        .iter()
        .map(|(_, payload)| payload["clientUserMessageId"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_ne!(ids[0], ids[1]);
    for (index, rejection) in ["failed to load rollout", "active turn cannot steer"]
        .into_iter()
        .enumerate()
    {
        native
            .queued_errors
            .lock()
            .unwrap()
            .push(crate::error::ApiError::BadGateway(rejection.into()));
        let (status, _) = request(
            &state,
            "POST",
            "/v1/threads/native-chat/input",
            json!({"input":[{"type":"text","text":"same"}],"clientUserMessageId":"rejected"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(native.requests.lock().unwrap().len(), 3 + index);
    }
}

#[tokio::test]
async fn native_identity_only_exact_requested_thread_absence_permits_resume() {
    for rejection in [
        "app-server error -32600: thread not found: other-chat",
        "app-server error -32603: thread not found: native-chat",
        "app-server error -32600: thread not found: native-chat-extra",
        "app-server error -32600: unknown thread state for native-chat",
        "app-server error -32600: no rollout found for thread id native-chat",
        "thread not found: native-chat",
    ] {
        let (state, native) = state().await;
        native
            .queued_errors
            .lock()
            .unwrap()
            .push(crate::error::ApiError::BadGateway(rejection.into()));
        let (status, body) = request(&state, "POST", "/v1/threads/native-chat/input", json!({
            "input":[{"type":"text","text":"one native attempt"}], "clientUserMessageId":"fixed-client"
        })).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY, "{rejection}: {body}");
        let calls = native.requests.lock().unwrap();
        assert_eq!(
            calls.len(),
            1,
            "nonmatching native error must not activate or resubmit: {rejection}: {calls:?}"
        );
        assert_eq!(calls[0].0, "turn/start");
        assert_eq!(calls[0].1["clientUserMessageId"], "fixed-client");
    }
}

#[tokio::test]
async fn native_identity_submission_ignores_stale_gateway_routing_state() {
    for status in [
        crate::app_server_api::ThreadLiveState::Streaming,
        crate::app_server_api::ThreadLiveState::Syncing,
    ] {
        let (state, native) = state().await;
        crate::thread_view::record_thread_live_state(
            &state.thread_views,
            "native-chat",
            status,
            std::future::ready(Ok(0)),
        )
        .await
        .unwrap();
        let (status, body) = request(
            &state,
            "POST",
            "/v1/threads/native-chat/input",
            json!({"input":[{"type":"text","text":"send now"}],"clientUserMessageId":"native-decision"}),
        ).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        {
            let calls = native.requests.lock().unwrap();
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0].0, "turn/start");
            assert_eq!(calls[0].1["clientUserMessageId"], "native-decision");
        }
    }
}
