use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::{
    sync::oneshot,
    time::{timeout, Duration},
};
use tower::ServiceExt;

use crate::{
    api::{build_router, AppState},
    app_server::{AppServer, InboundMessage},
    config::Config,
    error::{ApiError, ApiResult},
    events::ingest_inbound,
    store::Store,
};

const THREAD: &str = "native-queue-chat";
const TURN: &str = "original-native-turn";
const BASE: &str = "/v1/threads/native-queue-chat/queued-inputs";

#[derive(Default)]
struct NativeQueue {
    requests: Mutex<Vec<(String, Value)>>,
    rows: Mutex<Vec<Value>>,
    next_cursor: Mutex<Option<String>>,
    steer_error: Mutex<bool>,
    idle: Mutex<bool>,
    current_turn: Mutex<Option<String>>,
    history: Mutex<Vec<Value>>,
    update_gate: Mutex<Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>>,
    reorder_gate: Mutex<Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>>,
}

#[async_trait]
impl AppServer for NativeQueue {
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
        let response = match method {
            "thread/read" => Ok(json!({"thread":{
                "id":THREAD,"cwd":"/fixture","createdAt":1,"updatedAt":1,
                "status":{"type":"active","activeFlags":[]},"canAcceptDirectInput":true,
            }})),
            "thread/turns/list" => {
                let turn = self
                    .current_turn
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or_else(|| TURN.into());
                Ok(
                    json!({"data":if *self.idle.lock().unwrap() {vec![]} else {vec![json!({"id":turn,"status":"inProgress","items":[]})]},"nextCursor":null,"backwardsCursor":null}),
                )
            }
            "thread/queue/list" => Ok(
                json!({"data":self.rows.lock().unwrap().clone(),"nextCursor":*self.next_cursor.lock().unwrap()}),
            ),
            "thread/queue/add" => {
                let mut rows = self.rows.lock().unwrap();
                let row = json!({"id":format!("native-row-{}", rows.len()+1),"input":params["input"],"clientUserMessageId":params["clientUserMessageId"]});
                rows.push(row.clone());
                Ok(json!({"queuedSubmission":row}))
            }
            "thread/queue/update" => {
                let mut rows = self.rows.lock().unwrap();
                let row = rows
                    .iter_mut()
                    .find(|row| row["id"] == params["queuedSubmissionId"])
                    .ok_or_else(|| ApiError::BadGateway("native queued row missing".into()))?;
                row["input"] = params["input"].clone();
                Ok(json!({"queuedSubmission":row}))
            }
            "thread/queue/delete" => {
                let mut rows = self.rows.lock().unwrap();
                let before = rows.len();
                rows.retain(|row| row["id"] != params["queuedSubmissionId"]);
                Ok(json!({"deleted":rows.len() != before}))
            }
            "thread/queue/reorder" => {
                let mut rows = self.rows.lock().unwrap();
                let ids = params["queuedSubmissionIds"].as_array().unwrap();
                if ids.len() != rows.len()
                    || rows
                        .iter()
                        .any(|row| ids.iter().filter(|id| *id == &row["id"]).count() != 1)
                {
                    return Err(ApiError::BadGateway(
                        "native reorder requires every queued submission exactly once".into(),
                    ));
                }
                *rows = ids
                    .iter()
                    .map(|id| rows.iter().find(|row| row["id"] == *id).unwrap().clone())
                    .collect();
                Ok(json!({}))
            }
            "thread/queue/start" => Ok(json!({"turn":{
                "id":"native-started-turn","status":"inProgress","items":[],"itemsView":"notLoaded","error":null,"startedAt":null,"completedAt":null,"durationMs":null,
            }})),
            "turn/steer" if *self.steer_error.lock().unwrap() => Err(ApiError::BadGateway(
                "native steer acknowledgement lost".into(),
            )),
            "turn/steer" => Ok(json!({"turnId":params["expectedTurnId"]})),
            "thread/items/list" => Ok(
                json!({"data":self.history.lock().unwrap().clone(),"nextCursor":null,"backwardsCursor":null}),
            ),
            _ => Err(ApiError::BadGateway(format!(
                "unexpected native queue RPC {method}"
            ))),
        };
        let gate = match method {
            "thread/queue/update" => self.update_gate.lock().unwrap().take(),
            "thread/queue/reorder" => self.reorder_gate.lock().unwrap().take(),
            _ => None,
        };
        if let Some((started, release)) = gate {
            let _ = started.send(());
            release
                .await
                .map_err(|_| ApiError::BadGateway("update gate closed".into()))?;
        }
        response
    }
    async fn respond(&self, _request_id: &str, _result: Value) -> ApiResult<()> {
        Err(ApiError::BadGateway("unexpected approval response".into()))
    }
}

fn input() -> Value {
    json!([
        {"type":"text","text":"🧪 $missing","text_elements":[{"byteRange":{"start":5,"end":13},"placeholder":null}]},
        {"type":"skill","name":"missing","path":"/fixture/unavailable/SKILL.md"},
        {"type":"skill","name":"missing","path":"/fixture/unavailable/SKILL.md"},
        {"type":"image","fileId":"native-file","detail":"original"},
        {"type":"audio","url":"data:audio/wav;base64,fixture"},
        {"type":"localAudio","path":"/fixture/audio.wav"},
    ])
}

