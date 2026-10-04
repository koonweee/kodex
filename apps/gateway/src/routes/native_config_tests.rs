use std::sync::Arc;

use axum::{
    body::{to_bytes, Body},
    http::{Method, Request, StatusCode},
};
use serde_json::{json, Value};
use tower::ServiceExt;

use crate::{
    api::{build_router, AppState},
    app_server::tests::RecordingAppServer,
    config::Config,
    store::Store,
};

async fn state() -> (AppState, Arc<RecordingAppServer>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::default();
    config.codex.home = std::fs::canonicalize(dir.path()).unwrap();
    let native = Arc::new(RecordingAppServer::default());
    let state = AppState::new(config, Store::in_memory().await.unwrap(), native.clone());
    (state, native, dir)
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
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes))),
    )
}

fn target(state: &AppState, version: &str) -> Value {
    json!({"filePath":state.config.codex.home.join("config.toml"),"version":version})
}

#[tokio::test]
async fn native_config_writes_require_the_displayed_versioned_target() {
    let (state, native, _dir) = state().await;
    let (status, _) = request(
        &state,
        Method::PATCH,
        "/v1/composer-settings",
        json!({"model":"gpt-6"}),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(native.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn native_config_rejects_a_write_outside_the_owned_home() {
    let (state, native, _dir) = state().await;
    let (status, _) = request(
        &state,
        Method::PATCH,
        "/v1/composer-settings",
        json!({
            "writeTarget":{"filePath":"/unowned/config.toml","version":"v1"}, "model":"gpt-6"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(native.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn native_config_read_uses_the_highest_priority_user_profile_layer() {
    let (state, native, _dir) = state().await;
    let file = state.config.codex.home.join("review.config.toml");
    *native.next_response.lock().unwrap() = Some(json!({
        "config":{"model":"gpt-6"},"origins":{},
        "layers":[
            {"name":{"type":"sessionFlags"},"version":"flags","config":{}},
            {"name":{"type":"user","file":file,"profile":"review"},"version":"profile-version","config":{}},
            {"name":{"type":"user","file":state.config.codex.home.join("config.toml")},"version":"base-version","config":{}}
        ]
    }));
    let (status, body) = request(&state, Method::GET, "/v1/composer-settings", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["writeTarget"],
        json!({"filePath":file,"version":"profile-version"})
    );
}

#[tokio::test]
async fn native_config_mcp_patch_forwards_only_changed_native_leaves() {
    let (state, native, _dir) = state().await;
    native.queued_responses.lock().unwrap().extend([
        json!({"status":"ok","filePath":state.config.codex.home.join("config.toml"),"version":"v2"}),
        json!({})
    ]);
    let (status, _) = request(&state, Method::PATCH, "/v1/mcp/servers/docs", json!({
        "writeTarget":target(&state,"v1"),
        "edits":[{"keyPath":["url"],"value":"https://new.example/mcp"},{"keyPath":["http_headers","X.Custom"],"value":null}]
    })).await;
    assert_eq!(status, StatusCode::OK);
    let requests = native.requests.lock().unwrap();
    assert_eq!(requests[0].0, "config/batchWrite");
    assert_eq!(requests[0].1["expectedVersion"], "v1");
    assert_eq!(
        requests[0].1["edits"],
        json!([
            {"keyPath":"mcp_servers.\"docs\".\"url\"","mergeStrategy":"replace","value":"https://new.example/mcp"},
            {"keyPath":"mcp_servers.\"docs\".\"http_headers\".\"X.Custom\"","mergeStrategy":"replace","value":null}
        ])
    );
}

fn saved(state: &AppState, version: &str) -> Value {
    json!({"status":"ok","filePath":state.config.codex.home.join("config.toml"),"version":version})
}

#[tokio::test]
async fn native_config_composer_updates_are_sparse_versioned_and_globally_invalidated() {
    let (state, native, _dir) = state().await;
    *native.next_response.lock().unwrap() = Some(saved(&state, "v2"));
    let (status, body) = request(
        &state,
        Method::PATCH,
        "/v1/composer-settings",
        json!({
            "writeTarget":target(&state,"v1"),"effort":"ultra","serviceTier":null
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["saved"], true);
    assert_eq!(body["write"]["version"], "v2");
    let requests = native.requests.lock().unwrap().clone();
    assert_eq!(
        requests,
        vec![(
            "config/batchWrite".into(),
            json!({
                "filePath":state.config.codex.home.join("config.toml"),"expectedVersion":"v1","reloadUserConfig":true,
                "edits":[
                    {"keyPath":"model_reasoning_effort","mergeStrategy":"replace","value":"ultra"},
                    {"keyPath":"service_tier","mergeStrategy":"replace","value":null}
                ]
            })
        )]
    );
    let events = state.store.replay_events(None, None, None).await.unwrap();
    let config_events = events
        .iter()
        .filter(|event| event.kind == "config.changed")
        .collect::<Vec<_>>();
    assert_eq!(config_events.len(), 1);
    assert_eq!(config_events[0].payload, json!({}));
    assert_eq!(config_events[0].thread_id, None);
    assert!(events.iter().any(|event| event.kind == "skills.changed"));
}

#[tokio::test]
async fn native_config_uneditable_active_profile_never_falls_back_to_base() {
    let (state, native, _dir) = state().await;
    for active in [
        json!({"name":{"type":"user","file":"/unowned/profile.toml","profile":"review"},"version":"profile","config":{}}),
        json!({"name":{"type":"user","file":state.config.codex.home.join("review.toml"),"profile":"review"},"version":"profile","disabledReason":"disabled by policy","config":{}}),
    ] {
        *native.next_response.lock().unwrap() = Some(
            json!({"config":{},"origins":{},"layers":[active,
                {"name":{"type":"user","file":state.config.codex.home.join("config.toml")},"version":"base","config":{}}
            ]}),
        );
        let (status, body) =
            request(&state, Method::GET, "/v1/composer-settings", Value::Null).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["writeTarget"], Value::Null);
    }
    *native.next_response.lock().unwrap() = Some(json!({"config":{},"origins":{},"layers":[]}));
    let (_, body) = request(&state, Method::GET, "/v1/composer-settings", Value::Null).await;
    assert_eq!(body["writeTarget"], Value::Null);
}

#[cfg(unix)]
#[tokio::test]
async fn native_config_profile_symlinks_are_uneditable_and_never_touch_the_target() {
    let (state, native, _dir) = state().await;
    let outside = tempfile::tempdir().unwrap();
    let sentinel = outside.path().join("config.toml");
    std::fs::write(&sentinel, "sentinel = true\n").unwrap();
    for (alias, target_path) in [
        (
            state.config.codex.home.join("profile.toml"),
            sentinel.clone(),
        ),
        (
            state.config.codex.home.join("profiles"),
            outside.path().to_path_buf(),
        ),
    ] {
        std::os::unix::fs::symlink(&target_path, &alias).unwrap();
        let file = if alias.ends_with("profiles") {
            alias.join("config.toml")
        } else {
            alias
        };
        *native.next_response.lock().unwrap() = Some(json!({"config":{},"origins":{},"layers":[
            {"name":{"type":"user","file":file,"profile":"review"},"version":"v1","config":{}}
        ]}));
        let (_, body) = request(&state, Method::GET, "/v1/composer-settings", Value::Null).await;
        assert_eq!(body["writeTarget"], Value::Null);
        native.requests.lock().unwrap().clear();
        let (status, _) = request(
            &state,
            Method::PATCH,
            "/v1/composer-settings",
            json!({
                "writeTarget":{"filePath":file,"version":"v1"},"model":"gpt-6"
            }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(native.requests.lock().unwrap().is_empty());
        assert_eq!(
            std::fs::read_to_string(&sentinel).unwrap(),
            "sentinel = true\n"
        );
    }
}

#[tokio::test]
async fn native_config_mcp_create_toggle_and_delete_do_not_fabricate_effective_servers() {
    let (state, native, _dir) = state().await;
    native.queued_responses.lock().unwrap().extend([
        json!({"config":{"mcp_servers":{}},"origins":{}}),
        saved(&state, "v2"),
        json!({}),
        saved(&state, "v3"),
        json!({}),
        saved(&state, "v4"),
        json!({}),
    ]);
    for (method, path, body) in [
        (
            Method::POST,
            "/v1/mcp/servers",
            json!({"writeTarget":target(&state,"v1"),"name":"docs",
            "transport":{"type":"stdio","command":"mcp-docs","env":{"TOKEN":"secret-token"}},"enabled":true}),
        ),
        (
            Method::PATCH,
            "/v1/mcp/servers/docs/enabled",
            json!({"writeTarget":target(&state,"v2"),"enabled":false}),
        ),
        (
            Method::DELETE,
            "/v1/mcp/servers/docs",
            json!({"writeTarget":target(&state,"v3")}),
        ),
    ] {
        let (status, body) = request(&state, method, path, body).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["saved"], true);
        assert_eq!(body["reload"], json!({"queued":true,"error":null}));
        assert!(body.get("configuredServer").is_none());
        assert!(!body.to_string().contains("secret-token"));
    }
    let requests = native.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 7);
    assert_eq!(requests[0].0, "config/read");
    for (index, version) in [(1, "v1"), (3, "v2"), (5, "v3")] {
        assert_eq!(requests[index].0, "config/batchWrite");
        assert_eq!(requests[index].1["expectedVersion"], version);
        assert_eq!(requests[index].1["reloadUserConfig"], false);
        assert_eq!(
            requests[index + 1],
            ("config/mcpServer/reload".into(), Value::Null)
        );
    }
    assert_eq!(
        requests[1].1["edits"][0]["value"]["env"]["TOKEN"],
        "secret-token"
    );
    assert_eq!(
        requests[3].1["edits"],
        json!([{"keyPath":"mcp_servers.\"docs\".\"enabled\"","mergeStrategy":"replace","value":false}])
    );
    assert_eq!(
        requests[5].1["edits"],
        json!([{"keyPath":"mcp_servers.\"docs\"","mergeStrategy":"replace","value":null}])
    );
    let events = state.store.replay_events(None, None, None).await.unwrap();
    assert_eq!(events.len(), 3);
    assert!(events
        .iter()
        .all(|event| event.kind == "config.changed" && event.payload == json!({})));
}

#[tokio::test]
async fn native_config_mcp_create_rejects_an_existing_effective_server() {
    let (state, native, _dir) = state().await;
    *native.next_response.lock().unwrap() =
        Some(json!({"config":{"mcp_servers":{"docs":{"command":"mcp-docs"}}}}));
    let (status,body) = request(&state,Method::POST,"/v1/mcp/servers",json!({
        "writeTarget":target(&state,"v1"),"name":"docs","transport":{"type":"stdio","command":"other"}
    })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["message"].as_str().unwrap().contains("already exists"));
    assert_eq!(native.requests.lock().unwrap().len(), 1);
    assert!(state
        .store
        .replay_events(None, None, None)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn native_config_mcp_patch_rejects_root_objects_and_escapes_literal_key_segments() {
    let (state, native, _dir) = state().await;
    for edits in [
        json!([]),
        json!([{"keyPath":[],"value":null}]),
        json!([{"keyPath":["env"],"value":{"TOKEN":"new"}}]),
        json!([{"keyPath":["bad\nkey"],"value":"new"}]),
    ] {
        let (status, _) = request(
            &state,
            Method::PATCH,
            "/v1/mcp/servers/docs",
            json!({"writeTarget":target(&state,"v1"),"edits":edits}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    assert!(native.requests.lock().unwrap().is_empty());
    native
        .queued_responses
        .lock()
        .unwrap()
        .extend([saved(&state, "v2"), json!({})]);
    let (status, _) = request(
        &state,
        Method::PATCH,
        "/v1/mcp/servers/docs",
        json!({"writeTarget":target(&state,"v1"),"edits":[
            {"keyPath":["http_headers","X.\"Quoted\\Name"],"value":"new-token"}
        ]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        native.requests.lock().unwrap()[0].1["edits"][0]["keyPath"],
        "mcp_servers.\"docs\".\"http_headers\".\"X.\\\"Quoted\\\\Name\""
    );
}

#[tokio::test]
async fn native_config_conflicts_do_not_reload_publish_or_retry() {
    use crate::error::{ApiError, NativeConfigWriteErrorCode};
    let (state, native, _dir) = state().await;
    for (code, expected_status, expected_code) in [
        (
            NativeConfigWriteErrorCode::ConfigVersionConflict,
            StatusCode::CONFLICT,
            "config_version_conflict",
        ),
        (
            NativeConfigWriteErrorCode::ConfigValidationError,
            StatusCode::BAD_REQUEST,
            "config_write_error",
        ),
    ] {
        native
            .queued_errors
            .lock()
            .unwrap()
            .push(ApiError::NativeConfigWrite(code));
        let (status,body)=request(&state,Method::PATCH,"/v1/mcp/servers/docs",json!({"writeTarget":target(&state,"v1"),"edits":[{"keyPath":["enabled"],"value":false}]})).await;
        assert_eq!(status, expected_status);
        assert_eq!(body["code"], expected_code);
        assert_eq!(body["retryable"], false);
    }
    let requests = native.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests
        .iter()
        .all(|request| request.0 == "config/batchWrite"));
    drop(requests);
    assert!(state
        .store
        .replay_events(None, None, None)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn native_config_overridden_write_hides_effective_secrets_and_preserves_native_result() {
    let (state, native, _dir) = state().await;
    let mut result = saved(&state, "v2");
    result["status"] = json!("okOverridden");
    result["overriddenMetadata"] = json!({
        "effectiveValue":{"Authorization":"secret-token"},"message":"This setting is overridden by a higher-priority layer.",
        "overridingLayer":{"name":{"type":"sessionFlags"},"version":"flags-version"}
    });
    native
        .queued_responses
        .lock()
        .unwrap()
        .extend([result, json!({})]);
    let (status, body) = request(
        &state,
        Method::PATCH,
        "/v1/mcp/servers/docs",
        json!({"writeTarget":target(&state,"v1"),"edits":[{"keyPath":["enabled"],"value":false}]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["write"]["status"], "okOverridden");
    assert_eq!(
        body["write"]["overriddenMetadata"]["overridingLayer"]["kind"],
        "sessionFlags"
    );
    assert_eq!(body["write"]["version"], "v2");
    assert!(body["write"]["overriddenMetadata"]
        .get("effectiveValue")
        .is_none());
    assert!(!body.to_string().contains("secret-token"));
}

struct FailingReloadServer(Arc<RecordingAppServer>);

#[async_trait::async_trait]
impl crate::app_server::AppServer for FailingReloadServer {
    fn is_ready(&self) -> bool {
        true
    }
    fn readiness_error(&self) -> Option<String> {
        None
    }
    async fn request(&self, method: &str, params: Value) -> crate::error::ApiResult<Value> {
        if method == "config/mcpServer/reload" {
            self.0
                .requests
                .lock()
                .unwrap()
                .push((method.into(), params));
            return Err(crate::error::ApiError::BadGateway(
                "private-secret-diagnostic".into(),
            ));
        }
        self.0.request(method, params).await
    }
    async fn respond(&self, id: &str, result: Value) -> crate::error::ApiResult<()> {
        self.0.respond(id, result).await
    }
}

#[tokio::test]
async fn native_config_saved_write_survives_reload_failure_and_still_invalidates_other_clients() {
    let (mut state, native, _dir) = state().await;
    *native.next_response.lock().unwrap() = Some(saved(&state, "v2"));
    state.app_server = Arc::new(FailingReloadServer(native.clone()));
    let mut other_client = state.events.subscribe();
    let (status, body) = request(
        &state,
        Method::PATCH,
        "/v1/mcp/servers/docs",
        json!({"writeTarget":target(&state,"v1"),"edits":[{"keyPath":["enabled"],"value":false}]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["saved"], true);
    assert_eq!(body["write"]["version"], "v2");
    assert_eq!(body["reload"]["queued"], false);
    assert!(body["reload"]["error"].as_str().unwrap().contains("saved"));
    assert!(!body.to_string().contains("private-secret-diagnostic"));
    let event = other_client.try_recv().unwrap();
    assert_eq!(event.kind, "config.changed");
    assert_eq!(event.payload, json!({}));
    assert_eq!(native.requests.lock().unwrap().len(), 2);
    assert_eq!(
        state
            .store
            .replay_events(None, None, None)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn native_config_mcp_saved_write_is_reported_when_event_storage_fails_and_reload_still_runs()
{
    let (state, native, _dir) = state().await;
    native
        .queued_responses
        .lock()
        .unwrap()
        .extend([saved(&state, "v2"), json!({})]);
    state.store.pool().close().await;
    let (status, body) = request(
        &state,
        Method::PATCH,
        "/v1/mcp/servers/docs",
        json!({
            "writeTarget":target(&state,"v1"),"edits":[{"keyPath":["enabled"],"value":false}]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["saved"], true);
    assert_eq!(body["write"]["version"], "v2");
    assert!(body["notificationError"]
        .as_str()
        .unwrap()
        .contains("saved"));
    assert_eq!(body["reload"], json!({"queued":true,"error":null}));
    let requests = native.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].0, "config/batchWrite");
    assert_eq!(requests[1].0, "config/mcpServer/reload");
}

#[tokio::test]
async fn native_config_composer_saved_write_is_reported_when_skills_event_fails() {
    let (state, native, _dir) = state().await;
    *native.next_response.lock().unwrap() = Some(saved(&state, "v2"));
    sqlx::query("CREATE TRIGGER reject_skills BEFORE INSERT ON events WHEN NEW.kind = 'skills.changed' BEGIN SELECT RAISE(FAIL, 'private failure detail'); END")
        .execute(state.store.pool()).await.unwrap();
    let (status, body) = request(
        &state,
        Method::PATCH,
        "/v1/composer-settings",
        json!({
            "writeTarget":target(&state,"v1"),"model":"gpt-6"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["saved"], true);
    assert!(body["notificationError"]
        .as_str()
        .unwrap()
        .contains("saved"));
    assert!(!body.to_string().contains("private failure detail"));
    let events = state.store.replay_events(None, None, None).await.unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, "config.changed");
    assert_eq!(native.requests.lock().unwrap().len(), 1);
}
