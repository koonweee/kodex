pub mod account;
pub mod approvals;
pub mod capabilities;
pub mod composer_settings;
pub mod events;
pub mod file_preview;
pub mod health;
pub mod models;
pub mod projects;
pub mod threads;
pub mod turns;
pub mod uploads;
#[cfg(test)]
mod tests {
    use std::sync::{atomic::Ordering, Arc, Mutex as StdMutex};

    use async_trait::async_trait;
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
    };
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
    use tempfile::tempdir;
    use tokio::sync::Notify;
    use tokio::time::{timeout, Duration};
    use tower::ServiceExt;

    use crate::{
        api::{build_router, AppState},
        app_server::{tests::RecordingAppServer, AppServer, InboundMessage},
        config::Config,
        error::{ApiError, ApiResult},
        events::ingest_inbound,
        queue,
        store::{NewApproval, NewEvent, Store, ThreadComposerSettings, ThreadRuntimeState},
    };

    async fn test_state() -> (AppState, Arc<RecordingAppServer>) {
        let store = Store::in_memory().await.unwrap();
        let app_server = Arc::new(RecordingAppServer::default());
        app_server.ready.store(true, Ordering::SeqCst);
        (
            AppState::new(Config::default(), store, app_server.clone()),
            app_server,
        )
    }

    #[tokio::test]
    async fn health_and_openapi_routes_exist() {
        let (state, _) = test_state().await;
        let app = build_router(state.clone());

        let health = app
            .clone()
            .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);

        let openapi = app
            .oneshot(Request::get("/openapi.json").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(openapi.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn default_routes_do_not_emit_wildcard_cors() {
        let (state, _) = test_state().await;
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::get("/healthz")
                    .header("origin", "https://example.test")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_ne!(
            response
                .headers()
                .get("access-control-allow-origin")
                .and_then(|value| value.to_str().ok()),
            Some("*")
        );
    }

    #[tokio::test]
    async fn shell_routes_report_readiness_capabilities_docs_and_openapi_paths() {
        let (state, app_server) = test_state().await;
        app_server.ready.store(false, Ordering::SeqCst);
        let app = build_router(state);

        let ready = app
            .clone()
            .oneshot(Request::get("/readyz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(ready.status(), StatusCode::OK);
        let ready_body = response_json(ready).await;
        assert_eq!(ready_body["ready"], false);

        let capabilities = app
            .clone()
            .oneshot(
                Request::get("/v1/capabilities")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(capabilities.status(), StatusCode::OK);
        let capabilities_body = response_json(capabilities).await;
        assert_eq!(capabilities_body["gateway"]["sse"], true);
        assert_eq!(capabilities_body["appServer"]["ready"], false);

        let docs = app
            .clone()
            .oneshot(Request::get("/docs").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(docs.status().is_success() || docs.status().is_redirection());

        let openapi = app
            .oneshot(Request::get("/openapi.json").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let openapi = response_json(openapi).await;
        for path in [
            "/healthz",
            "/readyz",
            "/v1/capabilities",
            "/v1/composer-settings",
            "/v1/events",
            "/v1/debug/events",
            "/v1/projects",
            "/v1/projects/{projectId}",
            "/v1/threads",
            "/v1/chats/threads",
            "/v1/threads/pinned",
            "/v1/threads/{threadId}",
            "/v1/threads/{threadId}/resume",
            "/v1/threads/{threadId}/fork",
            "/v1/threads/{threadId}/archive",
            "/v1/threads/{threadId}/pin",
            "/v1/threads/{threadId}/turns",
            "/v1/threads/{threadId}/turns/{turnId}/steer",
            "/v1/threads/{threadId}/turns/{turnId}/interrupt",
            "/v1/threads/{threadId}/queued-inputs",
            "/v1/threads/{threadId}/queued-inputs/{queueId}",
            "/v1/threads/{threadId}/queued-inputs/{queueId}/retry",
            "/v1/threads/{threadId}/queued-inputs/{queueId}/steer",
            "/v1/threads/{threadId}/files/preview",
            "/v1/uploads/images",
            "/v1/approvals",
            "/v1/approvals/{approvalId}",
            "/v1/approvals/{approvalId}/decision",
            "/v1/account",
            "/v1/account/login",
            "/v1/account/login/{loginId}/cancel",
            "/v1/account/logout",
            "/v1/account/rate-limits",
            "/v1/models",
        ] {
            assert!(openapi["paths"].get(path).is_some(), "missing {path}");
        }

        let upload_request_schema = &openapi["paths"]["/v1/uploads/images"]["post"]["requestBody"]
            ["content"]["multipart/form-data"]["schema"];
        let upload_request_schema = if let Some(reference) = upload_request_schema["$ref"].as_str()
        {
            let schema_name = reference.trim_start_matches("#/components/schemas/");
            &openapi["components"]["schemas"][schema_name]
        } else {
            upload_request_schema
        };
        assert_eq!(upload_request_schema["type"], "object");
        assert_eq!(
            upload_request_schema["properties"]["images"]["type"],
            "array"
        );
        assert_eq!(
            upload_request_schema["properties"]["images"]["items"]["type"],
            "string"
        );
        assert_eq!(
            upload_request_schema["properties"]["images"]["items"]["format"],
            "binary"
        );
        assert!(upload_request_schema["required"]
            .as_array()
            .is_some_and(|required| required.iter().any(|value| value == "images")));
        assert!(
            openapi["components"]["schemas"]["QueuedInputStatus"]["enum"]
                .as_array()
                .is_some_and(|values| values.iter().any(|value| value == "pendingCommit"))
        );
        assert_eq!(
            openapi["paths"]["/v1/threads/{threadId}/queued-inputs/{queueId}/steer"]["post"]
                ["responses"]["200"]["content"]["application/json"]["schema"]["$ref"],
            "#/components/schemas/QueuedInputResponse"
        );
        assert_eq!(
            openapi["paths"]["/v1/threads/{threadId}/queued-inputs/{queueId}"]["delete"]
                ["responses"]["200"]["content"]["application/json"]["schema"]["$ref"],
            "#/components/schemas/QueuedInputDeleteResponse"
        );
    }

    #[tokio::test]
    async fn readyz_reports_app_server_incompatibility() {
        let (state, app_server) = test_state().await;
        *app_server.readiness_error.lock().unwrap() = Some(
            "Codex app-server is incompatible: rejected required persistExtendedHistory field"
                .to_string(),
        );
        let app = build_router(state);

        let ready = app
            .oneshot(Request::get("/readyz").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(ready.status(), StatusCode::OK);
        let body = response_json(ready).await;
        assert_eq!(body["ready"], false);
        assert_eq!(
            body["message"],
            "Codex app-server is incompatible: rejected required persistExtendedHistory field"
        );
    }

    #[tokio::test]
    async fn project_create_resolves_relative_cwd_from_home() {
        let (mut state, _) = test_state().await;
        let home = tempdir().unwrap();
        Arc::make_mut(&mut state.config).projects.home_dir = home.path().join(".");
        let cwd = tempfile::Builder::new()
            .prefix("kodex-project-")
            .tempdir_in(home.path())
            .unwrap();
        let relative_cwd = cwd
            .path()
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap()
            .to_string();
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/projects")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"cwd": relative_cwd}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let project = response_json(response).await;
        assert_eq!(
            project["cwd"],
            std::fs::canonicalize(cwd.path())
                .unwrap()
                .to_string_lossy()
                .to_string()
        );
        assert_eq!(project["name"], relative_cwd);
    }

    #[tokio::test]
    async fn project_create_can_create_missing_relative_directory_under_home() {
        let (mut state, _) = test_state().await;
        let home = tempdir().unwrap();
        Arc::make_mut(&mut state.config).projects.home_dir = home.path().to_path_buf();
        let parent = tempfile::Builder::new()
            .prefix("kodex-project-")
            .tempdir_in(home.path())
            .unwrap();
        let relative_cwd = format!(
            "{}/missing-child",
            parent
                .path()
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap()
        );
        let expected_cwd = parent.path().join("missing-child");
        let app = build_router(state);

        let missing = app
            .clone()
            .oneshot(
                Request::post("/v1/projects")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"cwd": relative_cwd}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::BAD_REQUEST);
        assert!(!expected_cwd.exists());

        let created = app
            .oneshot(
                Request::post("/v1/projects")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"cwd": relative_cwd, "createDirectory": true}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::CREATED);
        assert!(expected_cwd.is_dir());
    }

    #[tokio::test]
    async fn project_routes_create_list_get_and_reject_missing_cwd() {
        let (state, _) = test_state().await;
        let cwd = std::env::current_dir().unwrap().display().to_string();
        let app = build_router(state);

        let missing = app
            .clone()
            .oneshot(
                Request::post("/v1/projects")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(!missing.status().is_success());

        let created = app
            .clone()
            .oneshot(
                Request::post("/v1/projects")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"name": "Kodex", "cwd": cwd}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::CREATED);
        let project = response_json(created).await;
        let project_id = project["id"].as_str().unwrap();

        let listed = app
            .clone()
            .oneshot(Request::get("/v1/projects").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let listed = response_json(listed).await;
        assert_eq!(listed["projects"][0]["id"], project_id);

        let fetched = app
            .oneshot(
                Request::get(format!("/v1/projects/{project_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let fetched = response_json(fetched).await;
        assert_eq!(fetched["id"], project_id);
    }

    #[tokio::test]
    async fn thread_start_maps_to_app_server() {
        let (state, app_server) = test_state().await;
        let project = state
            .store
            .create_project(
                "Kodex".to_string(),
                std::env::current_dir().unwrap().display().to_string(),
            )
            .await
            .unwrap();
        let app = build_router(state);

        let body = json!({"projectId": project.id, "payload": {"prompt": "hi"}}).to_string();
        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/threads")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/start");
        assert!(requests[0].1.get("cwd").is_some());
        assert_eq!(requests[0].1["persistExtendedHistory"], true);
    }

    #[tokio::test]
    async fn thread_start_forwards_initial_composer_settings() {
        let (state, app_server) = test_state().await;
        let project = state
            .store
            .create_project(
                "Kodex".to_string(),
                std::env::current_dir().unwrap().display().to_string(),
            )
            .await
            .unwrap();
        *app_server.next_response.lock().unwrap() = Some(json!({
            "thread": {
                "id": "thread-1",
                "cwd": "/workspace",
                "status": {"type": "idle"},
                "source": "cli",
                "preview": "hello",
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_600_i64
            },
            "cwd": "/workspace"
        }));
        let app = build_router(state.clone());

        let body = json!({
            "projectId": project.id,
            "model": "gpt-5.4",
            "effort": "high",
            "serviceTier": "fast",
            "approvalPolicy": "on-request",
            "approvalsReviewer": "auto_review",
            "sandbox": "workspace-write",
            "payload": {
                "prompt": "hi",
                "effort": "xhigh",
                "reasoningEffort": "xhigh"
            }
        })
        .to_string();
        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/threads")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["thread"]["model"], "gpt-5.4");
        assert_eq!(body["thread"]["reasoningEffort"], "high");
        assert_eq!(body["thread"]["serviceTier"], "fast");
        assert_eq!(body["thread"]["approvalPolicy"], "on-request");
        assert_eq!(body["thread"]["approvalsReviewer"], "auto_review");
        assert_eq!(body["thread"]["sandbox"], "workspace-write");

        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [{
                "id": "thread-1",
                "cwd": "/workspace",
                "status": {"type": "idle"},
                "source": "cli",
                "preview": "hello",
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_600_i64
            }],
            "nextCursor": null,
            "backwardsCursor": null
        }));
        let listed = app
            .oneshot(
                Request::get(format!("/v1/threads?projectId={}", project.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(listed.status(), StatusCode::OK);
        let listed = response_json(listed).await;
        assert_eq!(listed["threads"][0]["model"], "gpt-5.4");
        assert_eq!(listed["threads"][0]["reasoningEffort"], "high");
        assert_eq!(listed["threads"][0]["serviceTier"], "fast");
        assert_eq!(listed["threads"][0]["approvalPolicy"], "on-request");
        assert_eq!(listed["threads"][0]["approvalsReviewer"], "auto_review");
        assert_eq!(listed["threads"][0]["sandbox"], "workspace-write");

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/start");
        assert_eq!(requests[0].1["prompt"], "hi");
        assert_eq!(requests[0].1["model"], "gpt-5.4");
        assert!(requests[0].1.get("effort").is_none());
        assert!(requests[0].1.get("reasoningEffort").is_none());
        assert_eq!(requests[0].1["serviceTier"], "fast");
        assert_eq!(requests[0].1["approvalPolicy"], "on-request");
        assert_eq!(requests[0].1["approvalsReviewer"], "auto_review");
        assert_eq!(requests[0].1["sandbox"], "workspace-write");
        assert_eq!(requests[0].1["persistExtendedHistory"], true);
    }

    #[tokio::test]
    async fn chat_thread_start_creates_dated_slug_cwd_and_maps_to_app_server() {
        let (mut state, app_server) = test_state().await;
        let home = tempdir().unwrap();
        Arc::make_mut(&mut state.config).projects.home_dir = home.path().join(".");
        *app_server.next_response.lock().unwrap() = Some(json!({
            "thread": {
                "id": "chat-thread-1",
                "cwd": "/workspace/chat",
                "status": {"type": "idle"},
                "source": "cli",
                "preview": "chat",
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_600_i64
            },
            "cwd": "/workspace/chat"
        }));
        let app = build_router(state);

        let body = json!({
            "firstMessageText": "Build the Chat Sidebar!",
            "model": "gpt-5.4",
            "effort": "high",
            "serviceTier": "fast",
            "approvalPolicy": "on-request",
            "approvalsReviewer": "auto_review",
            "sandbox": "workspace-write"
        })
        .to_string();
        let response = app
            .oneshot(
                Request::post("/v1/chats/threads")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["thread"]["model"], "gpt-5.4");
        assert_eq!(body["thread"]["reasoningEffort"], "high");
        assert_eq!(body["thread"]["serviceTier"], "fast");
        assert_eq!(body["thread"]["approvalPolicy"], "on-request");
        assert_eq!(body["thread"]["approvalsReviewer"], "auto_review");
        assert_eq!(body["thread"]["sandbox"], "workspace-write");
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/start");
        assert!(requests[0].1.get("projectId").is_none());
        assert_eq!(requests[0].1["model"], "gpt-5.4");
        assert!(requests[0].1.get("effort").is_none());
        assert_eq!(requests[0].1["serviceTier"], "fast");
        assert_eq!(requests[0].1["approvalPolicy"], "on-request");
        assert_eq!(requests[0].1["approvalsReviewer"], "auto_review");
        assert_eq!(requests[0].1["sandbox"], "workspace-write");
        assert_eq!(requests[0].1["persistExtendedHistory"], true);
        let cwd = requests[0].1["cwd"].as_str().unwrap();
        let today = chrono::Local::now()
            .date_naive()
            .format("%Y-%m-%d")
            .to_string();
        assert!(cwd.ends_with(&format!(
            "Documents{}Codex{}{}{}build-the-chat-sidebar",
            std::path::MAIN_SEPARATOR,
            std::path::MAIN_SEPARATOR,
            today,
            std::path::MAIN_SEPARATOR
        )));
        assert!(std::path::Path::new(cwd).is_dir());
    }

    #[tokio::test]
    async fn chat_thread_list_filters_threads_under_chat_root() {
        let (mut state, app_server) = test_state().await;
        let home = tempdir().unwrap();
        Arc::make_mut(&mut state.config).projects.home_dir = home.path().to_path_buf();
        let chat_cwd = home
            .path()
            .join("Documents")
            .join("Codex")
            .join("2026-05-05")
            .join("chat-thread");
        std::fs::create_dir_all(&chat_cwd).unwrap();
        let chat_cwd = std::fs::canonicalize(chat_cwd).unwrap();
        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [
                {
                    "id": "chat-thread",
                    "cwd": chat_cwd,
                    "status": {"type": "idle"},
                    "source": "local",
                    "preview": "chat",
                    "createdAt": 1_767_225_600_i64,
                    "updatedAt": 1_767_225_700_i64
                },
                {
                    "id": "project-thread",
                    "cwd": "/workspace/project",
                    "status": {"type": "idle"},
                    "source": "local",
                    "preview": "project",
                    "createdAt": 1_767_225_600_i64,
                    "updatedAt": 1_767_225_700_i64
                }
            ],
            "nextCursor": null,
            "backwardsCursor": null
        }));
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::get("/v1/chats/threads")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["threads"].as_array().unwrap().len(), 1);
        assert_eq!(body["threads"][0]["id"], "chat-thread");
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/list");
        assert!(requests[0].1["cwd"]
            .as_array()
            .unwrap()
            .contains(&Value::String(chat_cwd.to_string_lossy().to_string())));
        assert_eq!(requests[0].1["sortKey"], "updated_at");
    }

    #[tokio::test]
    async fn thread_list_project_filter_maps_to_cwd() {
        let (state, app_server) = test_state().await;
        let cwd = std::env::current_dir().unwrap().display().to_string();
        let project = state
            .store
            .create_project("Kodex".to_string(), cwd.clone())
            .await
            .unwrap();
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::get(format!("/v1/threads?projectId={}", project.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/list");
        assert_eq!(requests[0].1["cwd"], cwd);
    }

    #[tokio::test]
    async fn composer_settings_reads_project_config_and_persists_only_toolbar_defaults() {
        let (state, app_server) = test_state().await;
        let cwd = std::env::current_dir().unwrap().display().to_string();
        let project = state
            .store
            .create_project("Kodex".to_string(), cwd.clone())
            .await
            .unwrap();
        *app_server.next_response.lock().unwrap() = Some(json!({
            "config": {
                "model": "gpt-5.4",
                "model_reasoning_effort": "high",
                "service_tier": "fast",
                "approval_policy": "on-request",
                "approvals_reviewer": "auto_review",
                "sandbox_mode": "workspace-write"
            },
            "origins": {}
        }));
        let app = build_router(state);

        let read = app
            .clone()
            .oneshot(
                Request::get(format!("/v1/composer-settings?projectId={}", project.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(read.status(), StatusCode::OK);
        let body = response_json(read).await;
        assert_eq!(body["model"], "gpt-5.4");
        assert_eq!(body["effort"], "high");
        assert_eq!(body["serviceTier"], "fast");
        assert_eq!(body["permissionsPreset"], "autoReview");

        let write = app
            .oneshot(
                Request::patch("/v1/composer-settings")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "model": "gpt-5.4",
                            "effort": "medium",
                            "serviceTier": null,
                            "permissionsPreset": "fullAccess"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(write.status(), StatusCode::OK);

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(
            requests[0],
            (
                "config/read".to_string(),
                json!({"cwd": cwd, "includeLayers": false})
            )
        );
        assert_eq!(requests[1].0, "config/batchWrite");
        assert_eq!(
            requests[1].1,
            json!({
                "edits": [
                    {"keyPath": "model", "mergeStrategy": "replace", "value": "gpt-5.4"},
                    {"keyPath": "model_reasoning_effort", "mergeStrategy": "replace", "value": "medium"},
                    {"keyPath": "service_tier", "mergeStrategy": "replace", "value": null}
                ]
            })
        );
        assert!(requests[1].1.get("reloadUserConfig").is_none());
    }

    #[tokio::test]
    async fn thread_routes_map_read_resume_fork_and_archive() {
        let (state, app_server) = test_state().await;
        let app = build_router(state);

        assert_ok(
            app.clone()
                .oneshot(
                    Request::get("/v1/threads/thread-1")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/threads/thread-1/resume")
                        .header("content-type", "application/json")
                        .body(Body::from(r#"{"target":"latest"}"#))
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/threads/thread-1/fork")
                        .header("content-type", "application/json")
                        .body(Body::from(r#"{"fromItemId":"item-1"}"#))
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.oneshot(
                Request::post("/v1/threads/thread-1/archive")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
        );

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/read");
        assert_eq!(requests[0].1["threadId"], "thread-1");
        assert_eq!(requests[0].1["includeTurns"], true);
        assert_eq!(requests[1].0, "thread/resume");
        assert_eq!(requests[1].1["threadId"], "thread-1");
        assert_eq!(requests[1].1["persistExtendedHistory"], true);
        assert_eq!(requests[2].0, "thread/fork");
        assert_eq!(requests[2].1["threadId"], "thread-1");
        assert_eq!(requests[2].1["persistExtendedHistory"], true);
        assert_eq!(requests[3].0, "thread/archive");
        assert_eq!(requests[3].1["threadId"], "thread-1");
    }

    #[tokio::test]
    async fn fork_thread_copies_gateway_owned_composer_settings() {
        let (state, app_server) = test_state().await;
        state
            .store
            .save_thread_composer_settings(
                "thread-1",
                &ThreadComposerSettings {
                    model: Some("gpt-5.4-mini".to_string()),
                    reasoning_effort: Some("high".to_string()),
                    service_tier: Some("fast".to_string()),
                    approval_policy: Some("on-request".to_string()),
                    approvals_reviewer: Some("auto_review".to_string()),
                    sandbox: Some(json!({"type": "workspaceWrite", "networkAccess": false, "writableRoots": []})),
                },
            )
            .await
            .unwrap();
        *app_server.next_response.lock().unwrap() = Some(json!({
            "thread": {
                "id": "thread-fork",
                "cwd": "/workspace",
                "status": {"type": "idle"},
                "source": "cli",
                "preview": "hello",
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_600_i64
            },
            "cwd": "/workspace"
        }));
        let app = build_router(state);

        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/fork")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"fromItemId":"item-1"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["thread"]["id"], "thread-fork");
        assert_eq!(body["thread"]["model"], "gpt-5.4-mini");
        assert_eq!(body["thread"]["reasoningEffort"], "high");
        assert_eq!(body["thread"]["serviceTier"], "fast");
        assert_eq!(body["thread"]["approvalPolicy"], "on-request");
        assert_eq!(body["thread"]["approvalsReviewer"], "auto_review");
        assert_eq!(
            body["thread"]["sandbox"],
            json!({"type": "workspaceWrite", "networkAccess": false, "writableRoots": []})
        );

        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [{
                "id": "thread-fork",
                "cwd": "/workspace",
                "status": {"type": "idle"},
                "source": "cli",
                "preview": "hello",
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_600_i64
            }],
            "nextCursor": null,
            "backwardsCursor": null
        }));
        let listed = app
            .oneshot(Request::get("/v1/threads").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(listed.status(), StatusCode::OK);
        let listed = response_json(listed).await;
        assert_eq!(listed["threads"][0]["model"], "gpt-5.4-mini");
        assert_eq!(listed["threads"][0]["reasoningEffort"], "high");
        assert_eq!(listed["threads"][0]["serviceTier"], "fast");
        assert_eq!(listed["threads"][0]["approvalPolicy"], "on-request");
        assert_eq!(listed["threads"][0]["approvalsReviewer"], "auto_review");
        assert_eq!(
            listed["threads"][0]["sandbox"],
            json!({"type": "workspaceWrite", "networkAccess": false, "writableRoots": []})
        );
    }

    #[tokio::test]
    async fn thread_detail_returns_app_server_snapshot_turns_without_gateway_events() {
        let (state, app_server) = test_state().await;
        let app = build_router(state);
        *app_server.next_response.lock().unwrap() = Some(json!({
            "thread": {
                "id": "thread-1",
                "cliVersion": "0.128.0",
                "cwd": "/workspace",
                "ephemeral": false,
                "modelProvider": "openai",
                "preview": "hello",
                "source": "cli",
                "status": {"type": "idle"},
                "turns": [{
                    "id": "turn-1",
                    "status": {"type": "completed"},
                    "startedAt": 1_767_225_600_i64,
                    "completedAt": 1_767_225_610_i64,
                    "items": [
                        {"id": "item-user-1", "type": "userMessage", "content": [{"type": "text", "text": "hello"}]},
                        {"id": "item-agent-1", "type": "agentMessage", "text": "world"}
                    ]
                }],
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_610_i64
            }
        }));

        let response = app
            .oneshot(
                Request::get("/v1/threads/thread-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["thread"]["id"], "thread-1");
        assert_eq!(body["turns"][0]["id"], "turn-1");
        assert_eq!(body["turns"][0]["items"][0]["id"], "item-user-1");
        assert_eq!(body["thread"]["lastCompletedAgentTurnSeq"], 1);
        assert_eq!(body["thread"]["unreadCompletedAgentTurn"], true);
        assert_eq!(body["liveState"], "idle");

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(
            requests[0],
            (
                "thread/read".to_string(),
                json!({"threadId": "thread-1", "includeTurns": true})
            )
        );
    }

    #[tokio::test]
    async fn thread_list_derives_unread_completed_agent_turns_from_persisted_read_state() {
        let (state, app_server) = test_state().await;
        state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("thread-1".to_string()),
                turn_id: Some("legacy-turn".to_string()),
                item_id: None,
                kind: "codex.notification".to_string(),
                codex_method: Some("turn/completed".to_string()),
                payload: json!({"threadId": "thread-1"}),
            })
            .await
            .unwrap();
        let app = build_router(state);

        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [
                thread_summary("thread-1"),
                thread_summary("thread-2")
            ],
            "nextCursor": null,
            "backwardsCursor": null
        }));
        let response = app
            .clone()
            .oneshot(Request::get("/v1/threads").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["threads"][0]["lastCompletedAgentTurnSeq"], Value::Null);
        assert_eq!(body["threads"][0]["seenCompletedAgentTurnSeq"], json!(0));
        assert_eq!(body["threads"][0]["unreadCompletedAgentTurn"], json!(false));
        assert_eq!(body["threads"][1]["lastCompletedAgentTurnSeq"], Value::Null);
        assert_eq!(body["threads"][1]["unreadCompletedAgentTurn"], json!(false));

        let mut list_thread_with_cursor_like_marker = thread_summary("thread-1");
        list_thread_with_cursor_like_marker["lastCompletedAgentTurnSeq"] = json!(129381);
        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [
                list_thread_with_cursor_like_marker
            ],
            "nextCursor": null,
            "backwardsCursor": null
        }));
        let response = app
            .clone()
            .oneshot(Request::get("/v1/threads").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["threads"][0]["lastCompletedAgentTurnSeq"], Value::Null);
        assert_eq!(body["threads"][0]["unreadCompletedAgentTurn"], json!(false));

        *app_server.next_response.lock().unwrap() = Some(json!({
            "thread": thread_summary_with_completed_turns("thread-1", 1)
        }));
        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/seen")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["seenCompletedAgentTurnSeq"], json!(1));

        *app_server.next_response.lock().unwrap() = Some(json!({
            "thread": thread_summary_with_completed_turns("thread-1", 1)
        }));
        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/seen")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["seenCompletedAgentTurnSeq"], json!(1));

        *app_server.next_response.lock().unwrap() = Some(json!({
            "thread": thread_summary_with_completed_turns("thread-1", 1)
        }));
        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/seen")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"seenCompletedAgentTurnSeq":0}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["seenCompletedAgentTurnSeq"], json!(1));

        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [thread_summary("thread-1")],
            "nextCursor": null,
            "backwardsCursor": null
        }));
        let response = app
            .oneshot(Request::get("/v1/threads").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["threads"][0]["seenCompletedAgentTurnSeq"], json!(1));
        assert_eq!(body["threads"][0]["unreadCompletedAgentTurn"], json!(false));
        assert_eq!(body["threads"][0]["lastCompletedAgentTurnSeq"], Value::Null);
    }

    #[tokio::test]
    async fn thread_list_and_detail_overlay_gateway_owned_pin_state() {
        let (state, app_server) = test_state().await;
        let pin = state.store.pin_thread("thread-1").await.unwrap();
        let app = build_router(state);

        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [thread_summary("thread-1"), thread_summary("thread-2")],
            "nextCursor": null,
            "backwardsCursor": null
        }));
        let response = app
            .clone()
            .oneshot(Request::get("/v1/threads").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["threads"][0]["pinnedAt"], json!(pin.pinned_at));
        assert_eq!(body["threads"][1]["pinnedAt"], Value::Null);
        assert_eq!(
            body["rawPayload"]["data"][0]["pinnedAt"],
            json!(pin.pinned_at)
        );

        *app_server.next_response.lock().unwrap() = Some(json!({
            "thread": thread_summary("thread-1")
        }));
        let response = app
            .oneshot(
                Request::get("/v1/threads/thread-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["thread"]["pinnedAt"], json!(pin.pinned_at));
        assert_eq!(
            body["rawPayload"]["thread"]["pinnedAt"],
            json!(pin.pinned_at)
        );
    }

    #[tokio::test]
    async fn pin_routes_persist_broadcast_and_list_pinned_threads() {
        let (state, app_server) = test_state().await;
        let mut receiver = state.events.subscribe();
        let app = build_router(state);

        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/pin")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["threadId"], "thread-1");
        assert!(body["pinnedAt"].is_string());
        let pinned_at = body["pinnedAt"].clone();

        let event = receiver.recv().await.unwrap();
        assert_eq!(event.kind, "thread.pin_updated");
        assert_eq!(event.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(event.payload["threadId"], "thread-1");
        assert_eq!(event.payload["pinnedAt"], pinned_at);

        *app_server.next_response.lock().unwrap() = Some(json!({
            "thread": thread_summary("thread-1")
        }));
        let response = app
            .clone()
            .oneshot(
                Request::get("/v1/threads/pinned")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["threads"].as_array().unwrap().len(), 1);
        assert_eq!(body["threads"][0]["id"], "thread-1");
        assert_eq!(body["threads"][0]["pinnedAt"], pinned_at);

        let mut archived_thread = thread_summary("thread-1");
        archived_thread["archived"] = json!(true);
        *app_server.next_response.lock().unwrap() = Some(json!({
            "thread": archived_thread
        }));
        let response = app
            .clone()
            .oneshot(
                Request::get("/v1/threads/pinned")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["threads"].as_array().unwrap().len(), 0);

        let response = app
            .oneshot(
                Request::delete("/v1/threads/thread-1/pin")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["threadId"], "thread-1");
        assert_eq!(body["pinnedAt"], Value::Null);

        let event = receiver.recv().await.unwrap();
        assert_eq!(event.kind, "thread.pin_updated");
        assert_eq!(event.payload["pinnedAt"], Value::Null);
    }

    #[tokio::test]
    async fn thread_start_requires_stored_project_before_app_server_call() {
        let (state, app_server) = test_state().await;
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/threads")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"projectId":"missing","payload":{"prompt":"hi"}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(app_server.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn file_preview_serves_sniffed_images_and_markdown() {
        let (state, app_server) = test_state().await;
        let dir = tempdir().unwrap();
        let images = [
            (
                dir.path().join("preview-png.local"),
                b"\x89PNG\r\n\x1a\npreview image".as_slice(),
                "image/png",
            ),
            (
                dir.path().join("preview-jpeg.local"),
                b"\xff\xd8\xff\xe0preview image".as_slice(),
                "image/jpeg",
            ),
            (
                dir.path().join("preview-gif.local"),
                b"GIF89apreview image".as_slice(),
                "image/gif",
            ),
            (
                dir.path().join("preview-webp.local"),
                b"RIFF0000WEBPpreview image".as_slice(),
                "image/webp",
            ),
        ];
        for (path, bytes, _) in &images {
            std::fs::write(path, bytes).unwrap();
        }
        let markdown = dir.path().join("notes.md");
        std::fs::write(&markdown, "# Notes\n\nhello").unwrap();
        let markdown_long = dir.path().join("notes.markdown");
        std::fs::write(&markdown_long, "## More\n\nworld").unwrap();
        let app = build_router(state);

        for (path, bytes, content_type) in &images {
            let response = app
                .clone()
                .oneshot(
                    Request::get(file_preview_url("thread-1", path))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers().get("content-type").unwrap(),
                *content_type
            );
            assert_eq!(response.headers().get("cache-control").unwrap(), "private");
            assert_eq!(
                response.headers().get("content-length").unwrap(),
                bytes.len().to_string().as_str()
            );
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            assert_eq!(&body[..], *bytes);
        }

        let response = app
            .clone()
            .oneshot(
                Request::get(file_preview_url("thread-1", &markdown))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get("content-type").unwrap(),
            "text/markdown; charset=utf-8"
        );
        assert_eq!(
            response.headers().get("content-disposition").unwrap(),
            "attachment; filename=\"notes.md\""
        );
        assert_eq!(response.headers().get("cache-control").unwrap(), "private");
        assert_eq!(response_text(response).await, "# Notes\n\nhello");

        let response = app
            .oneshot(
                Request::get(file_preview_url("thread-1", &markdown_long))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get("content-type").unwrap(),
            "text/markdown; charset=utf-8"
        );

        let requests = app_server.requests.lock().unwrap();
        assert!(requests.iter().all(|(method, _)| method == "thread/read"));
    }

    #[tokio::test]
    async fn file_preview_rejects_unknown_unavailable_and_unsupported_targets() {
        let (state, _app_server) = test_state().await;
        let dir = tempdir().unwrap();
        let image = dir.path().join("preview.local");
        std::fs::write(&image, b"\x89PNG\r\n\x1a\npreview image").unwrap();
        let missing = dir.path().join("missing.png");
        let unsupported = dir.path().join("notes.txt");
        std::fs::write(&unsupported, "plain text").unwrap();
        let invalid_markdown = dir.path().join("bad.md");
        std::fs::write(&invalid_markdown, b"\xff\xfe\xfd").unwrap();
        let app = build_router(state);

        for (thread_id, path, expected_status) in [
            ("thread-missing", image.as_path(), StatusCode::NOT_FOUND),
            ("thread-1", missing.as_path(), StatusCode::NOT_FOUND),
            ("thread-1", dir.path(), StatusCode::NOT_FOUND),
            (
                "thread-1",
                unsupported.as_path(),
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ),
            (
                "thread-1",
                invalid_markdown.as_path(),
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::get(file_preview_url(thread_id, path))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected_status, "{path:?}");
        }
    }

    #[tokio::test]
    async fn file_preview_maps_rollout_missing_thread_app_server_error_to_not_found() {
        let store = Store::in_memory().await.unwrap();
        let app_server = Arc::new(MissingRolloutAppServer);
        let state = AppState::new(Config::default(), store, app_server);
        let dir = tempdir().unwrap();
        let image = dir.path().join("preview.local");
        std::fs::write(&image, b"\x89PNG\r\n\x1a\npreview image").unwrap();
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::get(file_preview_url("thread-missing", &image))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn turn_routes_map_start_steer_and_interrupt() {
        let (state, app_server) = test_state().await;
        let app = build_router(state);

        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/threads/thread-1/turns")
                        .header("content-type", "application/json")
                        .body(Body::from(r#"{"input":[{"type":"text","text":"hi"}]}"#))
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/threads/thread-1/turns/turn-1/steer")
                        .header("content-type", "application/json")
                        .body(Body::from(
                            r#"{"input":[{"type":"text","text":"continue"}]}"#,
                        ))
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.oneshot(
                Request::post("/v1/threads/thread-1/turns/turn-1/interrupt")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
        );

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "turn/start");
        assert_eq!(
            requests[0].1,
            json!({"threadId": "thread-1", "input": [{"type": "text", "text": "hi"}]})
        );
        assert_eq!(requests[1].0, "turn/steer");
        assert_eq!(
            requests[1].1,
            json!({
                "threadId": "thread-1",
                "expectedTurnId": "turn-1",
                "input": [{"type": "text", "text": "continue"}],
            })
        );
        assert_eq!(requests[2].0, "turn/interrupt");
        assert_eq!(
            requests[2].1,
            json!({"threadId": "thread-1", "turnId": "turn-1"})
        );
    }

    #[tokio::test]
    async fn turn_start_forwards_only_present_composer_settings() {
        let (state, app_server) = test_state().await;
        let app = build_router(state);

        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/threads/thread-1/turns")
                        .header("content-type", "application/json")
                        .body(Body::from(
                            r#"{
                                "input":[{"type":"text","text":"hi"}],
                                "model":"gpt-5.4",
                                "effort":"high",
                                "serviceTier":"fast",
                                "approvalPolicy":"never",
                                "approvalsReviewer":"user",
                                "sandboxPolicy":{"type":"dangerFullAccess"}
                            }"#,
                        ))
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/threads/thread-1/turns")
                        .header("content-type", "application/json")
                        .body(Body::from(
                            r#"{
                                "input":[{"type":"text","text":"changed"}],
                                "model":"gpt-5.4-mini",
                                "effort":"medium",
                                "approvalPolicy":"on-request",
                                "approvalsReviewer":"auto_review",
                                "sandboxPolicy":{"type":"workspaceWrite","networkAccess":false,"writableRoots":[]}
                            }"#,
                        ))
                        .unwrap(),
                )
                .await
                .unwrap(),
        );

        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [{
                "id": "thread-1",
                "cwd": "/workspace",
                "status": {"type": "idle"},
                "source": "cli",
                "model": "gpt-5.4",
                "reasoningEffort": "high",
                "serviceTier": "fast",
                "approvalPolicy": "never",
                "approvalsReviewer": "user",
                "sandbox": {"type": "dangerFullAccess"},
                "preview": "hello",
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_600_i64
            }],
            "nextCursor": null,
            "backwardsCursor": null
        }));
        let listed = app
            .clone()
            .oneshot(Request::get("/v1/threads").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(listed.status(), StatusCode::OK);
        let listed = response_json(listed).await;
        assert_eq!(listed["threads"][0]["model"], "gpt-5.4-mini");
        assert_eq!(listed["threads"][0]["reasoningEffort"], "medium");
        assert!(listed["threads"][0]["serviceTier"].is_null());
        assert_eq!(listed["threads"][0]["approvalPolicy"], "on-request");
        assert_eq!(listed["threads"][0]["approvalsReviewer"], "auto_review");
        assert_eq!(
            listed["threads"][0]["sandbox"],
            json!({"type":"workspaceWrite","networkAccess":false,"writableRoots":[]})
        );
        assert_eq!(listed["threads"][0]["rawPayload"]["model"], "gpt-5.4-mini");
        assert_eq!(
            listed["threads"][0]["rawPayload"]["reasoningEffort"],
            "medium"
        );
        assert!(listed["threads"][0]["rawPayload"]["serviceTier"].is_null());
        assert_eq!(
            listed["threads"][0]["rawPayload"]["approvalPolicy"],
            "on-request"
        );
        assert_eq!(
            listed["threads"][0]["rawPayload"]["approvalsReviewer"],
            "auto_review"
        );
        assert_eq!(
            listed["threads"][0]["rawPayload"]["sandbox"],
            json!({"type":"workspaceWrite","networkAccess":false,"writableRoots":[]})
        );
        assert_eq!(
            listed["rawPayload"]["data"][0]["model"],
            listed["threads"][0]["rawPayload"]["model"]
        );
        assert_eq!(
            listed["rawPayload"]["data"][0]["reasoningEffort"],
            listed["threads"][0]["rawPayload"]["reasoningEffort"]
        );
        assert_eq!(
            listed["rawPayload"]["data"][0]["sandbox"],
            listed["threads"][0]["rawPayload"]["sandbox"]
        );

        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/threads/thread-1/turns")
                        .header("content-type", "application/json")
                        .body(Body::from(
                            r#"{"input":[{"type":"text","text":"default"}]}"#,
                        ))
                        .unwrap(),
                )
                .await
                .unwrap(),
        );

        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [{
                "id": "thread-1",
                "cwd": "/workspace",
                "status": {"type": "idle"},
                "source": "cli",
                "model": "gpt-5.4-mini",
                "reasoningEffort": "medium",
                "serviceTier": "fast",
                "approvalPolicy": "on-request",
                "approvalsReviewer": "auto_review",
                "sandbox": {"type":"workspaceWrite","networkAccess":false,"writableRoots":[]},
                "preview": "hello",
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_600_i64
            }],
            "nextCursor": null,
            "backwardsCursor": null
        }));
        let listed = app
            .oneshot(Request::get("/v1/threads").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(listed.status(), StatusCode::OK);
        let listed = response_json(listed).await;
        assert!(listed["threads"][0]["model"].is_null());
        assert!(listed["threads"][0]["reasoningEffort"].is_null());
        assert!(listed["threads"][0]["serviceTier"].is_null());
        assert!(listed["threads"][0]["approvalPolicy"].is_null());
        assert!(listed["threads"][0]["approvalsReviewer"].is_null());
        assert!(listed["threads"][0]["sandbox"].is_null());
        assert!(listed["threads"][0]["rawPayload"]["model"].is_null());
        assert!(listed["threads"][0]["rawPayload"]["reasoningEffort"].is_null());
        assert!(listed["threads"][0]["rawPayload"]["serviceTier"].is_null());
        assert!(listed["threads"][0]["rawPayload"]["approvalPolicy"].is_null());
        assert!(listed["threads"][0]["rawPayload"]["approvalsReviewer"].is_null());
        assert!(listed["threads"][0]["rawPayload"]["sandbox"].is_null());
        assert!(listed["rawPayload"]["data"][0]["model"].is_null());
        assert!(listed["rawPayload"]["data"][0]["reasoningEffort"].is_null());
        assert!(listed["rawPayload"]["data"][0]["serviceTier"].is_null());
        assert!(listed["rawPayload"]["data"][0]["approvalPolicy"].is_null());
        assert!(listed["rawPayload"]["data"][0]["approvalsReviewer"].is_null());
        assert!(listed["rawPayload"]["data"][0]["sandbox"].is_null());

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(
            requests[0].1,
            json!({
                "threadId": "thread-1",
                "input": [{"type": "text", "text": "hi"}],
                "model": "gpt-5.4",
                "effort": "high",
                "serviceTier": "fast",
                "approvalPolicy": "never",
                "approvalsReviewer": "user",
                "sandboxPolicy": {"type": "dangerFullAccess"}
            })
        );
        assert_eq!(
            requests[1].1,
            json!({
                "threadId": "thread-1",
                "input": [{"type": "text", "text": "changed"}],
                "model": "gpt-5.4-mini",
                "effort": "medium",
                "approvalPolicy": "on-request",
                "approvalsReviewer": "auto_review",
                "sandboxPolicy": {"type":"workspaceWrite","networkAccess":false,"writableRoots":[]}
            })
        );
        assert_eq!(requests[2].0, "thread/list");
        assert_eq!(
            requests[3].1,
            json!({"threadId": "thread-1", "input": [{"type": "text", "text": "default"}]})
        );
        assert_eq!(requests[4].0, "thread/list");
    }

    #[tokio::test]
    async fn rejected_turn_start_does_not_persist_thread_composer_settings() {
        let (state, app_server) = test_state().await;
        let app = build_router(state);

        let rejected = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/turns")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{
                            "input":[{"type":"text","text":"hi"}],
                            "model":"gpt-5.4",
                            "sandboxPolicy":{"type":"unsupported"}
                        }"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(!rejected.status().is_success());

        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [{
                "id": "thread-1",
                "cwd": "/workspace",
                "status": {"type": "idle"},
                "source": "cli",
                "preview": "hello",
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_600_i64
            }],
            "nextCursor": null,
            "backwardsCursor": null
        }));
        let listed = app
            .oneshot(Request::get("/v1/threads").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(listed.status(), StatusCode::OK);
        let listed = response_json(listed).await;
        assert!(listed["threads"][0]["model"].is_null());
        assert!(listed["threads"][0]["sandbox"].is_null());

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0, "thread/list");
    }

    #[tokio::test]
    async fn turn_routes_forward_typed_image_inputs_and_reject_invalid_input() {
        let (state, app_server) = test_state().await;
        let app = build_router(state);

        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/threads/thread-1/turns")
                        .header("content-type", "application/json")
                        .body(Body::from(
                            r#"{"input":[{"type":"text","text":"inspect this"},{"type":"localImage","path":"/tmp/kodex-upload.png"}]}"#,
                        ))
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/threads/thread-1/turns/turn-1/steer")
                        .header("content-type", "application/json")
                        .body(Body::from(
                            r#"{"input":[{"type":"image","url":"https://example.test/image.png"}]}"#,
                        ))
                        .unwrap(),
                )
                .await
                .unwrap(),
        );

        let invalid = app
            .oneshot(
                Request::post("/v1/threads/thread-1/turns")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"input":[{"type":"video","url":"bad"}]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(!invalid.status().is_success());

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0].1,
            json!({
                "threadId": "thread-1",
                "input": [
                    {"type": "text", "text": "inspect this"},
                    {"type": "localImage", "path": "/tmp/kodex-upload.png"}
                ],
            })
        );
        assert_eq!(
            requests[1].1,
            json!({
                "threadId": "thread-1",
                "expectedTurnId": "turn-1",
                "input": [{"type": "image", "url": "https://example.test/image.png"}],
            })
        );
    }

    #[tokio::test]
    async fn queued_input_routes_persist_broadcast_and_replay_operational_events() {
        let (state, _app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: "active".to_string(),
                active_turn_id: Some("turn-1".to_string()),
                updated_at: chrono::Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        let app = build_router(state);

        let created = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/queued-inputs")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"next"}],"model":"gpt-5.4"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::OK);
        let created = response_json(created).await;
        let queue_id = created["queuedInput"]["id"].as_str().unwrap().to_string();
        assert_eq!(created["queuedInput"]["status"], "queued");
        assert_eq!(created["queuedInput"]["options"]["model"], "gpt-5.4");

        let listed = app
            .clone()
            .oneshot(
                Request::get("/v1/threads/thread-1/queued-inputs")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let listed = response_json(listed).await;
        assert_eq!(listed["queuedInputs"].as_array().unwrap().len(), 1);
        assert_eq!(listed["queuedInputs"][0]["id"], queue_id);

        let replay = app
            .clone()
            .oneshot(
                Request::get("/v1/events?threadId=thread-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let replay = response_json(replay).await;
        assert_eq!(replay["events"][0]["kind"], "turn_queue.item_upsert");

        let deleted = app
            .oneshot(
                Request::delete(format!("/v1/threads/thread-1/queued-inputs/{queue_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(deleted.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn queued_input_drains_one_row_when_thread_is_idle() {
        let (state, app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: "idle".to_string(),
                active_turn_id: None,
                updated_at: chrono::Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        let app = build_router(state);

        assert_ok(
            app.oneshot(
                Request::post("/v1/threads/thread-1/queued-inputs")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"drain me"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap(),
        );

        timeout(Duration::from_secs(2), async {
            loop {
                if app_server
                    .requests
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(method, _)| method == "turn/start")
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .filter(|(method, _)| method == "turn/start")
                .count(),
            1
        );
        assert_eq!(
            requests
                .iter()
                .find(|(method, _)| method == "turn/start")
                .unwrap()
                .1,
            json!({
                "threadId": "thread-1",
                "input": [{"type": "text", "text": "drain me"}]
            })
        );
    }

    #[tokio::test]
    async fn queued_input_drainer_claims_only_one_row_per_idle_transition() {
        let (state, app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: "idle".to_string(),
                active_turn_id: None,
                updated_at: chrono::Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        let app = build_router(state);

        for text in ["first", "second"] {
            assert_ok(
                app.clone()
                    .oneshot(
                        Request::post("/v1/threads/thread-1/queued-inputs")
                            .header("content-type", "application/json")
                            .body(Body::from(format!(
                                r#"{{"input":[{{"type":"text","text":"{text}"}}]}}"#
                            )))
                            .unwrap(),
                    )
                    .await
                    .unwrap(),
            );
        }

        timeout(Duration::from_secs(2), async {
            loop {
                let count = app_server
                    .requests
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|(method, _)| method == "turn/start")
                    .count();
                if count == 1 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        tokio::task::yield_now().await;
        assert_eq!(
            app_server
                .requests
                .lock()
                .unwrap()
                .iter()
                .filter(|(method, _)| method == "turn/start")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn active_thread_status_blocks_stale_idle_queue_drain() {
        let (state, app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: "idle".to_string(),
                active_turn_id: None,
                updated_at: chrono::Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        ingest_inbound(
            InboundMessage::Notification {
                method: "thread/status".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "status": {"type": "active", "activeFlags": []}
                }),
            },
            &state,
        )
        .await
        .unwrap();
        let app = build_router(state.clone());

        assert_ok(
            app.oneshot(
                Request::post("/v1/threads/thread-1/queued-inputs")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"input":[{"type":"text","text":"hold"}]}"#))
                    .unwrap(),
            )
            .await
            .unwrap(),
        );
        tokio::task::yield_now().await;

        assert!(app_server
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|(method, _)| method != "turn/start"));
        let runtime = state
            .store
            .get_thread_runtime_state("thread-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(runtime.status, "active");
    }

    #[tokio::test]
    async fn queue_recovery_broadcasts_failed_rows_after_restart() {
        let (state, _) = test_state().await;
        let queued = state
            .store
            .create_queued_input(
                "thread-1",
                vec![crate::app_server_api::UserInput::Text {
                    text: "recover me".to_string(),
                    text_elements: vec![],
                }],
                crate::app_server_api::TurnStartOptions::default(),
            )
            .await
            .unwrap();
        state
            .store
            .claim_next_queued_input("thread-1")
            .await
            .unwrap()
            .unwrap();
        let mut receiver = state.events.subscribe();

        queue::recover_queued_inputs(&state).await.unwrap();

        let event = receiver.recv().await.unwrap();
        assert_eq!(event.kind, queue::QUEUE_UPSERT_EVENT);
        assert_eq!(event.payload["id"], queued.id);
        assert_eq!(event.payload["status"], "failed");
        assert!(event.payload["lastError"]
            .as_str()
            .unwrap()
            .contains("Gateway restarted"));
    }

    #[tokio::test]
    async fn queue_recovery_schedules_existing_queued_rows_for_drain() {
        let (state, app_server) = test_state().await;
        state
            .store
            .create_queued_input(
                "thread-1",
                vec![crate::app_server_api::UserInput::Text {
                    text: "queued before restart".to_string(),
                    text_elements: vec![],
                }],
                crate::app_server_api::TurnStartOptions::default(),
            )
            .await
            .unwrap();

        queue::recover_queued_inputs(&state).await.unwrap();

        timeout(Duration::from_secs(2), async {
            loop {
                if app_server
                    .requests
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(method, _)| method == "turn/start")
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let requests = app_server.requests.lock().unwrap();
        assert!(requests.iter().any(|(method, _)| method == "thread/read"));
        assert!(requests.iter().any(|(method, _)| method == "turn/start"));
    }

    #[tokio::test]
    async fn queue_reconciliation_does_not_overwrite_draining_claim() {
        let (state, app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: "draining".to_string(),
                active_turn_id: None,
                updated_at: chrono::Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        queue::reconcile_thread_runtime_from_app_server(&state, "thread-1")
            .await
            .unwrap();

        let runtime = state
            .store
            .get_thread_runtime_state("thread-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(runtime.status, "draining");
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0, "thread/read");
    }

    #[tokio::test]
    async fn queued_steer_reconciles_active_runtime_without_turn_id() {
        let (state, app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: "active".to_string(),
                active_turn_id: None,
                updated_at: chrono::Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        *app_server.next_response.lock().unwrap() = Some(json!({
            "thread": {
                "id": "thread-1",
                "cliVersion": "0.128.0",
                "cwd": "/workspace",
                "ephemeral": false,
                "modelProvider": "openai",
                "preview": "hello",
                "source": "cli",
                "status": {"type": "active", "activeFlags": []},
                "turns": [{
                    "id": "turn-active",
                    "status": {"type": "running"},
                    "startedAt": 1_767_225_600_i64,
                    "items": []
                }],
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_610_i64
            }
        }));
        let app = build_router(state.clone());
        let created = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/queued-inputs")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"steer me"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::OK);
        let created = response_json(created).await;
        let queue_id = created["queuedInput"]["id"].as_str().unwrap();
        let mut receiver = state.events.subscribe();
        let steered = app
            .clone()
            .oneshot(
                Request::post(format!(
                    "/v1/threads/thread-1/queued-inputs/{queue_id}/steer"
                ))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(steered.status(), StatusCode::OK);
        let steered = response_json(steered).await;
        assert_eq!(steered["queuedInput"]["id"], queue_id);
        assert_eq!(steered["queuedInput"]["status"], "pendingCommit");
        assert_eq!(steered["queuedInput"]["acceptedTurnId"], "turn-active");

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/read");
        assert_eq!(requests[1].0, "turn/steer");
        assert_eq!(requests[1].1["expectedTurnId"], "turn-active");

        timeout(Duration::from_secs(2), async {
            let mut saw_steering = false;
            let mut saw_pending_commit = false;
            loop {
                let event = receiver.recv().await.unwrap();
                if event.kind == queue::QUEUE_DELETE_EVENT && event.payload["id"] == queue_id {
                    panic!("successful steer acceptance must not broadcast queue delete");
                }
                if event.kind == queue::QUEUE_UPSERT_EVENT && event.payload["id"] == queue_id {
                    match event.payload["status"].as_str() {
                        Some("steering") => saw_steering = true,
                        Some("pendingCommit") => {
                            assert!(saw_steering);
                            saw_pending_commit = true;
                        }
                        _ => {}
                    }
                }
                if saw_pending_commit {
                    break;
                }
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn committed_user_message_deletes_matching_pending_steer() {
        let (state, _app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: "active".to_string(),
                active_turn_id: Some("turn-1".to_string()),
                updated_at: chrono::Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        let app = build_router(state.clone());
        let created = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/queued-inputs")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"after tool"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let created = response_json(created).await;
        let queue_id = created["queuedInput"]["id"].as_str().unwrap().to_string();
        let mut receiver = state.events.subscribe();

        let steered = app
            .clone()
            .oneshot(
                Request::post(format!(
                    "/v1/threads/thread-1/queued-inputs/{queue_id}/steer"
                ))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response_json(steered).await["queuedInput"]["status"],
            "pendingCommit"
        );

        ingest_inbound(
            InboundMessage::Notification {
                method: "item/completed".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-user-1",
                    "item": {
                        "id": "item-user-1",
                        "type": "userMessage",
                        "content": [{"type": "text", "text": "after tool"}]
                    }
                }),
            },
            &state,
        )
        .await
        .unwrap();

        timeout(Duration::from_secs(2), async {
            loop {
                let event = receiver.recv().await.unwrap();
                if event.kind == queue::QUEUE_DELETE_EVENT && event.payload["id"] == queue_id {
                    break;
                }
            }
        })
        .await
        .unwrap();
        let listed = app
            .oneshot(
                Request::get("/v1/threads/thread-1/queued-inputs")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(response_json(listed).await["queuedInputs"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn accepted_steer_cannot_be_deleted_by_stale_client() {
        let (state, _app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: "active".to_string(),
                active_turn_id: Some("turn-1".to_string()),
                updated_at: chrono::Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        let app = build_router(state.clone());
        let created = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/queued-inputs")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"after tool"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let created = response_json(created).await;
        let queue_id = created["queuedInput"]["id"].as_str().unwrap().to_string();
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post(format!(
                        "/v1/threads/thread-1/queued-inputs/{queue_id}/steer"
                    ))
                    .body(Body::empty())
                    .unwrap(),
                )
                .await
                .unwrap(),
        );

        let deleted = app
            .clone()
            .oneshot(
                Request::delete(format!("/v1/threads/thread-1/queued-inputs/{queue_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(deleted.status(), StatusCode::BAD_REQUEST);
        let listed = app
            .oneshot(
                Request::get("/v1/threads/thread-1/queued-inputs")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let listed = response_json(listed).await;
        assert_eq!(listed["queuedInputs"][0]["id"], queue_id);
        assert_eq!(listed["queuedInputs"][0]["status"], "pendingCommit");
    }

    #[tokio::test]
    async fn in_flight_steer_cannot_be_deleted_by_stale_client() {
        let (state, _app_server) = test_state().await;
        let queued_input = state
            .store
            .create_queued_input(
                "thread-1",
                vec![crate::app_server_api::UserInput::Text {
                    text: "after tool".to_string(),
                    text_elements: vec![],
                }],
                crate::app_server_api::TurnStartOptions::default(),
            )
            .await
            .unwrap();
        state
            .store
            .claim_queued_input_for_steering("thread-1", &queued_input.id)
            .await
            .unwrap();
        state
            .store
            .delete_queued_input("thread-1", &queued_input.id)
            .await
            .unwrap_err();
        let app = build_router(state.clone());

        let deleted = app
            .oneshot(
                Request::delete(format!(
                    "/v1/threads/thread-1/queued-inputs/{}",
                    queued_input.id
                ))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(deleted.status(), StatusCode::BAD_REQUEST);
        let queued_input = state
            .store
            .get_queued_input("thread-1", &queued_input.id)
            .await
            .unwrap();
        assert_eq!(
            queued_input.status,
            crate::store::QueuedInputStatus::Steering
        );
    }

    #[tokio::test]
    async fn committed_user_message_broadcasts_before_pending_steer_delete() {
        let (state, _app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: "active".to_string(),
                active_turn_id: Some("turn-1".to_string()),
                updated_at: chrono::Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        let app = build_router(state.clone());
        let created = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/queued-inputs")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"after tool"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let created = response_json(created).await;
        let queue_id = created["queuedInput"]["id"].as_str().unwrap().to_string();
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post(format!(
                        "/v1/threads/thread-1/queued-inputs/{queue_id}/steer"
                    ))
                    .body(Body::empty())
                    .unwrap(),
                )
                .await
                .unwrap(),
        );
        let mut receiver = state.events.subscribe();

        ingest_inbound(
            InboundMessage::Notification {
                method: "item/completed".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-user-1",
                    "item": {
                        "id": "item-user-1",
                        "type": "userMessage",
                        "content": [{"type": "text", "text": "after tool"}]
                    }
                }),
            },
            &state,
        )
        .await
        .unwrap();

        let (timeline_event, delete_event) = timeout(Duration::from_secs(2), async {
            let mut timeline_event = None;
            let mut delete_event = None;
            loop {
                let event = receiver.recv().await.unwrap();
                if event.kind == "timeline.item_upsert"
                    && event.item_id.as_deref() == Some("item-user-1")
                {
                    timeline_event = Some(event);
                } else if event.kind == queue::QUEUE_DELETE_EVENT && event.payload["id"] == queue_id
                {
                    assert!(
                        timeline_event.is_some(),
                        "queue delete was broadcast before its committed timeline item"
                    );
                    delete_event = Some(event);
                }
                if let (Some(timeline_event), Some(delete_event)) = (&timeline_event, &delete_event)
                {
                    break (timeline_event.clone(), delete_event.clone());
                }
            }
        })
        .await
        .unwrap();
        assert!(
            timeline_event.seq < delete_event.seq,
            "timeline event should be broadcast before the queue delete that depends on it"
        );
    }

    #[tokio::test]
    async fn idle_thread_status_requeues_unmatched_pending_steer() {
        let (state, _app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: "active".to_string(),
                active_turn_id: Some("turn-1".to_string()),
                updated_at: chrono::Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        let app = build_router(state.clone());
        let created = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/queued-inputs")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"after tool"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let created = response_json(created).await;
        let queue_id = created["queuedInput"]["id"].as_str().unwrap().to_string();
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post(format!(
                        "/v1/threads/thread-1/queued-inputs/{queue_id}/steer"
                    ))
                    .body(Body::empty())
                    .unwrap(),
                )
                .await
                .unwrap(),
        );
        let mut receiver = state.events.subscribe();

        ingest_inbound(
            InboundMessage::Notification {
                method: "thread/status".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "status": {"type": "idle"}
                }),
            },
            &state,
        )
        .await
        .unwrap();

        timeout(Duration::from_secs(2), async {
            let mut saw_thread_status = false;
            loop {
                let event = receiver.recv().await.unwrap();
                if event.kind == "timeline.thread_status" {
                    saw_thread_status = true;
                }
                if event.kind == queue::QUEUE_UPSERT_EVENT && event.payload["id"] == queue_id {
                    assert!(
                        saw_thread_status,
                        "thread status should broadcast before requeued pending steer"
                    );
                    assert_eq!(event.payload["status"], "queued");
                    assert_eq!(event.payload["priority"], "rejectedSteer");
                    break;
                }
            }
        })
        .await
        .unwrap();
        let listed = app
            .oneshot(
                Request::get("/v1/threads/thread-1/queued-inputs")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let listed = response_json(listed).await;
        assert_eq!(listed["queuedInputs"][0]["id"], queue_id);
        assert_eq!(listed["queuedInputs"][0]["status"], "queued");
        assert_eq!(listed["queuedInputs"][0]["priority"], "rejectedSteer");
    }

    #[tokio::test]
    async fn completed_turn_broadcasts_before_pending_steer_requeue_and_drain() {
        let (state, _app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: "active".to_string(),
                active_turn_id: Some("turn-1".to_string()),
                updated_at: chrono::Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        let app = build_router(state.clone());
        let created = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/queued-inputs")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"after tool"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let created = response_json(created).await;
        let queue_id = created["queuedInput"]["id"].as_str().unwrap().to_string();
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post(format!(
                        "/v1/threads/thread-1/queued-inputs/{queue_id}/steer"
                    ))
                    .body(Body::empty())
                    .unwrap(),
                )
                .await
                .unwrap(),
        );
        let mut receiver = state.events.subscribe();

        ingest_inbound(
            InboundMessage::Notification {
                method: "turn/completed".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "turn": {
                        "id": "turn-1",
                        "status": {"type": "completed"},
                        "items": []
                    }
                }),
            },
            &state,
        )
        .await
        .unwrap();

        timeout(Duration::from_secs(2), async {
            let mut saw_turn_upsert = false;
            loop {
                let event = receiver.recv().await.unwrap();
                if event.kind == "timeline.turn_upsert" {
                    saw_turn_upsert = true;
                }
                if event.kind == queue::QUEUE_UPSERT_EVENT && event.payload["id"] == queue_id {
                    assert!(
                        saw_turn_upsert,
                        "turn completion should broadcast before requeued pending steer"
                    );
                    assert_eq!(event.payload["status"], "queued");
                    assert_eq!(event.payload["priority"], "rejectedSteer");
                    break;
                }
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn committed_user_message_matches_only_front_pending_steer() {
        let (state, _app_server) = test_state().await;
        let first = state
            .store
            .create_queued_input(
                "thread-1",
                vec![crate::app_server_api::UserInput::Text {
                    text: "first".to_string(),
                    text_elements: vec![],
                }],
                crate::app_server_api::TurnStartOptions::default(),
            )
            .await
            .unwrap();
        let second = state
            .store
            .create_queued_input(
                "thread-1",
                vec![crate::app_server_api::UserInput::Text {
                    text: "second".to_string(),
                    text_elements: vec![],
                }],
                crate::app_server_api::TurnStartOptions::default(),
            )
            .await
            .unwrap();
        for row in [&first, &second] {
            state
                .store
                .claim_queued_input_for_steering("thread-1", &row.id)
                .await
                .unwrap();
            state
                .store
                .mark_queued_input_pending_commit("thread-1", &row.id, "turn-1", None)
                .await
                .unwrap();
        }

        ingest_inbound(
            InboundMessage::Notification {
                method: "item/completed".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-user-second",
                    "item": {
                        "id": "item-user-second",
                        "type": "userMessage",
                        "content": [{"type": "text", "text": "second"}]
                    }
                }),
            },
            &state,
        )
        .await
        .unwrap();
        let listed = state.store.list_queued_inputs("thread-1").await.unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, first.id);
        assert_eq!(listed[1].id, second.id);

        ingest_inbound(
            InboundMessage::Notification {
                method: "item/completed".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-user-first",
                    "item": {
                        "id": "item-user-first",
                        "type": "userMessage",
                        "content": [{"type": "text", "text": "first"}]
                    }
                }),
            },
            &state,
        )
        .await
        .unwrap();
        let listed = state.store.list_queued_inputs("thread-1").await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, second.id);
        assert_eq!(
            listed[0].status,
            crate::store::QueuedInputStatus::PendingCommit
        );
    }

    #[tokio::test]
    async fn image_upload_accepts_images_and_rejects_non_images() {
        let (mut state, _) = test_state().await;
        let dir = tempdir().unwrap();
        Arc::make_mut(&mut state.config).uploads.dir = dir.path().join("uploads");
        let app = build_router(state);

        let accepted = app
            .clone()
            .oneshot(
                Request::post("/v1/uploads/images")
                    .header(
                        "content-type",
                        "multipart/form-data; boundary=kodexboundary",
                    )
                    .body(Body::from(multipart_body(
                        "image.png",
                        "image/png",
                        b"not really png",
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(accepted.status(), StatusCode::OK);
        let accepted = response_json(accepted).await;
        assert_eq!(accepted["images"].as_array().unwrap().len(), 1);
        let image_path = accepted["images"][0]["path"].as_str().unwrap();
        assert!(image_path.ends_with(".png"));
        assert!(std::path::Path::new(image_path).exists());

        let rejected = app
            .oneshot(
                Request::post("/v1/uploads/images")
                    .header(
                        "content-type",
                        "multipart/form-data; boundary=kodexboundary",
                    )
                    .body(Body::from(multipart_body(
                        "note.txt",
                        "text/plain",
                        b"hello",
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn image_upload_rejects_oversized_images() {
        let (mut state, _) = test_state().await;
        let dir = tempdir().unwrap();
        Arc::make_mut(&mut state.config).uploads.dir = dir.path().join("uploads");
        let app = build_router(state);
        let oversized = vec![b'x'; 10 * 1024 * 1024 + 1];

        let response = app
            .oneshot(
                Request::post("/v1/uploads/images")
                    .header(
                        "content-type",
                        "multipart/form-data; boundary=kodexboundary",
                    )
                    .body(Body::from(multipart_body(
                        "large.png",
                        "image/png",
                        &oversized,
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn turn_and_item_notifications_extract_metadata_and_persist_before_broadcast() {
        let (state, _) = test_state().await;
        let mut receiver = state.events.subscribe();

        ingest_inbound(
            InboundMessage::Notification {
                method: "item/agentMessage/delta".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-1",
                    "delta": "hello"
                }),
            },
            &state,
        )
        .await
        .unwrap();
        ingest_inbound(
            InboundMessage::Notification {
                method: "turn/completed".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turn": {"id": "turn-2"}
                }),
            },
            &state,
        )
        .await
        .unwrap();

        let first_broadcast = receiver.recv().await.unwrap();
        let persisted = state
            .store
            .replay_events(Some(first_broadcast.seq - 1), None, None)
            .await
            .unwrap();
        assert_eq!(persisted[0].id, first_broadcast.id);
        assert_eq!(persisted[0].thread_id.as_deref(), Some("thread-1"));
        assert_eq!(persisted[0].turn_id.as_deref(), Some("turn-1"));
        assert_eq!(persisted[0].item_id.as_deref(), Some("item-1"));

        let mut second_broadcast = receiver.recv().await.unwrap();
        while second_broadcast.codex_method.as_deref() != Some("turn/completed") {
            second_broadcast = receiver.recv().await.unwrap();
        }
        assert_eq!(
            second_broadcast.codex_method.as_deref(),
            Some("turn/completed")
        );
        assert_eq!(second_broadcast.turn_id.as_deref(), Some("turn-2"));
    }

    #[tokio::test]
    async fn app_server_overload_maps_to_retryable_error_response() {
        let store = Store::in_memory().await.unwrap();
        let app_server = Arc::new(RetryableAppServer);
        let state = AppState::new(Config::default(), store, app_server);
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/turns")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"input":[{"type":"text","text":"hi"}]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        let body = response_json(response).await;
        assert_eq!(body["code"], "app_server_retryable");
        assert_eq!(body["retryable"], true);
    }

    #[tokio::test]
    async fn approval_broker_creates_pending_approvals_for_supported_methods() {
        let (state, _) = test_state().await;
        for method in [
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
            "item/permissions/requestApproval",
            "mcpServer/elicitation/request",
            "item/tool/requestUserInput",
        ] {
            ingest_inbound(
                InboundMessage::ServerRequest {
                    request_id: format!("\"{method}\""),
                    method: method.to_string(),
                    params: json!({
                        "threadId": "thread-1",
                        "turnId": "turn-1",
                        "itemId": "item-1"
                    }),
                },
                &state,
            )
            .await
            .unwrap();
        }

        let approvals = state
            .store
            .list_approvals(Some("pending".to_string()), Some("thread-1".to_string()))
            .await
            .unwrap();
        assert_eq!(approvals.len(), 5);

        let events = state.store.replay_events(None, None, None).await.unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == "codex.server_request")
                .count(),
            5
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == "approval.created")
                .count(),
            5
        );
    }

    #[tokio::test]
    async fn unsupported_server_request_emits_warning_without_approval() {
        let (state, _) = test_state().await;
        ingest_inbound(
            InboundMessage::ServerRequest {
                request_id: "\"unsupported\"".to_string(),
                method: "unknown/request".to_string(),
                params: json!({"threadId": "thread-1"}),
            },
            &state,
        )
        .await
        .unwrap();

        assert!(state
            .store
            .list_approvals(None, None)
            .await
            .unwrap()
            .is_empty());
        let events = state.store.replay_events(None, None, None).await.unwrap();
        assert_eq!(events[0].kind, "codex.server_request");
        assert_eq!(events[1].kind, "gateway.warning");
    }

    #[tokio::test]
    async fn approval_decision_sends_one_response_and_emits_resolved_event() {
        let (state, app_server) = test_state().await;
        let approval = state
            .store
            .insert_approval(NewApproval {
                request_id: "\"approval-1\"".to_string(),
                thread_id: Some("thread-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("item-1".to_string()),
                method: "item/commandExecution/requestApproval".to_string(),
                payload: json!({"threadId": "thread-1"}),
            })
            .await
            .unwrap();
        let app = build_router(state.clone());

        let response = app
            .clone()
            .oneshot(
                Request::post(format!("/v1/approvals/{}/decision", approval.id))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"decision":{"decision":"accept"}}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(app_server.responses.lock().unwrap().len(), 1);

        let duplicate = app
            .clone()
            .oneshot(
                Request::post(format!("/v1/approvals/{}/decision", approval.id))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"decision":{"decision":"accept"}}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(duplicate.status(), StatusCode::BAD_REQUEST);
        assert_eq!(app_server.responses.lock().unwrap().len(), 1);

        let unknown = app
            .oneshot(
                Request::post("/v1/approvals/missing/decision")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"decision":{"decision":"accept"}}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unknown.status(), StatusCode::NOT_FOUND);

        let resolved_events = state
            .store
            .replay_events(None, None, Some("thread-1".to_string()))
            .await
            .unwrap()
            .into_iter()
            .filter(|event| event.kind == "approval.resolved")
            .collect::<Vec<_>>();
        assert_eq!(resolved_events.len(), 1);
    }

    #[tokio::test]
    async fn concurrent_approval_decisions_only_send_one_upstream_response() {
        let store = Store::in_memory().await.unwrap();
        let app_server = Arc::new(BlockingRespondAppServer::default());
        app_server.ready.store(true, Ordering::SeqCst);
        let state = AppState::new(Config::default(), store, app_server.clone());
        let approval = state
            .store
            .insert_approval(NewApproval {
                request_id: "\"approval-1\"".to_string(),
                thread_id: Some("thread-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("item-1".to_string()),
                method: "item/commandExecution/requestApproval".to_string(),
                payload: json!({"threadId": "thread-1"}),
            })
            .await
            .unwrap();
        let app = build_router(state);
        let path = format!("/v1/approvals/{}/decision", approval.id);

        let first = tokio::spawn({
            let app = app.clone();
            let path = path.clone();
            async move {
                app.oneshot(
                    Request::post(path)
                        .header("content-type", "application/json")
                        .body(Body::from(r#"{"decision":{"decision":"accept"}}"#))
                        .unwrap(),
                )
                .await
                .unwrap()
            }
        });

        timeout(
            Duration::from_secs(2),
            app_server.respond_started.notified(),
        )
        .await
        .unwrap();

        let duplicate = app
            .oneshot(
                Request::post(path)
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"decision":{"decision":"accept"}}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(duplicate.status(), StatusCode::BAD_REQUEST);
        assert_eq!(app_server.responses.lock().unwrap().len(), 1);

        app_server.release_response.notify_one();
        let first = first.await.unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(app_server.responses.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn approval_decision_validates_payload_before_responding() {
        let (state, app_server) = test_state().await;
        let approval = state
            .store
            .insert_approval(NewApproval {
                request_id: "\"approval-1\"".to_string(),
                thread_id: Some("thread-1".to_string()),
                turn_id: None,
                item_id: None,
                method: "item/commandExecution/requestApproval".to_string(),
                payload: json!({"threadId": "thread-1"}),
            })
            .await
            .unwrap();
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post(format!("/v1/approvals/{}/decision", approval.id))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"decision":{"decision":"bogus"}}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(app_server.responses.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn account_and_model_routes_map_to_app_server_methods() {
        let (state, app_server) = test_state().await;
        let app = build_router(state);

        assert_ok(
            app.clone()
                .oneshot(
                    Request::get("/v1/account?refreshToken=true")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/account/login")
                        .header("content-type", "application/json")
                        .body(Body::from(r#"{}"#))
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/account/login/login-1/cancel")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/account/logout")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.clone()
                .oneshot(
                    Request::get("/v1/account/rate-limits")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.oneshot(
                Request::get("/v1/models?includeHidden=true")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
        );

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "account/read");
        assert_eq!(requests[0].1, json!({"refreshToken": true}));
        assert_eq!(requests[1].0, "account/login/start");
        assert_eq!(requests[1].1, json!({"type": "chatgpt"}));
        assert_eq!(requests[2].0, "account/login/cancel");
        assert_eq!(requests[2].1, json!({"loginId": "login-1"}));
        assert_eq!(requests[3].0, "account/logout");
        assert_eq!(requests[3].1, Value::Null);
        assert_eq!(requests[4].0, "account/rateLimits/read");
        assert_eq!(requests[4].1, Value::Null);
        assert_eq!(requests[5].0, "model/list");
        assert_eq!(requests[5].1, json!({"includeHidden": true}));
    }

    #[tokio::test]
    async fn frontend_critical_routes_return_product_shaped_contracts() {
        let (state, app_server) = test_state().await;
        let cwd = std::env::current_dir().unwrap().display().to_string();
        let app = build_router(state);

        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [{
                "id": "thread-1",
                "cliVersion": "0.128.0",
                "name": "Build gateway",
                "cwd": cwd,
                "ephemeral": false,
                "modelProvider": "openai",
                "preview": "hello",
                "source": "cli",
                "status": {"type": "idle"},
                "turns": [],
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_660_i64
            }],
            "nextCursor": "next-1",
            "backwardsCursor": null
        }));
        let threads = app
            .clone()
            .oneshot(Request::get("/v1/threads").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(threads.status(), StatusCode::OK);
        let threads = response_json(threads).await;
        assert_eq!(threads["threads"][0]["id"], "thread-1");
        assert_eq!(threads["threads"][0]["name"], "Build gateway");
        assert_eq!(threads["threads"][0]["status"], "idle");
        assert_eq!(threads["threads"][0]["createdAt"], 1_767_225_600_i64);
        assert_eq!(threads["threads"][0]["updatedAt"], 1_767_225_660_i64);
        assert!(threads.get("payload").is_none());
        assert!(threads.get("rawPayload").is_some());

        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [
                {
                    "id": "visible",
                    "model": "gpt-5.4",
                    "displayName": "GPT-5.4",
                    "description": "Everyday coding",
                    "hidden": false,
                    "isDefault": true,
                    "defaultReasoningEffort": "medium",
                    "supportedReasoningEfforts": [
                        {"reasoningEffort": "medium", "description": "Balanced"}
                    ],
                    "inputModalities": ["text", "image"]
                },
                {
                    "id": "hidden",
                    "model": "hidden-model",
                    "displayName": "Hidden",
                    "description": "Hidden",
                    "hidden": true,
                    "isDefault": false,
                    "defaultReasoningEffort": "medium",
                    "supportedReasoningEfforts": []
                }
            ],
            "nextCursor": null
        }));
        let models = app
            .clone()
            .oneshot(Request::get("/v1/models").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(models.status(), StatusCode::OK);
        let models = response_json(models).await;
        assert_eq!(models["models"].as_array().unwrap().len(), 1);
        assert_eq!(models["models"][0]["id"], "visible");
        assert!(models.get("payload").is_none());

        *app_server.next_response.lock().unwrap() = Some(json!({
            "requiresOpenaiAuth": false,
            "account": {"type": "chatgpt", "email": "dev@example.test", "planType": "pro"}
        }));
        let account = app
            .clone()
            .oneshot(Request::get("/v1/account").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(account.status(), StatusCode::OK);
        let account = response_json(account).await;
        assert_eq!(account["requiresOpenaiAuth"], false);
        assert_eq!(account["account"]["email"], "dev@example.test");

        *app_server.next_response.lock().unwrap() = Some(json!({
            "rateLimits": {
                "limitId": "codex",
                "limitName": "Codex",
                "primary": {"usedPercent": 15, "resetsAt": 1770000000, "windowDurationMins": 300},
                "secondary": null,
                "credits": {"hasCredits": true, "unlimited": false, "balance": "10"},
                "planType": "pro",
                "rateLimitReachedType": null
            },
            "rateLimitsByLimitId": null
        }));
        let rate_limits = app
            .clone()
            .oneshot(
                Request::get("/v1/account/rate-limits")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(rate_limits.status(), StatusCode::OK);
        let rate_limits = response_json(rate_limits).await;
        assert_eq!(rate_limits["rateLimits"]["limitId"], "codex");
        assert_eq!(rate_limits["rateLimits"]["primary"]["usedPercent"], 15);

        *app_server.next_response.lock().unwrap() = Some(json!({
            "type": "chatgpt",
            "loginId": "login-1",
            "authUrl": "https://example.test/login"
        }));
        let login = app
            .oneshot(
                Request::post("/v1/account/login")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(login.status(), StatusCode::OK);
        let login = response_json(login).await;
        assert_eq!(login["loginType"], "chatgpt");
        assert_eq!(login["loginId"], "login-1");
        assert_eq!(login["authUrl"], "https://example.test/login");
    }

    #[tokio::test]
    async fn product_shaped_response_drift_returns_bad_gateway() {
        let (state, app_server) = test_state().await;
        let app = build_router(state);
        *app_server.next_response.lock().unwrap() = Some(json!({"data": [{"name": "missing id"}]}));

        let response = app
            .oneshot(Request::get("/v1/threads").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(response_json(response).await["code"], "bad_gateway");
    }

    #[tokio::test]
    async fn account_notifications_flow_through_event_stream() {
        let (state, _) = test_state().await;
        for method in [
            "account/login/completed",
            "account/updated",
            "account/rateLimits/updated",
        ] {
            ingest_inbound(
                InboundMessage::Notification {
                    method: method.to_string(),
                    params: json!({"accountId": "acct-1"}),
                },
                &state,
            )
            .await
            .unwrap();
        }

        let methods = state
            .store
            .replay_events(None, None, None)
            .await
            .unwrap()
            .into_iter()
            .map(|event| event.codex_method.unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            methods,
            vec![
                "account/login/completed",
                "account/updated",
                "account/rateLimits/updated"
            ]
        );
    }

    #[tokio::test]
    async fn frontend_static_serving_returns_index_and_api_routes_win() {
        let (mut state, _) = test_state().await;
        let dist = tempdir().unwrap();
        std::fs::write(
            dist.path().join("index.html"),
            "<!doctype html><title>Kodex UI</title><main>Kodex UI</main>",
        )
        .unwrap();
        state.config = Arc::new(Config {
            frontend: crate::config::FrontendConfig {
                dist_dir: Some(dist.path().to_path_buf()),
            },
            ..Config::default()
        });
        let app = build_router(state);

        let root = app
            .clone()
            .oneshot(Request::get("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(root.status(), StatusCode::OK);
        assert!(response_text(root).await.contains("Kodex UI"));

        let fallback = app
            .clone()
            .oneshot(
                Request::get("/threads/thread-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(fallback.status(), StatusCode::OK);
        assert!(response_text(fallback).await.contains("Kodex UI"));

        let health = app
            .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);
        assert_eq!(response_json(health).await["status"], "ok");
    }

    #[tokio::test]
    async fn missing_frontend_build_keeps_api_only_development_working() {
        let (mut state, _) = test_state().await;
        let dist = tempdir().unwrap();
        state.config = Arc::new(Config {
            frontend: crate::config::FrontendConfig {
                dist_dir: Some(dist.path().join("missing")),
            },
            ..Config::default()
        });
        let app = build_router(state);

        let health = app
            .clone()
            .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);

        let fallback = app
            .oneshot(Request::get("/not-an-api").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(fallback.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn event_replay_excludes_timeline_history_and_keeps_operational_events() {
        let (state, _) = test_state().await;
        state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("t1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "codex.notification".to_string(),
                codex_method: Some("turn/completed".to_string()),
                payload: json!({"threadId": "t1"}),
            })
            .await
            .unwrap();
        let approval = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("t1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "approval.created".to_string(),
                codex_method: Some("apply_patch".to_string()),
                payload: json!({"threadId": "t1", "status": "pending"}),
            })
            .await
            .unwrap();
        let warning = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("t1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "gateway.warning".to_string(),
                codex_method: None,
                payload: json!({"threadId": "t1", "message": "careful"}),
            })
            .await
            .unwrap();
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::get("/v1/events?threadId=t1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        let events = body["events"].as_array().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["seq"], approval.seq);
        assert_eq!(events[0]["kind"], "approval.created");
        assert_eq!(events[1]["seq"], warning.seq);
        assert_eq!(events[1]["kind"], "gateway.warning");
    }

    #[tokio::test]
    async fn debug_event_replay_returns_raw_persisted_events() {
        let (state, _) = test_state().await;
        state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("t1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "codex.notification".to_string(),
                codex_method: Some("turn/completed".to_string()),
                payload: json!({"threadId": "t1"}),
            })
            .await
            .unwrap();
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::get("/v1/debug/events?threadId=t1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["events"].as_array().unwrap().len(), 1);
        assert_eq!(body["events"][0]["kind"], "codex.notification");
    }

    #[tokio::test]
    async fn sse_replays_all_persisted_pages_before_live_events() {
        let (state, _) = test_state().await;
        for index in 0..501 {
            state
                .store
                .append_event(NewEvent {
                    project_id: Some("p1".to_string()),
                    thread_id: Some("t1".to_string()),
                    turn_id: None,
                    item_id: None,
                    kind: "gateway.warning".to_string(),
                    codex_method: None,
                    payload: json!({
                        "phase": "replay",
                        "index": index,
                    }),
                })
                .await
                .unwrap();
            if index == 250 {
                state
                    .store
                    .append_event(NewEvent {
                        project_id: Some("p2".to_string()),
                        thread_id: Some("t1".to_string()),
                        turn_id: None,
                        item_id: None,
                        kind: "gateway.warning".to_string(),
                        codex_method: None,
                        payload: json!({
                            "phase": "filtered",
                            "index": index,
                        }),
                    })
                    .await
                    .unwrap();
            }
        }
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::get("/v1/events?projectId=p1&threadId=t1")
                    .header("accept", "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let live = state
            .store
            .append_event(NewEvent {
                project_id: Some("p1".to_string()),
                thread_id: Some("t1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "timeline.item_delta".to_string(),
                codex_method: Some("item/agentMessage/delta".to_string()),
                payload: json!({"threadId": "t1", "phase": "live"}),
            })
            .await
            .unwrap();
        state.events.send(live.clone()).unwrap();

        let mut body = response.into_body();
        for index in 0..500 {
            let chunk = next_sse_chunk(&mut body).await;
            assert!(chunk.contains("\"phase\":\"replay\""));
            assert!(chunk.contains(&format!("\"index\":{index}")));
            assert!(!chunk.contains("\"phase\":\"filtered\""));
            assert!(!chunk.contains("\"phase\":\"live\""));
        }

        let beyond_first_page = next_sse_chunk(&mut body).await;
        assert!(beyond_first_page.contains("\"phase\":\"replay\""));
        assert!(beyond_first_page.contains("\"index\":500"));
        assert!(!beyond_first_page.contains("\"phase\":\"live\""));

        let live_chunk = next_sse_chunk(&mut body).await;
        assert!(live_chunk.contains(&format!("id: {}", live.seq)));
        assert!(live_chunk.contains("\"phase\":\"live\""));
    }

    #[tokio::test]
    async fn sse_skips_persisted_timeline_replay_before_live_events() {
        let (state, _) = test_state().await;
        let replay = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("t1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "codex.notification".to_string(),
                codex_method: Some("turn/completed".to_string()),
                payload: json!({"threadId": "t1", "phase": "replay"}),
            })
            .await
            .unwrap();
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::get("/v1/events?threadId=t1")
                    .header("accept", "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let mut body = response.into_body();

        let live = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("t1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "timeline.item_delta".to_string(),
                codex_method: Some("item/agentMessage/delta".to_string()),
                payload: json!({"threadId": "t1", "phase": "live"}),
            })
            .await
            .unwrap();
        state.events.send(replay.clone()).unwrap();
        state.events.send(live.clone()).unwrap();

        let first = next_sse_chunk(&mut body).await;
        assert!(first.contains(&format!("id: {}", live.seq)));
        assert!(first.contains("\"phase\":\"live\""));
        assert!(!first.contains("\"phase\":\"replay\""));
    }

    #[tokio::test]
    async fn sse_allows_live_thread_title_notifications() {
        let (state, _) = test_state().await;
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::get("/v1/events?threadId=t1")
                    .header("accept", "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let title = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("t1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "codex.notification".to_string(),
                codex_method: Some("thread/nameUpdated".to_string()),
                payload: json!({"threadId": "t1", "threadName": "New title"}),
            })
            .await
            .unwrap();
        state.events.send(title.clone()).unwrap();

        let mut body = response.into_body();
        let chunk = next_sse_chunk(&mut body).await;
        assert!(chunk.contains(&format!("id: {}", title.seq)));
        assert!(chunk.contains("thread/nameUpdated"));
        assert!(chunk.contains("New title"));
    }

    #[tokio::test]
    async fn sse_allows_live_thread_token_usage_notifications() {
        let (state, _) = test_state().await;
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::get("/v1/events?threadId=t1")
                    .header("accept", "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let token_usage = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("t1".to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: None,
                kind: "codex.notification".to_string(),
                codex_method: Some("thread/tokenUsage/updated".to_string()),
                payload: json!({
                    "threadId": "t1",
                    "turnId": "turn-1",
                    "tokenUsage": {
                        "last": {"totalTokens": 20_000},
                        "total": {"totalTokens": 20_000},
                        "modelContextWindow": 28_000
                    }
                }),
            })
            .await
            .unwrap();
        state.events.send(token_usage.clone()).unwrap();

        let mut body = response.into_body();
        let chunk = next_sse_chunk(&mut body).await;
        assert!(chunk.contains(&format!("id: {}", token_usage.seq)));
        assert!(chunk.contains("thread/tokenUsage/updated"));
        assert!(chunk.contains("modelContextWindow"));
    }

    #[tokio::test]
    async fn sse_allows_live_account_rate_limit_notifications() {
        let (state, _) = test_state().await;
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::get("/v1/events")
                    .header("accept", "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let rate_limits = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: None,
                turn_id: None,
                item_id: None,
                kind: "codex.notification".to_string(),
                codex_method: Some("account/rateLimits/updated".to_string()),
                payload: json!({
                    "rateLimits": {
                        "limitId": "codex",
                        "primary": {
                            "usedPercent": 12,
                            "resetsAt": 1_777_750_400_i64,
                            "windowDurationMins": 300
                        },
                        "secondary": {
                            "usedPercent": 25,
                            "resetsAt": 1_778_355_200_i64,
                            "windowDurationMins": 10_080
                        }
                    }
                }),
            })
            .await
            .unwrap();
        state.events.send(rate_limits.clone()).unwrap();

        let mut body = response.into_body();
        let chunk = next_sse_chunk(&mut body).await;
        assert!(chunk.contains(&format!("id: {}", rate_limits.seq)));
        assert!(chunk.contains("account/rateLimits/updated"));
        assert!(chunk.contains("\"usedPercent\":12"));
    }

    async fn response_json(response: axum::response::Response) -> Value {
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    fn thread_summary(id: &str) -> Value {
        json!({
            "id": id,
            "cliVersion": "0.128.0",
            "cwd": "/workspace",
            "ephemeral": false,
            "modelProvider": "openai",
            "preview": "hello",
            "source": "cli",
            "status": {"type": "idle"},
            "turns": [],
            "createdAt": 1_767_225_600_i64,
            "updatedAt": 1_767_225_600_i64
        })
    }

    fn thread_summary_with_completed_turns(id: &str, completed_turns: usize) -> Value {
        let turns = (0..completed_turns)
            .map(|index| {
                json!({
                    "id": format!("turn-{index}"),
                    "status": {"type": "completed"},
                    "items": []
                })
            })
            .collect::<Vec<_>>();
        let mut thread = thread_summary(id);
        thread["turns"] = Value::Array(turns);
        thread
    }

    fn multipart_body(file_name: &str, content_type: &str, bytes: &[u8]) -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(b"--kodexboundary\r\n");
        body.extend_from_slice(
            format!(
                "Content-Disposition: form-data; name=\"images\"; filename=\"{file_name}\"\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(format!("Content-Type: {content_type}\r\n\r\n").as_bytes());
        body.extend_from_slice(bytes);
        body.extend_from_slice(b"\r\n--kodexboundary--\r\n");
        body
    }

    fn file_preview_url(thread_id: &str, path: &std::path::Path) -> String {
        format!(
            "/v1/threads/{thread_id}/files/preview?path={}",
            path.display()
        )
    }

    async fn response_text(response: axum::response::Response) -> String {
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        String::from_utf8(body.to_vec()).unwrap()
    }

    fn assert_ok(response: axum::response::Response) {
        assert_eq!(response.status(), StatusCode::OK);
    }

    async fn next_sse_chunk(body: &mut Body) -> String {
        let frame = timeout(Duration::from_secs(2), body.frame())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let data = frame.into_data().unwrap();
        String::from_utf8(data.to_vec()).unwrap()
    }

    struct RetryableAppServer;

    struct MissingRolloutAppServer;

    #[derive(Default)]
    struct BlockingRespondAppServer {
        ready: std::sync::atomic::AtomicBool,
        responses: StdMutex<Vec<(String, Value)>>,
        respond_started: Notify,
        release_response: Notify,
    }

    #[async_trait]
    impl AppServer for RetryableAppServer {
        fn is_ready(&self) -> bool {
            true
        }

        fn readiness_error(&self) -> Option<String> {
            None
        }

        async fn request(&self, _method: &str, _params: Value) -> ApiResult<Value> {
            Err(ApiError::Retryable("server overloaded".to_string()))
        }

        async fn respond(&self, _request_id: &str, _result: Value) -> ApiResult<()> {
            Ok(())
        }
    }

    #[async_trait]
    impl AppServer for MissingRolloutAppServer {
        fn is_ready(&self) -> bool {
            true
        }

        fn readiness_error(&self) -> Option<String> {
            None
        }

        async fn request(&self, _method: &str, _params: Value) -> ApiResult<Value> {
            Err(ApiError::BadGateway(
                "app-server error -32602: no rollout found for thread id thread-missing"
                    .to_string(),
            ))
        }

        async fn respond(&self, _request_id: &str, _result: Value) -> ApiResult<()> {
            Ok(())
        }
    }

    #[async_trait]
    impl AppServer for BlockingRespondAppServer {
        fn is_ready(&self) -> bool {
            self.ready.load(Ordering::SeqCst)
        }

        fn readiness_error(&self) -> Option<String> {
            None
        }

        async fn request(&self, method: &str, _params: Value) -> ApiResult<Value> {
            Ok(json!({"ok": true, "method": method}))
        }

        async fn respond(&self, request_id: &str, result: Value) -> ApiResult<()> {
            self.responses
                .lock()
                .unwrap()
                .push((request_id.to_string(), result));
            self.respond_started.notify_one();
            self.release_response.notified().await;
            Ok(())
        }
    }
}
