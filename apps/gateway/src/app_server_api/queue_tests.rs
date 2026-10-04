use std::sync::Arc;

use serde_json::{json, Value};

use super::CodexClient;
use crate::{
    app_server::tests::RecordingAppServer,
    error::{ApiError, ApiResult},
};

fn native_input() -> Vec<Value> {
    vec![
        json!({"type":"text","text":"你好 $skill", "text_elements":[{
            "byteRange":{"start":7,"end":13},"placeholder":"$skill",
        }]}),
        json!({"type":"skill","name":"skill","path":"/native/技能/SKILL.md"}),
        json!({"type":"mention","name":"resource","path":"mcp://native/item"}),
        json!({"type":"image","fileId":"native-file-id","detail":"original"}),
        json!({"type":"localImage","path":"/native/图.png","detail":"high"}),
        json!({"type":"audio","url":"data:audio/wav;base64,fixture"}),
        json!({"type":"localAudio","path":"/native/音.wav"}),
    ]
}

fn row(id: &str) -> Value {
    json!({"id":id,"clientUserMessageId":"  相同-client-id  ","input":native_input()})
}

fn accepted_start() -> Value {
    json!({"turn":{
        "id":"native-turn/opaque", "status":"inProgress", "items":[],
        "itemsView":"notLoaded", "error":null,
        "startedAt":null,"completedAt":null,"durationMs":null,
    }})
}

fn responding(payload: Value) -> Arc<RecordingAppServer> {
    let server = Arc::new(RecordingAppServer::default());
    *server.next_response.lock().unwrap() = Some(payload);
    server
}

#[tokio::test]
async fn native_queue_add_and_update_preserve_input_and_opaque_identity() {
    let original = row("  native/id:队列 001  ");
    let mut changed = original.clone();
    changed["input"][0]["text"] = json!("更新 $skill");
    let server = Arc::new(RecordingAppServer::default());
    server.queued_responses.lock().unwrap().extend([
        json!({"queuedSubmission":original}),
        json!({"queuedSubmission":changed}),
    ]);
    let client = CodexClient::new(server.clone());
    let added = client
        .queue_add(
            "opaque/thread".into(),
            native_input(),
            "  相同-client-id  ".into(),
        )
        .await
        .unwrap();
    assert_eq!(serde_json::to_value(&added).unwrap(), original);
    let edited_input = changed["input"].as_array().unwrap().clone();
    let edited = client
        .queue_update(
            "opaque/thread".into(),
            added.id.clone(),
            edited_input.clone(),
        )
        .await
        .unwrap();
    assert_eq!(serde_json::to_value(edited).unwrap(), changed);
    assert_eq!(
        *server.requests.lock().unwrap(),
        vec![
            (
                "thread/queue/add".into(),
                json!({
                    "threadId":"opaque/thread","clientUserMessageId":"  相同-client-id  ",
                    "input":native_input(),
                })
            ),
            (
                "thread/queue/update".into(),
                json!({
                    "threadId":"opaque/thread","queuedSubmissionId":added.id,"input":edited_input,
                })
            ),
        ]
    );
}

#[tokio::test]
async fn native_queue_pages_keep_server_order_duplicate_client_ids_and_opaque_cursor() {
    let first = row("native-b");
    let second = row("native-a");
    let server = Arc::new(RecordingAppServer::default());
    server.queued_responses.lock().unwrap().extend([
        json!({"data":[first,second],"nextCursor":"opaque/续页?x=%2F#next"}),
        json!({"data":[]}),
    ]);
    let client = CodexClient::new(server.clone());
    let page = client
        .queue_list("thread".into(), None, Some(2))
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(&page.data).unwrap(),
        json!([first, second])
    );
    let last = client
        .queue_list("thread".into(), page.next_cursor, None)
        .await
        .unwrap();
    assert!(last.data.is_empty());
    assert!(last.next_cursor.is_none());
    assert_eq!(
        *server.requests.lock().unwrap(),
        vec![
            (
                "thread/queue/list".into(),
                json!({"threadId":"thread","cursor":null,"limit":2})
            ),
            (
                "thread/queue/list".into(),
                json!({"threadId":"thread","cursor":"opaque/续页?x=%2F#next","limit":null})
            ),
        ]
    );
}

