use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::{
    sync::oneshot,
    time::{timeout, Duration},
};

use super::{enqueue, promote, PromotionOutcome};
use crate::{
    api::AppState,
    app_server::{AppServer, InboundMessage},
    config::Config,
    error::{ApiError, ApiResult},
    events::ingest_inbound,
    store::{QueueTransfer, QueueTransferPhase, Store},
};

#[path = "preflight_tests.rs"]
mod preflight_tests;

#[path = "projection_tests.rs"]
mod projection_tests;

const THREAD: &str = "promotion-chat";
const TURN: &str = "original-active-turn";
const ROW: &str = "selected-native-row";
const OTHER_ROW: &str = "native-head-row";
const QUEUED_CLIENT: &str = "deliberately-reused-native-queue-client";
const ADDED_ROW: &str = "fresh-native-added-row";

struct Gate {
    started: oneshot::Sender<()>,
    release: oneshot::Receiver<()>,
}

#[derive(Clone, Copy)]
enum DeleteReply {
    Deleted,
    Absent,
    Lost,
}

struct PromotionNative {
    requests: Mutex<Vec<(String, Value)>>,
    active_turn: Mutex<Option<String>>,
    capability: Mutex<Option<bool>>,
    rows: Mutex<Vec<Value>>,
    delete_reply: Mutex<DeleteReply>,
    add_lost: Mutex<bool>,
    steer_error: Mutex<Option<String>>,
    gates: Mutex<HashMap<String, Gate>>,
}

impl PromotionNative {
    fn new() -> Self {
        Self {
            requests: Mutex::new(Vec::new()),
            active_turn: Mutex::new(Some(TURN.into())),
            capability: Mutex::new(Some(true)),
            rows: Mutex::new(vec![row(OTHER_ROW), row(ROW)]),
            delete_reply: Mutex::new(DeleteReply::Deleted),
            add_lost: Mutex::new(false),
            steer_error: Mutex::new(None),
            gates: Mutex::new(HashMap::new()),
        }
    }

    fn hold(&self, method: &str) -> (oneshot::Receiver<()>, oneshot::Sender<()>) {
        let (started, wait) = oneshot::channel();
        let (release, blocked) = oneshot::channel();
        self.gates.lock().unwrap().insert(
            method.into(),
            Gate {
                started,
                release: blocked,
            },
        );
        (wait, release)
    }

    async fn reply(&self, method: &str, captured: ApiResult<Value>) -> ApiResult<Value> {
        let gate = self.gates.lock().unwrap().remove(method);
        if let Some(gate) = gate {
            let _ = gate.started.send(());
            gate.release
                .await
                .map_err(|_| ApiError::BadGateway("fixture gate closed".into()))?;
        }
        captured
    }

    fn writes(&self) -> Vec<(String, Value)> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(method, _)| {
                !matches!(
                    method.as_str(),
                    "thread/read" | "thread/turns/list" | "thread/queue/list"
                )
            })
            .cloned()
            .collect()
    }
}

#[async_trait]
impl AppServer for PromotionNative {
    fn is_ready(&self) -> bool {
        true
    }
    fn readiness_error(&self) -> Option<String> {
        None
    }

