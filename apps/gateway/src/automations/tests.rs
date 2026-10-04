use std::sync::{Arc, Mutex, Weak};

use async_trait::async_trait;
use chrono::{TimeZone, Utc};
use serde_json::{json, Value};

use super::*;
use crate::{
    app_server::AppServer,
    config::Config,
    store::{AutomationStatus, AutomationUpdate, NewAutomation, Store},
};

#[derive(Default)]
struct Native {
    requests: Mutex<Vec<(String, Value)>>,
    rows: Mutex<Vec<Value>>,
    items: Mutex<Vec<Value>>,
    active: Mutex<bool>,
    add_lost: Mutex<bool>,
    start_lost: Mutex<bool>,
    early_receipt: Mutex<bool>,
    early_start_receipt: Mutex<bool>,
    resume_error: Mutex<bool>,
    cold: Mutex<bool>,
    state: Mutex<Weak<AppState>>,
}

impl Native {
    fn writes(&self) -> Vec<(String, Value)> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(method, _)| {
                matches!(method.as_str(), "thread/queue/add" | "thread/queue/start")
            })
            .cloned()
            .collect()
    }
}

#[async_trait]
impl AppServer for Native {
    fn is_ready(&self) -> bool {
        true
    }
    fn readiness_error(&self) -> Option<String> {
        None
    }
    async fn respond(&self, _: &str, _: Value) -> ApiResult<()> {
        unreachable!()
    }
    async fn request(&self, method: &str, params: Value) -> ApiResult<Value> {
        self.requests
            .lock()
            .unwrap()
            .push((method.into(), params.clone()));
        let active = *self.active.lock().unwrap();
        match method {
            "thread/resume" | "thread/read" => {
                if method == "thread/resume" && *self.resume_error.lock().unwrap() {
                    return Err(ApiError::BadGateway("target unavailable".into()));
                }
                if method == "thread/resume" {
                    *self.cold.lock().unwrap() = false;
                }
                let status = if *self.cold.lock().unwrap() {
                    json!({"type":"notLoaded"})
                } else if active {
                    json!({"type":"active","activeFlags":[]})
                } else {
                    json!({"type":"idle"})
                };
                Ok(
                    json!({"thread":{"id":params["threadId"],"cwd":"/automation", "createdAt":1,"updatedAt":2,"status":status,"canAcceptDirectInput":true,"turns":[]}}),
                )
            }
            "thread/turns/list" => Ok(
                json!({"data":if active {vec![json!({"id":"active-turn","status":"inProgress","items":[]})]} else {vec![]},"nextCursor":null,"backwardsCursor":null}),
            ),
            "thread/queue/add" => {
                let state = self.state.lock().unwrap().upgrade().unwrap();
                let client = params["clientUserMessageId"].as_str().unwrap();
                let run = state.store.get_automation_run(client).await.unwrap();
                assert_eq!(run.phase, Phase::Admitting, "persist before queue/add");
                assert_eq!(run.target_thread_id, params["threadId"]);
                let row = json!({"id":format!("native-{client}"),"clientUserMessageId":client,"input":params["input"]});
                self.rows.lock().unwrap().push(row.clone());
                if *self.early_receipt.lock().unwrap() {
                    observe_user_receipt(
                        &state,
                        &run.target_thread_id,
                        "receipt-turn",
                        Some(client),
                    )
                    .await?;
                }
                if *self.add_lost.lock().unwrap() {
                    Err(ApiError::BadGateway("add reply lost".into()))
                } else {
                    Ok(json!({"queuedSubmission":row}))
                }
            }
            "thread/queue/start" => {
                let state = self.state.lock().unwrap().upgrade().unwrap();
                let row = self
                    .rows
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|row| row["id"] == params["queuedSubmissionId"])
                    .cloned()
                    .unwrap();
                let run = state
                    .store
                    .get_automation_run(row["clientUserMessageId"].as_str().unwrap())
                    .await
                    .unwrap();
                assert_eq!(
                    run.phase,
                    Phase::StartRequested,
                    "persist before queue/start"
                );
                if *self.early_start_receipt.lock().unwrap() {
                    observe_user_receipt(
                        &state,
                        &run.target_thread_id,
                        "early-start-turn",
                        Some(&run.id),
                    )
                    .await?;
                }
                if *self.start_lost.lock().unwrap() {
                    Err(ApiError::BadGateway("start reply lost".into()))
                } else {
                    Ok(json!({"turn":{"id":"ack-turn","status":"inProgress","items":[]}}))
                }
            }
            "thread/queue/list" => Ok(json!({"data":*self.rows.lock().unwrap(),"nextCursor":null})),
            "thread/items/list" => Ok(
                json!({"data":*self.items.lock().unwrap(),"nextCursor":"older-unknown","backwardsCursor":null}),
            ),
            _ => Err(ApiError::BadGateway(format!(
                "unexpected fixture method {method}"
            ))),
        }
    }
}