#[tokio::test]
async fn native_queue_delete_and_reorder_return_only_validated_native_results() {
    let server = Arc::new(RecordingAppServer::default());
    server.queued_responses.lock().unwrap().extend([
        json!({"deleted":true}),
        json!({"deleted":false}),
        json!({}),
    ]);
    let client = CodexClient::new(server.clone());
    assert!(client
        .queue_delete("thread".into(), "native/id".into())
        .await
        .unwrap());
    assert!(!client
        .queue_delete("thread".into(), "native/id".into())
        .await
        .unwrap());
    client
        .queue_reorder("thread".into(), vec!["b".into(), "a".into()])
        .await
        .unwrap();
    assert_eq!(
        *server.requests.lock().unwrap(),
        vec![
            (
                "thread/queue/delete".into(),
                json!({"threadId":"thread","queuedSubmissionId":"native/id"})
            ),
            (
                "thread/queue/delete".into(),
                json!({"threadId":"thread","queuedSubmissionId":"native/id"})
            ),
            (
                "thread/queue/reorder".into(),
                json!({"threadId":"thread","queuedSubmissionIds":["b","a"]})
            ),
        ]
    );
}

#[tokio::test]
async fn native_queue_start_preserves_native_turn_ack_without_followup_or_commit_inference() {
    let mut payload = accepted_start();
    payload["turn"]["items"] = json!([{
        "type":"userMessage","id":"native-user-item","clientId":"echoed-client-id",
        "content":native_input(),
    }]);
    let server = Arc::new(RecordingAppServer::default());
    server
        .queued_responses
        .lock()
        .unwrap()
        .extend([payload.clone(), accepted_start()]);
    let client = CodexClient::new(server.clone());
    let selected = client
        .queue_start("thread".into(), Some("native/id".into()))
        .await
        .unwrap();
    assert_eq!(selected.payload, payload);
    let head = client.queue_start("thread".into(), None).await.unwrap();
    assert_eq!(head.payload, accepted_start());
    assert_eq!(
        *server.requests.lock().unwrap(),
        vec![
            (
                "thread/queue/start".into(),
                json!({"threadId":"thread","queuedSubmissionId":"native/id"})
            ),
            (
                "thread/queue/start".into(),
                json!({"threadId":"thread","queuedSubmissionId":null})
            ),
        ]
    );
}

#[tokio::test]
async fn malformed_native_queue_rows_and_pages_are_not_empty_successes() {
    let mut invalid_rows = vec![Value::Null, json!([])];
    for key in ["id", "clientUserMessageId", "input"] {
        let mut missing = row("queued");
        missing.as_object_mut().unwrap().remove(key);
        invalid_rows.push(missing);
        let mut wrong_type = row("queued");
        wrong_type[key] = json!(42);
        invalid_rows.push(wrong_type);
    }
    for invalid_input in [
        json!([{"type":"text"}]),
        json!([{"type":"text","text":"secret response must not leak","text_elements":[{"byteRange":{"start":-1,"end":2}}]}]),
        json!([{"type":"image","detail":"original"}]),
        json!([{"type":"unsupported-future-input","text":"do not silently drop this"}]),
    ] {
        let mut invalid_row = row("queued");
        invalid_row["input"] = invalid_input;
        invalid_rows.push(invalid_row);
    }
    for operation in ["add", "update"] {
        for payload in [json!({}), json!({"queuedSubmission":null}), json!([])] {
            rejects_response(operation, payload).await;
        }
        for invalid_row in &invalid_rows {
            rejects_response(operation, json!({"queuedSubmission":invalid_row})).await;
        }
    }
    for payload in [
        json!({}),
        json!({"data":null}),
        json!({"data":{}}),
        json!([]),
        json!({"data":[],"nextCursor":7}),
        json!({"data":[],"nextCursor":{}}),
    ] {
        rejects_response("list", payload).await;
    }
    for invalid_row in invalid_rows {
        rejects_response("list", json!({"data":[invalid_row]})).await;
    }
}

