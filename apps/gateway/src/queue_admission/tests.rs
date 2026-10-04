use serde_json::json;

use super::QueueAdmissionWitnesses;

#[test]
fn only_a_pre_add_active_turn_permits_one_promotion() {
    let witnesses = QueueAdmissionWitnesses::default();
    assert!(witnesses.capture("chat", None).is_none());
    let before_add = witnesses.capture("chat", Some("original-turn")).unwrap();
    assert!(witnesses.record(before_add, "native-row"));
    assert_eq!(witnesses.claim("chat", "native-row", None), None);
    assert_eq!(
        witnesses.claim("chat", "native-row", Some("new-turn")),
        None
    );
    assert_eq!(
        witnesses.claim("chat", "native-row", Some("original-turn")),
        Some("original-turn".into())
    );
    // The right is consumed before deletion, including lost delete/steer ACKs.
    assert_eq!(
        witnesses.claim("chat", "native-row", Some("original-turn")),
        None
    );
}

#[test]
fn row_and_thread_identity_are_not_interchangeable() {
    let witnesses = QueueAdmissionWitnesses::default();
    for (chat, row) in [("one", "first"), ("two", "second")] {
        let ticket = witnesses.capture(chat, Some("same-opaque-turn")).unwrap();
        assert!(witnesses.record(ticket, row));
    }
    assert_eq!(
        witnesses.claim("two", "first", Some("same-opaque-turn")),
        None
    );
    assert_eq!(
        witnesses.claim("one", "second", Some("same-opaque-turn")),
        None
    );
    assert!(witnesses
        .claim("one", "first", Some("same-opaque-turn"))
        .is_some());
    assert!(witnesses
        .claim("two", "second", Some("same-opaque-turn"))
        .is_some());
}

#[test]
fn late_add_ack_cannot_recreate_a_terminal_or_reset_witness() {
    for notification in [
        (
            "turn/completed",
            json!({"threadId":"chat","turn":{"id":"turn"}}),
        ),
        (
            "thread/reverted",
            json!({"threadId":"chat","beforeTurnId":"other"}),
        ),
        ("thread/closed", json!({"threadId":"chat"})),
        ("thread/archived", json!({"threadId":"chat"})),
        ("thread/deleted", json!({"threadId":"chat"})),
        (
            "thread/status/changed",
            json!({"threadId":"chat","status":{"type":"notLoaded"}}),
        ),
    ] {
        let witnesses = QueueAdmissionWitnesses::default();
        let ticket = witnesses.capture("chat", Some("turn")).unwrap();
        witnesses.observe_notification(notification.0, &notification.1);
        // A new capture cannot make the old ticket valid, even with the same ID.
        let newer = witnesses.capture("chat", Some("turn")).unwrap();
        assert!(!witnesses.record(ticket, "old-row"));
        assert!(witnesses.record(newer, "new-row"));
        assert_eq!(witnesses.claim("chat", "old-row", Some("turn")), None);
        assert!(witnesses.claim("chat", "new-row", Some("turn")).is_some());
    }
}

#[test]
fn old_terminal_receipts_do_not_remove_newer_turn_rights() {
    let witnesses = QueueAdmissionWitnesses::default();
    let old = witnesses.capture("chat", Some("old-turn")).unwrap();
    let current = witnesses.capture("chat", Some("new-turn")).unwrap();
    assert!(!witnesses.record(old, "old-row"));
    assert!(witnesses.record(current, "new-row"));
    witnesses.observe_notification(
        "turn/completed",
        &json!({"threadId":"chat","turn":{"id":"old-turn"}}),
    );
    assert_eq!(
        witnesses.claim("chat", "new-row", Some("new-turn")),
        Some("new-turn".into())
    );
}

#[test]
fn ended_turns_and_new_native_turns_retire_live_rights() {
    for (method, payload) in [
        (
            "turn/completed",
            json!({"threadId":"chat","turn":{"id":"turn"}}),
        ),
        (
            "turn/started",
            json!({"threadId":"chat","turn":{"id":"next-turn"}}),
        ),
        (
            "thread/status/changed",
            json!({"threadId":"chat","status":{"type":"idle"}}),
        ),
    ] {
        let witnesses = QueueAdmissionWitnesses::default();
        let ticket = witnesses.capture("chat", Some("turn")).unwrap();
        assert!(witnesses.record(ticket, "row"));
        witnesses.observe_notification(method, &payload);
        assert_eq!(witnesses.claim("chat", "row", Some("turn")), None);
    }
}

