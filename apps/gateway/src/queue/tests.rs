use std::sync::Arc;

use crate::{app_server::tests::RecordingAppServer, config::Config, store::Store};

use super::*;

#[tokio::test]
async fn empty_queue_drain_does_not_read_or_materialize_native_history() {
    let native = Arc::new(RecordingAppServer::default());
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );

    drain_one_queued_input(&state, "thread-1").await.unwrap();

    assert!(native.requests.lock().unwrap().is_empty());
    assert!(state
        .store
        .get_thread_runtime_state("thread-1")
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn failed_queue_row_does_not_read_native_history_until_retried() {
    let native = Arc::new(RecordingAppServer::default());
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    let row = state
        .store
        .create_queued_input(
            "thread-1",
            serde_json::from_value(json!([{"type":"text","text":"retry me"}])).unwrap(),
            TurnStartOptions::default(),
        )
        .await
        .unwrap();
    state
        .store
        .mark_queued_input_failed("thread-1", &row.id, "not submitted".into())
        .await
        .unwrap();

    drain_one_queued_input(&state, "thread-1").await.unwrap();

    assert!(native.requests.lock().unwrap().is_empty());
    assert_eq!(
        state
            .store
            .get_queued_input("thread-1", &row.id)
            .await
            .unwrap()
            .status,
        QueuedInputStatus::Failed
    );

    state
        .store
        .requeue_queued_input("thread-1", &row.id)
        .await
        .unwrap();
    drain_one_queued_input(&state, "thread-1").await.unwrap();

    assert_eq!(
        native
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(method, _)| method == "turn/start")
            .count(),
        1
    );
    assert!(state
        .store
        .list_queued_inputs("thread-1")
        .await
        .unwrap()
        .is_empty());
}
