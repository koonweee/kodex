use super::*;
use chrono::Utc;
use std::sync::Weak;

use crate::{
    automations,
    store::{AutomationRun, AutomationRunPhase as Phase, AutomationStatus, NewAutomation},
};

#[derive(Default)]
struct ProducerNative {
    native: NativeQueue,
    state: Mutex<Weak<AppState>>,
    lost_method: Mutex<Option<&'static str>>,
    watched_run: Mutex<Option<String>>,
    observed_handoffs: Mutex<Vec<Phase>>,
    idle: Mutex<bool>,
}

#[async_trait]
impl AppServer for ProducerNative {
    fn is_ready(&self) -> bool {
        true
    }
    fn readiness_error(&self) -> Option<String> {
        None
    }
    async fn respond(&self, _: &str, _: Value) -> ApiResult<()> {
        Err(ApiError::BadGateway("unexpected approval".into()))
    }
    async fn request(&self, method: &str, params: Value) -> ApiResult<Value> {
        let lost = *self.lost_method.lock().unwrap() == Some(method);
        if lost {
            let state = self.state.lock().unwrap().upgrade().unwrap();
            let id = self.watched_run.lock().unwrap().clone().unwrap();
            let run = state.store.get_automation_run(&id).await?;
            assert_eq!(
                run.phase,
                Phase::Uncertain,
                "producer replay must be fenced before native write"
            );
            self.observed_handoffs.lock().unwrap().push(run.phase);
        }
        let mut result = self.native.request(method, params).await?;
        if method == "thread/read" && *self.idle.lock().unwrap() {
            result["thread"]["status"] = json!({"type":"idle"});
        }
        if method == "thread/turns/list" && *self.idle.lock().unwrap() {
            result["data"] = json!([]);
        }
        if lost {
            // Native start can accept before queue cleanup; the shared fake
            // deliberately retains that row. Delete has removed its row.
            return Err(ApiError::BadGateway(
                "native mutation acknowledgement lost".into(),
            ));
        }
        Ok(result)
    }
}

async fn producer_state() -> (Arc<AppState>, Arc<ProducerNative>) {
    let native = Arc::new(ProducerNative::default());
    let state = Arc::new(AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    ));
    *native.state.lock().unwrap() = Arc::downgrade(&state);
    (state, native)
}

