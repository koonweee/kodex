use std::sync::Arc;

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::{json, Value};
use tower::ServiceExt;

use crate::{
    api::{build_router, AppState},
    app_server::{tests::RecordingAppServer, InboundMessage},
    config::Config,
    events::ingest_inbound,
    store::Store,
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

fn child(id: &str, parent: &str, status: &str, capability: Value) -> Value {
    json!({"id":id,"parentThreadId":parent,"canAcceptDirectInput":capability,
        "cwd":"/workspace","status":{"type":status},"createdAt":10,"updatedAt":20,
        "name":null,"preview":"Native child","source":"cli","agentNickname":"Scout","agentRole":"explorer"})
}

async fn get(state: &AppState, path: &str) -> (StatusCode, Value) {
    let response = build_router(state.clone())
        .oneshot(Request::get(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn native_subagents_use_one_ancestry_page_and_preserve_unloaded_children_and_capabilities() {
    let (state, native) = state().await;
    *native.next_response.lock().unwrap() = Some(json!({"data":[
        child("unloaded-grandchild","unloaded-parent","notLoaded",Value::Null),
        child("native-read-only-child","root","active",json!(false)),
        child("legacy-writable-child","root","idle",json!(true)),
        child("failed-child","root","systemError",Value::Null)
    ],"nextCursor":"opaque-next"}));
    let (status, body) = get(
        &state,
        "/v1/threads/root/subagents?cursor=opaque-prev&limit=4",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["nextCursor"], "opaque-next");
    assert_eq!(body["subagents"].as_array().unwrap().len(), 4);
    assert_eq!(body["subagents"][0]["id"], "unloaded-grandchild");
    assert_eq!(body["subagents"][0]["parentThreadId"], "unloaded-parent");
    assert_eq!(body["subagents"][0]["canAcceptDirectInput"], Value::Null);
    assert_eq!(body["subagents"][0]["status"], "notLoaded");
    assert_eq!(body["subagents"][1]["canAcceptDirectInput"], false);
    assert_eq!(body["subagents"][2]["canAcceptDirectInput"], true);
    assert_eq!(body["subagents"][3]["status"], "systemError");
    assert!(body["subagents"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row.get("liveState").is_none()));
    let requests = native.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].0, "thread/list");
    assert_eq!(
        requests[0].1,
        json!({"ancestorThreadId":"root","cursor":"opaque-prev","limit":4,
        "sortKey":"created_at","sortDirection":"asc","archived":false,"useStateDbOnly":true})
    );
}

#[tokio::test]
async fn native_subagent_refills_replace_missing_rows_without_local_repair_memory() {
    let (state, native) = state().await;
    native.queued_responses.lock().unwrap().extend([
        json!({"data":[child("child","root","idle",json!(true))],"nextCursor":null}),
        json!({"data":[],"nextCursor":null}),
    ]);
    let (first_status, first) = get(&state, "/v1/threads/root/subagents").await;
    assert_eq!(first_status, StatusCode::OK, "{first}");
    assert_eq!(first["subagents"].as_array().unwrap().len(), 1);
    let (second_status, second) = get(&state, "/v1/threads/root/subagents").await;
    assert_eq!(second_status, StatusCode::OK, "{second}");
    assert_eq!(second["subagents"], json!([]));
    assert!(native
        .requests
        .lock()
        .unwrap()
        .iter()
        .all(|request| request.0 == "thread/list"));
    assert_eq!(native.requests.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn native_subagent_unknown_child_status_publishes_only_global_refill_invalidation() {
    let (state, _native) = state().await;
    ingest_inbound(
        InboundMessage::Notification {
            method: "thread/status/changed".into(),
            params: json!({
                "threadId":"unknown-grandchild","status":{"type":"notLoaded"}
            }),
        },
        &state,
    )
    .await
    .unwrap();
    let events = state.store.replay_events(None, None, None).await.unwrap();
    let markers = events
        .iter()
        .filter(|event| event.kind == "thread.subagents_changed")
        .collect::<Vec<_>>();
    assert_eq!(markers.len(), 1);
    assert_eq!(markers[0].thread_id, None);
    assert_eq!(markers[0].project_id, None);
    assert_eq!(
        markers[0].payload,
        json!({"changedThreadId":"unknown-grandchild"})
    );
}

#[tokio::test]
async fn native_subagent_deleted_unloaded_child_invalidates_without_cached_ancestry() {
    let (state, native) = state().await;
    let mut receiver = state.events.subscribe();
    ingest_inbound(
        InboundMessage::Notification {
            method: "thread/deleted".into(),
            params: json!({"threadId":"unloaded-child"}),
        },
        &state,
    )
    .await
    .unwrap();
    let marker = receiver.try_recv().unwrap();
    assert_eq!(marker.kind, "thread.subagents_changed");
    assert_eq!(marker.thread_id, None);
    assert_eq!(marker.project_id, None);
    assert_eq!(marker.payload, json!({"changedThreadId":"unloaded-child"}));
    assert!(native.requests.lock().unwrap().is_empty());
    let persisted = state.store.replay_events(None, None, None).await.unwrap();
    assert_eq!(
        persisted
            .iter()
            .map(|event| event.kind.as_str())
            .collect::<Vec<_>>(),
        vec!["thread.subagents_changed", "turn_queue.changed"]
    );
    assert_eq!(persisted[0].seq, marker.seq);
    assert_eq!(persisted[1].payload, json!({"threadId":"unloaded-child"}));
}

#[tokio::test]
async fn native_subagent_marker_targets_only_explicit_native_thread_identity() {
    let (state, native) = state().await;
    let nested = crate::subagents::native_change_event(
        &state,
        "thread/started",
        &json!({"thread":child("child","root","idle",Value::Null)}),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(nested.thread_id, None);
    assert_eq!(nested.payload, json!({"changedThreadId":"child"}));
    let hook = crate::subagents::native_change_event(
        &state,
        "hook/completed",
        &json!({"run":{"eventName":"subagentStop"}}),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(hook.payload, json!({"changedThreadId":null}));
    assert!(crate::subagents::native_change_event(
        &state,
        "item/completed",
        &json!({"threadId":"root","item":{"id":"item-1","type":"agentMessage","text":"answer"}}),
    )
    .await
    .unwrap()
    .is_none());
    assert!(native.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn native_subagent_pages_bound_limit_and_keep_native_errors_visible() {
    let (state, native) = state().await;
    *native.next_response.lock().unwrap() = Some(json!({"data":[],"nextCursor":null}));
    let (status, body) = get(&state, "/v1/threads/root/subagents?limit=999&archived=true").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, json!({"subagents":[],"nextCursor":null}));
    assert_eq!(native.requests.lock().unwrap()[0].1["limit"], 100);
    assert_eq!(native.requests.lock().unwrap()[0].1["archived"], true);

    native
        .queued_errors
        .lock()
        .unwrap()
        .push(crate::error::ApiError::BadGateway(
            "-32602: invalid cursor".into(),
        ));
    let (status, body) = get(&state, "/v1/threads/root/subagents?cursor=expired").await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{body}");
    assert!(body.to_string().contains("invalid cursor"));
    assert_eq!(native.requests.lock().unwrap().len(), 2);
    assert!(native
        .requests
        .lock()
        .unwrap()
        .iter()
        .all(|request| request.0 == "thread/list"));
}

#[test]
fn native_subagent_input_capability_and_parent_survive_canonical_summary_projection() {
    for capability in [Value::Null, json!(false), json!(true)] {
        let summary = crate::app_server_api::ThreadSummary::from_payload(&child(
            "child",
            "root",
            "idle",
            capability.clone(),
        ))
        .unwrap();
        let view = crate::app_server_api::ThreadViewThreadSummary::from(summary.clone());
        let sidebar = super::threads::SidebarThreadSummary::from(summary.clone());
        for projected in [
            serde_json::to_value(summary).unwrap(),
            serde_json::to_value(view).unwrap(),
            serde_json::to_value(sidebar).unwrap(),
        ] {
            assert_eq!(projected["parentThreadId"], "root");
            assert!(projected.get("canAcceptDirectInput").is_some());
            assert_eq!(projected["canAcceptDirectInput"], capability);
        }
    }
}

#[tokio::test]
async fn native_subagent_explicit_input_denial_prevents_native_queue_admission() {
    let (state, native) = state().await;
    state
        .store
        .upsert_thread_runtime_state(crate::store::ThreadRuntimeState {
            thread_id: "child".into(),
            status: crate::store::ThreadRuntimeStatus::Starting,
            active_turn_id: None,
            updated_at: chrono::Utc::now(),
            last_event_seq: None,
        })
        .await
        .unwrap();
    *native.next_response.lock().unwrap() =
        Some(json!({"thread":child("child","root","active",json!(false))}));
    let response = build_router(state.clone())
        .oneshot(
            Request::post("/v1/threads/child/queued-inputs")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"input":[{"type":"text","text":"Do more"}]}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        *native.requests.lock().unwrap(),
        vec![(
            "thread/read".into(),
            json!({"threadId":"child","includeTurns":false})
        )]
    );
}

#[tokio::test]
async fn native_subagent_atomic_input_forwards_native_denial_without_queuing() {
    let (state, native) = state().await;
    let error = "app-server error -32600: direct app-server input is not allowed for multi-agent v2 sub-agents";
    native
        .queued_errors
        .lock()
        .unwrap()
        .push(crate::error::ApiError::BadGateway(error.into()));
    let response = build_router(state.clone())
        .oneshot(
            Request::post("/v1/threads/child/input")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "input": [{"type": "text", "text": "Do more"}],
                        "clientUserMessageId": "child-message"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["message"], error);
    assert_eq!(
        *native.requests.lock().unwrap(),
        vec![(
            "turn/start".into(),
            json!({
                "threadId": "child",
                "input": [{"type": "text", "text": "Do more"}],
                "clientUserMessageId": "child-message"
            })
        )]
    );
}

#[tokio::test]
async fn native_subagent_input_denial_cannot_delete_or_steer_a_native_queue_row() {
    let (state, native) = state().await;
    *native.next_response.lock().unwrap() =
        Some(json!({"thread":child("child","root","active",json!(false))}));
    let response = build_router(state.clone())
        .oneshot(
            Request::post("/v1/threads/child/queued-inputs/native-row/steer")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let events = state.store.replay_events(None, None, None).await.unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, "turn_queue.changed");
    assert_eq!(events[0].payload, json!({"threadId":"child"}));
    assert!(state
        .store
        .list_queue_transfers(None)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        *native.requests.lock().unwrap(),
        vec![(
            "thread/read".into(),
            json!({"threadId":"child","includeTurns":false})
        )]
    );
}

#[tokio::test]
async fn native_subagent_unknown_input_capability_does_not_infer_denial_from_role() {
    let (state, native) = state().await;
    state
        .store
        .upsert_thread_runtime_state(crate::store::ThreadRuntimeState {
            thread_id: "child".into(),
            status: crate::store::ThreadRuntimeStatus::Starting,
            active_turn_id: None,
            updated_at: chrono::Utc::now(),
            last_event_seq: None,
        })
        .await
        .unwrap();
    let input = json!([{"type":"text","text":"Native dispatch will decide"}]);
    native.queued_responses.lock().unwrap().extend([
        json!({"thread":child("child","root","notLoaded",Value::Null)}),
        json!({"data":[],"nextCursor":null,"backwardsCursor":null}),
        json!({"queuedSubmission":{"id":"native-row","clientUserMessageId":"native-client","input":input}}),
    ]);
    let response = build_router(state.clone())
        .oneshot(
            Request::post("/v1/threads/child/queued-inputs")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"input":input,"clientUserMessageId":"native-client"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["queuedInput"]["id"], "native-row");
    assert_eq!(body["queuedInput"]["input"], input);
    let calls = native.requests.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .map(|(method, _)| method.as_str())
            .collect::<Vec<_>>(),
        vec!["thread/read", "thread/turns/list", "thread/queue/add"]
    );
    assert_eq!(
        calls[2].1,
        json!({"threadId":"child","input":input,"clientUserMessageId":"native-client"})
    );
}
