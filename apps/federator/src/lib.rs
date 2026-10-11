pub mod config;
pub mod instance;
pub mod proxy;
pub mod registry;
mod static_assets;
pub mod store;

use axum::{routing::get, Json, Router};
use serde::Serialize;
use tokio::sync::{broadcast, watch};
use tower_http::{compression::CompressionLayer, trace::TraceLayer};
use utoipa::{OpenApi, ToSchema};
use utoipa_swagger_ui::SwaggerUi;

#[derive(Clone)]
pub struct State {
    instance_id: String,
    pub(crate) store: store::Store,
    pub(crate) registry_changes: broadcast::Sender<RegistryChange>,
}

#[derive(Debug, Clone)]
pub(crate) struct RegistryChange {
    pub(crate) executor_id: String,
    pub(crate) generation: Option<i64>,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    service: &'static str,
    instance_id: String,
    ready: bool,
}

#[derive(OpenApi)]
#[openapi(
    paths(
        health,
        registry::list_executors,
        registry::get_executor,
        registry::register_executor,
        registry::update_executor,
        registry::delete_executor
    ),
    components(schemas(
        HealthResponse,
        registry::ExecutorRecord,
        registry::ExecutorStatus,
        registry::ExecutorListResponse,
        registry::RegisterExecutorRequest,
        registry::UpdateExecutorRequest,
        registry::ErrorBody
    ))
)]
pub struct ApiDoc;

pub fn federated_openapi() -> serde_json::Value {
    let mut federator =
        serde_json::to_value(ApiDoc::openapi()).expect("federator OpenAPI serializes");
    let executor = serde_json::to_value(kodex_gateway::executor_openapi())
        .expect("executor OpenAPI serializes");

    if let (Some(target), Some(source)) = (
        federator["components"]["schemas"].as_object_mut(),
        executor["components"]["schemas"].as_object(),
    ) {
        for (name, schema) in source {
            target.entry(name.clone()).or_insert_with(|| schema.clone());
        }
    }
    let target_paths = federator["paths"]
        .as_object_mut()
        .expect("federator OpenAPI contains paths");
    for (path, item) in executor["paths"]
        .as_object()
        .expect("executor OpenAPI contains paths")
    {
        if path == "/v1/frontend-updates" {
            continue;
        }
        let Some(suffix) = path.strip_prefix("/v1") else {
            continue;
        };
        let mut item = item.clone();
        let operations = item
            .as_object_mut()
            .expect("OpenAPI path item is an object");
        for method in ["get", "post", "put", "patch", "delete"] {
            let Some(operation) = operations.get_mut(method) else {
                continue;
            };
            let parameters = operation
                .as_object_mut()
                .expect("OpenAPI operation is an object")
                .entry("parameters")
                .or_insert_with(|| serde_json::json!([]))
                .as_array_mut()
                .expect("OpenAPI operation parameters are an array");
            parameters.insert(
                0,
                serde_json::json!({
                    "name": "executorId",
                    "in": "path",
                    "required": true,
                    "schema": { "type": "string" }
                }),
            );
        }
        target_paths.insert(format!("/v1/executors/{{executorId}}{suffix}"), item);
    }
    federator
}

pub fn primary_router(
    state: State,
    frontend_dist: Option<std::path::PathBuf>,
    sandbox_public_url: String,
) -> Router {
    let mut router = Router::new()
        .route("/healthz", get(health))
        .route("/readyz", get(health))
        .merge(registry::router())
        .merge(proxy::router())
        .merge(SwaggerUi::new("/docs").external_url_unchecked("/openapi.json", federated_openapi()))
        .with_state(state);
    if let Some(dist) = frontend_dist {
        router = static_assets::attach_primary(router, dist, sandbox_public_url);
    }
    router
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
}

pub fn sandbox_router(frontend_dist: Option<std::path::PathBuf>) -> Router {
    let router = Router::new().route("/healthz", get(|| async { "ok" }));
    if let Some(dist) = frontend_dist {
        router.route_service(
            "/app-surface-sandbox.html",
            static_assets::sandbox_document(dist),
        )
    } else {
        router
    }
}

#[utoipa::path(
    get,
    path = "/healthz",
    responses((status = 200, body = HealthResponse))
)]
pub(crate) async fn health(
    axum::extract::State(state): axum::extract::State<State>,
) -> Json<HealthResponse> {
    Json(HealthResponse {
        service: "kodex-federator",
        instance_id: state.instance_id,
        ready: state.store.ready().await,
    })
}