#[test]
fn repeated_current_turn_start_and_unrelated_events_keep_the_right() {
    let witnesses = QueueAdmissionWitnesses::default();
    let ticket = witnesses.capture("chat", Some("turn")).unwrap();
    assert!(witnesses.record(ticket, "row"));
    witnesses.observe_notification(
        "turn/started",
        &json!({"threadId":"chat","turn":{"id":"turn"}}),
    );
    witnesses.observe_notification("thread/queue/changed", &json!({"threadId":"chat"}));
    witnesses.observe_notification(
        "turn/completed",
        &json!({"threadId":"other","turn":{"id":"turn"}}),
    );
    assert!(witnesses.claim("chat", "row", Some("turn")).is_some());
}

#[test]
fn disconnect_or_gateway_replacement_cannot_restore_a_right() {
    let witnesses = QueueAdmissionWitnesses::default();
    let before_disconnect = witnesses.capture("chat", Some("turn")).unwrap();
    let existing = witnesses.capture("other", Some("turn")).unwrap();
    assert!(witnesses.record(existing, "existing-row"));
    witnesses.invalidate_all();
    let after_disconnect = witnesses.capture("chat", Some("turn")).unwrap();
    assert!(!witnesses.record(before_disconnect, "late-row"));
    assert_eq!(witnesses.claim("other", "existing-row", Some("turn")), None);
    assert!(witnesses.record(after_disconnect, "new-row"));
    let replacement = QueueAdmissionWitnesses::default();
    assert_eq!(replacement.claim("chat", "new-row", Some("turn")), None);
}

#[test]
fn deleted_or_started_rows_lose_only_their_own_right() {
    let witnesses = QueueAdmissionWitnesses::default();
    for row in ["deleted", "kept"] {
        assert!(witnesses.record(witnesses.capture("chat", Some("turn")).unwrap(), row));
    }
    witnesses.forget("chat", "deleted");
    assert_eq!(witnesses.claim("chat", "deleted", Some("turn")), None);
    assert!(witnesses.claim("chat", "kept", Some("turn")).is_some());
}

#[tokio::test]
async fn actual_ingestion_retires_pre_delete_context_without_native_reads() {
    use std::sync::Arc;

    use crate::{
        api::AppState,
        app_server::{tests::RecordingAppServer, InboundMessage},
        config::Config,
        events::ingest_inbound,
        store::Store,
    };

    let native = Arc::new(RecordingAppServer::default());
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    let ticket = state
        .queue_admissions
        .capture("chat", Some("turn"))
        .unwrap();
    assert!(state.queue_admissions.record(ticket, "row"));
    let before_reset = state
        .queue_admissions
        .capture("chat", Some("turn"))
        .unwrap();
    ingest_inbound(
        InboundMessage::Notification {
            method: "thread/reverted".into(),
            params: json!({"threadId":"chat","beforeTurnId":"turn"}),
        },
        &state,
    )
    .await
    .unwrap();
    assert_eq!(
        state.queue_admissions.claim("chat", "row", Some("turn")),
        None
    );
    assert!(!state.queue_admissions.record(before_reset, "late-row"));
    assert!(
        native.requests.lock().unwrap().is_empty(),
        "invalidation must not call native history/queue RPCs inside ingestion"
    );
}

#[tokio::test]
async fn actual_disconnect_retires_all_queued_context_and_late_ack_tickets() {
    use std::sync::Arc;

    use crate::{
        api::AppState,
        app_server::{tests::RecordingAppServer, InboundMessage},
        config::Config,
        events::ingest_inbound,
        store::Store,
    };

    let native = Arc::new(RecordingAppServer::default());
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    let late = state
        .queue_admissions
        .capture("chat", Some("turn"))
        .unwrap();
    assert!(state.queue_admissions.record(
        state
            .queue_admissions
            .capture("other", Some("turn"))
            .unwrap(),
        "existing"
    ));
    ingest_inbound(InboundMessage::Disconnected, &state)
        .await
        .unwrap();
    assert!(!state.queue_admissions.record(late, "late-row"));
    assert_eq!(
        state
            .queue_admissions
            .claim("other", "existing", Some("turn")),
        None
    );
    assert!(native.requests.lock().unwrap().is_empty());
}
