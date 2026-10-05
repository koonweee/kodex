use super::*;
use crate::app_server_api::ThreadTimelineWindowPage;
use crate::{app_server::tests::RecordingAppServer, config::Config, store::Store};
use http_body_util::BodyExt;
use std::sync::{atomic::Ordering, Arc};

const THREAD: &str = "reverted-thread";

async fn state() -> AppState {
    let native = Arc::new(RecordingAppServer::default());
    native.ready.store(true, Ordering::SeqCst);
    AppState::new(Config::default(), Store::in_memory().await.unwrap(), native)
}

fn turn(id: &str, status: &str) -> ThreadTurnSnapshot {
    turn_snapshot_from_value(&json!({
        "id": id, "status": status, "items": [{
            "id": format!("item-{id}"), "type": "userMessage", "clientId": "reused",
            "content": [{"type": "text", "text": id}]
        }]
    }))
    .unwrap()
}

fn page() -> ThreadTimelineWindowPage {
    ThreadTimelineWindowPage {
        older_cursor: Some("old-cursor".into()),
        newer_cursor: None,
        has_older: true,
        limit: 50,
        loaded_turn_count: 2,
        reset_window: false,
    }
}

async fn revert(state: &AppState) {
    ingest_inbound(
        InboundMessage::Notification {
            method: "thread/reverted".into(),
            params: json!({"threadId": THREAD}),
        },
        state,
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn native_revert_clears_history_live_input_and_cursors_and_replays_a_refill() {
    let state = state().await;
    let mut live = state.events.subscribe();
    let before = state.store.latest_event_seq().await.unwrap();
    thread_view::build_thread_timeline_window(
        &state.thread_views,
        THREAD,
        &[turn("retained", "completed"), turn("removed", "inProgress")],
        Some(page()),
        before,
    )
    .await
    .unwrap();
    thread_view::record_pending_user_input(
        &state.thread_views,
        THREAD,
        "removed",
        "late-input",
        &[app_server_api::UserInput::Text {
            text: "pending".into(),
            text_elements: vec![],
        }],
        &[],
        (before, std::future::ready(Ok(before))),
    )
    .await
    .unwrap();
    revert(&state).await;
    let cleared = state.thread_views.patch_for_thread(THREAD).await;
    assert!(
        cleared.items.is_empty(),
        "revert must discard the old live/history projection"
    );
    assert!(cleared.turns.is_empty());
    assert!(cleared.active_turn_id.is_none());
    assert_eq!(cleared.live_state, ThreadLiveState::Idle);
    assert!(cleared.view_revision > before);
    assert!(state.thread_views.history_page(THREAD).await.is_none());
    let read = live.try_recv().unwrap();
    assert_eq!(read.kind, crate::routes::threads::THREAD_READ_UPDATED_EVENT);
    assert_eq!(read.payload["readStateKnown"], false);
    assert!(read.payload["latestCompletedTurnId"].is_null());
    let reset = live.try_recv().unwrap();
    assert!(reset.seq > read.seq);
    assert_eq!(reset.kind, THREAD_VIEW_PATCH_EVENT_KIND);
    assert_eq!(reset.payload["rows"], json!([]));
    let refill = live.try_recv().unwrap();
    assert_eq!(refill.seq, reset.seq);
    assert_eq!(
        refill.kind,
        thread_view::THREAD_VIEW_REFRESH_REQUIRED_EVENT_KIND
    );
    assert_eq!(refill.thread_id.as_deref(), Some(THREAD));
    let query = EventsQuery {
        thread_id: Some(THREAD.into()),
        cursor: Some(before),
        project_id: None,
        exclude_thread_id: None,
        include_global: None,
        thread_ids: None,
    };
    let stored = state
        .store
        .replay_events(Some(before), None, Some(THREAD.into()))
        .await
        .unwrap();
    let replay = workspace_sse_replay_events(stored, &query).unwrap();
    assert!(replay
        .iter()
        .any(|event| event.kind == thread_view::THREAD_VIEW_REFRESH_REQUIRED_EVENT_KIND));
    thread_view::build_thread_timeline_window(
        &state.thread_views,
        THREAD,
        &[turn("retained", "completed")],
        Some(ThreadTimelineWindowPage {
            older_cursor: None,
            has_older: false,
            ..page()
        }),
        cleared.view_revision,
    )
    .await
    .unwrap();
    let fresh = state.thread_views.patch_for_thread(THREAD).await;
    assert_eq!(
        fresh
            .turns
            .iter()
            .map(|turn| turn.id.as_str())
            .collect::<Vec<_>>(),
        vec!["retained"]
    );
    assert_eq!(
        state
            .thread_views
            .history_page(THREAD)
            .await
            .unwrap()
            .older_cursor,
        None
    );
}

#[tokio::test]
async fn native_revert_fences_all_pre_reset_history_merges_even_for_unseen_threads() {
    for unseen in [false, true] {
        let state = state().await;
        let before = state.store.latest_event_seq().await.unwrap();
        let stale = vec![turn("removed", "completed")];
        if !unseen {
            thread_view::build_thread_timeline(&state.thread_views, THREAD, &stale, before)
                .await
                .unwrap();
        }
        revert(&state).await;
        for result in [
            thread_view::build_thread_timeline(&state.thread_views, THREAD, &stale, before).await,
            thread_view::build_thread_timeline_window(
                &state.thread_views,
                THREAD,
                &stale,
                Some(page()),
                before,
            )
            .await,
            thread_view::prepend_thread_timeline_page(
                &state.thread_views,
                THREAD,
                &stale,
                Some(page()),
                before,
            )
            .await,
        ] {
            assert!(
                matches!(result, Err(ApiError::Conflict(_))),
                "a pre-revert snapshot must be rejected"
            );
            assert!(state
                .thread_views
                .patch_for_thread(THREAD)
                .await
                .items
                .is_empty());
            assert!(state.thread_views.history_page(THREAD).await.is_none());
        }
    }
}

#[tokio::test]
async fn http_sse_delivers_refill_signals_without_rewinding_transcript_high_water() {
    let state = state().await;
    let previous = state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: Some(THREAD.into()),
            turn_id: None,
            item_id: None,
            kind: "gateway.warning".into(),
            codex_method: None,
            payload: json!({"message": "Already in the replay snapshot"}),
        })
        .await
        .unwrap();
    let mut headers = HeaderMap::new();
    headers.insert(header::ACCEPT, "text/event-stream".parse().unwrap());
    let query = EventsQuery {
        thread_id: Some(THREAD.into()),
        cursor: Some(0),
        project_id: None,
        exclude_thread_id: None,
        include_global: None,
        thread_ids: None,
    };
    let mut body = events(headers, State(state.clone()), Query(query))
        .await
        .unwrap()
        .into_body();
    assert_eq!(next_sse(&mut body).await.id, previous.id);
    let metadata = EventMetadata::from_payload(&json!({"threadId": THREAD}));
    let first = append_timeline_changed_cursor(&state, &metadata, "first", None)
        .await
        .unwrap();
    let second = append_timeline_changed_cursor(&state, &metadata, "second", None)
        .await
        .unwrap();
    let patch = state
        .thread_views
        .reset_history(THREAD, std::future::ready(Ok(second.seq)))
        .await
        .unwrap();
    state
        .events
        .send(
            thread_view_patch_payload_event(&state, patch)
                .await
                .unwrap(),
        )
        .unwrap();
    assert_eq!(next_sse(&mut body).await.seq, second.seq);
    for cursor in [second.seq, first.seq] {
        state
            .events
            .send(thread_view_refresh_required_event(cursor, THREAD.into(), "refill").unwrap())
            .unwrap();
        let refill = next_sse(&mut body).await;
        assert_eq!(
            refill.kind,
            thread_view::THREAD_VIEW_REFRESH_REQUIRED_EVENT_KIND
        );
        assert_eq!(refill.seq, cursor);
    }
    // Refills do not lower the replay cutoff. A delayed broadcast of an event
    // already delivered by replay remains suppressed.
    state.events.send(previous).unwrap();
    let third = append_timeline_changed_cursor(&state, &metadata, "third", None)
        .await
        .unwrap();
    let patch = state
        .thread_views
        .reset_history(THREAD, std::future::ready(Ok(third.seq)))
        .await
        .unwrap();
    state
        .events
        .send(
            thread_view_patch_payload_event(&state, patch)
                .await
                .unwrap(),
        )
        .unwrap();
    let fresh = next_sse(&mut body).await;
    assert_eq!(fresh.kind, THREAD_VIEW_PATCH_EVENT_KIND);
    assert_eq!(fresh.seq, third.seq);
}

async fn next_sse(body: &mut axum::body::Body) -> EventEnvelope {
    let frame = tokio::time::timeout(std::time::Duration::from_secs(1), body.frame())
        .await
        .expect("HTTP SSE dropped the expected canonical/refill event")
        .unwrap()
        .unwrap()
        .into_data()
        .unwrap();
    let text = std::str::from_utf8(&frame).unwrap();
    let data = text
        .lines()
        .find_map(|line| line.strip_prefix("data: "))
        .unwrap();
    serde_json::from_str(data).unwrap()
}
