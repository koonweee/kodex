use super::*;

const THREAD: &str = "identity-thread";
const TURN: &str = "identity-turn";

fn input() -> Vec<UserInput> {
    vec![UserInput::Text {
        text: "Identical message".to_string(),
        text_elements: Vec::new(),
    }]
}

fn user_item(id: &str, client_id: Option<&str>) -> Value {
    json!({
        "id": id,
        "type": "userMessage",
        "clientId": client_id,
        "content": input(),
    })
}

async fn pending(sessions: &ThreadViewStore, client_id: &str, seq: i64) -> Option<ThreadViewPatch> {
    record_pending_user_input(sessions, THREAD, TURN, client_id, &input(), &[], (seq, seq))
        .await
        .unwrap()
}

async fn echo(sessions: &ThreadViewStore, item: Value, seq: i64) {
    let snapshot = ThreadItemSnapshot::from_payload(&item).unwrap();
    record_item_upsert(
        sessions,
        THREAD,
        TURN,
        item,
        snapshot,
        Some("completed"),
        seq,
    )
    .await
    .unwrap();
}

async fn active_snapshot(
    sessions: &ThreadViewStore,
    items: Vec<Value>,
    seq: i64,
) -> ThreadTimelineSnapshot {
    let turn = ThreadTurnSnapshot {
        id: TURN.to_string(),
        status: "inProgress".to_string(),
        started_at: Some(1),
        completed_at: None,
        items: items
            .iter()
            .map(|item| ThreadItemSnapshot::from_payload(item).unwrap())
            .collect(),
        raw_payload: json!({}),
    };
    build_thread_timeline(sessions, THREAD, &[turn], seq)
        .await
        .unwrap()
}

fn item_ids(items: &[ThreadTimelineSnapshotItem]) -> Vec<&str> {
    let mut ids = items
        .iter()
        .map(|item| item.item_id.as_str())
        .collect::<Vec<_>>();
    ids.sort_unstable();
    ids
}

#[tokio::test]
async fn identical_pending_messages_reconcile_only_the_echoed_client_identity() {
    let sessions = ThreadViewStore::default();
    pending(&sessions, "client-first", 1).await;
    pending(&sessions, "client-second", 2).await;
    let before = patch_for_thread(&sessions, THREAD).await.unwrap();
    assert_eq!(before.items.len(), 2);
    assert_eq!(
        before
            .items
            .iter()
            .map(|item| item.payload.item.client_id.as_deref())
            .collect::<Vec<_>>(),
        vec![Some("client-first"), Some("client-second")]
    );

    // Receipt order need not be the synthetic pending-row order.
    echo(
        &sessions,
        user_item("native-second", Some("client-second")),
        3,
    )
    .await;
    let after_second = patch_for_thread(&sessions, THREAD).await.unwrap();
    assert_eq!(
        item_ids(&after_second.items),
        vec!["native-second", "pending-user-client-first"]
    );
    echo(
        &sessions,
        user_item("native-first", Some("client-first")),
        4,
    )
    .await;
    let complete = patch_for_thread(&sessions, THREAD).await.unwrap();
    assert_eq!(
        item_ids(&complete.items),
        vec!["native-first", "native-second"]
    );
}

#[tokio::test]
async fn foreign_and_missing_client_ids_cannot_confirm_identical_pending_text() {
    for via_snapshot in [false, true] {
        let sessions = ThreadViewStore::default();
        pending(&sessions, "client-mine", 1).await;
        let other_items = vec![
            user_item("native-foreign", Some("client-other-tab")),
            user_item("native-without-client", None),
        ];
        if via_snapshot {
            active_snapshot(&sessions, other_items, 2).await;
        } else {
            for (index, item) in other_items.into_iter().enumerate() {
                echo(&sessions, item, index as i64 + 2).await;
            }
        }
        let patch = patch_for_thread(&sessions, THREAD).await.unwrap();
        assert_eq!(
            item_ids(&patch.items),
            vec![
                "native-foreign",
                "native-without-client",
                "pending-user-client-mine"
            ],
            "foreign or ID-less input must not acknowledge this pending submission"
        );
    }
}

#[tokio::test]
async fn active_snapshot_reconciles_only_matching_pending_client_identity() {
    let sessions = ThreadViewStore::default();
    pending(&sessions, "client-first", 1).await;
    pending(&sessions, "client-second", 2).await;
    let timeline = active_snapshot(
        &sessions,
        vec![user_item("native-second", Some("client-second"))],
        3,
    )
    .await;
    assert_eq!(
        item_ids(&timeline.items),
        vec!["native-second", "pending-user-client-first"]
    );
    assert_eq!(timeline.live_state, ThreadLiveState::Streaming);
}

#[tokio::test]
async fn native_echo_before_ack_prevents_late_pending_projection() {
    for via_snapshot in [false, true] {
        let sessions = ThreadViewStore::default();
        let item = user_item("native-before-ack", Some("client-first"));
        if via_snapshot {
            active_snapshot(&sessions, vec![item], 1).await;
        } else {
            echo(&sessions, item, 1).await;
        }
        assert!(
            pending(&sessions, "client-first", 2).await.is_none(),
            "ACK projection must not recreate an input already confirmed by native state"
        );
        let patch = patch_for_thread(&sessions, THREAD).await.unwrap();
        assert_eq!(item_ids(&patch.items), vec!["native-before-ack"]);
    }
}

#[tokio::test]
async fn native_item_identity_survives_duplicate_client_ids_and_snapshot_refresh() {
    let sessions = ThreadViewStore::default();
    echo(
        &sessions,
        user_item("native-first", Some("reused-client")),
        1,
    )
    .await;
    echo(
        &sessions,
        user_item("native-second", Some("reused-client")),
        2,
    )
    .await;
    let live = patch_for_thread(&sessions, THREAD).await.unwrap();
    assert_eq!(item_ids(&live.items), vec!["native-first", "native-second"]);

    let timeline = active_snapshot(
        &sessions,
        vec![user_item("native-first", Some("reused-client"))],
        3,
    )
    .await;
    assert_eq!(
        item_ids(&timeline.items),
        vec!["native-first", "native-second"]
    );
}

#[tokio::test]
async fn pending_identity_is_scoped_to_its_turn_and_repeated_ack_does_not_duplicate_it() {
    let sessions = ThreadViewStore::default();
    let item = user_item("native-prior-turn", Some("client-reused"));
    let snapshot = ThreadItemSnapshot::from_payload(&item).unwrap();
    record_item_upsert(
        &sessions,
        THREAD,
        "prior-turn",
        item,
        snapshot,
        Some("completed"),
        1,
    )
    .await
    .unwrap();
    pending(&sessions, "client-reused", 2).await;
    pending(&sessions, "client-reused", 3).await;
    let patch = patch_for_thread(&sessions, THREAD).await.unwrap();
    assert_eq!(
        item_ids(&patch.items),
        vec!["native-prior-turn", "pending-user-client-reused"]
    );
}
