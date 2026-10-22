use std::sync::Arc;

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::{json, Value};
use tower::ServiceExt;

use crate::{
    api::{build_router, AppState},
    app_server::{tests::RecordingAppServer, InboundMessage},
    config::Config,
    events::ingest_inbound,
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

fn thread(id: &str, name: &str, ephemeral: bool, forked_from_id: Option<&str>) -> Value {
    json!({
        "id": id,
        "cliVersion": "0.160.0",
        "cwd": "/workspace",
        "ephemeral": ephemeral,
        "forkedFromId": forked_from_id,
        "modelProvider": "openai",
        "name": name,
        "preview": name,
        "source": "cli",
        "status": {"type": "idle"},
        "turns": [],
        "createdAt": 1_767_225_600_i64,
        "updatedAt": 1_767_225_600_i64
    })
}

async fn request(state: &AppState, method: &str, path: &str) -> (StatusCode, Value) {
    let response = build_router(state.clone())
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, body)
}

fn seed_create(native: &RecordingAppServer) {
    native.queued_responses.lock().unwrap().extend([
        json!({"thread": thread("parent", "Parent title", false, None)}),
        json!({
            "thread": thread("side", "Parent title", true, Some("parent")),
            "cwd": "/workspace",
            "model": "gpt-5.4",
            "modelProvider": "openai"
        }),
    ]);
}

fn seed_named_create(native: &RecordingAppServer, parent_id: &str, child_id: &str) {
    native.queued_responses.lock().unwrap().extend([
        json!({"thread": thread(parent_id, parent_id, false, None)}),
        json!({
            "thread": thread(child_id, parent_id, true, Some(parent_id)),
            "cwd": "/workspace",
            "model": "gpt-5.4",
            "modelProvider": "openai"
        }),
    ]);
}

#[tokio::test]
async fn concurrent_create_reuses_one_ephemeral_fork_and_starts_with_empty_projection() {
    let (state, native) = state().await;
    seed_create(&native);

    let (first, second) = tokio::join!(
        request(&state, "POST", "/v1/threads/parent/side-thread"),
        request(&state, "POST", "/v1/threads/parent/side-thread"),
    );

    assert_eq!(first.0, StatusCode::OK, "{}", first.1);
    assert_eq!(second.0, StatusCode::OK, "{}", second.1);
    assert_eq!(first.1["thread"]["id"], "side");
    assert_eq!(second.1["thread"]["id"], "side");
    assert_eq!(first.1["parentThread"]["id"], "parent");
    assert_eq!(first.1["timeline"]["rows"], json!([]));
    assert_eq!(first.1["timeline"]["turns"], json!([]));
    assert_ne!(first.1["reused"], second.1["reused"]);

    let calls = native.requests.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .filter(|(method, _)| method == "thread/fork")
            .count(),
        1
    );
    let fork = calls
        .iter()
        .find(|(method, _)| method == "thread/fork")
        .unwrap();
    assert_eq!(
        fork.1,
        json!({"threadId":"parent", "ephemeral":true, "excludeTurns":true})
    );
    drop(calls);
    assert!(state
        .store
        .replay_events(None, None, None)
        .await
        .unwrap()
        .is_empty());
    assert!(
        !state
            .store
            .get_thread_read("side")
            .await
            .unwrap()
            .read_state_known
    );
}

