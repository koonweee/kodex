use serde_json::{json, Value};
use tempfile::tempdir;

use crate::{
    error::ApiError,
    store::{QueueTransfer, QueueTransferPhase, Store},
};

fn input() -> Vec<Value> {
    vec![
        json!({"type":"text","text":"你好 $skill","text_elements":[{
            "byteRange":{"start":7,"end":13},"placeholder":"$skill",
        }]}),
        json!({"type":"skill","name":"skill","path":"/native/技能/SKILL.md"}),
        json!({"type":"image","fileId":"opaque-file","detail":"original"}),
        json!({"type":"localAudio","path":"/native/音.wav"}),
    ]
}

async fn create(store: &Store, thread: &str, row: &str) -> QueueTransfer {
    store
        .create_queue_transfer(
            thread,
            row,
            "reused-original-client",
            "original-turn",
            input(),
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn deleting_intent_and_lossless_input_are_durable_before_any_native_mutation() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("gateway.db");
    let store = Store::connect(&path).await.unwrap();
    let record = store
        .create_queue_transfer(
            " opaque/thread ",
            " native/queue:相同 ",
            " original/client ",
            " expected/turn ",
            input(),
        )
        .await
        .unwrap();
    assert_eq!(record.phase, QueueTransferPhase::Deleting);
    assert!(record.error.is_none());
    assert_eq!(record.input, input());
    assert_ne!(record.id, record.client_user_message_id);
    assert_eq!(record.created_at, record.updated_at);
    store.pool().close().await;

    let reopened = Store::connect(&path).await.unwrap();
    let restored = reopened
        .get_queue_transfer(&record.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(&restored).unwrap(),
        serde_json::to_value(&record).unwrap()
    );
    assert_eq!(restored.thread_id, " opaque/thread ");
    assert_eq!(restored.native_queue_id, " native/queue:相同 ");
    assert_eq!(restored.client_user_message_id, " original/client ");
    assert_eq!(restored.expected_turn_id, " expected/turn ");
    assert_eq!(
        reopened
            .get_queue_transfer_for_row(" opaque/thread ", " native/queue:相同 ")
            .await
            .unwrap()
            .unwrap()
            .id,
        record.id,
    );
    for (thread, row) in [
        ("opaque/thread", " native/queue:相同 "),
        (" opaque/thread ", "native/queue:相同"),
        ("other-thread", " native/queue:相同 "),
    ] {
        assert!(reopened
            .get_queue_transfer_for_row(thread, row)
            .await
            .unwrap()
            .is_none());
    }
    assert_eq!(
        reopened
            .list_queue_transfers(Some("opaque/thread"))
            .await
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        reopened
            .list_queue_transfers(Some(" opaque/thread "))
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn competing_connections_claim_one_native_row_without_replacing_the_winner() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("gateway.db");
    let first = Store::connect(&path).await.unwrap();
    let second = Store::connect(&path).await.unwrap();
    let (left, right) = tokio::join!(
        first.create_queue_transfer(
            "thread",
            "native-row",
            "client-left",
            "turn-left",
            vec![json!({"type":"text","text":"left"})]
        ),
        second.create_queue_transfer(
            "thread",
            "native-row",
            "client-right",
            "turn-right",
            vec![json!({"type":"text","text":"right"})]
        ),
    );
    let (winner, loser) = match (left, right) {
        (Ok(winner), Err(loser)) | (Err(loser), Ok(winner)) => (winner, loser),
        outcomes => panic!("expected one durable claim, got {outcomes:?}"),
    };
    assert!(matches!(loser, ApiError::Conflict(_)));
    let rows = second.list_queue_transfers(Some("thread")).await.unwrap();
    assert_eq!(serde_json::to_value(rows).unwrap(), json!([winner]));
    // Native row identity is scoped to its thread, with no text/client dedup.
    let other = create(&first, "other-thread", "native-row").await;
    assert_ne!(other.id, winner.id);
    assert_eq!(second.list_queue_transfers(None).await.unwrap().len(), 2);
}

#[tokio::test]
async fn phase_changes_are_conditional_forward_only_and_keep_recovery_input() {
    let store = Store::in_memory().await.unwrap();
    let original = create(&store, "thread", "row").await;
    let deleted = store
        .advance_queue_transfer(
            &original.id,
            QueueTransferPhase::Deleting,
            QueueTransferPhase::Deleted,
            None,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(deleted.phase, QueueTransferPhase::Deleted);
    assert!(store
        .advance_queue_transfer(
            &original.id,
            QueueTransferPhase::Deleting,
            QueueTransferPhase::Deleted,
            None
        )
        .await
        .unwrap()
        .is_none());
    assert!(matches!(
        store
            .advance_queue_transfer(
                &original.id,
                QueueTransferPhase::Deleted,
                QueueTransferPhase::Accepted,
                None
            )
            .await,
        Err(ApiError::BadRequest(_))
    ));
    let unchanged = store
        .get_queue_transfer(&original.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unchanged.updated_at, deleted.updated_at);
    let steering = store
        .advance_queue_transfer(
            &original.id,
            QueueTransferPhase::Deleted,
            QueueTransferPhase::Steering,
            None,
        )
        .await
        .unwrap()
        .unwrap();
    let accepted = store
        .advance_queue_transfer(
            &original.id,
            QueueTransferPhase::Steering,
            QueueTransferPhase::Accepted,
            None,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(accepted.phase, QueueTransferPhase::Accepted);
    assert_eq!(accepted.input, original.input);
    assert_eq!(accepted.created_at, original.created_at);
    assert_eq!(accepted.expected_turn_id, steering.expected_turn_id);
    assert_eq!(
        store
            .list_queue_transfers(Some("thread"))
            .await
            .unwrap()
            .len(),
        1,
        "an acknowledgement does not settle native delivery"
    );
}

#[tokio::test]
async fn positive_receipt_can_settle_every_phase_and_late_acks_never_resurrect() {
    use QueueTransferPhase::{Accepted, Deleted, Deleting, Steering, Uncertain};
    for phase in [Deleting, Deleted, Steering, Accepted, Uncertain] {
        let store = Store::in_memory().await.unwrap();
        let record = create(&store, "thread", "row").await;
        set_phase(&store, &record.id, phase).await;
        assert!(store
            .settle_queue_transfer_delivery("thread", "original-turn", Some(&record.id))
            .await
            .unwrap());
        assert!(store
            .get_queue_transfer(&record.id)
            .await
            .unwrap()
            .is_none());
        assert!(!store
            .settle_queue_transfer_delivery("thread", "original-turn", Some(&record.id))
            .await
            .unwrap());
        let next = match phase {
            Deleting => Some(Deleted),
            Deleted => Some(Steering),
            Steering => Some(Accepted),
            Accepted => Some(Uncertain),
            Uncertain => None,
        };
        if let Some(next) = next {
            assert!(store
                .advance_queue_transfer(&record.id, phase, next, None)
                .await
                .unwrap()
                .is_none());
        }
        assert_eq!(
            store
                .invalidate_queue_transfers(None, "disconnect")
                .await
                .unwrap(),
            0
        );
        assert!(store.list_queue_transfers(None).await.unwrap().is_empty());
    }
}

#[tokio::test]
async fn only_exact_transfer_thread_turn_and_fresh_client_identity_settles() {
    let store = Store::in_memory().await.unwrap();
    let first = create(&store, "thread", "native-a").await;
    let second = create(&store, "thread", "native-b").await;
    assert_eq!(first.client_user_message_id, second.client_user_message_id);
    assert_eq!(first.input, second.input);
    assert_ne!(first.id, second.id);
    for (thread, turn, client) in [
        ("foreign-thread", "original-turn", Some(first.id.as_str())),
        ("thread", "foreign-turn", Some(first.id.as_str())),
        (
            "thread",
            "original-turn",
            Some(first.client_user_message_id.as_str()),
        ),
        ("thread", "original-turn", Some("unrelated-client")),
        ("thread", "original-turn", None),
    ] {
        assert!(!store
            .settle_queue_transfer_delivery(thread, turn, client)
            .await
            .unwrap());
    }
    assert_eq!(store.list_queue_transfers(None).await.unwrap().len(), 2);
    assert!(store
        .settle_queue_transfer_delivery("thread", "original-turn", Some(&first.id))
        .await
        .unwrap());
    let later = create(&store, "thread", "native-a").await;
    assert!(!store
        .settle_queue_transfer_delivery("thread", "original-turn", Some(&first.id))
        .await
        .unwrap());
    assert_eq!(
        store
            .get_queue_transfer(&second.id)
            .await
            .unwrap()
            .unwrap()
            .id,
        second.id
    );
    assert_eq!(
        store
            .get_queue_transfer(&later.id)
            .await
            .unwrap()
            .unwrap()
            .id,
        later.id
    );
    assert!(store
        .settle_queue_transfer_delivery("thread", "original-turn", Some(&second.id))
        .await
        .unwrap());
    assert_eq!(store.list_queue_transfers(None).await.unwrap().len(), 1);
}

#[tokio::test]
async fn reset_and_disconnect_expose_uncertainty_without_reactivating_records() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("gateway.db");
    let store = Store::connect(&path).await.unwrap();
    let first = create(&store, "thread-a", "row-a").await;
    let second = create(&store, "thread-b", "row-b").await;
    let same_thread = create(&store, "thread-b", "row-d").await;
    let already_uncertain = create(&store, "thread-a", "row-c").await;
    set_phase(&store, &first.id, QueueTransferPhase::Accepted).await;
    let saved_uncertain = store
        .advance_queue_transfer(
            &already_uncertain.id,
            QueueTransferPhase::Deleting,
            QueueTransferPhase::Uncertain,
            Some("delete reply lost"),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        store
            .invalidate_queue_transfers(Some("thread-a"), "native reset")
            .await
            .unwrap(),
        1
    );
    let first = store.get_queue_transfer(&first.id).await.unwrap().unwrap();
    assert_eq!(first.phase, QueueTransferPhase::Uncertain);
    assert_eq!(first.error.as_deref(), Some("native reset"));
    assert_eq!(first.input, input());
    assert_eq!(
        store
            .get_queue_transfer(&second.id)
            .await
            .unwrap()
            .unwrap()
            .phase,
        QueueTransferPhase::Deleting
    );
    assert_eq!(
        store
            .invalidate_queue_transfers_for_restart("native disconnected")
            .await
            .unwrap(),
        vec!["thread-b"],
    );
    assert_eq!(
        store
            .get_queue_transfer(&same_thread.id)
            .await
            .unwrap()
            .unwrap()
            .phase,
        QueueTransferPhase::Uncertain
    );
    assert!(store
        .invalidate_queue_transfers_for_restart("another disconnect")
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        store
            .invalidate_queue_transfers(None, "another disconnect")
            .await
            .unwrap(),
        0
    );
    assert!(store
        .advance_queue_transfer(
            &second.id,
            QueueTransferPhase::Deleting,
            QueueTransferPhase::Deleted,
            None
        )
        .await
        .unwrap()
        .is_none());
    assert!(matches!(
        store
            .advance_queue_transfer(
                &second.id,
                QueueTransferPhase::Uncertain,
                QueueTransferPhase::Steering,
                None
            )
            .await,
        Err(ApiError::BadRequest(_))
    ));
    let preserved = store
        .get_queue_transfer(&already_uncertain.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(preserved.error, saved_uncertain.error);
    assert_eq!(preserved.updated_at, saved_uncertain.updated_at);
    store.pool().close().await;
    let reopened = Store::connect(&path).await.unwrap();
    let records = reopened.list_queue_transfers(None).await.unwrap();
    assert_eq!(records.len(), 4);
    assert!(records
        .iter()
        .all(|record| record.phase == QueueTransferPhase::Uncertain && record.input == input()));
}

#[tokio::test]
async fn a_stale_terminal_only_invalidates_transfers_for_its_original_turn() {
    let store = Store::in_memory().await.unwrap();
    let old = store
        .create_queue_transfer("thread", "old-row", "original-client", "old-turn", input())
        .await
        .unwrap();
    let current = store
        .create_queue_transfer(
            "thread",
            "current-row",
            "original-client",
            "new-turn",
            input(),
        )
        .await
        .unwrap();
    let other = store
        .create_queue_transfer(
            "other-thread",
            "other-row",
            "original-client",
            "old-turn",
            input(),
        )
        .await
        .unwrap();
    set_phase(&store, &old.id, QueueTransferPhase::Accepted).await;
    set_phase(&store, &current.id, QueueTransferPhase::Steering).await;
    assert_eq!(
        store
            .invalidate_queue_transfers_for_turn("thread", "old-turn", "turn completed")
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .invalidate_queue_transfers_for_turn("thread", "old-turn", "late duplicate")
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .get_queue_transfer(&old.id)
            .await
            .unwrap()
            .unwrap()
            .phase,
        QueueTransferPhase::Uncertain
    );
    assert_eq!(
        store
            .get_queue_transfer(&current.id)
            .await
            .unwrap()
            .unwrap()
            .phase,
        QueueTransferPhase::Steering
    );
    assert_eq!(
        store
            .get_queue_transfer(&other.id)
            .await
            .unwrap()
            .unwrap()
            .phase,
        QueueTransferPhase::Deleting
    );
    assert!(store
        .advance_queue_transfer(
            &old.id,
            QueueTransferPhase::Accepted,
            QueueTransferPhase::Uncertain,
            None
        )
        .await
        .unwrap()
        .is_none());
    assert!(store
        .settle_queue_transfer_delivery("thread", "old-turn", Some(&old.id))
        .await
        .unwrap());
}

async fn set_phase(store: &Store, id: &str, target: QueueTransferPhase) {
    use QueueTransferPhase::{Accepted, Deleted, Deleting, Steering, Uncertain};
    if target == Uncertain {
        store
            .advance_queue_transfer(id, Deleting, Uncertain, Some("test boundary lost"))
            .await
            .unwrap()
            .unwrap();
        return;
    }
    let mut phase = Deleting;
    for next in [Deleted, Steering, Accepted] {
        if phase == target {
            return;
        }
        store
            .advance_queue_transfer(id, phase, next, None)
            .await
            .unwrap()
            .unwrap();
        phase = next;
    }
}