async fn admitted_run(state: &AppState) -> AutomationRun {
    let now = Utc::now();
    let automation = state
        .store
        .create_automation(NewAutomation {
            name: "Producer fixture".into(),
            prompt: "Native source input".into(),
            target_thread_id: THREAD.into(),
            start_at: now,
            next_run_at: now,
            repeat_every_seconds: 60,
            status: AutomationStatus::Paused,
            paused_reason: None,
            provenance: None,
        })
        .await
        .unwrap();
    let run = state
        .store
        .create_automation_run_now(&automation.id)
        .await
        .unwrap();
    let (status, response) = request(
        state,
        "POST",
        BASE,
        json!({"input":input(), "clientUserMessageId":run.id}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    state
        .store
        .transition_automation_run(
            &run.id,
            Phase::Admitting,
            Phase::Queued,
            response["queuedInput"]["id"].as_str(),
            None,
            None,
        )
        .await
        .unwrap()
        .unwrap()
}

fn receipt(client_id: &str, turn_id: &str, method: &str) -> InboundMessage {
    InboundMessage::Notification {
        method: method.into(),
        params: json!({"threadId":THREAD,"turnId":turn_id,"item":{
            "id":"native-producer-user","type":"userMessage","clientId":client_id,"content":input(),
        }}),
    }
}

#[tokio::test]
async fn manual_start_and_delete_lost_ack_fence_producer_recovery_before_native_write() {
    for start in [true, false] {
        let (state, native) = producer_state().await;
        let run = admitted_run(&state).await;
        let native_id = run.native_queue_id.as_deref().unwrap();
        let method = if start {
            "thread/queue/start"
        } else {
            "thread/queue/delete"
        };
        *native.lost_method.lock().unwrap() = Some(method);
        *native.watched_run.lock().unwrap() = Some(run.id.clone());
        *native.idle.lock().unwrap() = true;
        let (status, body) = if start {
            request(
                &state,
                "POST",
                &format!("{BASE}/start"),
                json!({"queuedSubmissionId":native_id}),
            )
            .await
        } else {
            request(
                &state,
                "DELETE",
                &format!("{BASE}/{native_id}"),
                Value::Null,
            )
            .await
        };
        assert_eq!(status, StatusCode::BAD_GATEWAY, "{body}");
        assert_eq!(
            *native.observed_handoffs.lock().unwrap(),
            vec![Phase::Uncertain]
        );
        assert_eq!(
            state.store.get_automation_run(&run.id).await.unwrap().phase,
            Phase::Uncertain
        );
        let before = native.native.requests.lock().unwrap().len();
        automations::recover_automations_after_restart(&state)
            .await
            .unwrap();
        let recovery = native.native.requests.lock().unwrap()[before..].to_vec();
        assert_eq!(
            recovery
                .iter()
                .map(|(method, _)| method.as_str())
                .collect::<Vec<_>>(),
            vec!["thread/queue/list", "thread/items/list"]
        );
        assert_eq!(
            state.store.get_automation_run(&run.id).await.unwrap().phase,
            Phase::Uncertain
        );
        ingest_inbound(
            receipt(&run.id, "actual-later-turn", "item/started"),
            &state,
        )
        .await
        .unwrap();
        let delivered = state.store.get_automation_run(&run.id).await.unwrap();
        assert_eq!(delivered.phase, Phase::Dispatched);
        assert_eq!(delivered.turn_id.as_deref(), Some("actual-later-turn"));
        assert_eq!(delivered.error, None);
        let calls = native.native.requests.lock().unwrap();
        assert_eq!(calls.iter().filter(|(m, _)| m == method).count(), 1);
        assert_eq!(
            calls
                .iter()
                .filter(|(m, _)| m == "thread/queue/add")
                .count(),
            1
        );
        assert!(calls
            .iter()
            .all(|(m, _)| m != "thread/resume" && m != "turn/start"));
    }
}

#[tokio::test]
async fn transfer_receipt_retains_witness_until_exact_producer_settlement_succeeds() {
    for reconcile in [false, true] {
        let (state, native) = producer_state().await;
        let selected = admitted_run(&state).await;
        let other = admitted_run(&state).await;
        let native_id = selected.native_queue_id.as_deref().unwrap();
        let (status, body) = request(
            &state,
            "POST",
            &format!("{BASE}/{native_id}/steer"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let transfer_id = body["transfer"]["id"].as_str().unwrap();
        assert_ne!(transfer_id, selected.id);
        assert_eq!(body["transfer"]["phase"], "accepted");
        assert_eq!(
            state
                .store
                .get_automation_run(&selected.id)
                .await
                .unwrap()
                .phase,
            Phase::Uncertain
        );
        sqlx::query(&format!("create trigger reject_producer_receipt before update on automation_runs when old.id = '{}' and new.phase = 'dispatched' begin select raise(fail, 'producer receipt write failed'); end", selected.id))
            .execute(state.store.pool()).await.unwrap();
        sqlx::query(&format!("create trigger require_producer_before_transfer_delete before delete on queue_transfers when old.id = '{}' and (select phase from automation_runs where id = '{}') != 'dispatched' begin select raise(fail, 'producer must settle before deleting correlation'); end", transfer_id, selected.id))
            .execute(state.store.pool()).await.unwrap();
        let native_receipt = json!({"turnId":TURN,"item":{
            "id":"native-producer-user","type":"userMessage","clientId":transfer_id,"content":input(),
        }});
        *native.native.history.lock().unwrap() = vec![native_receipt];
        let path = format!("/v1/queue-transfers/{transfer_id}/reconcile");
        if reconcile {
            let (status, _) = request(&state, "POST", &path, Value::Null).await;
            assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        } else {
            ingest_inbound(receipt(transfer_id, TURN, "item/started"), &state)
                .await
                .unwrap();
        }
        assert!(
            state
                .store
                .get_queue_transfer(transfer_id)
                .await
                .unwrap()
                .is_some(),
            "producer SQL failure must retain the fresh transfer identity"
        );
        assert_eq!(
            state
                .store
                .get_automation_run(&selected.id)
                .await
                .unwrap()
                .phase,
            Phase::Uncertain
        );
        assert_eq!(
            state
                .store
                .get_automation_run(&other.id)
                .await
                .unwrap()
                .phase,
            Phase::Queued
        );
        sqlx::query("drop trigger reject_producer_receipt")
            .execute(state.store.pool())
            .await
            .unwrap();
        if reconcile {
            let (status, delivered) = request(&state, "POST", &path, Value::Null).await;
            assert_eq!(status, StatusCode::OK, "{delivered}");
            assert_eq!(delivered, json!({"status":"delivered", "id":transfer_id}));
        } else {
            ingest_inbound(receipt(transfer_id, TURN, "item/completed"), &state)
                .await
                .unwrap();
        }
        let delivered = state.store.get_automation_run(&selected.id).await.unwrap();
        assert_eq!(delivered.phase, Phase::Dispatched);
        assert_eq!(delivered.turn_id.as_deref(), Some(TURN));
        assert!(state
            .store
            .get_queue_transfer(transfer_id)
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            state
                .store
                .get_automation_run(&other.id)
                .await
                .unwrap()
                .phase,
            Phase::Queued
        );
        let calls = native.native.requests.lock().unwrap();
        assert_eq!(
            calls
                .iter()
                .filter(|(m, _)| m == "thread/queue/add")
                .count(),
            2
        );
        assert_eq!(
            calls
                .iter()
                .filter(|(m, _)| m == "thread/queue/delete")
                .count(),
            1
        );
        assert_eq!(calls.iter().filter(|(m, _)| m == "turn/steer").count(), 1);
        assert!(calls
            .iter()
            .all(|(m, _)| m != "thread/queue/start" && m != "thread/resume"));
    }
}