#[tokio::test]
async fn malformed_native_queue_mutation_acks_are_not_false_deletion_or_accepted_start() {
    for payload in [
        json!({}),
        json!({"deleted":null}),
        json!({"deleted":"false"}),
        json!([]),
    ] {
        rejects_response("delete", payload).await;
    }
    for payload in [Value::Null, json!([]), json!(true)] {
        rejects_response("reorder", payload).await;
    }
    for payload in [
        json!({}),
        json!({"turn":null}),
        json!({"turn":[]}),
        json!({"turn":{}}),
    ] {
        rejects_response("start", payload).await;
    }
    for key in ["id", "items", "status"] {
        let mut missing = accepted_start();
        missing["turn"].as_object_mut().unwrap().remove(key);
        rejects_response("start", missing).await;
    }
    for (key, value) in [
        ("id", json!(7)),
        ("items", json!({})),
        ("status", json!("accepted")),
        ("itemsView", json!("unknown")),
        ("error", json!({"message":null})),
        (
            "items",
            json!([{"type":"userMessage","id":"missing-content"}]),
        ),
    ] {
        let mut wrong_type = accepted_start();
        wrong_type["turn"][key] = value;
        rejects_response("start", wrong_type).await;
    }
}

#[tokio::test]
async fn native_queue_errors_are_one_attempt_with_no_resume_or_legacy_fallback() {
    for operation in ["add", "list", "update", "delete", "reorder", "start"] {
        let server = Arc::new(RecordingAppServer::default());
        server
            .queued_errors
            .lock()
            .unwrap()
            .push(ApiError::BadGateway(
                "app-server error -32601: native queue method unsupported".into(),
            ));
        let error = invoke(&CodexClient::new(server.clone()), operation)
            .await
            .unwrap_err();
        assert!(matches!(error,ApiError::BadGateway(message) if message ==
            "app-server error -32601: native queue method unsupported"));
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0, format!("thread/queue/{operation}"));
    }
    for native_error in [
        "resume the thread before starting a queued message",
        "thread already has an active or pending turn",
    ] {
        let server = Arc::new(RecordingAppServer::default());
        server
            .queued_errors
            .lock()
            .unwrap()
            .push(ApiError::BadGateway(native_error.into()));
        let error = invoke(&CodexClient::new(server.clone()), "start")
            .await
            .unwrap_err();
        assert!(matches!(error,ApiError::BadGateway(message) if message == native_error));
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }
}

async fn rejects_response(operation: &str, payload: Value) {
    let server = responding(payload);
    let error = invoke(&CodexClient::new(server.clone()), operation)
        .await
        .unwrap_err();
    assert!(
        matches!(&error, ApiError::BadGateway(_)),
        "{operation}: {error}"
    );
    assert!(error
        .to_string()
        .contains(&format!("thread/queue/{operation} response")));
    assert!(!error.to_string().contains("secret response must not leak"));
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].0, format!("thread/queue/{operation}"));
}

async fn invoke(client: &CodexClient, operation: &str) -> ApiResult<()> {
    match operation {
        "add" => client
            .queue_add("thread".into(), native_input(), "client".into())
            .await
            .map(|_| ()),
        "list" => client
            .queue_list("thread".into(), None, Some(1))
            .await
            .map(|_| ()),
        "update" => client
            .queue_update("thread".into(), "queue".into(), native_input())
            .await
            .map(|_| ()),
        "delete" => client
            .queue_delete("thread".into(), "queue".into())
            .await
            .map(|_| ()),
        "reorder" => {
            client
                .queue_reorder("thread".into(), vec!["queue".into()])
                .await
        }
        "start" => client
            .queue_start("thread".into(), Some("queue".into()))
            .await
            .map(|_| ()),
        _ => unreachable!("test only names the six native queue operations"),
    }
}
