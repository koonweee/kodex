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

#[tokio::test]
async fn native_settings_read_uses_the_full_effective_resume_response() {
    let (state, native) = state().await;
    native.queued_responses.lock().unwrap().push(json!({
        "thread": {"id":"thread-1","cwd":"/tmp","createdAt":1,"updatedAt":2,"status":{"type":"idle"}},
        "model":"custom-native-model", "reasoningEffort":"high", "serviceTier":"fast",
        "activePermissionProfile":{"id":"custom-profile","extends":":workspace"}
    }));
    let response = build_router(state)
        .oneshot(
            Request::get("/v1/threads/thread-1/settings")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(
        body,
        json!({"model":"custom-native-model","effort":"high","serviceTier":"fast","activePermissionProfile":{"id":"custom-profile","extends":":workspace"}})
    );
    let calls = native.requests.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "thread/resume");
    assert_eq!(calls[0].1["threadId"], "thread-1");
    assert!(calls[0].1.get("model").is_none());
    assert!(calls[0].1.get("serviceTier").is_none());
}

#[tokio::test]
async fn native_settings_write_ack_does_not_publish_unapplied_values() {
    let (state, native) = state().await;
    let response = build_router(state.clone())
        .oneshot(
            Request::patch("/v1/threads/thread-1/settings")
                .header("content-type", "application/json")
                .body(Body::from(json!({"serviceTier":null}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body, json!({}));
    let calls = native.requests.lock().unwrap();
    assert_eq!(
        calls.as_slice(),
        &[(
            "thread/settings/update".into(),
            json!({"threadId":"thread-1","serviceTier":null})
        )]
    );
    drop(calls);
    assert_eq!(state.store.latest_event_seq().await.unwrap(), 0);
}

#[tokio::test]
async fn applied_native_settings_notification_only_invalidates_authoritative_reads() {
    let (state, native) = state().await;
    ingest_inbound(InboundMessage::Notification {
        method: "thread/settings/updated".into(),
        params: json!({"threadId":"thread-1","threadSettings":{
            "model":"custom-native-model","modelProvider":"openai","effort":"high","serviceTier":null,
            "cwd":"/tmp","approvalPolicy":"on-request","approvalsReviewer":"user",
            "sandboxPolicy":{"type":"workspaceWrite","writableRoots":[]},
            "collaborationMode":{"mode":"default","settings":{"model":"custom-native-model","reasoning_effort":"high","developer_instructions":null}},
            "activePermissionProfile":null
        }}),
    }, &state).await.unwrap();
    assert!(native.requests.lock().unwrap().is_empty());
    let events = state.store.replay_events(None, None, None).await.unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, "thread.settings_updated");
    assert_eq!(events[0].payload, json!({"threadId":"thread-1"}));
    let query: crate::events::EventsQuery = serde_json::from_value(json!({
        "threadIds":"other-pane", "includeGlobal":true
    }))
    .unwrap();
    let replay = crate::events_replay::workspace_sse_replay_events(events, &query).unwrap();
    assert_eq!(
        replay.len(),
        1,
        "settings refills must reach other tabs/panes and replay after reconnect"
    );
}

#[tokio::test]
async fn draft_effort_is_native_session_config_without_losing_other_overrides() {
    let (state, native) = state().await;
    let project = native.seed_project("Draft settings".into(), "/tmp".into());
    let response = build_router(state).oneshot(Request::post("/v1/threads")
        .header("content-type", "application/json")
        .body(Body::from(json!({"projectId":project.id,"effort":"xhigh","payload":{"config":{"unrelated":"retained"}}}).to_string())).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let calls = native.requests.lock().unwrap();
    let start = calls
        .iter()
        .find(|(method, _)| method == "thread/start")
        .unwrap();
    assert_eq!(
        start.1["config"],
        json!({"unrelated":"retained","model_reasoning_effort":"xhigh"})
    );
    assert!(start.1.get("effort").is_none());
    assert!(start.1.get("reasoningEffort").is_none());
}
