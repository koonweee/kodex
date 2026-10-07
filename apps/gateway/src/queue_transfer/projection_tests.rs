use super::*;

#[tokio::test]
async fn accepted_steer_projects_native_input_and_receipt_replaces_the_pending_row() {
    let (state, native) = fixture().await;
    let mut events = state.events.subscribe();
    let accepted = transfer(promote(&state, THREAD, ROW).await.unwrap());
    let pending = state.thread_views.patch_for_thread(THREAD).await;
    assert_eq!(pending.items.len(), 1);
    assert_eq!(pending.items[0].turn_id, TURN);
    assert_eq!(
        pending.items[0].item_id,
        format!("pending-user-{}", accepted.id)
    );
    assert_eq!(
        pending.items[0].payload.item.client_id.as_deref(),
        Some(accepted.id.as_str())
    );
    assert_eq!(pending.items[0].payload.item.content, Some(json!(input())));
    let mut published_pending = false;
    while let Ok(event) = events.try_recv() {
        if event.kind == "thread_view.patch" {
            published_pending |= event
                .payload
                .to_string()
                .contains(&format!("pending-user-{}", accepted.id));
        }
    }
    assert!(
        published_pending,
        "other tabs must receive the canonical pending row"
    );
    receipt(&state, THREAD, TURN, &accepted.id, "item/completed").await;
    let confirmed = state.thread_views.patch_for_thread(THREAD).await;
    assert_eq!(confirmed.items.len(), 1);
    assert_eq!(
        confirmed.items[0].item_id,
        format!("native-item-{}", accepted.id)
    );
    assert!(state
        .store
        .get_queue_transfer(&accepted.id)
        .await
        .unwrap()
        .is_none());
    assert_eq!(native.writes().len(), 2);
}

#[tokio::test]
async fn uncertain_delivery_removes_only_the_pending_projection() {
    let (state, _) = fixture().await;
    let accepted = transfer(promote(&state, THREAD, ROW).await.unwrap());
    assert_eq!(
        state
            .thread_views
            .patch_for_thread(THREAD)
            .await
            .items
            .len(),
        1
    );
    receipt(&state, THREAD, TURN, "other-input", "item/completed").await;
    ingest_inbound(
        InboundMessage::Notification {
            method: "turn/completed".into(),
            params: json!({"threadId":THREAD,"turn":{"id":TURN,"status":"completed","items":[]}}),
        },
        &state,
    )
    .await
    .unwrap();
    assert_eq!(saved(&state).await.phase, QueueTransferPhase::Uncertain);
    let uncertain = state.thread_views.patch_for_thread(THREAD).await;
    assert_eq!(uncertain.items.len(), 1);
    assert_eq!(uncertain.items[0].item_id, "native-item-other-input");
    // Late confirmation is still authoritative and must not be discarded.
    receipt(&state, THREAD, TURN, &accepted.id, "item/completed").await;
    let confirmed = state.thread_views.patch_for_thread(THREAD).await;
    assert_eq!(confirmed.items.len(), 2);
    assert!(confirmed
        .items
        .iter()
        .any(|item| item.item_id == format!("native-item-{}", accepted.id)));
}

#[tokio::test]
async fn acknowledged_native_file_input_keeps_its_normal_attachment_presentation() {
    let (state, native) = fixture().await;
    native
        .rows
        .lock()
        .unwrap()
        .iter_mut()
        .find(|row| row["id"] == ROW)
        .unwrap()["input"] = json!([
        {"type":"text","text":"Review this\n\n```kodex-attachments\n- .kodex/uploads/promotion-chat/upload-1/notes.md\n```"}
    ]);
    let accepted = transfer(promote(&state, THREAD, ROW).await.unwrap());
    let pending = state.thread_views.patch_for_thread(THREAD).await;
    assert_eq!(pending.items.len(), 1);
    assert_eq!(
        pending.items[0].payload.item.content,
        Some(json!(accepted.input))
    );
    let attachments = &pending.items[0].payload.item_snapshot.file_attachments;
    assert_eq!(attachments.len(), 1);
    assert_eq!(attachments[0].file_name, "notes.md");
}

#[tokio::test]
async fn uncertainty_during_pending_commit_cannot_leave_a_late_temporary_row() {
    let (state, native) = fixture().await;
    sqlx::query("CREATE TRIGGER invalidate_at_pending_commit AFTER INSERT ON events WHEN NEW.kind = 'timeline.pending_user_input' BEGIN UPDATE queue_transfers SET phase = 'uncertain', error = 'Continuity lost during projection'; END")
        .execute(state.store.pool()).await.unwrap();
    let outcome = transfer(promote(&state, THREAD, ROW).await.unwrap());
    assert_eq!(outcome.phase, QueueTransferPhase::Uncertain);
    assert_eq!(outcome.input, input());
    assert!(state
        .thread_views
        .patch_for_thread(THREAD)
        .await
        .items
        .is_empty());
    assert_eq!(
        native.writes().len(),
        2,
        "successful native acknowledgment must not become a resend"
    );
}

#[tokio::test]
async fn settled_transfer_cannot_leave_a_late_pending_projection() {
    for uncertain in [false, true] {
        let (state, _) = fixture().await;
        let accepted = transfer(promote(&state, THREAD, ROW).await.unwrap());
        if uncertain {
            state
                .store
                .advance_queue_transfer(
                    &accepted.id,
                    QueueTransferPhase::Accepted,
                    QueueTransferPhase::Uncertain,
                    Some("Turn ended"),
                )
                .await
                .unwrap();
        }
        // An explicit reconciliation can settle before a late projection
        // reaches its post-insertion check, without a live native item event.
        assert!(state
            .store
            .settle_queue_transfer_delivery(THREAD, TURN, Some(&accepted.id))
            .await
            .unwrap());
        crate::queue_transfer::projection::record_accepted(
            &state,
            &accepted,
            state.store.latest_event_seq().await.unwrap(),
        )
        .await;
        assert!(state
            .thread_views
            .patch_for_thread(THREAD)
            .await
            .items
            .is_empty());
    }
}

#[tokio::test]
async fn receipt_before_steer_ack_never_adds_a_duplicate_pending_message() {
    let (state, native) = fixture().await;
    let (started, release) = native.hold("turn/steer");
    let task = spawn(&state, ROW);
    entered(started).await;
    let transferring = saved(&state).await;
    receipt(&state, THREAD, TURN, &transferring.id, "item/completed").await;
    release.send(()).unwrap();
    assert!(matches!(
        finish(task).await.unwrap(),
        PromotionOutcome::Delivered { .. }
    ));
    let confirmed = state.thread_views.patch_for_thread(THREAD).await;
    assert_eq!(confirmed.items.len(), 1);
    assert_eq!(
        confirmed.items[0].item_id,
        format!("native-item-{}", transferring.id)
    );
}

#[tokio::test]
async fn revert_during_steer_does_not_publish_removed_input_after_a_late_ack() {
    let (state, native) = fixture().await;
    let (started, release) = native.hold("turn/steer");
    let task = spawn(&state, ROW);
    entered(started).await;
    invalidate(&state, false).await;
    release.send(()).unwrap();
    let outcome = transfer(finish(task).await.unwrap());
    assert_eq!(outcome.phase, QueueTransferPhase::Uncertain);
    assert!(state
        .thread_views
        .patch_for_thread(THREAD)
        .await
        .items
        .is_empty());
}
