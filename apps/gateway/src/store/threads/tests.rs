use tempfile::tempdir;

use crate::{error::ApiError, store::Store};

#[tokio::test]
async fn cancelled_custom_begin_cannot_poison_the_pool_or_block_other_writers() {
    use sqlx::Connection;
    use std::{
        future::Future,
        sync::Arc,
        task::{Context, Poll, Wake, Waker},
    };
    use tokio::{
        sync::Notify,
        time::{timeout, Duration},
    };

    struct BeginWake(Notify);
    impl Wake for BeginWake {
        fn wake(self: Arc<Self>) {
            self.0.notify_one();
        }
        fn wake_by_ref(self: &Arc<Self>) {
            self.0.notify_one();
        }
    }

    let dir = tempdir().unwrap();
    let path = dir.path().join("cancelled-begin.db");
    let store = Store::connect(&path).await.unwrap();
    let other = Store::connect(&path).await.unwrap();
    let mut cancelled = None;
    // Drive only the BEGIN acknowledgment, then cancel at SQLx's second
    // await (lock_handle), before its Transaction rollback guard exists.
    for _ in 0..100 {
        let mut connection = store.pool().acquire().await.unwrap();
        let wake = Arc::new(BeginWake(Notify::new()));
        let waker = Waker::from(wake.clone());
        let mut cx = Context::from_waker(&waker);
        let mut begin = Box::pin(connection.begin_with("BEGIN IMMEDIATE"));
        match begin.as_mut().poll(&mut cx) {
            Poll::Ready(result) => drop(result.unwrap()),
            Poll::Pending => {
                // The first wake acknowledges BEGIN; polling once more
                // reaches the handle check. Earlier cancellation is safely
                // rolled back by SQLx's worker acknowledgment.
                timeout(Duration::from_secs(2), wake.0.notified())
                    .await
                    .unwrap();
                if let Poll::Ready(result) = begin.as_mut().poll(&mut cx) {
                    drop(result.unwrap());
                }
            }
        }
        drop(begin);
        connection.ping().await.unwrap();
        if connection.is_in_transaction() {
            cancelled = Some(connection);
            break;
        }
    }
    let connection =
        cancelled.expect("exercise cancellation after the custom BEGIN acknowledgment");
    drop(connection);
    // Wait for pool release so its cancellation cleanup has completed.
    timeout(Duration::from_secs(2), async {
        while store.pool().num_idle() < store.pool().size() as usize {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    // Acquiring all connections also ensures a poisoned idle connection cannot
    // hide behind a healthy one in a pool with several connections.
    let mut connections = Vec::new();
    for _ in 0..store.pool().size() {
        let connection = store.pool().acquire().await.unwrap();
        assert!(
            !connection.is_in_transaction(),
            "cancelled BEGIN returned an open transaction to the pool"
        );
        connections.push(connection);
    }
    drop(connections);
    timeout(
        Duration::from_secs(2),
        other.record_thread_completion("chat", "turn"),
    )
    .await
    .expect("cancelled BEGIN must release the SQLite writer lock")
    .unwrap();
    let state = store
        .record_thread_completion("chat", "next")
        .await
        .unwrap();
    assert_eq!(state.latest_completed_turn_id.as_deref(), Some("next"));
}

#[tokio::test]
async fn completed_and_guard_rolled_back_transactions_reuse_the_healthy_connection() {
    let store = Store::in_memory().await.unwrap();
    // A connection-local table proves that normal releases keep this connection
    // instead of replacing it (which also protects in-memory test databases).
    sqlx::query("create temp table connection_identity (value integer)")
        .execute(store.pool())
        .await
        .unwrap();
    let mut transaction = store.pool().begin_with("BEGIN IMMEDIATE").await.unwrap();
    sqlx::query("insert into connection_identity values (1)")
        .execute(&mut *transaction)
        .await
        .unwrap();
    drop(transaction);
    let count: i64 = sqlx::query_scalar("select count(*) from connection_identity")
        .fetch_one(store.pool())
        .await
        .unwrap();
    assert_eq!(count, 0, "guard-drop rollback must finish before reuse");
    let head = store
        .record_thread_completion("chat", "turn")
        .await
        .unwrap();
    let seen = store
        .mark_thread_seen("chat", "turn", head.read_revision)
        .await
        .unwrap();
    assert!(!seen.unread_completed_agent_turn);
    assert!(matches!(
        store
            .mark_thread_seen("chat", "stale", head.read_revision)
            .await,
        Err(ApiError::Conflict(_))
    ));
    assert_eq!(
        store.get_thread_read("chat").await.unwrap().read_revision,
        seen.read_revision
    );
    let count: i64 = sqlx::query_scalar("select count(*) from connection_identity")
        .fetch_one(store.pool())
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn missing_read_marker_is_unknown_and_empty_reconcile_is_explicitly_known() {
    let store = Store::in_memory().await.unwrap();
    let unknown = store.get_thread_read("new").await.unwrap();
    assert_eq!(unknown.thread_id, "new");
    assert_eq!(unknown.read_revision, 0);
    assert!(!unknown.read_state_known);
    assert!(unknown.latest_completed_turn_id.is_none());
    assert!(unknown.seen_completed_turn_id.is_none());
    assert!(!unknown.unread_completed_agent_turn);

    let empty = store
        .reconcile_thread_completion_head("new", 0, None)
        .await
        .unwrap();
    assert!(empty.read_state_known);
    assert!(empty.read_revision > 0);
    assert!(!empty.unread_completed_agent_turn);
    assert_eq!(
        store
            .unread_badge_snapshot(&["new".into()], 0)
            .await
            .unwrap(),
        (0, empty.read_revision)
    );
    let unchanged = store
        .reconcile_thread_completion_head("new", empty.read_revision, None)
        .await
        .unwrap();
    assert_eq!(unchanged.read_revision, empty.read_revision);
    assert_eq!(unchanged.updated_at, empty.updated_at);
}

#[tokio::test]
async fn stale_native_head_cannot_replace_a_completion_seen_ack_or_revert() {
    let store = Store::in_memory().await.unwrap();
    let first = store
        .record_thread_completion("chat", "turn-z")
        .await
        .unwrap();
    let next = store
        .record_thread_completion("chat", "turn-a")
        .await
        .unwrap();
    assert!(next.read_revision > first.read_revision);
    assert!(next.unread_completed_agent_turn);
    let stale = store
        .reconcile_thread_completion_head("chat", first.read_revision, Some("turn-z"))
        .await
        .unwrap();
    assert_eq!(stale.latest_completed_turn_id.as_deref(), Some("turn-a"));
    assert_eq!(stale.read_revision, next.read_revision);

    let seen = store
        .mark_thread_seen("chat", "turn-a", next.read_revision)
        .await
        .unwrap();
    let after_seen = store
        .reconcile_thread_completion_head("chat", next.read_revision, Some("turn-z"))
        .await
        .unwrap();
    assert_eq!(after_seen.read_revision, seen.read_revision);
    assert_eq!(after_seen.seen_completed_turn_id.as_deref(), Some("turn-a"));
    assert!(!after_seen.unread_completed_agent_turn);

    let invalidated = store
        .invalidate_thread_completion_head("chat")
        .await
        .unwrap();
    assert!(!invalidated.read_state_known);
    assert!(invalidated.latest_completed_turn_id.is_none());
    assert_eq!(
        invalidated.seen_completed_turn_id.as_deref(),
        Some("turn-a")
    );
    let stale = store
        .reconcile_thread_completion_head("chat", seen.read_revision, Some("turn-a"))
        .await
        .unwrap();
    assert_eq!(stale.read_revision, invalidated.read_revision);
    assert!(!stale.read_state_known);
    let surviving = store
        .reconcile_thread_completion_head("chat", invalidated.read_revision, Some("turn-z"))
        .await
        .unwrap();
    assert!(
        surviving.unread_completed_agent_turn,
        "opaque older identity is conservatively unread until viewed"
    );
    assert_eq!(surviving.seen_completed_turn_id.as_deref(), Some("turn-a"));
}

#[tokio::test]
async fn stale_invalidation_cannot_erase_a_newer_confirmed_and_seen_head() {
    let store = Store::in_memory().await.unwrap();
    let older = store
        .record_thread_completion("chat", "older")
        .await
        .unwrap();
    let newer = store
        .record_thread_completion("chat", "newer")
        .await
        .unwrap();
    let seen = store
        .mark_thread_seen("chat", "newer", newer.read_revision)
        .await
        .unwrap();

    let stale = store
        .invalidate_thread_completion_head_if_revision("chat", older.read_revision)
        .await
        .unwrap();
    assert!(stale.read_state_known);
    assert_eq!(stale.latest_completed_turn_id.as_deref(), Some("newer"));
    assert_eq!(stale.seen_completed_turn_id.as_deref(), Some("newer"));
    assert_eq!(stale.read_revision, seen.read_revision);
    assert_eq!(stale.updated_at, seen.updated_at);
    assert!(!stale.unread_completed_agent_turn);
    assert_eq!(
        store
            .unread_badge_snapshot(&["chat".into()], 0)
            .await
            .unwrap(),
        (0, seen.read_revision)
    );

    let current = store
        .invalidate_thread_completion_head_if_revision("chat", seen.read_revision)
        .await
        .unwrap();
    assert!(!current.read_state_known);
    assert!(current.latest_completed_turn_id.is_none());
    assert_eq!(current.seen_completed_turn_id.as_deref(), Some("newer"));
    assert!(current.read_revision > seen.read_revision);

    let still_unknown = store
        .invalidate_thread_completion_head_if_revision("chat", current.read_revision)
        .await
        .unwrap();
    assert_eq!(still_unknown.read_revision, current.read_revision);
    assert_eq!(still_unknown.updated_at, current.updated_at);
    assert_eq!(
        still_unknown.seen_completed_turn_id,
        current.seen_completed_turn_id
    );
    let event_fence = store
        .invalidate_thread_completion_head("chat")
        .await
        .unwrap();
    assert!(event_fence.read_revision > still_unknown.read_revision);
}

#[tokio::test]
async fn seen_requires_the_exact_displayed_head_and_revision_and_duplicates_are_noops() {
    let store = Store::in_memory().await.unwrap();
    assert!(matches!(
        store.mark_thread_seen("chat", "turn-a", 0).await,
        Err(ApiError::Conflict(_))
    ));
    let first = store
        .record_thread_completion("chat", "turn-a")
        .await
        .unwrap();
    let duplicate = store
        .record_thread_completion("chat", "turn-a")
        .await
        .unwrap();
    assert_eq!(duplicate.read_revision, first.read_revision);
    assert_eq!(duplicate.updated_at, first.updated_at);
    let newer = store
        .record_thread_completion("chat", "turn-b")
        .await
        .unwrap();
    for (head, revision) in [
        ("turn-a", first.read_revision),
        ("turn-a", newer.read_revision),
        ("turn-b", first.read_revision),
    ] {
        assert!(matches!(
            store.mark_thread_seen("chat", head, revision).await,
            Err(ApiError::Conflict(_))
        ));
    }
    assert!(
        store
            .get_thread_read("chat")
            .await
            .unwrap()
            .unread_completed_agent_turn
    );
    let seen = store
        .mark_thread_seen("chat", "turn-b", newer.read_revision)
        .await
        .unwrap();
    assert!(!seen.unread_completed_agent_turn);
    assert!(seen.read_revision > newer.read_revision);
    let duplicate = store
        .mark_thread_seen("chat", "turn-b", seen.read_revision)
        .await
        .unwrap();
    assert_eq!(duplicate.read_revision, seen.read_revision);
    assert_eq!(duplicate.updated_at, seen.updated_at);
    let duplicate_completion = store
        .record_thread_completion("chat", "turn-b")
        .await
        .unwrap();
    assert_eq!(duplicate_completion.read_revision, seen.read_revision);
    assert!(!duplicate_completion.unread_completed_agent_turn);
    let invalidated = store
        .invalidate_thread_completion_head("chat")
        .await
        .unwrap();
    assert!(matches!(
        store
            .mark_thread_seen("chat", "turn-b", invalidated.read_revision)
            .await,
        Err(ApiError::Conflict(_))
    ));
}

#[tokio::test]
async fn unseen_revert_fences_zero_revision_reads_and_badges_require_known_scope() {
    let store = Store::in_memory().await.unwrap();
    let reset = store
        .invalidate_thread_completion_head("unseen")
        .await
        .unwrap();
    assert!(reset.read_revision > 0);
    let stale = store
        .reconcile_thread_completion_head("unseen", 0, Some("removed-turn"))
        .await
        .unwrap();
    assert_eq!(stale.read_revision, reset.read_revision);
    assert!(!stale.read_state_known);
    let reset_again = store
        .invalidate_thread_completion_head("unseen")
        .await
        .unwrap();
    assert!(reset_again.read_revision > reset.read_revision);
    let stale = store
        .reconcile_thread_completion_head("unseen", reset.read_revision, Some("removed-again"))
        .await
        .unwrap();
    assert_eq!(stale.read_revision, reset_again.read_revision);
    assert!(!stale.read_state_known);
    assert!(matches!(
        store.unread_badge_snapshot(&["unseen".into()], 0).await,
        Err(ApiError::Conflict(_))
    ));
    assert!(matches!(
        store.unread_badge_snapshot(&["missing".into()], 0).await,
        Err(ApiError::Conflict(_))
    ));
    let empty = store
        .reconcile_thread_completion_head("unseen", reset_again.read_revision, None)
        .await
        .unwrap();
    let a = store.record_thread_completion("a", "a-turn").await.unwrap();
    let b = store.record_thread_completion("b", "b-turn").await.unwrap();
    let seen = store
        .mark_thread_seen("b", "b-turn", b.read_revision)
        .await
        .unwrap();
    assert!(a.read_revision > empty.read_revision);
    assert_eq!(
        store
            .unread_badge_snapshot(&["a".into(), "a".into(), "b".into(), "unseen".into()], 0)
            .await
            .unwrap(),
        (1, seen.read_revision)
    );
    assert_eq!(
        store.unread_badge_snapshot(&["b".into()], 0).await.unwrap(),
        (0, seen.read_revision)
    );
    let global_revision = store.bump_thread_read_membership_revision().await.unwrap();
    assert!(global_revision > seen.read_revision);
    let membership_revision = store.thread_read_membership_revision().await.unwrap();
    assert_eq!(membership_revision, 1);
    assert!(matches!(
        store.unread_badge_snapshot(&["a".into()], 0).await,
        Err(ApiError::Conflict(_))
    ));
    assert!(matches!(
        store.unread_badge_snapshot(&[], 0).await,
        Err(ApiError::Conflict(_))
    ));
    assert_eq!(
        store.get_thread_read("a").await.unwrap().read_revision,
        a.read_revision
    );
    assert_eq!(
        store
            .unread_badge_snapshot(&[], membership_revision)
            .await
            .unwrap(),
        (0, global_revision)
    );
}

#[tokio::test]
async fn marker_identity_and_global_revision_survive_cold_reopen_without_event_history() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("markers.db");
    let store = Store::connect(&path).await.unwrap();
    let head = store
        .record_thread_completion("chat", "opaque-completion")
        .await
        .unwrap();
    let seen = store
        .mark_thread_seen("chat", "opaque-completion", head.read_revision)
        .await
        .unwrap();
    let unread = store
        .record_thread_completion("other", "another-completion")
        .await
        .unwrap();
    let global_revision = store.bump_thread_read_membership_revision().await.unwrap();
    assert!(global_revision > unread.read_revision);
    let membership_revision = store.thread_read_membership_revision().await.unwrap();
    sqlx::query("delete from events")
        .execute(store.pool())
        .await
        .unwrap();
    store.pool().close().await;

    let reopened = Store::connect(&path).await.unwrap();
    assert_eq!(
        reopened.thread_read_membership_revision().await.unwrap(),
        membership_revision
    );
    let restored = reopened.get_thread_read("chat").await.unwrap();
    assert_eq!(
        restored.latest_completed_turn_id,
        seen.latest_completed_turn_id
    );
    assert_eq!(restored.seen_completed_turn_id, seen.seen_completed_turn_id);
    assert_eq!(restored.read_revision, seen.read_revision);
    assert_eq!(restored.updated_at, seen.updated_at);
    assert!(!restored.unread_completed_agent_turn);
    assert_eq!(
        reopened
            .unread_badge_snapshot(&["chat".into(), "other".into()], membership_revision)
            .await
            .unwrap(),
        (1, global_revision)
    );
    let next = reopened
        .record_thread_completion("third", "new-completion")
        .await
        .unwrap();
    assert!(next.read_revision > global_revision);
    let states = reopened
        .thread_read_states(&["chat".into(), "other".into(), "missing".into()])
        .await
        .unwrap();
    assert_eq!(states["chat"].read_revision, seen.read_revision);
    assert!(states["other"].unread_completed_agent_turn);
    assert!(!states.contains_key("missing"));
}

#[tokio::test]
async fn concurrent_sql_writers_cas_and_seen_never_lose_the_native_completion() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("concurrent.db");
    let first = Store::connect(&path).await.unwrap();
    let second = Store::connect(&path).await.unwrap();
    let baseline = first
        .record_thread_completion("chat", "first")
        .await
        .unwrap();
    let (ack, completion) = tokio::join!(
        first.mark_thread_seen("chat", "first", baseline.read_revision),
        second.record_thread_completion("chat", "second"),
    );
    let completion = completion.unwrap();
    match ack {
        Ok(ack) => assert!(ack.read_revision < completion.read_revision),
        Err(ApiError::Conflict(_)) => {}
        Err(error) => panic!("unexpected concurrent acknowledgment error: {error}"),
    }
    let latest = first.get_thread_read("chat").await.unwrap();
    assert_eq!(latest.latest_completed_turn_id.as_deref(), Some("second"));
    assert!(latest.unread_completed_agent_turn);

    let (left, right) = tokio::join!(
        first.reconcile_thread_completion_head("race", 0, Some("left")),
        second.reconcile_thread_completion_head("race", 0, Some("right")),
    );
    let (left, right) = (left.unwrap(), right.unwrap());
    assert_eq!(left.read_revision, right.read_revision);
    assert_eq!(
        left.latest_completed_turn_id,
        right.latest_completed_turn_id
    );
    assert!(left.read_revision > completion.read_revision);
    let revision = first
        .unread_badge_snapshot(&["chat".into(), "race".into()], 0)
        .await
        .unwrap();
    assert_eq!(revision, (2, left.read_revision));
}
