pub mod account;
pub mod approvals;
pub mod capabilities;
pub mod composer_settings;
pub mod events;
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
        store::{NewApproval, NewEvent, Store},
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
        let app = build_router(state);

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
        let app = build_router(state);

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
            "/v1/projects",
            "/v1/projects/{projectId}",
            "/v1/threads",
            "/v1/threads/{threadId}",
            "/v1/threads/{threadId}/resume",
            "/v1/threads/{threadId}/fork",
            "/v1/threads/{threadId}/archive",
            "/v1/threads/{threadId}/turns",
            "/v1/threads/{threadId}/turns/{turnId}/steer",
            "/v1/threads/{threadId}/turns/{turnId}/interrupt",
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
    async fn project_create_rejects_relative_cwd() {
        let (state, _) = test_state().await;
        let app = build_router(state);

        for cwd in ["relative", "."] {
            let response = app
                .clone()
                .oneshot(
                    Request::post("/v1/projects")
                        .header("content-type", "application/json")
                        .body(Body::from(json!({"cwd": cwd}).to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
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
        let app = build_router(state);

        let body = json!({
            "projectId": project.id,
            "model": "gpt-5.4",
            "serviceTier": "fast",
            "approvalPolicy": "on-request",
            "approvalsReviewer": "auto_review",
            "sandbox": "workspace-write"
        })
        .to_string();
        let response = app
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
        assert_eq!(requests[0].1["model"], "gpt-5.4");
        assert_eq!(requests[0].1["serviceTier"], "fast");
        assert_eq!(requests[0].1["approvalPolicy"], "on-request");
        assert_eq!(requests[0].1["approvalsReviewer"], "auto_review");
        assert_eq!(requests[0].1["sandbox"], "workspace-write");
        assert_eq!(requests[0].1["persistExtendedHistory"], true);
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
        let completed = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("thread-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: None,
                kind: "codex.notification".to_string(),
                codex_method: Some("turn/completed".to_string()),
                payload: json!({"threadId": "thread-1", "turn": {"id": "turn-1"}}),
            })
            .await
            .unwrap();
        state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("thread-2".to_string()),
                turn_id: Some("turn-2".to_string()),
                item_id: Some("item-2".to_string()),
                kind: "codex.notification".to_string(),
                codex_method: Some("item/agentMessage/delta".to_string()),
                payload: json!({"threadId": "thread-2", "delta": "still streaming"}),
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
        assert_eq!(
            body["threads"][0]["lastCompletedAgentTurnSeq"],
            json!(completed.seq)
        );
        assert_eq!(body["threads"][0]["seenCompletedAgentTurnSeq"], json!(0));
        assert_eq!(body["threads"][0]["unreadCompletedAgentTurn"], json!(true));
        assert_eq!(body["threads"][1]["lastCompletedAgentTurnSeq"], Value::Null);
        assert_eq!(body["threads"][1]["unreadCompletedAgentTurn"], json!(false));

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
        assert_eq!(body["seenCompletedAgentTurnSeq"], json!(completed.seq));

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
        assert_eq!(body["seenCompletedAgentTurnSeq"], json!(completed.seq));

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
        assert_eq!(body["seenCompletedAgentTurnSeq"], json!(completed.seq));

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
        assert_eq!(
            body["threads"][0]["seenCompletedAgentTurnSeq"],
            json!(completed.seq)
        );
        assert_eq!(body["threads"][0]["unreadCompletedAgentTurn"], json!(false));
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
            app.oneshot(
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
            json!({"threadId": "thread-1", "input": [{"type": "text", "text": "default"}]})
        );
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
    async fn event_replay_returns_persisted_events() {
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
                Request::get("/v1/events?threadId=t1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["events"].as_array().unwrap().len(), 1);
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
                    kind: "codex.notification".to_string(),
                    codex_method: Some("item/agentMessage/delta".to_string()),
                    payload: json!({
                        "threadId": "t1",
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
                        kind: "codex.notification".to_string(),
                        codex_method: Some("item/agentMessage/delta".to_string()),
                        payload: json!({
                            "threadId": "t1",
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
                kind: "codex.notification".to_string(),
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
    async fn sse_replays_persisted_events_before_live_events() {
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
        let first = next_sse_chunk(&mut body).await;
        assert!(first.contains(&format!("id: {}", replay.seq)));
        assert!(first.contains("\"phase\":\"replay\""));

        let live = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("t1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "codex.notification".to_string(),
                codex_method: Some("item/agentMessage/delta".to_string()),
                payload: json!({"threadId": "t1", "phase": "live"}),
            })
            .await
            .unwrap();
        state.events.send(replay.clone()).unwrap();
        state.events.send(live.clone()).unwrap();

        let second = next_sse_chunk(&mut body).await;
        assert!(second.contains(&format!("id: {}", live.seq)));
        assert!(second.contains("\"phase\":\"live\""));
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
