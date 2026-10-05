use std::{future::ready, time::Duration};

use tokio::sync::oneshot;
use tokio::time::timeout;

use super::*;
use crate::{
    api::AppState,
    app_server::tests::RecordingAppServer,
    config::Config,
    store::{NewApproval, NewEvent, Store},
};

const THREAD: &str = "projection-commit";
const TURN: &str = "active-turn";

#[tokio::test]
async fn approval_cannot_overtake_an_allocated_native_delta_before_full_snapshot() {
    ordered_projection_commit(true, false).await;
}

#[tokio::test]
async fn approval_cannot_overtake_an_allocated_native_delta_before_history_merge() {
    ordered_projection_commit(true, true).await;
}

#[tokio::test]
async fn accepted_input_cannot_overtake_an_allocated_native_delta_before_full_snapshot() {
    ordered_projection_commit(false, false).await;
}

#[tokio::test]
async fn accepted_input_cannot_overtake_an_allocated_native_delta_before_history_merge() {
    ordered_projection_commit(false, true).await;
}

async fn ordered_projection_commit(approval: bool, history: bool) {
    let native = Arc::new(RecordingAppServer::default());
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    let initial = append_cursor(&state.store).await;
    record_item_delta(
        &state.thread_views,
        THREAD,
        TURN,
        "answer",
        "Seed",
        std::future::ready(Ok(initial)),
    )
    .await
    .unwrap();

    let (allocated, allocation) = oneshot::channel();
    let (release, held) = oneshot::channel();
    let writing_state = state.clone();
    let writer = tokio::spawn(async move {
        writing_state
            .thread_views
            .with_thread_view(
                THREAD,
                async {
                    let revision = append_cursor(&writing_state.store).await;
                    allocated.send(revision).unwrap();
                    let _ = held.await;
                    Ok(revision)
                },
                |view| {
                    assert_eq!(
                        view.append_delta(THREAD, TURN, "answer", " A"),
                        ItemDeltaApplyOutcome::Appended
                    );
                    view.to_snapshot()
                },
            )
            .await
            .unwrap()
    });
    let allocated_revision = allocation.await.unwrap();

    let later_state = state.clone();
    let mut later = tokio::spawn(async move {
        if approval {
            crate::approvals::receive_native(
                &later_state,
                NewApproval {
                    request_id: "17".into(),
                    thread_id: Some(THREAD.into()),
                    turn_id: Some(TURN.into()),
                    item_id: Some("command".into()),
                    method: "item/commandExecution/requestApproval".into(),
                    payload: json!({"threadId": THREAD, "turnId": TURN, "itemId": "command"}),
                },
            )
            .await
            .unwrap();
        } else {
            crate::turn_lifecycle::record_pending_user_projection(
                &later_state,
                THREAD,
                TURN,
                "pending-client",
                &[UserInput::Text {
                    text: "Accepted input".into(),
                    text_elements: Vec::new(),
                }],
                &[],
                allocated_revision,
            )
            .await
            .unwrap();
        }
    });
    let early_later = timeout(Duration::from_millis(30), &mut later).await.ok();
    let later_overtook = early_later.is_some();
    let reading_state = state.clone();
    let read_revision = state.store.latest_event_seq().await.unwrap();
    let mut reader = tokio::spawn(async move {
        if history {
            let snapshot = reading_state
                .thread_views
                .refresh_from_history_window(THREAD, &[], None, read_revision)
                .await
                .unwrap();
            (snapshot.view_revision, snapshot.items)
        } else {
            let patch = reading_state.thread_views.patch_for_thread(THREAD).await;
            (patch.view_revision, patch.items)
        }
    });
    let early_reader = timeout(Duration::from_millis(30), &mut reader).await.ok();
    let read_overtook = early_reader.is_some();

    // Complete every owned task even on the old, incorrect sequencing.
    release.send(()).unwrap();
    let written = writer.await.unwrap();
    match early_later {
        Some(result) => result.unwrap(),
        None => later.await.unwrap(),
    }
    let (read_revision, read_items) = match early_reader {
        Some(result) => result.unwrap(),
        None => reader.await.unwrap(),
    };
    assert!(
        !later_overtook,
        "later projection committed before allocated native text"
    );
    assert!(
        !read_overtook,
        "snapshot claimed coverage before allocated native text"
    );
    assert_eq!(written.view_revision, allocated_revision);
    assert!(read_revision >= allocated_revision);
    assert_eq!(answer(&read_items), "Seed A");
    let final_view = crate::approvals::hydrate_thread_view(&state, THREAD)
        .await
        .unwrap();
    assert_eq!(answer(&final_view.items), "Seed A");
    if approval {
        assert_eq!(final_view.pending_approval_requests.len(), 1);
    } else {
        assert!(final_view
            .items
            .iter()
            .any(|item| item.item_id == "pending-user-pending-client"));
    }
    assert!(native.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn failed_cursor_allocation_does_not_mutate_or_hold_the_projection() {
    let sessions = ThreadViewStore::default();
    let result = sessions
        .with_thread_view(
            THREAD,
            async { Err(ApiError::Other(anyhow::anyhow!("cursor insert failed"))) },
            |_| panic!("failed allocation must not apply its mutation"),
        )
        .await;
    assert!(result.is_err());
    let patch = timeout(Duration::from_secs(1), sessions.patch_for_thread(THREAD))
        .await
        .unwrap();
    assert_eq!(patch.view_revision, 0);
    assert!(patch.items.is_empty());
    let next = sessions
        .with_thread_view(THREAD, ready(Ok(1)), |view| {
            view.append_delta(THREAD, TURN, "answer", "Recovered");
            view.to_snapshot()
        })
        .await
        .unwrap();
    assert_eq!(answer(&next.items), "Recovered");
}

#[tokio::test]
async fn stale_active_history_without_timestamps_keeps_newer_same_id_text() {
    let sessions = ThreadViewStore::default();
    record_item_delta(&sessions, THREAD, TURN, "answer", "Seed", ready(Ok(1)))
        .await
        .unwrap();
    let captured_revision = 1;
    record_item_delta(&sessions, THREAD, TURN, "answer", " A", ready(Ok(2)))
        .await
        .unwrap();

    let snapshot = sessions
        .refresh_from_history_window(
            THREAD,
            &[active_history("Seed", None)],
            None,
            captured_revision,
        )
        .await
        .unwrap();

    assert_eq!(snapshot.view_revision, 2);
    assert_eq!(answer(&snapshot.items), "Seed A");
    assert_eq!(snapshot.items.len(), 1);
    assert_eq!(snapshot.active_turn_id.as_deref(), Some(TURN));
}

#[tokio::test]
async fn current_active_history_replaces_same_id_text_without_using_turn_clock() {
    for started_at in [None, Some(1)] {
        let sessions = ThreadViewStore::default();
        record_item_delta(&sessions, THREAD, TURN, "answer", "Live", ready(Ok(2)))
            .await
            .unwrap();
        let captured_revision = 2;

        let snapshot = sessions
            .refresh_from_history_window(
                THREAD,
                &[active_history("Native current answer", started_at)],
                None,
                captured_revision,
            )
            .await
            .unwrap();

        assert_eq!(snapshot.view_revision, 2);
        assert_eq!(answer(&snapshot.items), "Native current answer");
        assert_eq!(snapshot.items.len(), 1);
        assert_eq!(snapshot.active_turn_id.as_deref(), Some(TURN));
    }
}

#[tokio::test]
async fn current_older_page_does_not_promote_cached_head_over_live_text() {
    let sessions = ThreadViewStore::default();
    sessions
        .refresh_from_history_window(THREAD, &[active_history("Seed", None)], None, 1)
        .await
        .unwrap();
    record_item_delta(&sessions, THREAD, TURN, "answer", " A", ready(Ok(2)))
        .await
        .unwrap();
    let captured_revision = 2;
    let mut older = active_history("Older answer", None);
    older.id = "older-turn".into();
    older.status = "completed".into();

    let snapshot = sessions
        .prepend_history_page(THREAD, &[older], None, captured_revision)
        .await
        .unwrap();

    assert_eq!(snapshot.view_revision, 2);
    assert_eq!(snapshot.items.len(), 2);
    let texts = snapshot
        .items
        .iter()
        .map(|item| (item.turn_id.as_str(), item.payload.item.text.as_deref()))
        .collect::<Vec<_>>();
    assert_eq!(
        texts,
        [("older-turn", Some("Older answer")), (TURN, Some("Seed A"))]
    );
    assert_eq!(snapshot.active_turn_id.as_deref(), Some(TURN));
}

#[tokio::test]
async fn stale_active_history_cannot_reopen_a_newer_terminal_projection() {
    stale_terminal_history(false).await;
}

#[tokio::test]
async fn stale_reset_window_cannot_discard_a_newer_terminal_projection() {
    stale_terminal_history(true).await;
}

async fn stale_terminal_history(reset_window: bool) {
    let sessions = ThreadViewStore::default();
    sessions
        .refresh_from_history_window(THREAD, &[active_history("Seed", None)], None, 1)
        .await
        .unwrap();
    let captured_revision = 1;
    record_item_delta(&sessions, THREAD, TURN, "answer", " A", ready(Ok(2)))
        .await
        .unwrap();
    let mut terminal = active_history("Seed A", None);
    terminal.status = "completed".into();
    record_turn_status(&sessions, THREAD, &terminal, ready(Ok(3)))
        .await
        .unwrap();
    let mut older = active_history("Older answer", None);
    older.id = "older-turn".into();
    older.status = "completed".into();

    let snapshot = sessions
        .refresh_from_history_window(
            THREAD,
            &[older, active_history("Seed", None)],
            Some(ThreadTimelineWindowPage {
                older_cursor: Some("older-page".into()),
                newer_cursor: None,
                has_older: true,
                limit: 50,
                loaded_turn_count: 2,
                reset_window,
            }),
            captured_revision,
        )
        .await
        .unwrap();

    assert_eq!(snapshot.view_revision, 3);
    assert_eq!(snapshot.items.len(), 2);
    let current = snapshot
        .items
        .iter()
        .find(|item| item.turn_id == TURN)
        .unwrap();
    assert_eq!(current.payload.item.text.as_deref(), Some("Seed A"));
    assert_eq!(current.status, "completed");
    assert_eq!(
        snapshot
            .turns
            .iter()
            .find(|turn| turn.id == TURN)
            .unwrap()
            .status,
        "completed"
    );
    assert_eq!(snapshot.items[0].turn_id, "older-turn");
    assert_eq!(snapshot.active_turn_id, None);
    assert_eq!(snapshot.live_state, ThreadLiveState::Idle);

    // This later read owns only its older turn, not the cached active head
    // retained from the stale native response above.
    let mut oldest = active_history("Oldest answer", None);
    oldest.id = "oldest-turn".into();
    oldest.status = "completed".into();
    let page = sessions
        .prepend_history_page(THREAD, &[oldest], None, 3)
        .await
        .unwrap();
    assert_eq!(page.items.len(), 3);
    assert_eq!(page.items[0].turn_id, "oldest-turn");
    let current = page.items.iter().find(|item| item.turn_id == TURN).unwrap();
    assert_eq!(current.payload.item.text.as_deref(), Some("Seed A"));
    assert_eq!(current.status, "completed");
    assert_eq!(
        page.turns
            .iter()
            .find(|turn| turn.id == TURN)
            .unwrap()
            .status,
        "completed"
    );
    assert_eq!(page.active_turn_id, None);
    assert_eq!(page.live_state, ThreadLiveState::Idle);

    terminal.items = active_history("Native current final answer", None).items;
    let current = sessions
        .refresh_from_history_window(THREAD, &[terminal], None, 3)
        .await
        .unwrap();
    let answer = current
        .items
        .iter()
        .find(|item| item.turn_id == TURN)
        .unwrap();
    assert_eq!(
        answer.payload.item.text.as_deref(),
        Some("Native current final answer")
    );
    assert_eq!(current.active_turn_id, None);
    assert_eq!(current.live_state, ThreadLiveState::Idle);
}

fn active_history(text: &str, started_at: Option<i64>) -> ThreadTurnSnapshot {
    ThreadTurnSnapshot {
        id: TURN.into(),
        status: "inProgress".into(),
        started_at,
        completed_at: None,
        items: vec![ThreadItemSnapshot::from_payload(&json!({
            "id": "answer", "type": "agentMessage", "text": text,
        }))
        .unwrap()],
        raw_payload: json!({}),
    }
}

async fn append_cursor(store: &Store) -> i64 {
    store
        .append_event(NewEvent {
            project_id: None,
            thread_id: Some(THREAD.into()),
            turn_id: Some(TURN.into()),
            item_id: Some("answer".into()),
            kind: crate::events_replay::THREAD_VIEW_CURSOR_KIND.into(),
            codex_method: Some("item/agentMessage/delta".into()),
            payload: json!({}),
        })
        .await
        .unwrap()
        .seq
}

fn answer(items: &[ThreadTimelineSnapshotItem]) -> &str {
    items
        .iter()
        .find(|item| item.item_id == "answer")
        .and_then(|item| item.payload.item.text.as_deref())
        .unwrap()
}
