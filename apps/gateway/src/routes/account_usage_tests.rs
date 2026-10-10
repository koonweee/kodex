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
};

#[tokio::test]
async fn account_usage_reads_preserve_reset_details_and_unknown_details() {
    let native = Arc::new(RecordingAppServer::default());
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    for credits in [
        json!(null),
        json!([]),
        json!([{
            "id":"chosen", "title":"Weekly gift", "description":"A reset", "grantedAt":10,
            "expiresAt":20, "resetType":"codexRateLimits", "status":"available"
        }]),
    ] {
        let summary = json!({"availableCount":2,"credits":credits});
        *native.next_response.lock().unwrap() =
            Some(json!({"rateLimits":{},"rateLimitResetCredits":summary}));
        let response = build_router(state.clone())
            .oneshot(
                Request::builder()
                    .uri("/v1/account/rate-limits")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body["rateLimitResetCredits"], summary);
    }
}

#[tokio::test]
async fn account_usage_reset_forwards_identity_and_refills_both_clients() {
    let native = Arc::new(RecordingAppServer::default());
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    let mut first = state.events.subscribe();
    let mut second = state.events.subscribe();
    for outcome in ["reset", "nothingToReset", "noCredit", "alreadyRedeemed"] {
        *native.next_response.lock().unwrap() = Some(json!({"outcome":outcome}));
        let params = json!({"creditId":"chosen", "idempotencyKey":"logical-attempt"});
        let response = build_router(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/account/rate-limit-reset-credits/consume")
                    .header("content-type", "application/json")
                    .body(Body::from(params.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body, json!({"outcome":outcome}));
        assert_eq!(
            native.requests.lock().unwrap().last().unwrap(),
            &("account/rateLimitResetCredit/consume".into(), params)
        );
        for events in [&mut first, &mut second] {
            let event = events.try_recv().unwrap();
            assert_eq!(event.kind, "account.rate_limits_updated");
            assert_eq!(event.codex_method, None);
            assert_eq!(event.payload, json!({}));
            assert!(crate::events_replay::is_operational_replay_event(&event));
        }
    }
}

#[tokio::test]
async fn account_usage_reset_failure_refills_without_retrying_the_write() {
    let native = Arc::new(RecordingAppServer::default());
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    let mut events = state.events.subscribe();
    native
        .queued_errors
        .lock()
        .unwrap()
        .push(crate::error::ApiError::AppServerUnavailable);
    let response = build_router(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/account/rate-limit-reset-credits/consume")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"creditId":"chosen", "idempotencyKey":"attempt"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(native.requests.lock().unwrap().len(), 1);
    assert_eq!(
        events.try_recv().unwrap().kind,
        "account.rate_limits_updated"
    );
}
