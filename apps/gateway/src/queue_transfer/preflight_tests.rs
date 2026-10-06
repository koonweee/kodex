use super::*;

async fn lose_context(state: &AppState, change: &str) {
    match change {
        "disconnected" => invalidate(state, true).await,
        "reverted" => invalidate(state, false).await,
        "completed" => {
            timeout(
                Duration::from_secs(2),
                ingest_inbound(
                    InboundMessage::Notification {
                        method: "turn/completed".into(),
                        params: json!({"threadId":THREAD,"turn":{
                            "id":TURN,"status":"completed","items":[],
                        }}),
                    },
                    state,
                ),
            )
            .await
            .unwrap()
            .unwrap();
        }
        _ => panic!("unknown fixture context change"),
    }
}

#[tokio::test]
async fn context_lost_during_queue_list_cannot_reenter_native_deletion() {
    for change in ["reverted", "disconnected", "completed"] {
        let (state, native) = fixture(true).await;
        let (listing, release) = native.hold("thread/queue/list");
        let task = spawn(&state, ROW);
        entered(listing).await;
        assert!(state
            .store
            .list_queue_transfers(None)
            .await
            .unwrap()
            .is_empty());
        lose_context(&state, change).await;
        release.send(()).unwrap();
        let _outcome = finish(task).await;
        assert!(
            native.writes().is_empty(),
            "{change} must fence the captured native row"
        );
        assert_eq!(*native.rows.lock().unwrap(), vec![row(OTHER_ROW), row(ROW)]);
        assert!(state
            .store
            .list_queue_transfers(None)
            .await
            .unwrap()
            .is_empty());
    }
}

#[tokio::test]
async fn stale_pre_add_native_head_cannot_create_a_new_promotion_witness() {
    for change in ["reverted", "disconnected", "completed"] {
        let (state, native) = fixture(false).await;
        let (reading, release) = native.hold("thread/turns/list");
        let producer_state = state.clone();
        let task = tokio::spawn(async move {
            enqueue(&producer_state, THREAD, input(), QUEUED_CLIENT.into()).await
        });
        entered(reading).await;
        lose_context(&state, change).await;
        release.send(()).unwrap();
        let _outcome = timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
        // Ordinary native admission is still allowed. It cannot gain a fresh
        // promotion right from the old head captured before context loss.
        let before = native.rows.lock().unwrap().clone();
        let _promotion = promote(&state, THREAD, ADDED_ROW).await;
        let writes = native.writes();
        assert!(
            writes.len() <= 1,
            "{change} must not admit then promote from a stale head: {writes:?}"
        );
        assert!(writes
            .iter()
            .all(|(method, _)| method == "thread/queue/add"));
        assert_eq!(*native.rows.lock().unwrap(), before);
        assert!(state
            .store
            .list_queue_transfers(None)
            .await
            .unwrap()
            .is_empty());
    }
}

async fn create_unresolved(state: &AppState) -> QueueTransfer {
    state
        .store
        .create_queue_transfer(THREAD, ROW, QUEUED_CLIENT, TURN, input())
        .await
        .unwrap()
}

async fn reject_transfer_markers(state: &AppState) {
    sqlx::query("CREATE TRIGGER reject_transfer_marker BEFORE INSERT ON events WHEN NEW.kind = 'turn_queue.transfer_changed' BEGIN SELECT RAISE(FAIL, 'fixture denies only transfer marker'); END")
        .execute(state.store.pool()).await.unwrap();
}

async fn ingest(state: &AppState, message: InboundMessage) -> ApiResult<()> {
    timeout(Duration::from_secs(2), ingest_inbound(message, state))
        .await
        .unwrap()
}

#[tokio::test]
async fn failed_transfer_marker_cannot_skip_disconnect_approval_and_completion_cleanup() {
    let (state, native) = fixture(false).await;
    let transfer = create_unresolved(&state).await;
    state.thread_views.observe_completion(THREAD, TURN).await;
    ingest(&state, InboundMessage::ServerRequest {
        request_id:"41".into(),
        method:"item/commandExecution/requestApproval".into(),
        params:json!({"threadId":THREAD,"turnId":TURN,"itemId":"command","command":"printf fixture"}),
    }).await.unwrap();
    let initial = crate::approvals::list_approvals(&state, None, None)
        .await
        .unwrap();
    assert_eq!(initial.approvals.len(), 1);
    let approval_id = initial.approvals[0].id.clone();
    reject_transfer_markers(&state).await;

    let outcome = ingest(&state, InboundMessage::Disconnected).await;
    assert!(
        state
            .thread_views
            .pending_completion(THREAD)
            .await
            .is_none(),
        "EOF cleanup cannot stop at a failed transfer refill marker"
    );
    assert!(crate::approvals::list_approvals(&state, None, None)
        .await
        .unwrap()
        .approvals
        .is_empty());
    assert_eq!(
        crate::approvals::get_approval(&state, &approval_id)
            .await
            .unwrap()
            .status,
        "unavailable"
    );
    assert_eq!(
        state
            .store
            .get_queue_transfer(&transfer.id)
            .await
            .unwrap()
            .unwrap()
            .phase,
        QueueTransferPhase::Uncertain
    );
    assert!(native.requests.lock().unwrap().is_empty());
    assert!(
        outcome.is_ok(),
        "optional transfer notification cannot fail mandatory EOF ingestion"
    );
}

