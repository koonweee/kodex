use serde_json::json;

use super::{QueueSteerGuards, QueueSteerToken};

fn capture(guards: &QueueSteerGuards, thread: &str, turn: &str) -> QueueSteerToken {
    guards
        .capture_after_probe(guards.begin_probe(thread), Some(turn))
        .unwrap()
}

#[test]
fn late_native_reads_cannot_restore_a_retired_probe() {
    for (method, params) in [
        (
            "turn/completed",
            json!({"threadId":"chat","turn":{"id":"turn"}}),
        ),
        (
            "turn/started",
            json!({"threadId":"chat","turn":{"id":"next"}}),
        ),
        ("thread/reverted", json!({"threadId":"chat"})),
        ("thread/closed", json!({"threadId":"chat"})),
        ("thread/archived", json!({"threadId":"chat"})),
        ("thread/deleted", json!({"threadId":"chat"})),
        (
            "thread/status/changed",
            json!({"threadId":"chat","status":{"type":"idle"}}),
        ),
        (
            "thread/status/changed",
            json!({"threadId":"chat","status":{"type":"notLoaded"}}),
        ),
        (
            "thread/status/changed",
            json!({"threadId":"chat","status":{"type":"systemError"}}),
        ),
        ("disconnected", json!({})),
    ] {
        let guards = QueueSteerGuards::default();
        let held_probe = guards.begin_probe("chat");
        if method == "disconnected" {
            guards.invalidate_all();
        } else {
            guards.observe_notification(method, &params);
        }
        let current_probe = guards.begin_probe("chat");
        assert!(
            guards
                .capture_after_probe(held_probe, Some("turn"))
                .is_none(),
            "{method}"
        );
        let current = guards
            .capture_after_probe(current_probe, Some("turn"))
            .unwrap();
        assert!(guards.is_current(&current), "{method}");
    }
}

#[test]
fn turn_end_change_reset_and_disconnect_retire_bound_tokens() {
    for (method, params) in [
        (
            "turn/completed",
            json!({"threadId":"chat","turn":{"id":"turn"}}),
        ),
        (
            "turn/started",
            json!({"threadId":"chat","turn":{"id":"next"}}),
        ),
        ("thread/reverted", json!({"threadId":"chat"})),
        ("thread/closed", json!({"threadId":"chat"})),
        ("thread/archived", json!({"threadId":"chat"})),
        ("thread/deleted", json!({"threadId":"chat"})),
        (
            "thread/status/changed",
            json!({"threadId":"chat","status":{"type":"idle"}}),
        ),
        (
            "thread/status/changed",
            json!({"threadId":"chat","status":{"type":"notLoaded"}}),
        ),
        (
            "thread/status/changed",
            json!({"threadId":"chat","status":{"type":"systemError"}}),
        ),
        ("disconnected", json!({})),
    ] {
        let guards = QueueSteerGuards::default();
        let held_token = capture(&guards, "chat", "turn");
        if method == "disconnected" {
            guards.invalidate_all();
        } else {
            guards.observe_notification(method, &params);
        }
        assert!(!guards.is_current(&held_token), "{method}");
        let current = capture(&guards, "chat", "turn");
        assert!(guards.is_current(&current));
        assert!(
            !guards.is_current(&held_token),
            "same turn ID must not restore an old operation"
        );
    }
}

#[test]
fn duplicate_current_start_and_older_completion_preserve_bound_token() {
    let guards = QueueSteerGuards::default();
    let token = capture(&guards, "chat", "current");
    assert_eq!(token.turn_id(), "current");
    for (method, params) in [
        (
            "turn/started",
            json!({"threadId":"chat","turn":{"id":"current"}}),
        ),
        (
            "turn/completed",
            json!({"threadId":"chat","turn":{"id":"older"}}),
        ),
        (
            "thread/status/changed",
            json!({"threadId":"chat","status":{"type":"active","activeFlags":["waitingOnApproval"]}}),
        ),
        ("thread/queue/changed", json!({"threadId":"chat"})),
        ("thread/reverted", json!({"threadId":"other"})),
    ] {
        guards.observe_notification(method, &params);
        assert!(guards.is_current(&token), "{method}");
    }
}

#[test]
fn unbound_probe_is_fenced_even_when_another_operation_knows_the_turn() {
    for method in ["turn/started", "turn/completed"] {
        let guards = QueueSteerGuards::default();
        let bound = capture(&guards, "chat", "current");
        let unknown = guards.begin_probe("chat");
        let event_turn = if method == "turn/started" {
            "current"
        } else {
            "older"
        };
        guards.observe_notification(method, &json!({"threadId":"chat","turn":{"id":event_turn}}));
        assert!(guards.is_current(&bound));
        assert!(guards
            .capture_after_probe(unknown, Some("current"))
            .is_none());
    }
}

#[test]
fn guards_share_lifecycle_invalidation_only_with_their_clones() {
    let guards = QueueSteerGuards::default();
    let clone = guards.clone();
    let token = capture(&guards, "chat", "turn");
    assert!(clone.is_current(&token));
    let replacement = QueueSteerGuards::default();
    assert!(!replacement.is_current(&token));
    assert!(replacement
        .capture_after_probe(guards.begin_probe("chat"), Some("turn"))
        .is_none());
    clone.invalidate_all();
    assert!(!guards.is_current(&token));
}

#[test]
fn idle_probe_never_creates_a_steer_token() {
    let guards = QueueSteerGuards::default();
    assert!(guards
        .capture_after_probe(guards.begin_probe("chat"), None)
        .is_none());
    let token = capture(&guards, "chat", "later");
    assert_eq!(token.turn_id(), "later");
    assert!(guards.is_current(&token));
}

#[tokio::test]
async fn actual_ingestion_fences_held_probes_and_tokens_without_native_reads() {
    use crate::{
        api::AppState,
        app_server::{tests::RecordingAppServer, InboundMessage},
        config::Config,
        events::ingest_inbound,
        store::Store,
    };
    use std::sync::Arc;

    let native = Arc::new(RecordingAppServer::default());
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    let token = capture(&state.queue_steer_guards, "chat", "turn");
    let probe = state.queue_steer_guards.begin_probe("chat");
    ingest_inbound(
        InboundMessage::Notification {
            method: "thread/reverted".into(),
            params: json!({"threadId":"chat","beforeTurnId":"turn"}),
        },
        &state,
    )
    .await
    .unwrap();
    assert!(!state.queue_steer_guards.is_current(&token));
    assert!(state
        .queue_steer_guards
        .capture_after_probe(probe, Some("turn"))
        .is_none());
    assert!(
        native.requests.lock().unwrap().is_empty(),
        "invalidation must not issue native RPCs inside notification ingestion"
    );
}

#[tokio::test]
async fn actual_disconnect_retires_operations_across_threads() {
    use crate::{
        api::AppState,
        app_server::{tests::RecordingAppServer, InboundMessage},
        config::Config,
        events::ingest_inbound,
        store::Store,
    };
    use std::sync::Arc;

    let native = Arc::new(RecordingAppServer::default());
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    let probe = state.queue_steer_guards.begin_probe("chat");
    let token = capture(&state.queue_steer_guards, "other", "turn");
    ingest_inbound(InboundMessage::Disconnected, &state)
        .await
        .unwrap();
    assert!(!state.queue_steer_guards.is_current(&token));
    assert!(state
        .queue_steer_guards
        .capture_after_probe(probe, Some("turn"))
        .is_none());
    assert!(native.requests.lock().unwrap().is_empty());
}