    async fn request(&self, method: &str, params: Value) -> ApiResult<Value> {
        self.requests
            .lock()
            .unwrap()
            .push((method.into(), params.clone()));
        let captured = match method {
            "thread/read" => {
                let active = self.active_turn.lock().unwrap().clone();
                Ok(json!({"thread":{
                    "id":THREAD,"cwd":"/promotion-fixture","createdAt":1,"updatedAt":2,
                    "status":if active.is_some() { json!({"type":"active","activeFlags":[]}) } else { json!({"type":"notLoaded"}) },
                    "canAcceptDirectInput":*self.capability.lock().unwrap(),
                    "turns":active.map(|id| vec![json!({"id":id,"status":"inProgress","items":[]})]).unwrap_or_default(),
                }}))
            }
            "thread/turns/list" => Ok(json!({
                "data":self.active_turn.lock().unwrap().as_ref().map(|id| vec![
                    json!({"id":id,"status":"inProgress","items":[]}),
                ]).unwrap_or_default(),
                "nextCursor":null,"backwardsCursor":null,
            })),
            "thread/queue/list" => {
                Ok(json!({"data":self.rows.lock().unwrap().clone(),"nextCursor":null}))
            }
            "thread/queue/add" => {
                let row = json!({
                    "id":ADDED_ROW,"clientUserMessageId":params["clientUserMessageId"],
                    "input":params["input"],
                });
                self.rows.lock().unwrap().push(row.clone());
                if *self.add_lost.lock().unwrap() {
                    Err(ApiError::BadGateway("add acknowledgement lost".into()))
                } else {
                    Ok(json!({"queuedSubmission":row}))
                }
            }
            "thread/queue/delete" => {
                // Absent models a competing removal after the list; Lost models
                // a successful delete whose acknowledgement never arrives.
                self.rows
                    .lock()
                    .unwrap()
                    .retain(|row| row["id"] != params["queuedSubmissionId"]);
                match *self.delete_reply.lock().unwrap() {
                    DeleteReply::Deleted => Ok(json!({"deleted":true})),
                    DeleteReply::Absent => Ok(json!({"deleted":false})),
                    DeleteReply::Lost => {
                        Err(ApiError::BadGateway("delete acknowledgement lost".into()))
                    }
                }
            }
            "turn/steer" => match self.steer_error.lock().unwrap().clone() {
                Some(message) => Err(ApiError::BadGateway(message)),
                None => Ok(json!({"turnId":TURN})),
            },
            _ => Err(ApiError::BadGateway(format!(
                "unexpected promotion RPC: {method}"
            ))),
        };
        self.reply(method, captured).await
    }

    async fn respond(&self, _request_id: &str, _result: Value) -> ApiResult<()> {
        Err(ApiError::BadGateway(
            "unexpected server-request response".into(),
        ))
    }
}

fn input() -> Vec<Value> {
    vec![
        json!({"type":"text","text":"你好 $skill","text_elements":[{"byteRange":{"start":7,"end":13},"placeholder":"$skill"}]}),
        json!({"type":"skill","name":"skill","path":"/fixture/skill/SKILL.md"}),
        json!({"type":"image","fileId":"native-image-file","detail":"original"}),
        json!({"type":"audio","url":"https://fixture.invalid/input.wav"}),
        json!({"type":"localAudio","path":"/fixture/input.wav"}),
    ]
}

fn row(id: &str) -> Value {
    json!({"id":id,"clientUserMessageId":QUEUED_CLIENT,"input":input()})
}

async fn fixture(witness: bool) -> (AppState, Arc<PromotionNative>) {
    let native = Arc::new(PromotionNative::new());
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    if witness {
        remember(&state, ROW);
    }
    (state, native)
}

fn remember(state: &AppState, row_id: &str) {
    let before_add = state.queue_admissions.capture(THREAD, Some(TURN)).unwrap();
    assert!(state.queue_admissions.record(before_add, row_id));
}

async fn entered(started: oneshot::Receiver<()>) {
    timeout(Duration::from_secs(2), started)
        .await
        .unwrap()
        .unwrap();
}

fn spawn(state: &AppState, row: &str) -> tokio::task::JoinHandle<ApiResult<PromotionOutcome>> {
    let state = state.clone();
    let row = row.to_string();
    tokio::spawn(async move { promote(&state, THREAD, &row).await })
}

async fn finish(
    task: tokio::task::JoinHandle<ApiResult<PromotionOutcome>>,
) -> ApiResult<PromotionOutcome> {
    timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap()
}

fn transfer(outcome: PromotionOutcome) -> QueueTransfer {
    match outcome {
        PromotionOutcome::Transfer { transfer } => transfer,
        PromotionOutcome::Delivered { .. } => {
            panic!("an RPC acknowledgement is not a native receipt")
        }
    }
}

async fn saved(state: &AppState) -> QueueTransfer {
    let mut rows = state
        .store
        .list_queue_transfers(Some(THREAD))
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    rows.remove(0)
}

async fn receipt(state: &AppState, thread: &str, turn: &str, client: &str, method: &str) {
    timeout(Duration::from_secs(2), ingest_inbound(InboundMessage::Notification {
        method:method.into(),
        params:json!({"threadId":thread,"turnId":turn,"item":{
            "id":format!("native-item-{client}"),"type":"userMessage","clientId":client,"content":input(),
        }}),
    }, state)).await.unwrap().unwrap();
}

async fn invalidate(state: &AppState, disconnected: bool) {
    let message = if disconnected {
        InboundMessage::Disconnected
    } else {
        InboundMessage::Notification {
            method: "thread/reverted".into(),
            params: json!({"threadId":THREAD,"beforeTurnId":TURN}),
        }
    };
    timeout(Duration::from_secs(2), ingest_inbound(message, state))
        .await
        .unwrap()
        .unwrap();
}

