use std::{
    convert::Infallible,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use axum::{body::Body, http::Request, response::Response, routing::get, Json, Router};
use http_body_util::BodyExt;
use serde_json::json;
use tokio::{
    sync::{Notify, RwLock},
    time::timeout,
};
use tower::ServiceExt;

use super::{ExecutorRecord, ExecutorStatus, SUPPORTED_EXECUTOR_API_VERSION};
use crate::{config, primary_router};

#[derive(Clone)]
struct TestCapabilities {
    instance_id: &'static str,
    api_version: &'static str,
    ready: bool,
    native_matches: bool,
}

fn primary_request(builder: axum::http::request::Builder) -> axum::http::request::Builder {
    builder.header("host", "localhost:8787")
}

fn primary_mutation(builder: axum::http::request::Builder) -> axum::http::request::Builder {
    primary_request(builder)
        .header("origin", "http://localhost:8787")
        .header("x-kodex-api-version", crate::trust::FEDERATOR_API_VERSION)
}

async fn response_json(response: axum::response::Response) -> serde_json::Value {
    let body = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&body).unwrap()
}

#[tokio::test]
async fn refresh_reports_readiness_compatibility_replacement_and_offline_state() {
    let capabilities = Arc::new(RwLock::new(TestCapabilities {
        instance_id: "executor-instance",
        api_version: super::SUPPORTED_EXECUTOR_API_VERSION,
        ready: true,
        native_matches: true,
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let executor = Router::new().route(
        "/v1/capabilities",
        get({
            let capabilities = capabilities.clone();
            move || {
                let capabilities = capabilities.clone();
                async move {
                    let capabilities = capabilities.read().await;
                    Json(json!({
                        "gateway": {
                            "apiVersion": capabilities.api_version,
                            "instanceId": capabilities.instance_id
                        },
                        "appServer": {
                            "ready": capabilities.ready,
                            "schemaVersion": "0.160.0",
                            "detectedVersionMatchesSchema": capabilities.native_matches
                        }
                    }))
                }
            }
        }),
    );
    let executor_task = tokio::spawn(async move { axum::serve(listener, executor).await.unwrap() });
    let dir = tempfile::tempdir().unwrap();
    let config = config::Config {
        data_dir: dir.path().to_path_buf(),
        database_path: dir.path().join("federator.db"),
        ..config::Config::default()
    };
    let (_instance, state) = crate::prepare(&config).await.unwrap();
    let mut changes = state.registry_changes.subscribe();
    let app = primary_router(state, None, config.sandbox_public_url);
    let created = app
        .clone()
        .oneshot(
            primary_mutation(Request::post("/v1/federation/executors"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "displayName": "Status executor",
                        "baseUrl": format!("http://{address}")
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let created = response_json(created).await;
    let executor_id = created["id"].as_str().unwrap();
    assert_eq!(created["status"], "ready");
    assert_eq!(changes.recv().await.unwrap().generation, Some(1));

    capabilities.write().await.ready = false;
    let unready = app
        .clone()
        .oneshot(
            primary_mutation(Request::post(format!(
                "/v1/federation/executors/{executor_id}/probe"
            )))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unready.status(), axum::http::StatusCode::OK);
    let unready = response_json(unready).await;
    assert_eq!(unready["status"], "unready");
    assert_eq!(unready["generation"], 2);
    assert_eq!(changes.recv().await.unwrap().generation, Some(2));

    {
        let mut capabilities = capabilities.write().await;
        capabilities.ready = true;
        capabilities.api_version = "3";
    }
    let incompatible = app
        .clone()
        .oneshot(
            primary_mutation(Request::post(format!(
                "/v1/federation/executors/{executor_id}/probe"
            )))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    let incompatible = response_json(incompatible).await;
    assert_eq!(incompatible["status"], "incompatible");
    assert_eq!(incompatible["apiVersion"], "3");
    assert_eq!(incompatible["generation"], 3);
    assert_eq!(changes.recv().await.unwrap().generation, Some(3));

    capabilities.write().await.instance_id = "replacement-instance";
    let replacement = app
        .clone()
        .oneshot(
            primary_mutation(Request::post(format!(
                "/v1/federation/executors/{executor_id}/probe"
            )))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    let replacement = response_json(replacement).await;
    assert_eq!(replacement["status"], "unknown");
    assert_eq!(replacement["instanceId"], "executor-instance");
    assert_eq!(replacement["apiVersion"], "3");
    assert_eq!(replacement["generation"], 4);
    assert!(replacement["lastError"]
        .as_str()
        .unwrap()
        .contains("different executor instance"));
    assert_eq!(changes.recv().await.unwrap().generation, Some(4));

    executor_task.abort();
    let offline = app
        .oneshot(
            primary_mutation(Request::post(format!(
                "/v1/federation/executors/{executor_id}/probe"
            )))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    let offline = response_json(offline).await;
    assert_eq!(offline["status"], "unknown");
    assert_eq!(offline["generation"], 4);
    assert!(offline["lastError"]
        .as_str()
        .unwrap()
        .contains("probe failed"));
    assert_eq!(changes.recv().await.unwrap().generation, Some(4));
}

#[tokio::test]
async fn identity_replacement_always_revokes_an_active_unknown_generation() {
    let capabilities = Arc::new(RwLock::new(TestCapabilities {
        instance_id: "original-instance",
        api_version: SUPPORTED_EXECUTOR_API_VERSION,
        ready: true,
        native_matches: true,
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let executor = Router::new()
        .route(
            "/v1/capabilities",
            get({
                let capabilities = capabilities.clone();
                move || {
                    let capabilities = capabilities.clone();
                    async move {
                        let capabilities = capabilities.read().await;
                        Json(json!({
                            "gateway": {
                                "apiVersion": capabilities.api_version,
                                "instanceId": capabilities.instance_id
                            },
                            "appServer": {
                                "ready": capabilities.ready,
                                "schemaVersion": "0.160.0",
                                "detectedVersionMatchesSchema": capabilities.native_matches
                            }
                        }))
                    }
                }
            }),
        )
        .route(
            "/v1/events",
            get(|| async {
                let stream = async_stream::stream! {
                    yield Ok::<_, Infallible>("data: connected\n\n");
                    std::future::pending::<()>().await;
                };
                Response::builder()
                    .header("content-type", "text/event-stream")
                    .header("x-kodex-api-version", "4")
                    .body(Body::from_stream(stream))
                    .unwrap()
            }),
        );
    let executor_task = tokio::spawn(async move { axum::serve(listener, executor).await.unwrap() });
    let dir = tempfile::tempdir().unwrap();
    let config = config::Config {
        data_dir: dir.path().to_path_buf(),
        database_path: dir.path().join("federator.db"),
        ..config::Config::default()
    };
    let (_instance, state) = crate::prepare(&config).await.unwrap();
    state
        .store
        .insert_executor(&ExecutorRecord {
            id: "executor-1".to_string(),
            generation: 1,
            display_name: "Executor".to_string(),
            base_url: format!("http://{address}"),
            instance_id: "original-instance".to_string(),
            api_version: SUPPORTED_EXECUTOR_API_VERSION.to_string(),
            app_server_schema_version: "0.160.0".to_string(),
            enabled: true,
            status: ExecutorStatus::Unknown,
            last_error: Some("Executor has not been checked since federator restart.".to_string()),
            last_seen_at: 1,
            created_at: 1,
            updated_at: 1,
        })
        .await
        .unwrap();
    let app = primary_router(state, None, config.sandbox_public_url);
    let stream = app
        .clone()
        .oneshot(
            primary_request(Request::get("/v1/executors/executor-1/events"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mut stream = stream.into_body();
    assert_eq!(
        stream.frame().await.unwrap().unwrap().into_data().unwrap(),
        "data: connected\n\n"
    );

    capabilities.write().await.instance_id = "replacement-instance";
    let replacement = app
        .oneshot(
            primary_mutation(Request::post("/v1/federation/executors/executor-1/probe"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let replacement = response_json(replacement).await;
    assert_eq!(replacement["status"], "unknown");
    assert_eq!(replacement["generation"], 2);
    let frame = timeout(Duration::from_secs(1), stream.frame())
        .await
        .expect("identity replacement revokes the active stream")
        .expect("generation fence reports the replacement");
    assert!(frame.is_err());
    executor_task.abort();
}

#[tokio::test]
async fn concurrent_metadata_probes_are_serialized_per_executor() {
    let calls = Arc::new(AtomicUsize::new(0));
    let first_entered = Arc::new(Notify::new());
    let release_first = Arc::new(Notify::new());
    let second_entered = Arc::new(Notify::new());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let executor = Router::new().route(
        "/v1/capabilities",
        get({
            let calls = calls.clone();
            let first_entered = first_entered.clone();
            let release_first = release_first.clone();
            let second_entered = second_entered.clone();
            move || {
                let calls = calls.clone();
                let first_entered = first_entered.clone();
                let release_first = release_first.clone();
                let second_entered = second_entered.clone();
                async move {
                    match calls.fetch_add(1, Ordering::SeqCst) {
                        1 => {
                            first_entered.notify_one();
                            release_first.notified().await;
                        }
                        2 => second_entered.notify_one(),
                        _ => {}
                    }
                    Json(json!({
                        "gateway": {"apiVersion": "4", "instanceId": "executor-instance"},
                        "appServer": {
                            "ready": true,
                            "schemaVersion": "0.160.0",
                            "detectedVersionMatchesSchema": true
                        }
                    }))
                }
            }
        }),
    );
    let executor_task = tokio::spawn(async move { axum::serve(listener, executor).await.unwrap() });
    let dir = tempfile::tempdir().unwrap();
    let config = config::Config {
        data_dir: dir.path().to_path_buf(),
        database_path: dir.path().join("federator.db"),
        ..config::Config::default()
    };
    let (_instance, state) = crate::prepare(&config).await.unwrap();
    let app = primary_router(state, None, config.sandbox_public_url);
    let registered = app
        .clone()
        .oneshot(
            primary_mutation(Request::post("/v1/federation/executors"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "displayName": "Executor",
                        "baseUrl": format!("http://{address}")
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let executor_id = response_json(registered).await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let uri = format!("/v1/federation/executors/{executor_id}/probe");
    let first = tokio::spawn({
        let app = app.clone();
        let uri = uri.clone();
        async move {
            app.oneshot(
                primary_mutation(Request::post(uri))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
        }
    });
    first_entered.notified().await;
    let second = tokio::spawn({
        let app = app.clone();
        let uri = uri.clone();
        async move {
            app.oneshot(
                primary_mutation(Request::post(uri))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
        }
    });
    assert!(
        timeout(Duration::from_millis(50), second_entered.notified())
            .await
            .is_err()
    );
    release_first.notify_one();
    assert_eq!(first.await.unwrap().status(), axum::http::StatusCode::OK);
    second_entered.notified().await;
    let second = response_json(second.await.unwrap()).await;
    assert_eq!(second["generation"], 1);
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    executor_task.abort();
}

#[tokio::test]
async fn probes_for_unknown_executors_do_not_allocate_probe_locks() {
    let dir = tempfile::tempdir().unwrap();
    let config = config::Config {
        data_dir: dir.path().to_path_buf(),
        database_path: dir.path().join("federator.db"),
        ..config::Config::default()
    };
    let (_instance, state) = crate::prepare(&config).await.unwrap();
    let probe_locks = state.executor_probe_locks.clone();
    let app = primary_router(state, None, config.sandbox_public_url);

    for executor_id in ["missing-one", "missing-two"] {
        let response = app
            .clone()
            .oneshot(
                primary_mutation(Request::post(format!(
                    "/v1/federation/executors/{executor_id}/probe"
                )))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::NOT_FOUND);
    }

    assert!(probe_locks.lock().await.is_empty());
}