async fn fixture() -> (Arc<AppState>, Arc<Native>, Automation) {
    let native = Arc::new(Native::default());
    let state = Arc::new(AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    ));
    *native.state.lock().unwrap() = Arc::downgrade(&state);
    let start = Utc.with_ymd_and_hms(2026, 10, 5, 9, 0, 0).unwrap();
    let automation = state
        .store
        .create_automation(NewAutomation {
            name: "Scheduled check".into(),
            prompt: "Native-only input".into(),
            target_thread_id: "original-target".into(),
            start_at: start,
            repeat_every_seconds: 60,
            next_run_at: start,
            status: AutomationStatus::Active,
            paused_reason: None,
            provenance: None,
        })
        .await
        .unwrap();
    (state, native, automation)
}

#[tokio::test]
async fn unattended_scheduled_admission_loads_only_its_target_and_starts_its_exact_row() {
    let (state, native, automation) = fixture().await;
    *native.cold.lock().unwrap() = true;
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
    assert_eq!(run.phase, Phase::Dispatched);
    assert_eq!(run.turn_id.as_deref(), Some("ack-turn"));
    let writes = native.writes();
    assert_eq!(writes.len(), 2);
    assert_eq!(
        writes[0],
        (
            "thread/queue/add".into(),
            json!({"threadId":"original-target","clientUserMessageId":run.id,"input":[{"type":"text","text":"Native-only input","text_elements":[]}]})
        )
    );
    assert_eq!(
        writes[1].1,
        json!({"threadId":"original-target","queuedSubmissionId":run.native_queue_id})
    );
    assert_eq!(native.requests.lock().unwrap()[0].0, "thread/read");
    assert_eq!(native.requests.lock().unwrap()[1].0, "thread/resume");
    assert!(native
        .requests
        .lock()
        .unwrap()
        .iter()
        .all(|(_, params)| params["threadId"] == "original-target"));
}

#[tokio::test]
async fn exact_receipt_before_lost_add_ack_wins_and_run_now_does_not_touch_schedule() {
    let (state, native, automation) = fixture().await;
    *native.early_receipt.lock().unwrap() = true;
    *native.add_lost.lock().unwrap() = true;
    let run = run_now(&state, &automation.id).await.unwrap();
    assert_eq!(run.phase, Phase::Dispatched);
    assert_eq!(run.turn_id.as_deref(), Some("receipt-turn"));
    assert_eq!(native.writes().len(), 1);
    let current = state.store.get_automation(&automation.id).await.unwrap();
    assert_eq!(current.next_run_at, automation.next_run_at);
    assert_eq!(current.last_run_at, None);
    assert_eq!(current.consecutive_failure_count, 0);
}

#[tokio::test]
async fn lost_start_ack_is_not_retried_or_reactivated_from_a_remaining_native_row() {
    let (state, native, automation) = fixture().await;
    *native.start_lost.lock().unwrap() = true;
    let run = run_now(&state, &automation.id).await.unwrap();
    assert_eq!(run.phase, Phase::Uncertain);
    let before = native.requests.lock().unwrap().len();
    *native.cold.lock().unwrap() = true;
    recover_automations_after_restart(&state).await.unwrap();
    let recovery = native.requests.lock().unwrap()[before..].to_vec();
    assert_eq!(
        recovery.iter().map(|(m, _)| m.as_str()).collect::<Vec<_>>(),
        vec!["thread/queue/list", "thread/items/list"]
    );
    assert_eq!(
        state.store.get_automation_run(&run.id).await.unwrap().phase,
        Phase::Uncertain
    );
    assert_eq!(native.writes().len(), 2);
}