fn row(id: &str) -> Value {
    json!({"id":id,"clientUserMessageId":"reused-client","input":input()})
}

async fn state() -> (AppState, Arc<NativeQueue>) {
    let native = Arc::new(NativeQueue::default());
    (
        AppState::new(
            Config::default(),
            Store::in_memory().await.unwrap(),
            native.clone(),
        ),
        native,
    )
}

async fn request(state: &AppState, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
    let response = build_router(state.clone())
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn create(state: &AppState) -> Value {
    let (status, body) = request(
        state,
        "POST",
        BASE,
        json!({"input":input(),"clientUserMessageId":"reused-client"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["queuedInput"].clone()
}

#[tokio::test]
async fn native_http_queue_list_preserves_native_rows_cursor_and_current_steer_eligibility() {
    let (state, native) = state().await;
    *native.rows.lock().unwrap() = vec![row("native-a"), row("native-b")];
    *native.next_cursor.lock().unwrap() = Some("opaque-next".into());
    let (status, body) = request(
        &state,
        "GET",
        &format!("{BASE}?cursor=opaque-input"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["queuedInputs"].as_array().unwrap().len(), 2);
    assert_eq!(body["queuedInputs"][0]["id"], "native-a");
    assert_eq!(body["queuedInputs"][1]["id"], "native-b");
    for row in body["queuedInputs"].as_array().unwrap() {
        assert_eq!(row["threadId"], THREAD);
        assert_eq!(row["input"], input());
        assert_eq!(row["canSteer"], true);
        assert!(row.get("status").is_none() && row.get("options").is_none());
    }
    assert_eq!(body["transfers"], json!([]));
    assert_eq!(body["nextCursor"], "opaque-next");
    let calls = native.requests.lock().unwrap();
    assert_eq!(
        calls[0],
        (
            "thread/queue/list".into(),
            json!({"threadId":THREAD,"cursor":"opaque-input","limit":100})
        )
    );
    assert!(calls.iter().all(|(method, _)| matches!(
        method.as_str(),
        "thread/queue/list" | "thread/read" | "thread/turns/list"
    )));
}

#[tokio::test]
async fn native_http_queue_add_preserves_full_input_and_rejects_legacy_turn_options() {
    let (state, native) = state().await;
    let queued = create(&state).await;
    assert_eq!(queued["id"], "native-row-1");
    assert_eq!(queued["clientUserMessageId"], "reused-client");
    assert_eq!(queued["input"], input());
    assert_eq!(queued["canSteer"], true);
    let before = native.requests.lock().unwrap().clone();
    assert_eq!(
        before
            .iter()
            .filter(|(method, _)| method == "thread/queue/add")
            .count(),
        1
    );
    assert!(before.iter().all(|(method, params)| matches!(
        method.as_str(),
        "thread/read" | "thread/turns/list" | "thread/queue/add"
    ) && params.get("includeTurns")
        != Some(&json!(true))));
    for options in [
        json!({"model":"stale-model"}),
        json!({"options":{"effort":"high"}}),
    ] {
        let mut body = json!({"input":input()});
        body.as_object_mut()
            .unwrap()
            .extend(options.as_object().unwrap().clone());
        let (status, _) = request(&state, "POST", BASE, body).await;
        assert!(matches!(
            status,
            StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY
        ));
    }
    assert_eq!(*native.requests.lock().unwrap(), before);
}

#[tokio::test]
async fn native_http_queue_edit_reorder_start_and_delete_delegate_once_without_dispatcher() {
    let (state, native) = state().await;
    let a = create(&state).await;
    let b = create(&state).await;
    let a_id = a["id"].as_str().unwrap();
    let b_id = b["id"].as_str().unwrap();
    let edited = json!([{ "type":"text","text":"edited" },{"type":"localAudio","path":"/fixture/revised.wav"}]);
    let (status, body) = request(
        &state,
        "PUT",
        &format!("{BASE}/{a_id}"),
        json!({"input":edited}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["queuedInput"]["id"], a["id"]);
    assert_eq!(
        body["queuedInput"]["clientUserMessageId"],
        a["clientUserMessageId"]
    );
    assert_eq!(body["queuedInput"]["input"], edited);
    assert_eq!(body["queuedInput"]["canSteer"], true);
    let (status, body) = request(
        &state,
        "POST",
        &format!("{BASE}/reorder"),
        json!({"queuedSubmissionIds":[b_id,a_id]}),
    )
    .await;
    assert!(status.is_success(), "{body}");
    assert_eq!(
        native
            .rows
            .lock()
            .unwrap()
            .iter()
            .map(|row| row["id"].clone())
            .collect::<Vec<_>>(),
        vec![b["id"].clone(), a["id"].clone()]
    );
    let (status, body) = request(
        &state,
        "POST",
        &format!("{BASE}/start"),
        json!({"queuedSubmissionId":a_id}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["payload"]["turn"]["id"], "native-started-turn");
    for deleted in [true, false] {
        let (status, body) =
            request(&state, "DELETE", &format!("{BASE}/{a_id}"), Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body, json!({"deleted":deleted,"id":a_id,"threadId":THREAD}));
    }
    let requests = native.requests.lock().unwrap();
    assert!(requests
        .iter()
        .all(|(method, _)| method != "turn/start" && method != "thread/resume"));
    for method in [
        "thread/queue/update",
        "thread/queue/reorder",
        "thread/queue/start",
    ] {
        assert_eq!(
            requests.iter().filter(|(name, _)| name == method).count(),
            1
        );
    }
}

#[tokio::test]
async fn native_http_queue_has_no_retry_endpoint_or_old_status_contract() {
    let (state, native) = state().await;
    let (status, _) = request(
        &state,
        "POST",
        &format!("{BASE}/missing/retry"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(native.requests.lock().unwrap().is_empty());
    let (_, schema) = request(&state, "GET", "/openapi.json", Value::Null).await;
    assert!(schema["paths"]
        .get("/v1/threads/{threadId}/queued-inputs/{queueId}/retry")
        .is_none());
    assert!(schema["components"]["schemas"]
        .get("QueuedInputStatus")
        .is_none());
}

async fn stream(state: &AppState, cursor: i64) -> Body {
    let response = build_router(state.clone())
        .oneshot(
            Request::get(format!(
                "/v1/events?threadId=other-chat&includeGlobal=true&cursor={cursor}"
            ))
            .header("accept", "text/event-stream")
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers()["content-type"]
        .to_str()
        .unwrap()
        .contains("text/event-stream"));
    response.into_body()
}

async fn marker(body: &mut Body, name: &str) {
    timeout(Duration::from_secs(2), async {
        while let Some(frame) = body.frame().await {
            let frame = frame.unwrap();
            let Ok(data) = frame.into_data() else {
                continue;
            };
            let text = String::from_utf8_lossy(&data);
            if text.contains(name) {
                assert!(text.contains(THREAD));
                assert!(!text.contains("missing/SKILL.md"));
                return;
            }
        }
        panic!("SSE ended before {name}");
    })
    .await
    .expect("queue mutation must invalidate both clients");
}

#[tokio::test]
async fn native_http_queue_attachment_envelope_preserves_raw_input_and_thread_boundary() {
    let (state, native) = state().await;
    let attachment = json!({
        "id":"file-id", "fileName":"notes.md", "extension":"md", "sizeBytes":20,
        "relativePath":format!(".kodex/uploads/{THREAD}/file-id/notes.md"),
        "mimeType":"text/markdown",
    });
    let (status, created) = request(
        &state,
        "POST",
        BASE,
        json!({"input":input(),"attachments":[attachment],"clientUserMessageId":"with-file"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(
        created["queuedInput"]["attachments"][0]["relativePath"],
        attachment["relativePath"]
    );
    let (status, listed) = request(&state, "GET", BASE, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        listed["queuedInputs"][0]["attachments"],
        created["queuedInput"]["attachments"]
    );
    let calls = native.requests.lock().unwrap().clone();
    let added = &calls
        .iter()
        .find(|(method, _)| method == "thread/queue/add")
        .unwrap()
        .1["input"];
    let original = input().as_array().unwrap().clone();
    assert_eq!(
        &added.as_array().unwrap()[..original.len()],
        original.as_slice()
    );
    assert_eq!(added.as_array().unwrap().len(), original.len() + 1);
    assert!(added[original.len()]["text"]
        .as_str()
        .unwrap()
        .contains(attachment["relativePath"].as_str().unwrap()));

    let mut foreign = attachment;
    foreign["relativePath"] = json!(".kodex/uploads/other-chat/file-id/notes.md");
    let (status, _) = request(
        &state,
        "POST",
        BASE,
        json!({"input":input(),"attachments":[foreign]}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(*native.requests.lock().unwrap(), calls);
}

#[tokio::test]
async fn native_http_queue_saved_admission_survives_refill_publication_failure() {
    let (state, native) = state().await;
    sqlx::query("CREATE TRIGGER reject_queue_marker BEFORE INSERT ON events WHEN NEW.kind='turn_queue.changed' BEGIN SELECT RAISE(FAIL, 'fixture event failure'); END")
        .execute(state.store.pool()).await.unwrap();
    let queued = create(&state).await;
    assert_eq!(queued["id"], "native-row-1");
    assert_eq!(queued["input"], json!(input()));
    assert_eq!(native.rows.lock().unwrap().len(), 1);
    assert_eq!(
        native
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(method, _)| method == "thread/queue/add")
            .count(),
        1
    );
    let (status, listed) = request(&state, "GET", BASE, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["queuedInputs"][0], queued);
}

#[path = "http_tests/producers.rs"]
mod producers;
#[path = "http_tests/recovery.rs"]
mod recovery;

#[path = "http_tests/steer_first.rs"]
mod steer_first;
