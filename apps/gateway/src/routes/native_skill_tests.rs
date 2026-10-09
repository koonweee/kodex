use std::sync::Arc;

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::{json, Value};
use tower::ServiceExt;

use crate::{
    api::{build_router, AppState},
    app_server::tests::RecordingAppServer,
    config::Config,
    store::Store,
    thread_view,
};

async fn state() -> (AppState, Arc<RecordingAppServer>) {
    let native = Arc::new(RecordingAppServer::default());
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
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}

fn selected_and_raw_input() -> Value {
    // Preserve client names, duplicate explicit selections, Unicode spans and
    // ordering. Native selection decides validity and raw $name execution.
    json!([
        {"type":"skill","name":"missing","path":"/fixture/unavailable/SKILL.md"},
        {"type":"text","text":"🧪 $missing and $native-only","text_elements":[{"byteRange":{"start":5,"end":13},"placeholder":null}]},
        {"type":"skill","name":"missing","path":"/fixture/unavailable/SKILL.md"},
    ])
}

#[tokio::test]
async fn native_skill_start_and_steer_forward_selections_and_raw_text_without_catalog_resolution() {
    for (path, method, response) in [
        (
            "/v1/threads/native-chat/turns",
            "turn/start",
            json!({"turn":{"id":"native-turn","status":"inProgress"}}),
        ),
        (
            "/v1/threads/native-chat/turns/native-turn/steer",
            "turn/steer",
            json!({"turnId":"native-turn"}),
        ),
    ] {
        let (state, native) = state().await;
        *native.next_response.lock().unwrap() = Some(response);
        let input = selected_and_raw_input();
        let (status, body) = request(&state, "POST", path, json!({"input":input})).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let requests = native.requests.lock().unwrap();
        assert_eq!(
            requests.len(),
            1,
            "skill submission must not require catalog/history reads: {requests:?}"
        );
        assert_eq!(requests[0].0, method);
        assert_eq!(requests[0].1["input"], input);
    }
}

#[tokio::test]
async fn native_skill_input_routes_active_steering_without_rewriting_selections() {
    let (state, native) = state().await;
    thread_view::record_item_delta(
        &state.thread_views,
        "native-chat",
        "native-turn",
        "native-agent-message",
        "Working",
        std::future::ready(Ok(1)),
    )
    .await
    .unwrap();
    *native.next_response.lock().unwrap() =
        Some(json!({"turn":{"id":"native-turn","status":"inProgress"}}));
    let input = selected_and_raw_input();

    let (status, body) = request(
        &state,
        "POST",
        "/v1/threads/native-chat/input",
        json!({"input":input}),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.get("payload").is_some());
    assert!(body["queuedInput"].is_null());
    let requests = native.requests.lock().unwrap();
    assert_eq!(requests.len(), 1, "unexpected native calls: {requests:?}");
    assert_eq!(requests[0].0, "turn/start");

    assert_eq!(requests[0].1["input"], input);
}

#[tokio::test]
async fn native_skill_history_uses_structured_content_without_scanning_plain_text_or_reading_catalog(
) {
    let (state, native) = state().await;
    native.queued_responses.lock().unwrap().extend([
        json!({"thread":{"id":"native-chat","cwd":"/fixture","preview":"Native","status":{"type":"idle"},"createdAt":1,"updatedAt":1}}),
        json!({"data":[{"id":"native-turn","status":"completed","items":[
            {"id":"plain","type":"userMessage","content":[{"type":"text","text":"$native-only"}]},
            {"id":"selected","type":"userMessage","content":[
                {"type":"text","text":"🧪 $missing","text_elements":[{"byteRange":{"start":5,"end":13},"placeholder":null}]},
                {"type":"skill","name":"missing","path":"/fixture/unavailable/SKILL.md"}
            ]}
        ]}],"nextCursor":null}),
    ]);
    let (status, body) = request(&state, "GET", "/v1/threads/native-chat", Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let rows = body["timeline"]["rows"].as_array().unwrap();
    let snapshot = |id: &str| {
        rows.iter()
            .find(|row| row["item"]["itemId"] == id)
            .unwrap_or_else(|| panic!("missing {id}: {body}"))["item"]["payload"]
            .clone()
    };
    assert!(snapshot("plain")
        .get("skillMentions")
        .and_then(Value::as_array)
        .is_none_or(Vec::is_empty));
    assert_eq!(
        snapshot("selected")["skillMentions"],
        json!([{
            "start":3,"end":11,"name":"missing","path":"/fixture/unavailable/SKILL.md"
        }])
    );
    let requests = native.requests.lock().unwrap();
    assert!(
        requests
            .iter()
            .all(|(method, _)| matches!(method.as_str(), "thread/read" | "thread/turns/list")),
        "history must not require a catalog: {requests:?}"
    );
}
