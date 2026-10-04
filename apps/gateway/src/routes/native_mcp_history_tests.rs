use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

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
    store::{AppSurfaceProvider, AppSurfaceSessionUpsert, Store},
};

const THREAD: &str = "widget-history";
const OLDER: &str = "opaque-widget-older";

#[derive(Default)]
struct Native {
    calls: Mutex<Vec<(String, Value)>>,
    loaded: AtomicBool,
}

impl Native {
    fn summary(&self) -> Value {
        json!({
            "id": THREAD, "cwd": "/fixture", "createdAt": 1, "updatedAt": 3,
            "source": "cli", "modelProvider": "openai", "preview": "Widget history",
            "status": {"type": if self.loaded.load(Ordering::SeqCst) { "idle" } else { "notLoaded" }},
            "canAcceptDirectInput": null
        })
    }
}

fn page(older: bool) -> Value {
    let name = if older { "old" } else { "current" };
    json!({
        "data": [{
            "id": format!("turn-{name}"), "status": "completed", "itemsView": "full",
            "startedAt": if older { 1 } else { 2 }, "completedAt": if older { 2 } else { 3 },
            "items": [{
                "id": format!("call-{name}"), "type": "mcpToolCall", "server": "docs", "tool": "view",
                "status": "completed", "arguments": {}, "error": null,
                "appContext": null,
                "mcpAppUi": {"resourceUri": format!("ui://docs/{name}"), "preferredModelDisplayMode": "inline"},
                "result": {"content": [{"type": "text", "text": format!("{name} widget result")}]}
            }]
        }],
        "nextCursor": if older { Value::Null } else { json!(OLDER) },
        "backwardsCursor": null
    })
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
            "thread/read" => Ok(json!({"thread": self.summary()})),
            "thread/turns/list" if params["itemsView"] == "notLoaded" => Ok(json!({
                "data": [{"id": "turn-current", "status": "completed", "itemsView": "notLoaded", "items": []}],
                "nextCursor": null, "backwardsCursor": null
            })),
            "thread/turns/list" if params["itemsView"] == "full" => {
                Ok(page(params["cursor"] == OLDER))
            }
            "thread/resume" => {
                self.loaded.store(true, Ordering::SeqCst);
                Ok(json!({
                    "thread": self.summary(), "cwd": "/fixture", "model": "gpt-5.4", "modelProvider": "openai",
                    "approvalPolicy": "never", "approvalsReviewer": "user", "sandbox": {"type": "dangerFullAccess"},
                    "initialTurnsPage": page(false)
                }))
            }
            _ => Err(ApiError::BadGateway(format!(
                "history must not call MCP or import app resources: {method}"
            ))),
        }
    }

    async fn respond(&self, _: &str, _: Value) -> ApiResult<()> {
        Err(ApiError::BadGateway("unexpected native response".into()))
    }
}

async fn request(state: &AppState, method: Method, suffix: &str) -> Value {
    let response = build_router(state.clone())
        .oneshot(
            Request::builder()
                .method(method)
                .uri(format!("/v1/threads/{THREAD}{suffix}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

fn assert_turns(body: &Value, expected: &[&str]) {
    assert_eq!(
        body["timeline"]["turns"]
            .as_array()
            .unwrap()
            .iter()
            .map(|turn| turn["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        expected
    );
}

fn assert_history_only_calls(native: &Native, resumes: usize) {
    let calls = native.calls.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .filter(|(method, _)| method == "thread/resume")
            .count(),
        resumes
    );
    for (method, params) in calls.iter() {
        assert_eq!(params["threadId"], THREAD);
        match method.as_str() {
            "thread/read" => assert_eq!(params["includeTurns"], false),
            "thread/turns/list" => assert!(matches!(
                params["itemsView"].as_str(),
                Some("full" | "notLoaded")
            )),
            "thread/resume" => assert_eq!(params["excludeTurns"], true),
            _ => panic!("unexpected side effect: {method} {params}"),
        }
    }
    assert!(calls
        .iter()
        .any(|(method, params)| method == "thread/turns/list" && params["cursor"] == OLDER));
}

#[tokio::test]
async fn cold_readonly_widget_history_returns_current_and_older_pages_without_mcp_imports() {
    let native = Arc::new(Native::default());
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    let current = request(&state, Method::GET, "").await;
    assert_eq!(current["thread"]["status"], "notLoaded");
    assert_turns(&current, &["turn-current"]);
    assert_eq!(current["historyPage"]["olderCursor"], OLDER);

    let older = request(
        &state,
        Method::GET,
        &format!("/timeline/pages?cursor={OLDER}"),
    )
    .await;
    assert_turns(&older, &["turn-old", "turn-current"]);
    assert_eq!(older["historyPage"]["hasOlder"], false);
    assert!(!native.loaded.load(Ordering::SeqCst));
    assert_history_only_calls(&native, 0);
    assert!(state
        .store
        .latest_app_surface_session(THREAD)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn reopened_cached_surfaces_survive_current_older_and_attached_history_unchanged() {
    for provider in [AppSurfaceProvider::Mcp, AppSurfaceProvider::Generated] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("gateway.db");
        let store = Store::connect(&path).await.unwrap();
        let original = store
            .upsert_app_surface_session(AppSurfaceSessionUpsert {
                thread_id: THREAD.into(),
                provider,
                title: "Retained latest app".into(),
                resource_uri: Some("ui://retained/latest".into()),
                resource_mime_type: MCP_APP_MIME_TYPE.into(),
                html: "<!doctype html><main>Retained latest app</main>".into(),
                fallback_content: "Retained latest app".into(),
                display_modes: vec!["inline".into()],
                csp: Default::default(),
                permissions: Default::default(),
                grants: Default::default(),
                provenance: json!({"retained": true}),
            })
            .await
            .unwrap();
        let expected = serde_json::to_value(&original).unwrap();
        store.pool().close().await;
        let native = Arc::new(Native::default());
        let state = AppState::new(
            Config::default(),
            Store::connect(&path).await.unwrap(),
            native.clone(),
        );

        for (method, suffix) in [
            (Method::GET, String::new()),
            (Method::GET, format!("/timeline/pages?cursor={OLDER}")),
            (Method::POST, "/attach".into()),
        ] {
            let body = request(&state, method.clone(), &suffix).await;
            assert_eq!(body["thread"]["id"], THREAD);
            if method == Method::GET {
                assert!(!native.loaded.load(Ordering::SeqCst));
            }
            let cached = state
                .store
                .latest_app_surface_session(THREAD)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(serde_json::to_value(cached).unwrap(), expected,
                "history must preserve the complete cached artifact, including its bridge token and revision");
        }
        assert_history_only_calls(&native, 1);
        let public = request(&state, Method::GET, "/app-surface").await;
        assert_eq!(
            public["session"],
            serde_json::to_value(super::app_surfaces::session_dto(original.clone())).unwrap()
        );
        let document = build_router(state.clone())
            .oneshot(
                Request::get(public["session"]["documentUrl"].as_str().unwrap())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(document.status(), StatusCode::OK);
        assert_eq!(
            to_bytes(document.into_body(), usize::MAX).await.unwrap(),
            original.html
        );
        assert_history_only_calls(&native, 1);
        assert!(state
            .store
            .replay_events(None, None, None)
            .await
            .unwrap()
            .iter()
            .all(|event| !event.kind.starts_with("app_surface.")));
    }
}
