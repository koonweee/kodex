use super::*;
use crate::store::AutomationNewThread;

async fn fresh_fixture() -> (Arc<AppState>, Arc<Native>, Automation) {
    let (state, native, automation) = fixture().await;
    let automation = state
        .store
        .update_automation(
            &automation.id,
            AutomationUpdate {
                new_thread: Some(AutomationNewThread {
                    cwd: Some(std::env::temp_dir().to_string_lossy().into()),
                    model: Some("chosen".into()),
                    effort: Some("high".into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    (state, native, automation)
}

#[tokio::test]
async fn fresh_runs_create_distinct_chats_and_persist_target_before_input() {
    let (state, native, automation) = fresh_fixture().await;
    let mut events = state.events.subscribe();
    let first = run_now(&state, &automation.id).await.unwrap();
    let second = run_now(&state, &automation.id).await.unwrap();
    assert_eq!(first.phase, Phase::Dispatched);
    assert_eq!(second.phase, Phase::Dispatched);
    assert!(first.target_thread_id.is_some());
    assert_ne!(first.target_thread_id, second.target_thread_id);
    assert_eq!(
        state
            .store
            .get_automation(&automation.id)
            .await
            .unwrap()
            .next_run_at,
        automation.next_run_at
    );
    {
        let requests = native.requests.lock().unwrap();
        let starts: Vec<_> = requests
            .iter()
            .filter(|(method, _)| method == "thread/start")
            .collect();
        assert_eq!(starts.len(), 2);
        assert!(starts
            .iter()
            .all(|(_, payload)| payload["projectId"].is_null()
                && payload["model"] == "chosen"
                && payload["config"]["model_reasoning_effort"] == "high"));
    }
    let mut created = 0;
    while let Ok(event) = events.try_recv() {
        if event.kind == "thread.upserted" {
            created += 1;
        }
    }
    assert_eq!(created, 2, "another client gets each catalog refill");
    let replay = state.store.replay_events(None, None, None).await.unwrap();
    assert_eq!(
        replay
            .iter()
            .filter(|event| event.kind == "thread.upserted" && event.payload["scope"] == "chat")
            .count(),
        2
    );
}

#[tokio::test]
async fn lost_creation_ack_is_uncertain_and_never_recreated_by_recovery_or_scheduler() {
    let (state, native, automation) = fresh_fixture().await;
    *native.create_lost.lock().unwrap() = true;
    assert_eq!(
        process_due_automations(&state, automation.start_at)
            .await
            .unwrap(),
        1
    );
    let run = state
        .store
        .list_automation_runs(&automation.id)
        .await
        .unwrap()
        .remove(0);
    assert_eq!(run.phase, Phase::Uncertain);
    assert!(run.target_thread_id.is_none());
    recover_automations_after_restart(&state).await.unwrap();
    assert_eq!(
        process_due_automations(&state, automation.start_at + chrono::Duration::minutes(2))
            .await
            .unwrap(),
        0
    );
    let requests = native.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .filter(|(method, _)| method == "thread/start")
            .count(),
        1
    );
    assert!(!requests
        .iter()
        .any(|(method, _)| method.starts_with("thread/queue")));
}

#[tokio::test]
async fn late_creation_ack_after_restart_cannot_admit_input() {
    let (state, native, automation) = fresh_fixture().await;
    *native.restart_during_create.lock().unwrap() = true;
    let run = run_now(&state, &automation.id).await.unwrap();
    assert_eq!(run.phase, Phase::Uncertain);
    assert!(run.target_thread_id.is_none());
    assert!(native.writes().is_empty());
}

#[tokio::test]
async fn claimed_fresh_target_survives_definition_edit() {
    let (state, native, automation) = fresh_fixture().await;
    let run = state
        .store
        .create_automation_run_now(&automation.id)
        .await
        .unwrap();
    state
        .store
        .update_automation(
            &automation.id,
            AutomationUpdate {
                target_thread_id: Some("other".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let run = admit(&state, run).await.unwrap();
    assert_eq!(run.phase, Phase::Dispatched);
    assert_ne!(run.target_thread_id.as_deref(), Some("other"));
    assert_eq!(
        native
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, _)| m == "thread/start")
            .count(),
        1
    );
}
