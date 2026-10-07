use super::*;

#[tokio::test]
async fn idle_send_now_starts_the_selected_native_row_without_delete_or_steer() {
    let (state, native) = fixture().await;
    *native.active_turn.lock().unwrap() = None;
    let outcome = promote(&state, THREAD, ROW).await.unwrap();
    assert!(matches!(outcome, PromotionOutcome::Delivered { id } if id == ROW));
    assert_eq!(
        native.writes(),
        vec![(
            "thread/queue/start".into(),
            json!({"threadId":THREAD,"queuedSubmissionId":ROW}),
        )]
    );
    assert_eq!(*native.rows.lock().unwrap(), vec![row(OTHER_ROW)]);
    assert!(state
        .store
        .list_queue_transfers(None)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn idle_routing_race_native_queue_start_rejection_does_not_steer_or_retry() {
    let (state, native) = fixture().await;
    *native.active_turn.lock().unwrap() = None;
    let (reading, release) = native.hold("thread/turns/list");
    let task = spawn(&state, ROW);
    entered(reading).await;
    // Native state changes before its notification reaches the gateway. The
    // native start command supplies the final atomic guard in this window.
    *native.active_turn.lock().unwrap() = Some("another-client-turn".into());
    release.send(()).unwrap();
    assert!(matches!(finish(task).await, Err(ApiError::BadRequest(_))));
    assert_eq!(native.writes().len(), 1);
    assert_eq!(native.writes()[0].0, "thread/queue/start");
    assert_eq!(*native.rows.lock().unwrap(), vec![row(OTHER_ROW), row(ROW)]);
}

#[tokio::test]
async fn idle_first_send_now_starts_the_native_front_and_leaves_other_rows_ordered() {
    let (state, native) = fixture().await;
    *native.active_turn.lock().unwrap() = None;
    let outcome = crate::queue_transfer::promote_first(&state, THREAD)
        .await
        .unwrap();
    assert!(matches!(outcome, PromotionOutcome::Delivered { id } if id == OTHER_ROW));
    assert_eq!(
        native.writes(),
        vec![(
            "thread/queue/start".into(),
            json!({"threadId":THREAD,"queuedSubmissionId":OTHER_ROW}),
        )]
    );
    assert_eq!(*native.rows.lock().unwrap(), vec![row(ROW)]);
}

#[tokio::test]
async fn idle_send_now_never_retries_or_steers_a_lost_queue_start_acknowledgement() {
    let (state, native) = fixture().await;
    *native.active_turn.lock().unwrap() = None;
    *native.start_lost.lock().unwrap() = true;
    assert!(matches!(
        promote(&state, THREAD, ROW).await,
        Err(ApiError::BadGateway(_))
    ));
    assert_eq!(native.writes().len(), 1);
    assert_eq!(native.writes()[0].0, "thread/queue/start");
    assert_eq!(*native.rows.lock().unwrap(), vec![row(OTHER_ROW)]);
    assert!(state
        .store
        .list_queue_transfers(None)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn idle_first_send_now_returns_the_unresolved_front_transfer_without_starting() {
    let (state, native) = fixture().await;
    *native.active_turn.lock().unwrap() = None;
    let saved = state
        .store
        .create_queue_transfer(THREAD, OTHER_ROW, QUEUED_CLIENT, TURN, input())
        .await
        .unwrap();
    let outcome = transfer(
        crate::queue_transfer::promote_first(&state, THREAD)
            .await
            .unwrap(),
    );
    assert_eq!(outcome.id, saved.id);
    assert!(native.writes().is_empty());
    assert_eq!(*native.rows.lock().unwrap(), vec![row(OTHER_ROW), row(ROW)]);
}

#[tokio::test]
async fn idle_send_now_rejects_stale_preflight_after_reset_or_turn_start() {
    for change in ["disconnected", "reverted", "started"] {
        let (state, native) = fixture().await;
        *native.active_turn.lock().unwrap() = None;
        let (reading, release) = native.hold("thread/turns/list");
        let task = spawn(&state, ROW);
        entered(reading).await;
        if change == "started" {
            *native.active_turn.lock().unwrap() = Some("other-client-turn".into());
            state.queue_steer_guards.observe_notification(
                "turn/started",
                &json!({"threadId":THREAD,"turn":{"id":"other-client-turn"}}),
            );
        } else {
            invalidate(&state, change == "disconnected").await;
        }
        release.send(()).unwrap();
        assert!(
            matches!(finish(task).await, Err(ApiError::Conflict(_))),
            "{change}"
        );
        assert!(native.writes().is_empty(), "{change}");
        assert_eq!(*native.rows.lock().unwrap(), vec![row(OTHER_ROW), row(ROW)]);
    }
}

#[tokio::test]
async fn concurrent_idle_send_now_clicks_do_not_start_or_steer_the_same_row_twice() {
    let (state, native) = fixture().await;
    *native.active_turn.lock().unwrap() = None;
    let (starting, release) = native.hold("thread/queue/start");
    let first = spawn(&state, ROW);
    entered(starting).await;
    let mut second = spawn(&state, ROW);
    assert!(timeout(Duration::from_millis(30), &mut second)
        .await
        .is_err());
    release.send(()).unwrap();
    assert!(matches!(
        finish(first).await.unwrap(),
        PromotionOutcome::Delivered { .. }
    ));
    assert!(matches!(finish(second).await, Err(ApiError::Conflict(_))));
    assert_eq!(native.writes().len(), 1);
}

#[tokio::test]
async fn active_send_now_with_uncertain_steer_never_falls_back_to_queue_start() {
    let (state, native) = fixture().await;
    *native.steer_error.lock().unwrap() = Some("turn ended or acknowledgement lost".into());
    let outcome = transfer(promote(&state, THREAD, ROW).await.unwrap());
    assert_eq!(outcome.phase, QueueTransferPhase::Uncertain);
    assert!(native
        .writes()
        .iter()
        .all(|(method, _)| method != "thread/queue/start"));
    assert_retry_does_not_write(&state, &native).await;
}
