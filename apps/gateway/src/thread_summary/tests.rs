use std::sync::Arc;

use serde_json::json;

use super::*;
use crate::{
    api::AppState,
    app_server::{tests::RecordingAppServer, InboundMessage},
    config::Config,
    events::{ingest_inbound, EventsQuery},
    events_replay::{event_matches, is_operational_replay_event},
    store::Store,
};

#[tokio::test]
async fn native_user_completion_refills_unknown_threads_globally_without_native_reads() {
    let native = Arc::new(RecordingAppServer::default());
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    let mut events = state.events.subscribe();
    ingest_inbound(InboundMessage::Notification {
        method: "item/completed".into(),
        params: json!({"threadId":"new-chat", "turnId":"first-turn", "item": {
            "id":"accepted", "type":"userMessage", "content":[{"type":"text", "text":"First prompt"}]
        }}),
    }, &state).await.unwrap();
    let mut delivered = Vec::new();
    while let Ok(event) = events.try_recv() {
        delivered.push(event);
    }
    let marker = delivered
        .iter()
        .find(|event| event.kind == THREAD_SUMMARY_CHANGED_EVENT)
        .unwrap();
    assert_eq!(marker.payload, json!({"threadId":"new-chat"}));
    assert!(delivered
        .iter()
        .any(|event| event.kind == "thread_view.patch" && event.seq < marker.seq));
    let query: EventsQuery =
        serde_json::from_value(json!({"threadIds":"other-chat", "includeGlobal":true})).unwrap();
    assert!(event_matches(marker, &query));
    assert!(is_operational_replay_event(marker));
    assert!(native.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn starts_agent_output_and_malformed_notifications_do_not_refill_summaries() {
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        Arc::new(RecordingAppServer::default()),
    );
    for (method, params) in [
        (
            "item/started",
            json!({"threadId":"t", "item":{"type":"userMessage"}}),
        ),
        (
            "item/completed",
            json!({"threadId":"t", "item":{"type":"agentMessage"}}),
        ),
        (
            "item/agentMessage/delta",
            json!({"threadId":"t", "delta":"text"}),
        ),
        ("item/completed", json!({"item":{"type":"userMessage"}})),
    ] {
        assert!(native_change_event(&state, method, &params)
            .await
            .unwrap()
            .is_none());
    }
}