#[tokio::test]
async fn failed_transfer_marker_cannot_skip_native_history_reset() {
    let (state, native) = fixture(false).await;
    let transfer = create_unresolved(&state).await;
    receipt(
        &state,
        THREAD,
        TURN,
        "native-user-before-reset",
        "item/started",
    )
    .await;
    let before = state.thread_views.patch_for_thread(THREAD).await;
    assert_eq!(before.items.len(), 1);
    reject_transfer_markers(&state).await;

    let outcome = ingest(
        &state,
        InboundMessage::Notification {
            method: "thread/reverted".into(),
            params: json!({"threadId":THREAD,"beforeTurnId":TURN}),
        },
    )
    .await;
    let after = state.thread_views.patch_for_thread(THREAD).await;
    assert!(
        after.items.is_empty(),
        "native revert must discard all old canonical items despite a failed transfer marker"
    );
    assert!(after.turns.is_empty());
    assert!(after.active_turn_id.is_none());
    assert!(after.view_revision > before.view_revision);
    assert_eq!(
        state
            .store
            .get_queue_transfer(&transfer.id)
            .await
            .unwrap()
            .unwrap()
            .phase,
        QueueTransferPhase::Uncertain
    );
    assert!(native.requests.lock().unwrap().is_empty());
    assert!(outcome.is_ok());
}

#[tokio::test]
async fn failed_transfer_marker_cannot_discard_the_settling_native_user_receipt() {
    let (state, native) = fixture(false).await;
    let transfer = create_unresolved(&state).await;
    reject_transfer_markers(&state).await;
    let outcome = ingest(&state, InboundMessage::Notification {
        method:"item/started".into(),
        params:json!({"threadId":THREAD,"turnId":TURN,"item":{
            "id":"receipt-native-item","type":"userMessage","clientId":transfer.id,"content":input(),
        }}),
    }).await;
    assert!(state
        .store
        .get_queue_transfer(&transfer.id)
        .await
        .unwrap()
        .is_none());
    let view = state.thread_views.patch_for_thread(THREAD).await;
    assert_eq!(
        view.items.len(),
        1,
        "receipt settlement cannot consume the native item before canonical ingestion"
    );
    assert_eq!(view.items[0].item_id, "receipt-native-item");
    assert_eq!(view.items[0].turn_id, TURN);
    assert_eq!(
        view.items[0].payload.item_snapshot.client_id.as_deref(),
        Some(transfer.id.as_str())
    );
    assert_eq!(
        view.items[0].payload.item_snapshot.raw_payload["content"],
        json!(input())
    );
    assert!(native.requests.lock().unwrap().is_empty());
    assert!(outcome.is_ok());
}

#[tokio::test]
async fn first_row_context_lost_during_native_selection_leaves_queue_untouched() {
    for change in ["reverted", "disconnected", "completed"] {
        let (state, native) = fixture(true).await;
        *native.rows.lock().unwrap() = vec![row(ROW), row(OTHER_ROW)];
        let before = native.rows.lock().unwrap().clone();
        let (listing, release) = native.hold("thread/queue/list");
        let selecting_state = state.clone();
        let selecting = tokio::spawn(async move {
            crate::queue_transfer::promote_first(&selecting_state, THREAD).await
        });
        entered(listing).await;
        lose_context(&state, change).await;
        release.send(()).unwrap();
        assert!(matches!(
            finish(selecting).await,
            Err(ApiError::Conflict(_))
        ));
        assert!(
            native.writes().is_empty(),
            "{change} must fence native selection"
        );
        assert_eq!(*native.rows.lock().unwrap(), before);
        assert!(state
            .store
            .list_queue_transfers(None)
            .await
            .unwrap()
            .is_empty());
    }
}

#[tokio::test]
async fn first_row_native_input_denial_leaves_queue_untouched() {
    let (state, native) = fixture(true).await;
    *native.rows.lock().unwrap() = vec![row(ROW), row(OTHER_ROW)];
    *native.capability.lock().unwrap() = Some(false);
    assert!(matches!(
        crate::queue_transfer::promote_first(&state, THREAD).await,
        Err(ApiError::BadRequest(_))
    ));
    assert!(native.writes().is_empty());
    assert_eq!(*native.rows.lock().unwrap(), vec![row(ROW), row(OTHER_ROW)]);
    assert!(state
        .store
        .list_queue_transfers(None)
        .await
        .unwrap()
        .is_empty());
}
