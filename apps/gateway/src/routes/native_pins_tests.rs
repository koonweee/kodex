use std::sync::Arc;

use axum::{
    body::{to_bytes, Body},
    http::{Method, Request, StatusCode},
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

async fn request(state: &AppState, method: Method, path: &str, body: Value) -> (StatusCode, Value) {
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
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into()))
        },
    )
}

#[tokio::test]
async fn pinned_only_mutations_use_native_order_and_refill_both_clients() {
    let (state, native) = state().await;
    let mut first = state.events.subscribe();
    let mut second = state.events.subscribe();
    for (pinned, before) in [(true, Some("before")), (false, None)] {
        let (status, _) = request(
            &state,
            Method::POST,
            "/v1/threads/path-thread/pin",
            json!({"threadId":"wrong","pinned":pinned,"beforeThreadId":before}),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert_eq!(
            native.requests.lock().unwrap().last().unwrap(),
            &(
                "thread/section/move".into(),
                json!({"threadId":"path-thread",
                "sectionId":if pinned {Some(crate::app_server_api::PINNED_THREAD_SECTION_ID)} else {None},
                "beforeThreadId":before})
            )
        );
        for events in [&mut first, &mut second] {
            let event = events.try_recv().unwrap();
            assert_eq!(event.kind, "thread.pins_updated");
            assert_eq!(event.payload, json!({}));
            assert!(crate::events_replay::is_operational_replay_event(&event));
        }
    }
    let (status, _) = request(
        &state,
        Method::POST,
        "/v1/self-control/threads/path-thread/pin",
        json!({"pinned":true,"source":{"sourceThreadId":"origin"}}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        native.requests.lock().unwrap().last().unwrap().0,
        "thread/section/move"
    );
}

#[tokio::test]
async fn custom_section_routes_are_removed_without_native_mutations() {
    let (mut state, native) = state().await;
    let frontend = tempfile::tempdir().unwrap();
    std::fs::write(frontend.path().join("index.html"), "<main>Frontend</main>").unwrap();
    Arc::make_mut(&mut state.config).frontend.dist_dir = Some(frontend.path().to_path_buf());
    for (method, path) in [
        (Method::GET, "/v1/thread-sections"),
        (Method::POST, "/v1/thread-sections"),
        (Method::PATCH, "/v1/thread-sections/custom"),
        (Method::DELETE, "/v1/thread-sections/custom"),
        (Method::GET, "/v1/thread-sections/custom/threads"),
        (Method::POST, "/v1/threads/thread/section"),
        (Method::POST, "/v1/self-control/thread-sections"),
        (Method::PATCH, "/v1/self-control/thread-sections/custom"),
        (Method::DELETE, "/v1/self-control/thread-sections/custom"),
        (Method::POST, "/v1/self-control/threads/thread/section"),
    ] {
        let (status, _) = request(
            &state,
            method,
            path,
            json!({"name":"Test","sectionId":"custom"}),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
    }
    assert!(native.requests.lock().unwrap().is_empty());
}

fn native_thread(id: &str, section: Value, project: Value) -> Value {
    json!({"id":id,"cwd":"/workspace","projectId":project,"section":section,
        "createdAt":1,"updatedAt":2,"status":{"type":"idle"}})
}

#[tokio::test]
async fn pinned_page_keeps_native_order_cursor_and_hides_custom_metadata() {
    let (state, native) = state().await;
    let pinned = json!({"id":crate::app_server_api::PINNED_THREAD_SECTION_ID,"name":"Pinned","appearance":null});
    *native.next_response.lock().unwrap() = Some(json!({"data":[
        native_thread("z",pinned.clone(),json!("project")),
        native_thread("a",pinned,json!("project"))],"nextCursor":"next","backwardsCursor":"previous"}));
    let (status, body) = request(
        &state,
        Method::GET,
        "/v1/pinned-threads?cursor=page&limit=2",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["threads"][0]["id"], "z");
    assert_eq!(body["threads"][1]["id"], "a");
    assert_eq!(body["threads"][0]["pinned"], true);
    assert!(body["threads"][0].get("section").is_none());
    assert_eq!(body["nextCursor"], "next");
    assert_eq!(body["backwardsCursor"], "previous");
    let calls = native.requests.lock().unwrap();
    let params = &calls[0].1;
    assert_eq!(
        params["sectionId"],
        crate::app_server_api::PINNED_THREAD_SECTION_ID
    );
    assert_eq!(params["sortKey"], "section_position");
    assert_eq!(params["sortDirection"], "asc");
    assert_eq!(params["cursor"], "page");
    assert_eq!(params["limit"], 2);
    assert!(!calls.iter().any(|(method, _)| method == "thread/read"));
}

#[tokio::test]
async fn existing_custom_section_members_stay_visible_in_projects_and_chats() {
    let (state, native) = state().await;
    let custom = json!({"id":"existing-custom","name":"Keep native storage","appearance":null});
    for (path, project) in [
        ("/v1/chats/threads", Value::Null),
        ("/v1/threads?projectId=project", json!("project")),
    ] {
        *native.next_response.lock().unwrap() = Some(
            json!({"data":[native_thread("retained",custom.clone(),project)],"nextCursor":null}),
        );
        let (status, body) = request(&state, Method::GET, path, Value::Null).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["threads"][0]["id"], "retained");
        assert_eq!(body["threads"][0]["pinned"], false);
        let calls = native.requests.lock().unwrap();
        let (_, params) = calls
            .iter()
            .rev()
            .find(|(method, _)| method == "thread/list")
            .unwrap();
        assert!(
            params.get("sectionId").is_none(),
            "null would exclude retained custom membership"
        );
    }
    let (status, body) = request(&state, Method::GET, "/v1/sidebar/threads", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.get("pinnedThreads").is_some());
    assert!(body.get("sections").is_none());
    assert!(body.get("sectionThreads").is_none());
    assert!(!native
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|(method, _)| method.starts_with("threadSection/")));
}

#[tokio::test]
async fn invalid_or_rejected_pin_does_not_emit_a_success_marker() {
    let (state, native) = state().await;
    let mut events = state.events.subscribe();
    let (status, _) = request(
        &state,
        Method::POST,
        "/v1/threads/thread/pin",
        json!({"beforeThreadId":"a"}),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(native.requests.lock().unwrap().is_empty());
    native
        .queued_errors
        .lock()
        .unwrap()
        .push(crate::error::ApiError::BadGateway("native refused".into()));
    let (status, _) = request(
        &state,
        Method::POST,
        "/v1/threads/thread/pin",
        json!({"pinned":true}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert!(events.try_recv().is_err());
}
