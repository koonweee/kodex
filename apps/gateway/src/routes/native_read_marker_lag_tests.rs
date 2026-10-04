use super::*;

#[tokio::test]
async fn native_read_marker_live_completion_waits_for_native_projection_without_claiming_old_head()
{
    let (state, native) = fixture(&[&[THREAD]]).await;
    let initial = list(&state).await;
    let (status, acknowledged) = seen(&state, THREAD, FIRST, revision(&initial)).await;
    assert_eq!(status, StatusCode::OK);
    let mut observer = stream(&state).await;
    native.requests.lock().unwrap().clear();

    // The terminal notification arrives while the native SQLite projection
    // still contains only the previously seen completion.
    terminal_event(&state, SECOND).await;
    assert!(
        native.requests.lock().unwrap().is_empty(),
        "serial notification ingestion must not await another native RPC"
    );
    let invalidated = read_event(&mut observer, revision(&acknowledged) + 1).await;
    assert_unknown(&invalidated, Some(FIRST));
    let mut lag_events = state.events.subscribe();
    let lagging = list(&state).await;
    assert_unknown(&lagging, Some(FIRST));
    assert_eq!(revision(&lagging), revision(&invalidated));
    while let Ok(event) = lag_events.try_recv() {
        assert_ne!(
            event.kind, "thread.read_updated",
            "unchanged lag must not cause a refill/invalidation loop"
        );
    }
    for turn in [FIRST, SECOND] {
        let (status, _) = seen(&state, THREAD, turn, revision(&lagging)).await;
        assert_eq!(status, StatusCode::CONFLICT);
    }
    let (status, badge) = request(&state, "GET", "/v1/threads/unread-badge", None).await;
    assert_eq!(status, StatusCode::CONFLICT, "{badge}");
    assert!(
        badge.get("count").is_none(),
        "lag must not become a zero badge"
    );

    native.heads.lock().unwrap().insert(
        THREAD.into(),
        headers(&[(SECOND, "completed"), (FIRST, "completed")], false),
    );
    // No duplicate event, retry loop or history-page walk is needed once the
    // native projection catches up; an ordinary authoritative read suffices.
    let current = list(&state).await;
    assert_read(&current, Some(SECOND), Some(FIRST), true);
    assert!(revision(&current) > revision(&invalidated));
    let (status, acknowledged) = seen(&state, THREAD, SECOND, revision(&current)).await;
    assert_eq!(status, StatusCode::OK, "{acknowledged}");
    assert_read(&acknowledged, Some(SECOND), Some(SECOND), false);
    assert_read_only_headers(&native);
}

#[tokio::test]
async fn native_read_marker_queued_older_completion_cannot_replace_newer_acknowledged_native_head()
{
    let (state, native) = fixture(&[&[THREAD]]).await;
    native.heads.lock().unwrap().insert(
        THREAD.into(),
        headers(&[(SECOND, "completed"), (FIRST, "completed")], false),
    );
    // An HTTP read can observe native history ahead of the serial event queue.
    let ahead = list(&state).await;
    let (status, acknowledged) = seen(&state, THREAD, SECOND, revision(&ahead)).await;
    assert_eq!(status, StatusCode::OK);
    let mut observer = stream(&state).await;
    native.requests.lock().unwrap().clear();
    terminal_event(&state, FIRST).await;
    assert!(native.requests.lock().unwrap().is_empty());
    let invalidated = read_event(&mut observer, revision(&acknowledged) + 1).await;
    assert_unknown(&invalidated, Some(SECOND));

    // FIRST occurs in this native page, but SECOND is its actual descending
    // head. The event's ID cannot become the durable latest completion.
    let current = list(&state).await;
    assert_read(&current, Some(SECOND), Some(SECOND), false);
    let (status, badge) = request(&state, "GET", "/v1/threads/unread-badge", None).await;
    assert_eq!(status, StatusCode::OK, "{badge}");
    assert_eq!(badge["count"], 0);
    assert_read_only_headers(&native);
}

#[tokio::test]
async fn native_read_marker_confirmed_live_witness_does_not_pin_future_header_window() {
    let (state, native) = fixture(&[&[THREAD]]).await;
    terminal_event(&state, FIRST).await;
    let confirmed = list(&state).await;
    assert_read(&confirmed, Some(FIRST), None, true);
    let (status, acknowledged) = seen(&state, THREAD, FIRST, revision(&confirmed)).await;
    assert_eq!(status, StatusCode::OK);

    // Eight newer completions fill the native window while their notifications
    // have not arrived. A previously confirmed witness is no longer a pending
    // projection barrier and must not force an unbounded search for FIRST.
    let newer = (0..8)
        .map(|index| (format!("newer-native-{index}"), "completed"))
        .collect::<Vec<_>>();
    let refs = newer
        .iter()
        .map(|(id, status)| (id.as_str(), *status))
        .collect::<Vec<_>>();
    native
        .heads
        .lock()
        .unwrap()
        .insert(THREAD.into(), headers(&refs, true));
    native.requests.lock().unwrap().clear();
    let current = list(&state).await;
    assert_read(&current, Some("newer-native-0"), Some(FIRST), true);
    assert!(revision(&current) > revision(&acknowledged));
    assert_eq!(
        native
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(method, _)| method == "thread/turns/list")
            .count(),
        1
    );
    assert_read_only_headers(&native);
}