async fn assert_retry_does_not_write(state: &AppState, native: &PromotionNative) {
    let requests = native.requests.lock().unwrap().clone();
    let _ = promote(state, THREAD, ROW).await;
    assert_eq!(
        *native.requests.lock().unwrap(),
        requests,
        "an unresolved transfer must return its record without another native request"
    );
}

#[tokio::test]
async fn enqueue_binds_only_the_native_ack_to_its_pre_add_active_turn() {
    let (state, native) = fixture(false).await;
    let (adding, release) = native.hold("thread/queue/add");
    let producer_state = state.clone();
    let task = tokio::spawn(async move {
        enqueue(&producer_state, THREAD, input(), QUEUED_CLIENT.into()).await
    });
    entered(adding).await;
    assert!(state
        .queue_admissions
        .claim(THREAD, ADDED_ROW, Some(TURN))
        .is_none());
    *native.active_turn.lock().unwrap() = Some("later-active-turn".into());
    release.send(()).unwrap();
    let row = timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(row.id, ADDED_ROW);
    assert_eq!(row.input, input());
    assert_eq!(row.client_user_message_id, QUEUED_CLIENT);
    assert!(state
        .queue_admissions
        .claim(THREAD, ADDED_ROW, Some("later-active-turn"))
        .is_none());
    assert_eq!(
        state.queue_admissions.claim(THREAD, ADDED_ROW, Some(TURN)),
        Some(TURN.into())
    );
    assert_eq!(
        native.writes(),
        vec![(
            "thread/queue/add".into(),
            json!({
                "threadId":THREAD,"input":input(),"clientUserMessageId":QUEUED_CLIENT,
            })
        )]
    );
    assert!(state
        .store
        .list_queue_transfers(None)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn lost_context_or_add_ack_cannot_reconstruct_promotion_rights_from_a_native_row() {
    for interruption in ["completed", "reverted", "disconnected", "lost"] {
        let (state, native) = fixture(false).await;
        *native.add_lost.lock().unwrap() = interruption == "lost";
        let (adding, release) = native.hold("thread/queue/add");
        let producer_state = state.clone();
        let task = tokio::spawn(async move {
            enqueue(&producer_state, THREAD, input(), QUEUED_CLIENT.into()).await
        });
        entered(adding).await;
        match interruption {
            "completed" => {
                timeout(Duration::from_secs(2), ingest_inbound(InboundMessage::Notification {
                    method:"turn/completed".into(),
                    params:json!({"threadId":THREAD,"turn":{"id":TURN,"status":"completed","items":[]}}),
                }, &state)).await.unwrap().unwrap();
            }
            "reverted" | "disconnected" => invalidate(&state, interruption == "disconnected").await,
            _ => {}
        }
        release.send(()).unwrap();
        let result = timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
        if interruption == "lost" {
            assert!(result.is_err());
        } else {
            assert_eq!(result.unwrap().id, ADDED_ROW);
        }
        assert!(state
            .queue_admissions
            .claim(THREAD, ADDED_ROW, Some(TURN))
            .is_none());
        assert!(matches!(
            promote(&state, THREAD, ADDED_ROW).await,
            Err(ApiError::Conflict(_))
        ));
        assert_eq!(
            native.writes(),
            vec![(
                "thread/queue/add".into(),
                json!({
                    "threadId":THREAD,"input":input(),"clientUserMessageId":QUEUED_CLIENT,
                })
            )]
        );
        assert_eq!(
            *native.rows.lock().unwrap(),
            vec![row(OTHER_ROW), row(ROW), row(ADDED_ROW)]
        );
        assert!(state
            .store
            .list_queue_transfers(None)
            .await
            .unwrap()
            .is_empty());
    }
}

#[tokio::test]
async fn missing_live_admission_witness_leaves_native_row_untouched() {
    let (state, native) = fixture(false).await;
    assert!(matches!(
        promote(&state, THREAD, ROW).await,
        Err(ApiError::Conflict(_))
    ));
    assert!(native.writes().is_empty());
    assert_eq!(*native.rows.lock().unwrap(), vec![row(OTHER_ROW), row(ROW)]);
    assert!(state
        .store
        .list_queue_transfers(None)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn cold_replaced_or_prohibited_native_context_cannot_delete_a_queued_row() {
    for (active, capability) in [
        (None, Some(true)),
        (Some("different-turn"), Some(true)),
        (Some(TURN), Some(false)),
    ] {
        let (state, native) = fixture(true).await;
        *native.active_turn.lock().unwrap() = active.map(str::to_string);
        *native.capability.lock().unwrap() = capability;
        let error = promote(&state, THREAD, ROW)
            .await
            .err()
            .expect("promotion must reject");
        assert!(matches!(
            error,
            ApiError::Conflict(_) | ApiError::BadRequest(_)
        ));
        assert!(native.writes().is_empty());
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
async fn lossless_input_and_original_turn_are_durable_before_each_native_write() {
    let (state, native) = fixture(true).await;
    let (deleting, delete_ack) = native.hold("thread/queue/delete");
    let (steering, steer_ack) = native.hold("turn/steer");
    let task = spawn(&state, ROW);
    entered(deleting).await;
    let before_delete = saved(&state).await;
    assert_eq!(before_delete.phase, QueueTransferPhase::Deleting);
    assert_eq!(before_delete.native_queue_id, ROW);
    assert_eq!(before_delete.client_user_message_id, QUEUED_CLIENT);
    assert_eq!(before_delete.expected_turn_id, TURN);
    assert_eq!(before_delete.input, input());
    delete_ack.send(()).unwrap();
    entered(steering).await;
    assert_eq!(saved(&state).await.phase, QueueTransferPhase::Steering);
    assert_eq!(
        native.writes(),
        vec![
            (
                "thread/queue/delete".into(),
                json!({"threadId":THREAD,"queuedSubmissionId":ROW})
            ),
            (
                "turn/steer".into(),
                json!({"threadId":THREAD,"expectedTurnId":TURN,"clientUserMessageId":before_delete.id,"input":input()})
            ),
        ]
    );
    assert_ne!(
        before_delete.id, QUEUED_CLIENT,
        "steer correlation must be fresh per transfer"
    );
    steer_ack.send(()).unwrap();
    let accepted = transfer(finish(task).await.unwrap());
    assert_eq!(accepted.id, before_delete.id);
    assert_eq!(accepted.phase, QueueTransferPhase::Accepted);
    assert_eq!(saved(&state).await.phase, QueueTransferPhase::Accepted);
    let requests = native.requests.lock().unwrap();
    let lists = requests
        .iter()
        .filter(|(method, _)| method == "thread/queue/list")
        .collect::<Vec<_>>();
    assert_eq!(lists.len(), 1);
    assert_eq!(
        lists[0].1,
        json!({"threadId":THREAD,"limit":100,"cursor":null})
    );
    let summary_reads = requests
        .iter()
        .filter(|(method, _)| method == "thread/read")
        .collect::<Vec<_>>();
    assert_eq!(summary_reads.len(), 1);
    assert_eq!(
        summary_reads[0].1,
        json!({"threadId":THREAD,"includeTurns":false})
    );
    let header_reads = requests
        .iter()
        .filter(|(method, _)| method == "thread/turns/list")
        .collect::<Vec<_>>();
    assert_eq!(header_reads.len(), 1);
    assert_eq!(
        header_reads[0].1,
        json!({"threadId":THREAD,"cursor":null,"sortDirection":"desc","itemsView":"notLoaded","limit":1})
    );
}

#[tokio::test]
async fn false_or_lost_delete_ack_preserves_uncertainty_without_steer_or_requeue() {
    for reply in [DeleteReply::Absent, DeleteReply::Lost] {
        let (state, native) = fixture(true).await;
        *native.delete_reply.lock().unwrap() = reply;
        let outcome = transfer(promote(&state, THREAD, ROW).await.unwrap());
        assert_eq!(outcome.phase, QueueTransferPhase::Uncertain);
        assert_eq!(saved(&state).await.input, input());
        assert_eq!(
            native.writes(),
            vec![(
                "thread/queue/delete".into(),
                json!({"threadId":THREAD,"queuedSubmissionId":ROW})
            )]
        );
        assert_retry_does_not_write(&state, &native).await;
    }
}

#[tokio::test]
async fn lost_steer_or_expected_turn_rejection_never_retargets_or_resubmits() {
    for error in ["steer acknowledgement lost", "app-server error -32600: expected active turn id `original-active-turn` but found `different-turn`"] {
        let (state, native) = fixture(true).await;
        *native.steer_error.lock().unwrap() = Some(error.into());
        let outcome = transfer(promote(&state, THREAD, ROW).await.unwrap());
        assert_eq!(outcome.phase, QueueTransferPhase::Uncertain);
        assert_eq!(outcome.input, input());
        assert_eq!(native.writes().len(), 2);
        assert_eq!(native.writes()[1].1["expectedTurnId"], TURN);
        assert_retry_does_not_write(&state, &native).await;
    }
}

#[tokio::test]
async fn concurrent_promotions_share_one_transfer_and_one_native_attempt() {
    let (state, native) = fixture(true).await;
    let (deleting, release) = native.hold("thread/queue/delete");
    let first = spawn(&state, ROW);
    entered(deleting).await;
    let second = spawn(&state, ROW);
    release.send(()).unwrap();
    let first = transfer(finish(first).await.unwrap());
    let second = transfer(finish(second).await.unwrap());
    assert_eq!(first.id, second.id);
    assert_eq!(native.writes().len(), 2);
    assert_eq!(saved(&state).await.id, first.id);
}

#[tokio::test]
async fn native_receipt_before_steer_ack_settles_without_late_success_or_error_resurrection() {
    for error in [None, Some("steer acknowledgement lost")] {
        let (state, native) = fixture(true).await;
        *native.steer_error.lock().unwrap() = error.map(str::to_string);
        let (steering, release) = native.hold("turn/steer");
        let task = spawn(&state, ROW);
        entered(steering).await;
        let pending = saved(&state).await;
        receipt(&state, THREAD, TURN, &pending.id, "item/started").await;
        assert!(state
            .store
            .get_queue_transfer(&pending.id)
            .await
            .unwrap()
            .is_none());
        receipt(&state, THREAD, TURN, &pending.id, "item/completed").await;
        release.send(()).unwrap();
        assert!(
            matches!(finish(task).await.unwrap(), PromotionOutcome::Delivered { id } if id == pending.id)
        );
        assert!(state
            .store
            .list_queue_transfers(None)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(native.writes().len(), 2);
    }
}

#[tokio::test]
async fn repeated_original_queue_client_or_prior_receipt_cannot_settle_a_new_transfer() {
    let (state, native) = fixture(true).await;
    let first = transfer(promote(&state, THREAD, ROW).await.unwrap());
    receipt(&state, THREAD, TURN, &first.id, "item/completed").await;
    remember(&state, OTHER_ROW);
    let second = transfer(promote(&state, THREAD, OTHER_ROW).await.unwrap());
    assert_ne!(first.id, second.id);
    assert_eq!(first.client_user_message_id, second.client_user_message_id);
    for (thread, turn, client) in [
        (THREAD, TURN, QUEUED_CLIENT),
        (THREAD, TURN, first.id.as_str()),
        (THREAD, "foreign-turn", second.id.as_str()),
        ("foreign-chat", TURN, second.id.as_str()),
    ] {
        receipt(&state, thread, turn, client, "item/started").await;
        assert!(state
            .store
            .get_queue_transfer(&second.id)
            .await
            .unwrap()
            .is_some());
    }
    receipt(&state, THREAD, TURN, &second.id, "item/completed").await;
    assert!(state
        .store
        .list_queue_transfers(None)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(native.writes().len(), 4);
}

#[tokio::test]
async fn reset_or_disconnect_during_held_delete_cannot_begin_a_late_steer() {
    for disconnected in [false, true] {
        let (state, native) = fixture(true).await;
        let (deleting, release) = native.hold("thread/queue/delete");
        let task = spawn(&state, ROW);
        entered(deleting).await;
        invalidate(&state, disconnected).await;
        assert_eq!(saved(&state).await.phase, QueueTransferPhase::Uncertain);
        release.send(()).unwrap();
        assert_eq!(
            transfer(finish(task).await.unwrap()).phase,
            QueueTransferPhase::Uncertain
        );
        assert_eq!(native.writes().len(), 1);
        assert_retry_does_not_write(&state, &native).await;
    }
}

#[tokio::test]
async fn reset_or_disconnect_during_held_steer_cannot_be_reclassified_by_late_ack() {
    for disconnected in [false, true] {
        let (state, native) = fixture(true).await;
        let (steering, release) = native.hold("turn/steer");
        let task = spawn(&state, ROW);
        entered(steering).await;
        invalidate(&state, disconnected).await;
        release.send(()).unwrap();
        assert_eq!(
            transfer(finish(task).await.unwrap()).phase,
            QueueTransferPhase::Uncertain
        );
        assert_eq!(saved(&state).await.phase, QueueTransferPhase::Uncertain);
        assert_eq!(native.writes().len(), 2);
        assert_retry_does_not_write(&state, &native).await;
    }
}

#[tokio::test]
async fn stale_completion_cannot_retire_a_transfer_for_the_current_turn() {
    let (state, native) = fixture(true).await;
    let accepted = transfer(promote(&state, THREAD, ROW).await.unwrap());
    let requests = native.requests.lock().unwrap().clone();
    for (turn, expected_phase) in [
        ("older-completed-turn", QueueTransferPhase::Accepted),
        (TURN, QueueTransferPhase::Uncertain),
    ] {
        timeout(
            Duration::from_secs(2),
            ingest_inbound(
                InboundMessage::Notification {
                    method: "turn/completed".into(),
                    params: json!({"threadId":THREAD,"turn":{
                        "id":turn,"status":"completed","items":[],
                    }}),
                },
                &state,
            ),
        )
        .await
        .unwrap()
        .unwrap();
        let unresolved = saved(&state).await;
        assert_eq!(unresolved.id, accepted.id);
        assert_eq!(unresolved.phase, expected_phase);
        assert_eq!(unresolved.input, input());
    }
    assert_eq!(*native.requests.lock().unwrap(), requests);
    assert_retry_does_not_write(&state, &native).await;
}

#[tokio::test]
async fn native_status_loss_preserves_transfer_content_without_any_submission() {
    for status in ["idle", "notLoaded", "systemError"] {
        let (state, native) = fixture(true).await;
        let accepted = transfer(promote(&state, THREAD, ROW).await.unwrap());
        let requests = native.requests.lock().unwrap().clone();
        for (native_status, expected_phase) in [
            (
                json!({"type":"active","activeFlags":["waitingOnApproval"]}),
                QueueTransferPhase::Accepted,
            ),
            (json!({"type":status}), QueueTransferPhase::Uncertain),
        ] {
            timeout(
                Duration::from_secs(2),
                ingest_inbound(
                    InboundMessage::Notification {
                        method: "thread/status/changed".into(),
                        params: json!({"threadId":THREAD,"status":native_status}),
                    },
                    &state,
                ),
            )
            .await
            .unwrap()
            .unwrap();
            let unresolved = saved(&state).await;
            assert_eq!(unresolved.id, accepted.id);
            assert_eq!(unresolved.phase, expected_phase);
            assert_eq!(unresolved.input, input());
        }
        assert_eq!(*native.requests.lock().unwrap(), requests);
        assert_retry_does_not_write(&state, &native).await;
    }
}

#[tokio::test]
async fn failed_durable_transfer_creation_cannot_delete_native_input() {
    let (state, native) = fixture(true).await;
    sqlx::query("CREATE TRIGGER reject_transfer BEFORE INSERT ON queue_transfers BEGIN SELECT RAISE(FAIL,'fixture denies durable transfer'); END")
        .execute(state.store.pool()).await.unwrap();
    assert!(promote(&state, THREAD, ROW).await.is_err());
    assert!(native.writes().is_empty());
    assert_eq!(*native.rows.lock().unwrap(), vec![row(OTHER_ROW), row(ROW)]);
}

#[tokio::test]
async fn failed_persisted_deleted_or_steering_boundary_cannot_steer_or_retry() {
    for phase in ["deleted", "steering"] {
        let (state, native) = fixture(true).await;
        let (deleting, release) = native.hold("thread/queue/delete");
        let task = spawn(&state, ROW);
        entered(deleting).await;
        sqlx::query(&format!("CREATE TRIGGER reject_transfer_phase BEFORE UPDATE ON queue_transfers WHEN NEW.phase = '{phase}' BEGIN SELECT RAISE(FAIL,'fixture denies durable boundary'); END"))
            .execute(state.store.pool()).await.unwrap();
        release.send(()).unwrap();
        assert!(finish(task).await.is_err());
        assert_eq!(saved(&state).await.input, input());
        assert_eq!(native.writes().len(), 1);
        sqlx::query("DROP TRIGGER reject_transfer_phase")
            .execute(state.store.pool())
            .await
            .unwrap();
        assert_retry_does_not_write(&state, &native).await;
    }
}
