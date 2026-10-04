use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use axum::{
    body::{to_bytes, Body},
    http::{Method, Request, StatusCode},
};
use serde_json::{json, Value};
use tower::ServiceExt;

use crate::{
    api::{build_router, AppState},
    app_server::AppServer,
    app_surfaces::MCP_APP_MIME_TYPE,
    config::Config,
    error::{ApiError, ApiResult},
    store::{AppSurfaceProvider, AppSurfaceSessionStatus, AppSurfaceSessionUpsert, Store},
};

#[derive(Default)]
struct Native {
    calls: Mutex<Vec<(String, Value)>>,
    wrong_read_id: bool,
}

fn thread(id: &str) -> Value {
    json!({"id":id,"cwd":"/fixture","status":{"type":"notLoaded"},
        "createdAt":1,"updatedAt":1,"canAcceptDirectInput":null})
}

#[async_trait]
impl AppServer for Native {
    fn is_ready(&self) -> bool {
        true
    }
    fn readiness_error(&self) -> Option<String> {
        None
    }

    async fn request(&self, method: &str, params: Value) -> ApiResult<Value> {
        self.calls
            .lock()
            .unwrap()
            .push((method.into(), params.clone()));
        match method {
            "thread/read" if params["threadId"] == "owned-chat" => {
                let id = if self.wrong_read_id {
                    "other-chat"
                } else {
                    "owned-chat"
                };
                Ok(json!({"thread":thread(id)}))
            }
            "thread/read" => Err(ApiError::BadGateway(
                "native thread not found in this home".into(),
            )),
            "thread/resume" | "thread/fork" => Ok(json!({"thread":thread("owned-chat")})),
            "thread/turns/list" => Ok(json!({"data":[],"nextCursor":null,"backwardsCursor":null})),
            _ => Err(ApiError::BadGateway(format!(
                "unexpected target RPC {method}"
            ))),
        }
    }

    async fn respond(&self, _: &str, _: Value) -> ApiResult<()> {
        Err(ApiError::BadGateway("unexpected response".into()))
    }
}

async fn state(wrong_read_id: bool) -> (AppState, Arc<Native>) {
    let native = Arc::new(Native {
        wrong_read_id,
        ..Default::default()
    });
    (
        AppState::new(
            Config::default(),
            Store::in_memory().await.unwrap(),
            native.clone(),
        ),
        native,
    )
}

async fn request(state: &AppState, method: Method, path: &str, body: Value) -> (StatusCode, Value) {
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
    (status, serde_json::from_slice(&bytes).unwrap())
}

fn surface_body() -> Value {
    json!({"title":"View","html":"<!doctype html><main>View</main>","fallbackContent":"View","presentation":"focus"})
}