pub async fn prepare(
    config: &config::Config,
) -> anyhow::Result<(instance::PreparedInstance, State)> {
    let prepared = instance::prepare(&config.data_dir, &config.database_path)?;
    let store = store::Store::connect(&config.database_path).await?;
    let (registry_changes, _) = broadcast::channel(128);
    let state = State {
        instance_id: prepared.identity.id.to_string(),
        store,
        registry_changes,
    };
    Ok((prepared, state))
}

pub async fn serve(
    primary: tokio::net::TcpListener,
    sandbox: tokio::net::TcpListener,
    state: State,
    frontend_dist: Option<std::path::PathBuf>,
    sandbox_public_url: String,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> anyhow::Result<()> {
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let mut primary_task = tokio::spawn(serve_one(
        primary,
        primary_router(state, frontend_dist.clone(), sandbox_public_url),
        shutdown_rx.clone(),
    ));
    let mut sandbox_task = tokio::spawn(serve_one(
        sandbox,
        sandbox_router(frontend_dist),
        shutdown_rx,
    ));
    tokio::select! {
        result = &mut primary_task => result??,
        result = &mut sandbox_task => result??,
        _ = shutdown => {},
    }
    let _ = shutdown_tx.send(true);
    if !primary_task.is_finished() {
        primary_task.await??;
    }
    if !sandbox_task.is_finished() {
        sandbox_task.await??;
    }
    Ok(())
}

async fn serve_one(
    listener: tokio::net::TcpListener,
    app: Router,
    mut shutdown: watch::Receiver<bool>,
) -> std::io::Result<()> {
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            while !*shutdown.borrow() && shutdown.changed().await.is_ok() {}
        })
        .await
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    use axum::{
        body::Body,
        http::{Request, StatusCode},
        response::IntoResponse,
    };
    use http_body_util::BodyExt;
    use serde_json::json;
    use tower::ServiceExt;

    use super::*;

    #[tokio::test]
    async fn serves_health_and_app_shell_without_codex() {
        let dir = tempfile::tempdir().unwrap();
        let dist = dir.path().join("frontend");
        std::fs::create_dir(&dist).unwrap();
        std::fs::write(
            dist.join("index.html"),
            "<html><head></head><body>Federated Kodex</body></html>",
        )
        .unwrap();
        std::fs::write(
            dist.join("app-surface-sandbox.html"),
            "<main>Sandbox</main>",
        )
        .unwrap();
        let config = config::Config {
            data_dir: dir.path().join("state"),
            database_path: dir.path().join("state/federator.db"),
            frontend_dist: Some(dist.clone()),
            ..config::Config::default()
        };
        let (_instance, state) = prepare(&config).await.unwrap();
        let app = primary_router(state, Some(dist.clone()), config.sandbox_public_url.clone());
        let health = app
            .clone()
            .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(health.status(), 200);
        let body = health.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["service"], "kodex-federator");
        assert_eq!(body["ready"], true);
        let shell = app
            .clone()
            .oneshot(Request::get("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(shell.status(), 200);
        let body = shell.into_body().collect().await.unwrap().to_bytes();
        assert!(String::from_utf8_lossy(&body).contains(
            r#"<meta name="kodex-app-surface-sandbox-url" content="http://localhost:8790/app-surface-sandbox.html">"#
        ));
        for path in [
            "/app-surface-sandbox.html",
            "/%61pp-surface-sandbox.html",
            "/./app-surface-sandbox.html",
        ] {
            let primary_sandbox = app
                .clone()
                .oneshot(Request::get(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(primary_sandbox.status(), 404, "{path}");
        }

        let sandbox = sandbox_router(Some(dist));
        let sandbox_document = sandbox
            .clone()
            .oneshot(
                Request::get("/app-surface-sandbox.html")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(sandbox_document.status(), 200);
        let sandbox_shell = sandbox
            .oneshot(Request::get("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(sandbox_shell.status(), 404);
    }

    #[test]
    fn federated_contract_qualifies_executor_routes_and_excludes_control() {
        let contract = federated_openapi();
        let paths = contract["paths"].as_object().unwrap();
        assert!(paths.contains_key("/v1/federation/executors"));
        assert!(paths.contains_key("/v1/executors/{executorId}/projects"));
        assert!(paths.contains_key("/v1/executors/{executorId}/events"));
        assert!(!paths.contains_key("/v1/executors/{executorId}/frontend-updates"));
        assert!(paths.keys().all(|path| !path.contains("self-control")));
        assert_eq!(
            paths["/v1/executors/{executorId}/projects"]["get"]["parameters"][0]["name"],
            "executorId"
        );
    }

    #[tokio::test]
    async fn federator_shutdown_does_not_close_an_executor_listener() {
        let dir = tempfile::tempdir().unwrap();
        let config = config::Config {
            data_dir: dir.path().to_path_buf(),
            database_path: dir.path().join("federator.db"),
            ..config::Config::default()
        };
        let (_instance, state) = prepare(&config).await.unwrap();
        let primary = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let sandbox = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let executor = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let executor_address = executor.local_addr().unwrap();
        serve(
            primary,
            sandbox,
            state,
            None,
            config.sandbox_public_url,
            async {},
        )
        .await
        .unwrap();
        let client = tokio::net::TcpStream::connect(executor_address)
            .await
            .unwrap();
        let (_socket, _) = executor.accept().await.unwrap();
        drop(client);
    }

    #[tokio::test]
    async fn executor_registration_persists_and_generations_fence_updates() {
        let executor_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let executor_address = executor_listener.local_addr().unwrap();
        let executor = Router::new()
            .route(
                "/v1/capabilities",
                get(|| async {
                    Json(json!({
                        "gateway": {
                            "apiVersion": "4",
                            "instanceId": "executor-instance-1"
                        },
                        "appServer": {
                            "ready": true,
                            "schemaVersion": "0.160.0",
                            "detectedVersionMatchesSchema": true
                        }
                    }))
                }),
            )
            .route(
                "/v1/projects",
                get(|headers: axum::http::HeaderMap| async move {
                    let mut response = if headers
                        .get("x-kodex-expected-instance")
                        .is_some_and(|value| value == "executor-instance-1")
                        && headers
                            .get("x-kodex-api-version")
                            .is_some_and(|value| value == "4")
                    {
                        Json(json!({"projects": [{"id": "shared-native-id"}]})).into_response()
                    } else {
                        StatusCode::CONFLICT.into_response()
                    };
                    response.headers_mut().insert(
                        "x-kodex-api-version",
                        axum::http::HeaderValue::from_static("4"),
                    );
                    response
                }),
            )
            .route(
                "/v1/self-control/status",
                get(|| async { Json(json!({"mustNotEscape": true})) }),
            );
        let executor_task = tokio::spawn(async move {
            axum::serve(executor_listener, executor).await.unwrap();
        });

        let dir = tempfile::tempdir().unwrap();
        let config = config::Config {
            data_dir: dir.path().to_path_buf(),
            database_path: dir.path().join("federator.db"),
            ..config::Config::default()
        };
        let (instance, state) = prepare(&config).await.unwrap();
        let app = primary_router(state, None, config.sandbox_public_url.clone());
        let request = json!({
            "displayName": "Desk Mac",
            "baseUrl": format!("http://{executor_address}")
        });
        let created = app
            .clone()
            .oneshot(
                Request::post("/v1/federation/executors")
                    .header("content-type", "application/json")
                    .body(Body::from(request.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::CREATED);
        let created = response_json(created).await;
        let executor_id = created["id"].as_str().unwrap();
        assert_eq!(created["generation"], 1);
        assert_eq!(created["instanceId"], "executor-instance-1");
        assert_eq!(created["status"], "ready");

        let proxied = app
            .clone()
            .oneshot(
                Request::get(format!("/v1/executors/{executor_id}/projects"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(proxied.status(), StatusCode::OK);
        let proxied = response_json(proxied).await;
        assert_eq!(proxied["projects"][0]["id"], "shared-native-id");

        let blocked_control = app
            .clone()
            .oneshot(
                Request::get(format!("/v1/executors/{executor_id}/self-control/status"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(blocked_control.status(), StatusCode::NOT_FOUND);

        let duplicate = app
            .clone()
            .oneshot(
                Request::post("/v1/federation/executors")
                    .header("content-type", "application/json")
                    .body(Body::from(request.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(duplicate.status(), StatusCode::CONFLICT);

        let rename = app.clone().oneshot(
            Request::patch(format!("/v1/federation/executors/{executor_id}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"displayName": "Desk Mac renamed"}).to_string(),
                ))
                .unwrap(),
        );
        let disable = app.clone().oneshot(
            Request::patch(format!("/v1/federation/executors/{executor_id}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"enabled": false}).to_string()))
                .unwrap(),
        );
        let (renamed, disabled) = tokio::join!(rename, disable);
        let renamed = renamed.unwrap();
        let disabled = disabled.unwrap();
        assert_eq!(renamed.status(), StatusCode::OK);
        assert_eq!(disabled.status(), StatusCode::OK);
        let renamed = response_json(renamed).await;
        let disabled = response_json(disabled).await;
        assert_eq!(renamed["displayName"], "Desk Mac renamed");
        assert_eq!(disabled["enabled"], false);
        let mut generations = [
            renamed["generation"].as_i64().unwrap(),
            disabled["generation"].as_i64().unwrap(),
        ];
        generations.sort();
        assert_eq!(generations, [2, 3]);

        let converged = app
            .clone()
            .oneshot(
                Request::get(format!("/v1/federation/executors/{executor_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let converged = response_json(converged).await;
        assert_eq!(converged["displayName"], "Desk Mac renamed");
        assert_eq!(converged["enabled"], false);
        assert_eq!(converged["generation"], 3);

        drop(app);
        drop(instance);
        let (_reopened_instance, reopened_state) = prepare(&config).await.unwrap();
        let reopened = primary_router(reopened_state, None, config.sandbox_public_url);
        let listed = reopened
            .oneshot(
                Request::get("/v1/federation/executors")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let listed = response_json(listed).await;
        assert_eq!(listed["executors"].as_array().unwrap().len(), 1);
        assert_eq!(listed["executors"][0]["generation"], 3);
        assert_eq!(listed["executors"][0]["displayName"], "Desk Mac renamed");
        assert_eq!(listed["executors"][0]["enabled"], false);
        assert_eq!(listed["executors"][0]["status"], "unknown");
        executor_task.abort();
    }

    #[tokio::test]
    async fn replaced_v3_executor_cannot_execute_a_v4_federated_mutation() {
        let executed = Arc::new(AtomicBool::new(false));
        let executor_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let executor_address = executor_listener.local_addr().unwrap();
        let old_mutation = axum::routing::post({
            let executed = executed.clone();
            move |headers: axum::http::HeaderMap| {
                let executed = executed.clone();
                async move {
                    let status = if headers
                        .get("x-kodex-api-version")
                        .is_some_and(|value| value == "3")
                    {
                        executed.store(true, Ordering::SeqCst);
                        StatusCode::CREATED
                    } else {
                        StatusCode::CONFLICT
                    };
                    ([("x-kodex-api-version", "3")], status)
                }
            }
        });
        let old_executor = Router::new()
            .route(
                "/v1/projects",
                get(|| async {
                    (
                        [("x-kodex-api-version", "3")],
                        Json(json!({"projects": [{"id": "replacement-data"}]})),
                    )
                })
                .merge(old_mutation),
            )
            .route(
                "/v1/events",
                get(|| async {
                    (
                        [
                            ("x-kodex-api-version", "3"),
                            ("content-type", "text/event-stream"),
                        ],
                        "data: replacement-event\n\n",
                    )
                }),
            );
        let executor_task = tokio::spawn(async move {
            axum::serve(executor_listener, old_executor).await.unwrap();
        });

        let dir = tempfile::tempdir().unwrap();
        let config = config::Config {
            data_dir: dir.path().to_path_buf(),
            database_path: dir.path().join("federator.db"),
            ..config::Config::default()
        };
        let (_instance, state) = prepare(&config).await.unwrap();
        state
            .store
            .insert_executor(&registry::ExecutorRecord {
                id: "executor-1".to_string(),
                generation: 1,
                display_name: "Replaced executor".to_string(),
                base_url: format!("http://{executor_address}"),
                instance_id: "expected-v4-instance".to_string(),
                api_version: registry::SUPPORTED_EXECUTOR_API_VERSION.to_string(),
                app_server_schema_version: "0.160.0".to_string(),
                enabled: true,
                status: registry::ExecutorStatus::Ready,
                last_error: None,
                last_seen_at: 1,
                created_at: 1,
                updated_at: 1,
            })
            .await
            .unwrap();
        let app = primary_router(state, None, config.sandbox_public_url);
        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/executors/executor-1/projects")
                    .header("content-type", "application/json")
                    .header("x-kodex-api-version", "3")
                    .body(Body::from(r#"{"name":"must not run"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert!(!executed.load(Ordering::SeqCst));

        for path in ["projects", "events"] {
            let response = app
                .clone()
                .oneshot(
                    Request::get(format!("/v1/executors/executor-1/{path}"))
                        .header("accept", "text/event-stream")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::CONFLICT, "{path}");
            let response = response_json(response).await;
            assert_eq!(response["code"], "executor_incompatible", "{path}");
        }
        executor_task.abort();
    }

    async fn response_json(response: axum::response::Response) -> serde_json::Value {
        let body = response.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&body).unwrap()
    }
}