#[tokio::test]
async fn native_read_marker_hydrated_terminal_event_advances_an_unconfirmed_older_witness() {
    let (state, native) = fixture(&[&[THREAD]]).await;
    terminal_event(&state, FIRST).await;
    native
        .heads
        .lock()
        .unwrap()
        .insert(THREAD.into(), headers(&[(SECOND, "completed")], true));
    assert_unknown(&list(&state).await, None);
    // HTTP history can hydrate the newer terminal before its queued event is
    // ingested. Notification deduplication must not suppress read reconciliation.
    let newer = crate::app_server_api::ThreadTurnSnapshot {
        id: SECOND.into(),
        status: "completed".into(),
        started_at: None,
        completed_at: None,
        items: vec![],
        raw_payload: json!({"id": SECOND, "status": "completed", "items": []}),
    };
    state
        .thread_views
        .refresh_from_turns(
            THREAD,
            &[newer],
            state.store.latest_event_seq().await.unwrap(),
        )
        .await
        .unwrap();
    let planned_before = state
        .store
        .replay_events(None, None, None)
        .await
        .unwrap()
        .into_iter()
        .filter(|event| event.kind == "notification.planned")
        .count();
    terminal_event(&state, SECOND).await;
    let current = list(&state).await;
    assert_read(&current, Some(SECOND), None, true);
    let planned_after = state
        .store
        .replay_events(None, None, None)
        .await
        .unwrap()
        .into_iter()
        .filter(|event| event.kind == "notification.planned")
        .count();
    assert_eq!(
        planned_before, planned_after,
        "hydration still deduplicates notifications"
    );
}

#[tokio::test]
async fn native_read_marker_malformed_required_status_never_becomes_an_empty_head_or_zero_badge() {
    for status in [
        None,
        Some(Value::Null),
        Some(json!("future-status")),
        Some(json!({"type":"completed"})),
    ] {
        let (state, native) = fixture(&[&[THREAD]]).await;
        let mut malformed = json!({"id": FIRST, "items": [], "itemsView": "notLoaded"});
        if let Some(status) = status {
            malformed["status"] = status;
        }
        native.heads.lock().unwrap().insert(
            THREAD.into(),
            json!({
                "data": [malformed], "nextCursor": null, "backwardsCursor": null,
            }),
        );
        let (status, _) = request(&state, "GET", "/v1/threads", None).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        let read = state.store.get_thread_read(THREAD).await.unwrap();
        assert!(!read.read_state_known);
        assert_eq!(read.read_revision, 0);
        let (status, body) = request(&state, "GET", "/v1/threads/unread-badge", None).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert!(body.get("count").is_none());
        assert_read_only_headers(&native);
    }
}

#[tokio::test]
async fn native_read_marker_malformed_continuation_never_proves_a_complete_badge_inventory() {
    for cursor in [json!(17), json!({"opaque":"invalid"})] {
        let (state, native) = fixture(&[&[]]).await;
        *native.malformed_inventory_cursor.lock().unwrap() = Some(cursor);
        let (status, body) = request(&state, "GET", "/v1/threads/unread-badge", None).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert!(body.get("count").is_none());
        assert_eq!(
            native.requests.lock().unwrap().len(),
            1,
            "do not guess a native cursor"
        );
    }
}

#[tokio::test]
async fn native_read_marker_malformed_continuation_never_proves_an_empty_completion_head() {
    for cursor in [json!(17), json!({"opaque":"invalid"})] {
        let (state, native) = fixture(&[&[THREAD]]).await;
        let mut active = headers(&[(FIRST, "inProgress")], false);
        active["nextCursor"] = cursor;
        native.heads.lock().unwrap().insert(THREAD.into(), active);
        let (status, body) = request(&state, "GET", "/v1/threads/unread-badge", None).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert!(body.get("count").is_none());
        let state = state.store.get_thread_read(THREAD).await.unwrap();
        assert!(!state.read_state_known);
        assert_eq!(state.read_revision, 0);
        assert_read_only_headers(&native);
    }
}
