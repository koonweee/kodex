use chrono::{TimeZone, Utc};

use crate::store::{
    AutomationRunPhase as Phase, AutomationStatus, AutomationUpdate, NewAutomation, Store,
};

fn start() -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 5, 9, 0, 0).unwrap()
}

#[tokio::test]
async fn run_history_is_bounded_without_hiding_outstanding_recovery_records() {
    let store = Store::in_memory().await.unwrap();
    let automation = automation(&store).await;
    let mut ids = Vec::new();
    for index in 0..103 {
        let run = store
            .create_automation_run_now(&automation.id)
            .await
            .unwrap();
        sqlx::query("update automation_runs set created_at = ? where id = ?")
            .bind(start() + chrono::Duration::seconds(index))
            .bind(&run.id)
            .execute(&store.pool)
            .await
            .unwrap();
        ids.push(run.id);
    }
    let history = store.list_automation_runs(&automation.id).await.unwrap();
    assert_eq!(
        history.iter().map(|run| &run.id).collect::<Vec<_>>(),
        ids.iter().rev().take(100).collect::<Vec<_>>()
    );
    assert_eq!(
        store
            .list_outstanding_automation_runs()
            .await
            .unwrap()
            .len(),
        103
    );
}

async fn automation(store: &Store) -> crate::store::Automation {
    store
        .create_automation(NewAutomation {
            name: "Check".into(),
            prompt: "Report status".into(),
            target_thread_id: "original-target".into(),
            start_at: start(),
            repeat_every_seconds: 60,
            next_run_at: start(),
            status: AutomationStatus::Active,
            paused_reason: None,
            provenance: None,
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn competing_schedule_claims_coalesce_missed_ticks_and_keep_one_pending_admission() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gateway.db");
    let first = Store::connect(&path).await.unwrap();
    let second = Store::connect(&path).await.unwrap();
    let automation = automation(&first).await;
    let now = start() + chrono::Duration::seconds(125);
    let (a, b) = tokio::join!(
        first.claim_due_automation_runs(now, 10),
        second.claim_due_automation_runs(now, 10)
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_eq!(
        a.updated_automation_ids.len() + b.updated_automation_ids.len(),
        1
    );
    let runs = a.runs.into_iter().chain(b.runs).collect::<Vec<_>>();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].scheduled_for, Some(start()));
    assert_eq!(runs[0].phase, Phase::Admitting);
    assert_eq!(
        first
            .get_automation(&automation.id)
            .await
            .unwrap()
            .next_run_at,
        start() + chrono::Duration::seconds(180)
    );
    first
        .transition_automation_run(
            &runs[0].id,
            Phase::Admitting,
            Phase::Uncertain,
            None,
            None,
            Some("lost reply"),
        )
        .await
        .unwrap();
    assert!(second
        .claim_due_automation_runs(start() + chrono::Duration::seconds(360), 10)
        .await
        .unwrap()
        .runs
        .is_empty());
    assert_eq!(
        first
            .list_automation_runs(&automation.id)
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        first
            .get_automation(&automation.id)
            .await
            .unwrap()
            .next_run_at,
        start() + chrono::Duration::seconds(420)
    );
}

#[tokio::test]
async fn run_now_is_independent_and_the_target_survives_definition_edits_and_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gateway.db");
    let store = Store::connect(&path).await.unwrap();
    let automation = automation(&store).await;
    let run = store
        .create_automation_run_now(&automation.id)
        .await
        .unwrap();
    assert_eq!(run.scheduled_for, None);
    store
        .update_automation(
            &automation.id,
            AutomationUpdate {
                target_thread_id: Some("edited-target".into()),
                prompt: Some("edited prompt".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let scheduled = store
        .claim_due_automation_runs(start(), 10)
        .await
        .unwrap()
        .runs;
    assert_eq!(
        scheduled.len(),
        1,
        "run-now must not block scheduled admission"
    );
    assert_eq!(scheduled[0].target_thread_id, "edited-target");
    let before = store.get_automation(&automation.id).await.unwrap();
    store
        .transition_automation_run(
            &run.id,
            Phase::Admitting,
            Phase::Rejected,
            None,
            None,
            Some("not resumable"),
        )
        .await
        .unwrap();
    let after = store.get_automation(&automation.id).await.unwrap();
    assert_eq!(after.next_run_at, before.next_run_at);
    assert_eq!(after.consecutive_failure_count, 0);
    assert_eq!(after.last_run_at, None);
    store.pool().close().await;
    let reopened = Store::connect(&path).await.unwrap();
    assert_eq!(
        reopened
            .get_automation_run(&run.id)
            .await
            .unwrap()
            .target_thread_id,
        "original-target"
    );
}

#[tokio::test]
async fn early_exact_receipt_wins_over_late_admission_ack_and_failure() {
    let store = Store::in_memory().await.unwrap();
    let automation = automation(&store).await;
    let run = store
        .claim_due_automation_runs(start(), 10)
        .await
        .unwrap()
        .runs
        .remove(0);
    for (thread, client) in [
        ("other-target", Some(run.id.as_str())),
        ("original-target", None),
        ("original-target", Some("foreign")),
    ] {
        assert!(store
            .settle_automation_run_delivery(thread, "native-turn", client)
            .await
            .unwrap()
            .is_none());
    }
    let delivered = store
        .settle_automation_run_delivery("original-target", "native-turn", Some(&run.id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(delivered.phase, Phase::Dispatched);
    assert_eq!(delivered.turn_id.as_deref(), Some("native-turn"));
    for phase in [Phase::Queued, Phase::Rejected, Phase::Uncertain] {
        assert!(store
            .transition_automation_run(
                &run.id,
                Phase::Admitting,
                phase,
                Some("native-row"),
                None,
                Some("late error")
            )
            .await
            .unwrap()
            .is_none());
    }
    assert!(store
        .settle_automation_run_delivery("original-target", "later-turn", Some(&run.id))
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        store
            .get_automation_run(&run.id)
            .await
            .unwrap()
            .turn_id
            .as_deref(),
        Some("native-turn")
    );
    assert_eq!(
        store
            .get_automation(&automation.id)
            .await
            .unwrap()
            .consecutive_failure_count,
        0
    );
}

#[tokio::test]
async fn only_scheduled_definite_rejections_count_once_and_pause_at_existing_threshold() {
    let store = Store::in_memory().await.unwrap();
    let automation = automation(&store).await;
    for minute in 0..5 {
        let run = store
            .claim_due_automation_runs(start() + chrono::Duration::minutes(minute), 10)
            .await
            .unwrap()
            .runs
            .remove(0);
        assert!(store
            .transition_automation_run(
                &run.id,
                Phase::Admitting,
                Phase::Rejected,
                None,
                None,
                Some("target missing")
            )
            .await
            .unwrap()
            .is_some());
        assert!(store
            .transition_automation_run(
                &run.id,
                Phase::Admitting,
                Phase::Rejected,
                None,
                None,
                Some("duplicate")
            )
            .await
            .unwrap()
            .is_none());
    }
    let paused = store.get_automation(&automation.id).await.unwrap();
    assert_eq!(paused.status, AutomationStatus::Paused);
    assert_eq!(paused.paused_reason.as_deref(), Some("tooManyFailures"));
    assert_eq!(paused.consecutive_failure_count, 5);
}

#[tokio::test]
async fn restart_retains_uncertainty_and_exact_late_receipts_can_settle_every_phase() {
    let store = Store::in_memory().await.unwrap();
    let automation = automation(&store).await;
    for phase in [
        Phase::Admitting,
        Phase::Queued,
        Phase::StartRequested,
        Phase::Rejected,
        Phase::Uncertain,
        Phase::Removed,
    ] {
        let run = store
            .create_automation_run_now(&automation.id)
            .await
            .unwrap();
        if matches!(
            phase,
            Phase::Queued | Phase::StartRequested | Phase::Removed
        ) {
            store
                .transition_automation_run(
                    &run.id,
                    Phase::Admitting,
                    Phase::Queued,
                    Some(&format!("native-{}", run.id)),
                    None,
                    None,
                )
                .await
                .unwrap();
        }
        if phase == Phase::StartRequested {
            store
                .transition_automation_run(&run.id, Phase::Queued, phase, None, None, None)
                .await
                .unwrap();
        } else if matches!(phase, Phase::Rejected | Phase::Uncertain) {
            store
                .transition_automation_run(
                    &run.id,
                    Phase::Admitting,
                    phase,
                    None,
                    None,
                    Some("saved uncertainty"),
                )
                .await
                .unwrap();
        } else if phase == Phase::Removed {
            assert!(store
                .remove_automation_run("foreign", &format!("native-{}", run.id))
                .await
                .unwrap()
                .is_none());
            store
                .remove_automation_run("original-target", &format!("native-{}", run.id))
                .await
                .unwrap();
        }
        store
            .invalidate_automation_admissions_after_restart()
            .await
            .unwrap();
        let current = store.get_automation_run(&run.id).await.unwrap();
        assert_eq!(
            current.phase,
            if matches!(phase, Phase::Admitting | Phase::StartRequested) {
                Phase::Uncertain
            } else {
                phase
            }
        );
        let delivered = store
            .settle_automation_run_delivery("original-target", "actual-turn", Some(&run.id))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(delivered.phase, Phase::Dispatched);
        assert!(store
            .remove_automation_run("original-target", &format!("native-{}", run.id))
            .await
            .unwrap()
            .is_none());
    }
    assert!(store
        .list_outstanding_automation_runs()
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        store
            .get_automation(&automation.id)
            .await
            .unwrap()
            .consecutive_failure_count,
        0
    );
}

#[tokio::test]
async fn promoted_delivery_requires_exact_native_row_and_late_intent_cannot_regress_it() {
    let store = Store::in_memory().await.unwrap();
    let automation = automation(&store).await;
    let mut runs = Vec::new();
    for native_id in ["native-a", "native-b"] {
        let run = store
            .create_automation_run_now(&automation.id)
            .await
            .unwrap();
        runs.push(
            store
                .transition_automation_run(
                    &run.id,
                    Phase::Admitting,
                    Phase::Queued,
                    Some(native_id),
                    None,
                    None,
                )
                .await
                .unwrap()
                .unwrap(),
        );
    }
    assert!(store
        .mark_automation_run_handoff_pending("foreign", "native-a")
        .await
        .unwrap()
        .is_none());
    assert!(store
        .settle_automation_run_promotion("original-target", "different-row", "turn")
        .await
        .unwrap()
        .is_none());
    let pending = store
        .mark_automation_run_handoff_pending("original-target", "native-a")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(pending.phase, Phase::Uncertain);
    assert_eq!(
        store.get_automation_run(&runs[1].id).await.unwrap().phase,
        Phase::Queued
    );
    let delivered = store
        .settle_automation_run_promotion("original-target", "native-a", "actual-promoted-turn")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(delivered.id, runs[0].id);
    assert_eq!(delivered.phase, Phase::Dispatched);
    assert_eq!(delivered.turn_id.as_deref(), Some("actual-promoted-turn"));
    assert!(store
        .mark_automation_run_handoff_pending("original-target", "native-a")
        .await
        .unwrap()
        .is_none());
    assert!(store
        .settle_automation_run_promotion("original-target", "native-a", "late-other-turn")
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        store.get_automation_run(&runs[0].id).await.unwrap().turn_id,
        delivered.turn_id
    );
    assert_eq!(
        store.get_automation_run(&runs[1].id).await.unwrap().phase,
        Phase::Queued
    );
    assert_eq!(
        store
            .get_automation(&automation.id)
            .await
            .unwrap()
            .last_run_at,
        None
    );
}

#[tokio::test]
async fn confirmed_removal_clears_current_scheduled_error_without_counting_failure() {
    let store = Store::in_memory().await.unwrap();
    let automation = automation(&store).await;
    let run = store
        .claim_due_automation_runs(start(), 1)
        .await
        .unwrap()
        .runs
        .remove(0);
    store
        .transition_automation_run(
            &run.id,
            Phase::Admitting,
            Phase::Queued,
            Some("native-row"),
            None,
            None,
        )
        .await
        .unwrap();
    store
        .mark_automation_run_handoff_pending("original-target", "native-row")
        .await
        .unwrap();
    assert!(store
        .get_automation(&automation.id)
        .await
        .unwrap()
        .last_error
        .is_some());
    let removed = store
        .remove_automation_run("original-target", "native-row")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(removed.phase, Phase::Removed);
    let current = store.get_automation(&automation.id).await.unwrap();
    assert_eq!(current.last_error, None);
    assert_eq!(current.consecutive_failure_count, 0);
    assert_eq!(current.last_native_queue_id.as_deref(), Some("native-row"));
}
