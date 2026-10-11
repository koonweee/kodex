use crate::{
    api::{build_router, AppState},
    app_server::tests::RecordingAppServer,
    config::Config,
    store::Store,
};
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::{json, Value};
use std::sync::Arc;
use tower::ServiceExt;

async fn read(payload: Value, query: &str) -> (StatusCode, Value, Arc<RecordingAppServer>) {
    let native = Arc::new(RecordingAppServer::default());
    *native.next_response.lock().unwrap() = Some(payload);
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    let response = build_router(state)
        .oneshot(
            Request::get(format!(
                "/v1/self-control/threads/chat/turns/compact{query}"
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        native,
    )
}

fn page(items: Value) -> Value {
    json!({"data":[{"id":"turn", "status":"failed", "error":{"message":"Model failed"}, "items":items}], "nextCursor":"older", "backwardsCursor":null})
}

#[tokio::test]
async fn compact_reads_preserve_text_errors_and_native_pagination_without_activation() {
    let (status, body, native) = read(page(json!([
        {"id":"user","type":"userMessage","content":[{"type":"text","text":"Question"}]},
        {"id":"tool","type":"commandExecution","status":"failed","exitCode":1,"aggregatedOutput":"Failure details"},
        {"id":"answer","type":"agentMessage","phase":"final_answer","text":"Answer"}
    ])), "?cursor=older-page&limit=2").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["nextCursor"], "older");
    assert_eq!(body["turns"][0]["status"], "failed");
    assert_eq!(body["turns"][0]["error"], "Model failed");
    let items = body["turns"][0]["items"].as_array().unwrap();
    assert_eq!(items[0]["text"], "Question");
    assert_eq!(items[1]["status"], "failed");
    assert_eq!(items[1]["exitCode"], 1);
    assert!(items[1].get("text").is_none());
    assert_eq!(items[2]["text"], "Answer");
    let requests = native.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].0, "thread/turns/list");
    assert_eq!(requests[0].1["cursor"], "older-page");
    assert_eq!(requests[0].1["itemsView"], "full");
    assert_eq!(requests[0].1["limit"], 2);
}

#[tokio::test]
async fn compact_reads_bound_unicode_text_and_include_opt_in_tool_output() {
    let (status, body, _) = read(
        page(json!([
            {"id":"tool","type":"commandExecution","aggregatedOutput":"😀".repeat(600)},
            {"id":"answer","type":"agentMessage","text":"after budget"}
        ])),
        "?maxChars=256&includeToolOutput=true",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["truncated"], true);
    assert_eq!(body["turns"][0]["items"][0]["truncated"], true);
    let text_count: usize = body["turns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|turn| {
            turn["error"].as_str().map_or(0, |s| s.chars().count())
                + turn["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|item| {
                        item["text"].as_str().map_or(0, |s| s.chars().count())
                            + item["error"].as_str().map_or(0, |s| s.chars().count())
                    })
                    .sum::<usize>()
        })
        .sum();
    assert!(text_count <= 256);
}

#[tokio::test]
async fn compact_reads_validate_bounds_and_distinguish_failure_from_empty() {
    for query in ["?limit=0", "?limit=21", "?maxChars=0", "?maxChars=64001"] {
        let (status, _, native) = read(json!({}), query).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(native.requests.lock().unwrap().is_empty());
    }
    let (status, _, _) = read(json!({"unexpected":true}), "").await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    let (status, body, _) = read(json!({"data":[],"nextCursor":null}), "").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["turns"], json!([]));
    assert_eq!(body["truncated"], false);
}

#[tokio::test]
async fn compact_reads_bound_items_preserve_active_status_and_ignore_binary_payloads() {
    let mut items = vec![
        json!({"id":"function","type":"functionCallOutput","output":[
            {"type":"input_text","text":"Function text"}, {"type":"input_image","image_url":"secret-binary"}
        ]}),
        json!({"id":"dynamic","type":"dynamicToolCall","status":"completed","success":false,"contentItems":[{"type":"inputText","text":"Tool failed"}]}),
        json!({"id":"mcp","type":"mcpToolCall","status":"failed","error":{"message":"Permission denied"},"arguments":{"secret":"private"},"result":{"content":[{"type":"text","text":"MCP output"}]}}),
    ];
    items.extend(
        (0..250).map(|i| json!({"id":format!("item-{i}"),"type":"agentMessage","text":"progress"})),
    );
    let mut payload = page(json!(items));
    payload["data"][0]["status"] = json!("inProgress");
    let (status, body, _) = read(payload, "?includeToolOutput=true").await;
    assert_eq!(status, StatusCode::OK);
    let turn = &body["turns"][0];
    assert_eq!(turn["status"], "inProgress");
    assert_eq!(turn["items"].as_array().unwrap().len(), 200);
    assert_eq!(turn["omittedItems"], 53);
    assert_eq!(turn["items"][0]["text"], "Function text");
    assert_eq!(turn["items"][1]["success"], false);
    assert_eq!(turn["items"][2]["error"], "Permission denied");
    assert!(!body.to_string().contains("secret"));
    assert!(!body.to_string().contains("private"));
    assert_eq!(body["truncated"], true);
}

#[tokio::test]
async fn compact_tool_content_blocks_share_one_field_limit() {
    let (status, body, _) = read(page(json!([{"id":"tool","type":"functionCallOutput","output":[
        {"type":"input_text","text":"a".repeat(3000)}, {"type":"input_text","text":"b".repeat(3000)}
    ]}])), "?includeToolOutput=true").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["turns"][0]["items"][0]["text"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        4000
    );
    assert_eq!(body["turns"][0]["items"][0]["truncated"], true);
}
