use crate::{
    api::{build_router, AppState},
    app_server::tests::RecordingAppServer,
    config::Config,
    store::Store,
};
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::{json, Value};
use std::sync::Arc;
use tower::ServiceExt;

async fn state(home: &std::path::Path) -> (AppState, Arc<RecordingAppServer>) {
    let native = Arc::new(RecordingAppServer::default());
    let mut config = Config::default();
    config.projects.home_dir = home.to_owned();
    (
        AppState::new(config, Store::in_memory().await.unwrap(), native.clone()),
        native,
    )
}

async fn post(state: &AppState, path: &str, input: Value) -> (StatusCode, Value) {
    let response = build_router(state.clone())
        .oneshot(
            Request::post(path)
                .header("content-type", "application/json")
                .body(Body::from(input.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body =
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes)));
    (status, body)
}

#[tokio::test]
async fn projectless_creation_uses_chat_directory_and_cannot_inject_project() {
    let home = tempfile::tempdir().unwrap();
    let (state, native) = state(home.path()).await;
    let mut observer = state.events.subscribe();
    let (status, body) = post(
        &state,
        "/v1/self-control/threads",
        json!({"model":"test-model", "payload":{"projectId":"foreign"}}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let event = tokio::time::timeout(std::time::Duration::from_secs(1), async {
        loop {
            let event = observer.recv().await.unwrap();
            if event.kind == "thread.upserted" {
                break event;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(event.payload["scope"], "chat");
    assert!(event.project_id.is_none());
    let replay = build_router(state.clone())
        .oneshot(Request::get("/v1/events").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let replay: Value =
        serde_json::from_slice(&to_bytes(replay.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert!(replay["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["kind"] == "thread.upserted" && row["payload"] == event.payload));
    let requests = native.requests.lock().unwrap();
    let payload = &requests
        .iter()
        .find(|(method, _)| method == "thread/start")
        .unwrap()
        .1;
    assert!(payload["projectId"].is_null());
    let cwd = std::path::Path::new(payload["cwd"].as_str().unwrap());
    assert!(
        cwd.starts_with(home.path().canonicalize().unwrap().join("Documents/Codex"))
            && cwd.is_dir()
    );
    assert_eq!(payload["model"], "test-model");
    assert!(!requests
        .iter()
        .any(|(method, _)| method == "project/create"));
}

#[tokio::test]
async fn projectless_creation_validates_explicit_directory() {
    let home = tempfile::tempdir().unwrap();
    let (state, native) = state(home.path()).await;
    let (status, _) = post(
        &state,
        "/v1/self-control/threads",
        json!({"cwd":"relative"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(native.requests.lock().unwrap().is_empty());
    let (status, body) = post(
        &state,
        "/v1/self-control/threads",
        json!({"cwd":home.path()}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let requests = native.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .find(|(m, _)| m == "thread/start")
            .unwrap()
            .1["cwd"],
        home.path().to_string_lossy().as_ref()
    );
}

#[tokio::test]
async fn projectless_spawn_replay_does_not_create_or_submit_twice() {
    let home = tempfile::tempdir().unwrap();
    let (state, native) = state(home.path()).await;
    let input =
        json!({"input":[{"type":"text","text":"hello"}],"idempotencyKey":"standalone-spawn"});
    let (status, first) = post(&state, "/v1/self-control/thread-spawns", input.clone()).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let (status, replay) = post(&state, "/v1/self-control/thread-spawns", input).await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(first["threadId"], replay["threadId"]);
    assert_eq!(replay["idempotentReplay"], true);
    let requests = native.requests.lock().unwrap();
    for method in ["thread/start", "thread/queue/add"] {
        assert_eq!(requests.iter().filter(|(m, _)| m == method).count(), 1);
    }
}

#[tokio::test]
async fn archived_discovery_forwards_native_filter_and_pagination_without_activation() {
    let home = tempfile::tempdir().unwrap();
    let (state, native) = state(home.path()).await;
    *native.next_response.lock().unwrap() =
        Some(json!({"data":[],"nextCursor":"next","backwardsCursor":null}));
    let response = build_router(state)
        .oneshot(
            Request::get(
                "/v1/self-control/threads?archived=true&projectId=project-1&cursor=page&limit=5",
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["nextCursor"], "next");
    let requests = native.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].0, "thread/list");
    assert_eq!(requests[0].1["archived"], true);
    assert_eq!(requests[0].1["projectId"], "project-1");
    assert_eq!(requests[0].1["cursor"], "page");
    assert_eq!(requests[0].1["limit"], 5);
}

#[tokio::test]
async fn unarchive_notifies_other_clients_and_replays_refill() {
    let home = tempfile::tempdir().unwrap();
    let (state, native) = state(home.path()).await;
    let mut observer = state.events.subscribe();
    let (status, body) = post(
        &state,
        "/v1/self-control/threads/thread-1/unarchive",
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let event = tokio::time::timeout(std::time::Duration::from_secs(1), observer.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event.kind, "thread.subagents_changed");
    assert_eq!(event.payload["changedThreadId"], "thread-1");
    let response = build_router(state)
        .oneshot(Request::get("/v1/events").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let replay: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert!(replay["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["kind"] == event.kind && row["payload"] == event.payload));
    let requests = native.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .filter(|(method, _)| method == "thread/unarchive")
            .count(),
        1
    );
    assert!(!requests.iter().any(|(method, _)| method == "thread/resume"));
}

#[tokio::test]
async fn archived_discovery_rejects_unbounded_pages_and_surfaces_read_errors() {
    let home = tempfile::tempdir().unwrap();
    let (state, native) = state(home.path()).await;
    for limit in [0, 101] {
        let response = build_router(state.clone())
            .oneshot(
                Request::get(format!(
                    "/v1/self-control/threads?archived=true&limit={limit}"
                ))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    assert!(native.requests.lock().unwrap().is_empty());
    *native.next_response.lock().unwrap() = Some(json!({"malformed":true}));
    let response = build_router(state)
        .oneshot(
            Request::get("/v1/self-control/threads?archived=true")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let requests = native.requests.lock().unwrap();
    assert!(requests[0].1.get("projectId").is_none());
    assert_eq!(requests[0].1["limit"], 50);
}

#[tokio::test]
async fn control_notifications_persist_and_notify_other_clients_without_activation() {
    let home = tempfile::tempdir().unwrap();
    let (state, native) = state(home.path()).await;
    let mut observer = state.events.subscribe();
    for enabled in [false, true] {
        let response = build_router(state.clone())
            .oneshot(
                Request::patch("/v1/self-control/threads/thread-1/notifications")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"enabled":enabled,"source":{"sourceThreadId":"caller"}}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body["notificationsEnabled"], enabled);
        assert_eq!(
            state
                .store
                .thread_notifications_enabled("thread-1")
                .await
                .unwrap(),
            enabled
        );
        let event = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                let event = observer.recv().await.unwrap();
                if event.kind == "thread.notifications_updated" {
                    break event;
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(event.payload["notificationsEnabled"], enabled);
        let replay = build_router(state.clone())
            .oneshot(Request::get("/v1/events").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let replay: Value =
            serde_json::from_slice(&to_bytes(replay.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert!(replay["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["kind"] == event.kind && row["payload"] == event.payload));
        let audits = state
            .store
            .replay_events(None, None, Some("thread-1".into()))
            .await
            .unwrap();
        assert!(audits.iter().any(
            |row| row.kind == "self_control.thread_notifications_updated"
                && row.payload["source"]["sourceThreadId"] == "caller"
        ));
    }
    assert!(native.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn control_automation_accepts_fresh_chat_target_without_creating_chat() {
    let home = tempfile::tempdir().unwrap();
    let (state, native) = state(home.path()).await;
    let (status, body) = post(
        &state,
        "/v1/self-control/automations",
        json!({
            "name":"Fresh report", "prompt":"Report progress", "newThread":{"cwd":home.path()},
            "schedule":{"startAt":"2026-10-12T00:00:00Z","repeatEvery":{"value":1,"unit":"hours"}}
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["automation"]["newThread"]["cwd"],
        home.path().to_string_lossy().as_ref()
    );
    assert!(body["automation"]["targetThreadId"].is_null());
    assert_eq!(body["pausedByDefault"], true);
    assert!(!native
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|(method, _)| method == "thread/start"));
}

#[tokio::test]
async fn fresh_automation_rejects_ambiguous_target_and_relative_directory() {
    let home = tempfile::tempdir().unwrap();
    let (state, native) = state(home.path()).await;
    for target in [
        json!({}),
        json!({"targetThreadId":"existing", "newThread":{}}),
        json!({"newThread":{"cwd":"relative"}}),
    ] {
        let mut request = json!({"name":"Report","prompt":"Report","schedule":{"startAt":"2026-10-12T00:00:00Z","repeatEvery":{"value":1,"unit":"hours"}}});
        request
            .as_object_mut()
            .unwrap()
            .extend(target.as_object().unwrap().clone());
        let (status, body) = post(&state, "/v1/self-control/automations", request).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    }
    assert!(native.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn fresh_project_automation_uses_native_root_and_rejects_an_override() {
    let home = tempfile::tempdir().unwrap();
    let (state, native) = state(home.path()).await;
    native.native_projects.lock().unwrap().insert("project".into(), json!({
        "id":"project", "name":"Project", "roots":[{"path":home.path()}], "metadata":{}, "position":0,"createdAt":1,"updatedAt":2
    }));
    let mut request = json!({"name":"Report","prompt":"Report","newThread":{"projectId":"project"},"schedule":{"startAt":"2030-01-01T00:00:00Z","repeatEvery":{"value":1,"unit":"hours"}}});
    let (status, body) = post(&state, "/v1/self-control/automations", request.clone()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let id = body["automation"]["id"].as_str().unwrap();
    let (status, result) = post(
        &state,
        &format!("/v1/self-control/automations/{id}/run-now"),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert!(result["run"]["targetThreadId"].is_string());
    let starts: Vec<_> = native
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|(m, _)| m == "thread/start")
        .cloned()
        .collect();
    assert_eq!(starts.len(), 1);
    assert_eq!(starts[0].1["projectId"], "project");
    assert_eq!(starts[0].1["cwd"], home.path().to_string_lossy().as_ref());
    request["newThread"]["cwd"] = json!("/outside");
    let (status, _) = post(&state, "/v1/self-control/automations", request).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        native
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, _)| m == "thread/start")
            .count(),
        1
    );
}