async fn seed_surface(state: &AppState, thread_id: &str) {
    state
        .store
        .upsert_app_surface_session(AppSurfaceSessionUpsert {
            thread_id: thread_id.into(),
            provider: AppSurfaceProvider::Generated,
            title: "Existing view".into(),
            resource_uri: None,
            resource_mime_type: MCP_APP_MIME_TYPE.into(),
            html: "<!doctype html><main>Existing</main>".into(),
            fallback_content: "Existing".into(),
            display_modes: vec!["inline".into()],
            csp: Default::default(),
            permissions: Default::default(),
            grants: Default::default(),
            provenance: json!({}),
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn native_control_surface_unknown_target_cannot_create_or_publish_local_state() {
    let (state, native) = state(false).await;
    let (status, body) = request(
        &state,
        Method::POST,
        "/v1/self-control/threads/foreign-chat/app-surface",
        surface_body(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{body}");
    assert!(state
        .store
        .latest_app_surface_session("foreign-chat")
        .await
        .unwrap()
        .is_none());
    assert!(state
        .store
        .replay_events(None, None, None)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        *native.calls.lock().unwrap(),
        vec![(
            "thread/read".into(),
            json!({"threadId":"foreign-chat","includeTurns":false})
        )]
    );
}

#[tokio::test]
async fn native_control_surface_stored_record_does_not_establish_native_ownership() {
    let (state, native) = state(false).await;
    seed_surface(&state, "foreign-chat").await;
    for (method, suffix, body) in [
        (Method::GET, "", json!({})),
        (Method::POST, "", surface_body()),
        (Method::POST, "/presentation", json!({"action":"focus"})),
        (Method::DELETE, "", json!({})),
    ] {
        let (status, body) = request(
            &state,
            method,
            &format!("/v1/self-control/threads/foreign-chat/app-surface{suffix}"),
            body,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_GATEWAY, "{body}");
    }
    let surface = state
        .store
        .latest_app_surface_session("foreign-chat")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(surface.revision, 1);
    assert_eq!(surface.status, AppSurfaceSessionStatus::Active);
    assert!(state
        .store
        .replay_events(None, None, None)
        .await
        .unwrap()
        .is_empty());
    let calls = native.calls.lock().unwrap();
    assert_eq!(calls.len(), 4);
    assert!(calls
        .iter()
        .all(|(method, params)| method == "thread/read" && params["includeTurns"] == false));
}

#[tokio::test]
async fn native_control_surface_owned_unloaded_target_uses_metadata_without_activation() {
    let (state, native) = state(false).await;
    for (method, suffix, body) in [
        (Method::POST, "", surface_body()),
        (Method::GET, "", json!({})),
        (Method::POST, "/presentation", json!({"action":"focus"})),
        (Method::DELETE, "", json!({})),
    ] {
        let (status, body) = request(
            &state,
            method,
            &format!("/v1/self-control/threads/owned-chat/app-surface{suffix}"),
            body,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    let surface = state
        .store
        .latest_app_surface_session("owned-chat")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(surface.status, AppSurfaceSessionStatus::Archived);
    let calls = native.calls.lock().unwrap();
    assert_eq!(calls.len(), 4);
    assert!(calls.iter().all(|(method, params)| method == "thread/read"
        && params == &json!({"threadId":"owned-chat","includeTurns":false})));
}

#[tokio::test]
async fn native_control_surface_rejects_a_mismatched_native_identity() {
    let (state, _) = state(true).await;
    let (status, body) = request(
        &state,
        Method::POST,
        "/v1/self-control/threads/owned-chat/app-surface",
        surface_body(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{body}");
    assert!(state
        .store
        .latest_app_surface_session("owned-chat")
        .await
        .unwrap()
        .is_none());
    assert!(state
        .store
        .replay_events(None, None, None)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn native_control_resume_and_fork_cannot_import_a_foreign_rollout_or_history() {
    for action in ["resume", "fork"] {
        for payload in [
            json!({"path":"/outside/kodex/rollout.jsonl"}),
            json!({"history":[]}),
        ] {
            let (state, native) = state(false).await;
            let (status, body) = request(
                &state,
                Method::POST,
                &format!("/v1/self-control/threads/owned-chat/{action}"),
                json!({"payload":payload}),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{action}: {body}");
            assert!(
                native
                    .calls
                    .lock()
                    .unwrap()
                    .iter()
                    .all(|(method, _)| method == "thread/read"),
                "unsafe imports must never reach a native mutation"
            );
            assert!(state
                .store
                .replay_events(None, None, None)
                .await
                .unwrap()
                .is_empty());
        }
        let (state, native) = state(false).await;
        let (status, body) = request(
            &state,
            Method::POST,
            &format!("/v1/self-control/threads/foreign-chat/{action}"),
            json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_GATEWAY, "{action}: {body}");
        assert_eq!(
            *native.calls.lock().unwrap(),
            vec![(
                "thread/read".into(),
                json!({"threadId":"foreign-chat","includeTurns":false})
            )]
        );
    }
}
