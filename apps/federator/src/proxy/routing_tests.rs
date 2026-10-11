use axum::{body::Body, http::Request, response::Response, routing::get, Json, Router};
use http_body_util::BodyExt;
use serde_json::json;
use tower::ServiceExt;

use crate::{config, primary_router};

fn primary_request(builder: axum::http::request::Builder) -> axum::http::request::Builder {
    builder.header("host", "localhost:8787")
}

fn primary_mutation(builder: axum::http::request::Builder) -> axum::http::request::Builder {
    primary_request(builder)
        .header("origin", "http://localhost:8787")
        .header("x-kodex-api-version", crate::trust::FEDERATOR_API_VERSION)
}

async fn response_json(response: Response) -> serde_json::Value {
    let body = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&body).unwrap()
}

async fn spawn_executor(
    instance_id: &'static str,
    marker: &'static str,
) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let executor = Router::new()
        .route(
            "/v1/capabilities",
            get(move || async move {
                Json(json!({
                    "gateway": {"apiVersion": "4", "instanceId": instance_id},
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
            get(move |headers: axum::http::HeaderMap| async move {
                assert_eq!(headers["x-kodex-expected-instance"], instance_id);
                (
                    [("x-kodex-api-version", "4")],
                    Json(json!({
                        "projects": [{
                            "id": "shared-native-project-id",
                            "name": marker
                        }]
                    })),
                )
            }),
        );
    let task = tokio::spawn(async move { axum::serve(listener, executor).await.unwrap() });
    (address, task)
}

#[tokio::test]
async fn qualified_routes_isolate_colliding_native_ids_across_executors() {
    let (first_address, first_task) = spawn_executor("instance-a", "executor-a").await;
    let (second_address, second_task) = spawn_executor("instance-b", "executor-b").await;
    let dir = tempfile::tempdir().unwrap();
    let config = config::Config {
        data_dir: dir.path().to_path_buf(),
        database_path: dir.path().join("federator.db"),
        ..config::Config::default()
    };
    let (_instance, state) = crate::prepare(&config).await.unwrap();
    let app = primary_router(state, None, config.sandbox_public_url);

    let mut executor_ids = Vec::new();
    for (name, address) in [
        ("Executor A", first_address),
        ("Executor B", second_address),
    ] {
        let registered = app
            .clone()
            .oneshot(
                primary_mutation(Request::post("/v1/federation/executors"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "displayName": name,
                            "baseUrl": format!("http://{address}")
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(registered.status(), axum::http::StatusCode::CREATED);
        executor_ids.push(
            response_json(registered).await["id"]
                .as_str()
                .unwrap()
                .to_string(),
        );
    }

    for (executor_id, marker) in [
        (&executor_ids[0], "executor-a"),
        (&executor_ids[1], "executor-b"),
    ] {
        let projects = app
            .clone()
            .oneshot(
                primary_request(Request::get(format!(
                    "/v1/executors/{executor_id}/projects"
                )))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        let projects = response_json(projects).await;
        assert_eq!(projects["projects"][0]["id"], "shared-native-project-id");
        assert_eq!(projects["projects"][0]["name"], marker);
    }

    let removed = app
        .clone()
        .oneshot(
            primary_mutation(Request::delete(format!(
                "/v1/federation/executors/{}",
                executor_ids[0]
            )))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(removed.status(), axum::http::StatusCode::NO_CONTENT);
    let missing = app
        .clone()
        .oneshot(
            primary_request(Request::get(format!(
                "/v1/executors/{}/projects",
                executor_ids[0]
            )))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing.status(), axum::http::StatusCode::NOT_FOUND);
    let retained = app
        .oneshot(
            primary_request(Request::get(format!(
                "/v1/executors/{}/projects",
                executor_ids[1]
            )))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        response_json(retained).await["projects"][0]["name"],
        "executor-b"
    );
    first_task.abort();
    second_task.abort();
}
