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

fn goal(status: &str) -> Value {
    json!({"threadId":"thread-1","objective":"Finish the feature","status":status,"tokenBudget":10000,"tokensUsed":123,"timeUsedSeconds":45,"createdAt":1,"updatedAt":2})
}

#[tokio::test]
async fn native_goal_reads_and_clears_return_authoritative_results_without_activation() {
    let (state, native) = state().await;
    let app = build_router(state);
    for (request, method, result) in [
        (
            Request::get("/v1/threads/thread-1/goal"),
            "thread/goal/get",
            json!({"goal":goal("active")}),
        ),
        (
            Request::get("/v1/threads/thread-1/goal"),
            "thread/goal/get",
            json!({"goal":null}),
        ),
        (
            Request::delete("/v1/threads/thread-1/goal"),
            "thread/goal/clear",
            json!({"cleared":true}),
        ),
        (
            Request::delete("/v1/threads/thread-1/goal"),
            "thread/goal/clear",
            json!({"cleared":false}),
        ),
    ] {
        native.queued_responses.lock().unwrap().push(result.clone());
        let response = app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body, result);
        assert_eq!(
            native.requests.lock().unwrap().len(),
            1,
            "goal RPC must not resume or read settings"
        );
        assert_eq!(
            native.requests.lock().unwrap().pop().unwrap(),
            (method.into(), json!({"threadId":"thread-1"}))
        );
    }
}

#[tokio::test]
async fn native_goal_set_preserves_sparse_and_explicit_null_updates() {
    let (state, native) = state().await;
    let app = build_router(state.clone());
    for patch in [
        json!({"objective":"Finish the feature"}),
        json!({"status":"paused"}),
        json!({"tokenBudget":null}),
        json!({"objective":null,"status":null,"tokenBudget":20000}),
    ] {
        let result = json!({"goal":goal("paused")});
        native.queued_responses.lock().unwrap().push(result.clone());
        let response = app
            .clone()
            .oneshot(
                Request::patch("/v1/threads/thread-1/goal")
                    .header("content-type", "application/json")
                    .body(Body::from(patch.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body, result);
        let mut expected = patch;
        expected["threadId"] = json!("thread-1");
        assert_eq!(
            native.requests.lock().unwrap().len(),
            1,
            "goal RPC must not resume or read settings"
        );
        assert_eq!(
            native.requests.lock().unwrap().pop().unwrap(),
            ("thread/goal/set".into(), expected)
        );
    }
    assert_eq!(
        state.store.latest_event_seq().await.unwrap(),
        0,
        "notifications own goal invalidation"
    );
}

#[tokio::test]
async fn native_goal_notifications_invalidate_model_and_client_changes_for_other_tabs_and_reconnect(
) {
    let (state, native) = state().await;
    for status in [
        "active",
        "paused",
        "blocked",
        "usageLimited",
        "budgetLimited",
        "complete",
    ] {
        ingest_inbound(
            InboundMessage::Notification {
                method: "thread/goal/updated".into(),
                params: json!({"threadId":"thread-1","turnId":"turn-model","goal":goal(status)}),
            },
            &state,
        )
        .await
        .unwrap();
    }
    ingest_inbound(
        InboundMessage::Notification {
            method: "thread/goal/cleared".into(),
            params: json!({"threadId":"thread-1"}),
        },
        &state,
    )
    .await
    .unwrap();
    assert!(
        native.requests.lock().unwrap().is_empty(),
        "serial ingestion must never read native goals"
    );
    let events = state.store.replay_events(None, None, None).await.unwrap();
    assert_eq!(events.len(), 7);
    for event in &events {
        assert_eq!(event.kind, "thread.goal_changed");
        assert_eq!(event.payload, json!({"threadId":"thread-1"}));
        assert!(crate::events_replay::is_normal_live_event(event));
    }
    let query =
        serde_json::from_value(json!({"threadIds":"other-pane","includeGlobal":true})).unwrap();
    assert_eq!(
        crate::events_replay::workspace_sse_replay_events(events, &query)
            .unwrap()
            .len(),
        7
    );
}

#[tokio::test]
async fn native_goal_set_rejects_unknown_status_before_native_write() {
    let (state, native) = state().await;
    let response = build_router(state)
        .oneshot(
            Request::patch("/v1/threads/thread-1/goal")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"status":"stopped"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert!(native.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn native_goal_contract_is_typed_in_openapi_and_sparse_nullable_in_requests() {
    let (state, _) = state().await;
    let response = build_router(state)
        .oneshot(Request::get("/openapi.json").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    let path = &body["paths"]["/v1/threads/{threadId}/goal"];
    for (method, response_type) in [
        ("get", "ThreadGoalGetResponse"),
        ("patch", "ThreadGoalSetResponse"),
        ("delete", "ThreadGoalClearResponse"),
    ] {
        assert_eq!(
            path[method]["responses"]["200"]["content"]["application/json"]["schema"]["$ref"],
            format!("#/components/schemas/{response_type}")
        );
    }
    assert_eq!(
        path["patch"]["requestBody"]["content"]["application/json"]["schema"]["$ref"],
        "#/components/schemas/ThreadGoalSetRequest"
    );
    assert_eq!(
        body["components"]["schemas"]["ThreadGoalGetResponse"]["required"],
        json!(["goal"])
    );
    let request = &body["components"]["schemas"]["ThreadGoalSetRequest"];
    assert!(
        request.get("required").is_none(),
        "all patches are optional"
    );
    assert_eq!(
        body["components"]["schemas"]["ThreadGoalStatus"]["enum"],
        json!([
            "active",
            "paused",
            "blocked",
            "usageLimited",
            "budgetLimited",
            "complete"
        ])
    );
    let marker = &body["components"]["schemas"]["ThreadGoalChanged"];
    assert_eq!(marker["required"], json!(["threadId"]));
    for patch in [
        json!({}),
        json!({"objective":null,"status":null,"tokenBudget":null}),
    ] {
        let decoded: crate::app_server_api::ThreadGoalSetRequest =
            serde_json::from_value(patch.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), patch);
    }
}

#[tokio::test]
async fn native_goal_malformed_responses_surface_gateway_errors() {
    let (state, native) = state().await;
    let app = build_router(state);
    for request in [
        Request::get("/v1/threads/thread-1/goal"),
        Request::patch("/v1/threads/thread-1/goal"),
        Request::delete("/v1/threads/thread-1/goal"),
    ] {
        native
            .queued_responses
            .lock()
            .unwrap()
            .push(json!({"goal":{}}));
        let response = app
            .clone()
            .oneshot(
                request
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    }
}