#[tokio::test]
async fn lost_add_ack_remains_uncertain_even_when_native_row_survives_cleanup() {
    let (state, native, automation) = fixture().await;
    *native.add_lost.lock().unwrap() = true;
    let run = run_now(&state, &automation.id).await.unwrap();
    assert_eq!(run.phase, Phase::Uncertain);
    let before = native.requests.lock().unwrap().len();
    *native.cold.lock().unwrap() = true;
    recover_automations_after_restart(&state).await.unwrap();
    let recovery = native.requests.lock().unwrap()[before..].to_vec();
    assert_eq!(
        recovery.iter().map(|(m, _)| m.as_str()).collect::<Vec<_>>(),
        vec!["thread/queue/list", "thread/items/list"]
    );
    assert_eq!(
        state.store.get_automation_run(&run.id).await.unwrap().phase,
        Phase::Uncertain
    );
    assert_eq!(
        native.writes().len(),
        1,
        "a listed row and bounded absent history cannot authorize start"
    );
}

#[tokio::test]
async fn exact_receipt_before_lost_start_ack_cannot_regress_dispatch_or_fail_schedule() {
    let (state, native, automation) = fixture().await;
    *native.early_start_receipt.lock().unwrap() = true;
    *native.start_lost.lock().unwrap() = true;
    process_due_automations(&state, automation.start_at)
        .await
        .unwrap();
    let run = state
        .store
        .list_automation_runs(&automation.id)
        .await
        .unwrap()
        .remove(0);
    assert_eq!(run.phase, Phase::Dispatched);
    assert_eq!(run.turn_id.as_deref(), Some("early-start-turn"));
    assert_eq!(run.error, None);
    assert_eq!(native.writes().len(), 2);
    let current = state.store.get_automation(&automation.id).await.unwrap();
    assert_eq!(current.consecutive_failure_count, 0);
    assert_eq!(current.last_error, None);
    assert_eq!(current.last_native_queue_id, run.native_queue_id);
}