#[tokio::test]
async fn different_parents_get_independent_children_and_side_children_cannot_nest() {
    let (state, native) = state().await;
    seed_named_create(&native, "parent-a", "side-a");
    seed_named_create(&native, "parent-b", "side-b");

    let (first_status, first) = request(&state, "POST", "/v1/threads/parent-a/side-thread").await;
    let (second_status, second) = request(&state, "POST", "/v1/threads/parent-b/side-thread").await;
    assert_eq!(first_status, StatusCode::OK, "{first}");
    assert_eq!(second_status, StatusCode::OK, "{second}");
    assert_eq!(first["thread"]["id"], "side-a");
    assert_eq!(second["thread"]["id"], "side-b");

    native.requests.lock().unwrap().clear();
    let (nested_status, nested) = request(&state, "POST", "/v1/threads/side-a/side-thread").await;
    assert_eq!(nested_status, StatusCode::BAD_REQUEST, "{nested}");
    assert!(native.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn get_refreshes_parent_metadata_without_native_resume_or_history_reads() {
    let (state, native) = state().await;
    seed_create(&native);
    let (status, body) = request(&state, "POST", "/v1/threads/parent/side-thread").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    native.requests.lock().unwrap().clear();
    native.queued_responses.lock().unwrap().push(json!({
        "thread": thread("parent", "Updated parent title", false, None)
    }));

    let (status, body) = request(&state, "GET", "/v1/threads/parent/side-thread").await;

    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["thread"]["id"], "side");
    assert_eq!(body["parentThread"]["name"], "Updated parent title");
    assert_eq!(body["timeline"]["rows"], json!([]));
    assert_eq!(
        native.requests.lock().unwrap().as_slice(),
        &[(
            "thread/read".into(),
            json!({"threadId":"parent", "includeTurns":false})
        )]
    );
}

#[tokio::test]
async fn delete_is_idempotent_and_unsubscribes_the_active_child_once() {
    let (state, native) = state().await;
    seed_create(&native);
    let (status, body) = request(&state, "POST", "/v1/threads/parent/side-thread").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    native.requests.lock().unwrap().clear();

    let (first_status, first) = request(&state, "DELETE", "/v1/threads/parent/side-thread").await;
    let (second_status, second) = request(&state, "DELETE", "/v1/threads/parent/side-thread").await;

    assert_eq!(first_status, StatusCode::OK, "{first}");
    assert_eq!(first["closed"], true);
    assert_eq!(first["sideThreadId"], "side");
    assert_eq!(second_status, StatusCode::OK, "{second}");
    assert_eq!(second["closed"], false);
    assert_eq!(
        native.requests.lock().unwrap().as_slice(),
        &[("thread/unsubscribe".into(), json!({"threadId":"side"}))]
    );
    let (status, _) = request(&state, "GET", "/v1/threads/parent/side-thread").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn side_completion_stays_canonical_without_read_or_push_projection() {
    let (state, native) = state().await;
    seed_create(&native);
    let (status, body) = request(&state, "POST", "/v1/threads/parent/side-thread").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let mut receiver = state.events.subscribe();

    ingest_inbound(
        InboundMessage::Notification {
            method: "turn/completed".into(),
            params: json!({
                "threadId":"side",
                "turn":{"id":"side-turn","status":"completed"}
            }),
        },
        &state,
    )
    .await
    .unwrap();

    let mut broadcast_kinds = Vec::new();
    while let Ok(event) = receiver.try_recv() {
        broadcast_kinds.push(event.kind);
    }
    let events = state
        .store
        .replay_events(None, None, Some("side".into()))
        .await
        .unwrap();
    assert!(broadcast_kinds
        .iter()
        .any(|kind| kind == "thread_view.patch"));
    assert!(events.iter().all(|event| {
        event.kind != "thread.read_updated" && event.kind != "notification.planned"
    }));
    assert!(
        state
            .store
            .get_thread_read("side")
            .await
            .unwrap()
            .read_state_known
            == false
    );
}

#[tokio::test]
async fn native_close_and_disconnect_expire_registered_side_threads() {
    let (state, native) = state().await;
    seed_create(&native);
    let (status, body) = request(&state, "POST", "/v1/threads/parent/side-thread").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let mut receiver = state.events.subscribe();

    ingest_inbound(
        InboundMessage::Notification {
            method: "thread/closed".into(),
            params: json!({"threadId":"side"}),
        },
        &state,
    )
    .await
    .unwrap();

    let closed = receiver.recv().await.unwrap();
    assert_eq!(closed.kind, "side_thread.closed");
    assert_eq!(closed.payload["reason"], "native_closed");
    assert!(state.thread_views.snapshot("side").await.is_none());
    assert_eq!(
        request(&state, "GET", "/v1/threads/parent/side-thread")
            .await
            .0,
        StatusCode::NOT_FOUND
    );

    seed_create(&native);
    native.queued_responses.lock().unwrap()[1]["thread"]["id"] = json!("side-2");
    let (status, body) = request(&state, "POST", "/v1/threads/parent/side-thread").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    ingest_inbound(InboundMessage::Disconnected, &state)
        .await
        .unwrap();
    assert!(state.thread_views.snapshot("side-2").await.is_none());
    assert_eq!(
        request(&state, "GET", "/v1/threads/parent/side-thread")
            .await
            .0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn closing_active_side_turn_interrupts_before_unsubscribe_and_ignores_late_events() {
    let (state, native) = state().await;
    seed_create(&native);
    let (status, body) = request(&state, "POST", "/v1/threads/parent/side-thread").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    ingest_inbound(
        InboundMessage::Notification {
            method: "turn/started".into(),
            params: json!({
                "threadId":"side",
                "turn":{"id":"active-side-turn","status":"inProgress"}
            }),
        },
        &state,
    )
    .await
    .unwrap();
    native.requests.lock().unwrap().clear();

    let (status, body) = request(&state, "DELETE", "/v1/threads/parent/side-thread").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        native.requests.lock().unwrap().as_slice(),
        &[
            (
                "turn/interrupt".into(),
                json!({"threadId":"side", "turnId":"active-side-turn"})
            ),
            ("thread/unsubscribe".into(), json!({"threadId":"side"}))
        ]
    );

    ingest_inbound(
        InboundMessage::Notification {
            method: "item/completed".into(),
            params: json!({
                "threadId":"side",
                "turnId":"active-side-turn",
                "item":{"id":"late", "type":"agentMessage", "text":"late"}
            }),
        },
        &state,
    )
    .await
    .unwrap();
    assert!(state.thread_views.snapshot("side").await.is_none());
}

#[tokio::test]
async fn stop_uses_the_side_projection_without_unsupported_native_reads() {
    let (state, native) = state().await;
    seed_create(&native);
    let (status, body) = request(&state, "POST", "/v1/threads/parent/side-thread").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    ingest_inbound(
        InboundMessage::Notification {
            method: "turn/started".into(),
            params: json!({
                "threadId":"side",
                "turn":{"id":"active-side-turn","status":"inProgress"}
            }),
        },
        &state,
    )
    .await
    .unwrap();
    native.requests.lock().unwrap().clear();

    let (status, body) = request(&state, "POST", "/v1/threads/side/interrupt-current").await;

    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["disposition"], "interrupted");
    assert_eq!(body["interruptedTurnId"], "active-side-turn");
    assert_eq!(
        native.requests.lock().unwrap().as_slice(),
        &[(
            "turn/interrupt".into(),
            json!({"threadId":"side", "turnId":"active-side-turn"})
        )]
    );
}