#[tokio::test]
async fn recovery_groups_immutable_targets_and_never_resubmits_edited_prompts() {
    let (state, native, automation) = fixture().await;
    *native.active.lock().unwrap() = true;
    let queued = run_now(&state, &automation.id).await.unwrap();
    *native.add_lost.lock().unwrap() = true;
    let unknown = run_now(&state, &automation.id).await.unwrap();
    assert_eq!(unknown.phase, Phase::Uncertain);
    state
        .store
        .update_automation(
            &automation.id,
            AutomationUpdate {
                target_thread_id: Some("edited-target".into()),
                prompt: Some("DO NOT RESUBMIT".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let before = native.requests.lock().unwrap().len();
    *native.cold.lock().unwrap() = true;
    recover_automations_after_restart(&state).await.unwrap();
    let recovery = native.requests.lock().unwrap()[before..].to_vec();
    assert_eq!(
        recovery
            .iter()
            .filter(|(m, _)| m == "thread/queue/list")
            .count(),
        1
    );
    assert_eq!(
        recovery
            .iter()
            .filter(|(m, _)| m == "thread/items/list")
            .count(),
        1
    );
    assert_eq!(
        recovery
            .iter()
            .filter(|(m, _)| m == "thread/resume")
            .count(),
        1
    );
    assert!(recovery
        .iter()
        .all(|(_, params)| params["threadId"] == "original-target"));
    assert_eq!(
        native.writes().len(),
        2,
        "recovery never sends another queue/add"
    );
    assert_eq!(
        state
            .store
            .get_automation_run(&queued.id)
            .await
            .unwrap()
            .phase,
        Phase::Queued
    );
    let unknown = state.store.get_automation_run(&unknown.id).await.unwrap();
    assert_eq!(unknown.phase, Phase::Uncertain);
    assert!(
        unknown.native_queue_id.is_some(),
        "native row is visible correlation, never restart permission"
    );
}

#[tokio::test]
async fn bounded_absence_stays_uncertain_but_exact_positive_history_can_settle() {
    let (state, native, automation) = fixture().await;
    let run = state
        .store
        .create_automation_run_now(&automation.id)
        .await
        .unwrap();
    recover_automations_after_restart(&state).await.unwrap();
    assert_eq!(
        state.store.get_automation_run(&run.id).await.unwrap().phase,
        Phase::Uncertain
    );
    assert!(native.writes().is_empty());
    native.items.lock().unwrap().push(json!({"turnId":"persisted-turn","item":{"id":"native-user-item","type":"userMessage","clientId":run.id,"content":[{"type":"text","text":"actual submitted input"}]}}));
    recover_automations_after_restart(&state).await.unwrap();
    let current = state.store.get_automation_run(&run.id).await.unwrap();
    assert_eq!(current.phase, Phase::Dispatched);
    assert_eq!(current.turn_id.as_deref(), Some("persisted-turn"));
    assert!(native.writes().is_empty());
    assert!(native
        .requests
        .lock()
        .unwrap()
        .iter()
        .all(
            |(m, p)| matches!(m.as_str(), "thread/items/list" | "thread/queue/list")
                && p["limit"] == if m == "thread/queue/list" { 100 } else { 25 }
        ));
}

#[tokio::test]
async fn skipped_scheduled_slot_publishes_its_advanced_cadence_to_other_clients() {
    let (state, native, automation) = fixture().await;
    *native.active.lock().unwrap() = true;
    process_due_automations(&state, automation.start_at)
        .await
        .unwrap();
    let mut second_client = state.events.subscribe();
    assert_eq!(
        process_due_automations(&state, automation.start_at + chrono::Duration::seconds(120))
            .await
            .unwrap(),
        0
    );
    let current = state.store.get_automation(&automation.id).await.unwrap();
    assert_eq!(
        current.next_run_at,
        automation.start_at + chrono::Duration::seconds(180)
    );
    let updates = std::iter::from_fn(|| second_client.try_recv().ok()).collect::<Vec<_>>();
    let upsert = updates
        .iter()
        .find(|event| event.kind == AUTOMATION_UPSERT_EVENT)
        .expect("another client must receive the changed schedule");
    assert_eq!(upsert.payload["nextRunAt"], json!(current.next_run_at));
    assert_eq!(
        native.writes().len(),
        1,
        "a skipped tick is not another admission"
    );
}

#[tokio::test]
async fn one_admission_bookkeeping_error_does_not_strand_other_claimed_schedules() {
    let (state, native, first) = fixture().await;
    let second = state
        .store
        .create_automation(NewAutomation {
            name: "Independent schedule".into(),
            prompt: "Second prompt".into(),
            target_thread_id: "second-target".into(),
            start_at: first.start_at,
            next_run_at: first.start_at,
            repeat_every_seconds: 60,
            status: AutomationStatus::Active,
            paused_reason: None,
            provenance: None,
        })
        .await
        .unwrap();
    sqlx::query(&format!("create trigger reject_first_ack before update on automation_runs when new.automation_id = '{}' and new.phase = 'queued' begin select raise(fail, 'test queue acknowledgement write failure'); end", first.id))
        .execute(state.store.pool()).await.unwrap();
    assert!(process_due_automations(&state, first.start_at)
        .await
        .is_err());
    let second_run = state
        .store
        .list_automation_runs(&second.id)
        .await
        .unwrap()
        .remove(0);
    assert_eq!(
        second_run.phase,
        Phase::Dispatched,
        "already-claimed independent run must still be admitted"
    );
    assert_eq!(
        native
            .writes()
            .iter()
            .filter(|(method, _)| method == "thread/queue/add")
            .count(),
        2
    );
    assert_eq!(
        state
            .store
            .list_automation_runs(&first.id)
            .await
            .unwrap()
            .len(),
        1
    );
}
