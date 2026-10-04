use std::sync::{atomic::Ordering, Arc};

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::{json, Value};
use tempfile::tempdir;
use tower::ServiceExt;

use crate::{
    api::{build_router, AppState},
    app_server::tests::RecordingAppServer,
    config::Config,
    store::Store,
};

async fn test_state() -> (AppState, Arc<RecordingAppServer>) {
    let server = Arc::new(RecordingAppServer::default());
    server.ready.store(true, Ordering::SeqCst);
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        server.clone(),
    );
    (state, server)
}

fn native_project(id: &str, cwd: &str) -> Value {
    json!({
        "id": id,
        "name": "Native project",
        "roots": [{"path": cwd}],
        "metadata": {"unrecognized-key": "preserve upstream"},
        "position": 0,
        "createdAt": 1_767_225_600_i64,
        "updatedAt": 1_767_225_601_i64,
        "recencyAt": null,
    })
}

async fn response_json(response: axum::response::Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
}

#[tokio::test]
async fn create_project_uses_native_identity_and_does_not_create_a_gateway_record() {
    let (state, server) = test_state().await;
    let directory = tempdir().unwrap();
    let cwd = std::fs::canonicalize(directory.path()).unwrap();
    let cwd = cwd.to_string_lossy().to_string();
    server
        .queued_responses
        .lock()
        .unwrap()
        .push(json!({"project": native_project("native-project-1", &cwd)}));
    let response = build_router(state.clone())
        .oneshot(
            Request::post("/v1/projects")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"name": "Native project", "cwd": cwd, "idempotencyKey": "create-operation-1"})
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CREATED);
    let project = response_json(response).await;
    assert_eq!(project["id"], "native-project-1");
    assert_eq!(project["cwd"], cwd);
    assert_eq!(project["createdAt"], "2026-01-01T00:00:00Z");
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].0, "project/create");
    assert_eq!(
        requests[0].1,
        json!({
            "name": "Native project",
            "roots": [{"path": cwd}],
            "idempotencyKey": "create-operation-1",
        })
    );
}

#[tokio::test]
async fn list_projects_reads_all_native_pages_in_native_order() {
    let (state, server) = test_state().await;
    server.queued_responses.lock().unwrap().extend([
        json!({"data": [native_project("native-first", "/workspace/one")], "nextCursor": "second-page"}),
        json!({"data": [native_project("native-second", "/workspace/two")], "nextCursor": null}),
    ]);
    let response = build_router(state)
        .oneshot(Request::get("/v1/projects").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["projects"][0]["id"], "native-first");
    assert_eq!(body["projects"][1]["id"], "native-second");
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].0, "project/list");
    assert_eq!(requests[0].1["sortKey"], "position");
    assert_eq!(requests[0].1["sortDirection"], "asc");
    assert_eq!(requests[1].1["cursor"], "second-page");
}

#[tokio::test]
async fn read_project_uses_native_metadata_without_a_gateway_record() {
    let (state, server) = test_state().await;
    server
        .queued_responses
        .lock()
        .unwrap()
        .push(json!({"project": native_project("native-project-1", "/workspace")}));
    let response = build_router(state)
        .oneshot(
            Request::get("/v1/projects/native-project-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response_json(response).await["id"], "native-project-1");
    assert_eq!(
        server.requests.lock().unwrap()[0],
        (
            "project/read".to_string(),
            json!({"projectId": "native-project-1"}),
        )
    );
}

#[tokio::test]
async fn thread_creation_forwards_the_native_project_id() {
    for endpoint in ["/v1/threads", "/v1/self-control/threads"] {
        let (state, server) = test_state().await;
        server
            .queued_responses
            .lock()
            .unwrap()
            .push(json!({"project": native_project("native-project-1", "/workspace")}));
        let response = build_router(state)
            .oneshot(
                Request::post(endpoint)
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"projectId":"native-project-1"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK, "{endpoint}");
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "project/read");
        let (_, params) = requests
            .iter()
            .find(|(method, _)| method == "thread/start")
            .unwrap();
        assert_eq!(params["projectId"], "native-project-1");
        assert_eq!(params["cwd"], "/workspace");
    }
}

#[tokio::test]
async fn project_thread_listing_uses_native_membership() {
    let (state, server) = test_state().await;
    let response = build_router(state)
        .oneshot(
            Request::get("/v1/threads?projectId=native-project-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].0, "thread/list");
    assert_eq!(requests[0].1["projectId"], "native-project-1");
    assert!(requests[0].1.get("cwd").is_none());
}

#[tokio::test]
async fn another_client_refetches_changed_native_project_metadata() {
    let (state, server) = test_state().await;
    server.native_projects.lock().unwrap().insert(
        "native-project-1".to_string(),
        native_project("native-project-1", "/workspace"),
    );
    let app = build_router(state.clone());
    let first = app
        .clone()
        .oneshot(Request::get("/v1/projects").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(
        response_json(first).await["projects"][0]["name"],
        "Native project"
    );

    server
        .native_projects
        .lock()
        .unwrap()
        .get_mut("native-project-1")
        .unwrap()["name"] = json!("Changed in native state");
    let second = app
        .oneshot(Request::get("/v1/projects").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(
        response_json(second).await["projects"][0]["name"],
        "Changed in native state"
    );
}

#[tokio::test]
async fn project_settings_and_permissions_use_the_native_working_directory() {
    for (endpoint, method, payload) in [
        (
            "/v1/composer-settings",
            "config/read",
            json!({"config": {}}),
        ),
        (
            "/v1/permission-profiles",
            "permissionProfile/list",
            json!({"data": [], "nextCursor": null}),
        ),
    ] {
        let (state, server) = test_state().await;
        server.native_projects.lock().unwrap().insert(
            "native-project-1".to_string(),
            native_project("native-project-1", "/native/workspace"),
        );
        server.queued_responses.lock().unwrap().push(payload);
        let response = build_router(state)
            .oneshot(
                Request::get(format!("{endpoint}?projectId=native-project-1"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{endpoint}");
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "project/read");
        assert_eq!(requests[1].0, method);
        assert_eq!(requests[1].1["cwd"], "/native/workspace");
    }
}

#[tokio::test]
async fn a_rootless_native_project_remains_readable_without_breaking_the_sidebar() {
    let (mut state, server) = test_state().await;
    let home = tempdir().unwrap();
    Arc::make_mut(&mut state.config).projects.home_dir = home.path().to_path_buf();
    let mut project = native_project("rootless", "/unused");
    project["roots"] = json!([]);
    server
        .native_projects
        .lock()
        .unwrap()
        .insert("rootless".to_string(), project);
    let app = build_router(state);

    for endpoint in [
        "/v1/projects",
        "/v1/projects/rootless",
        "/v1/sidebar/threads",
    ] {
        let response = app
            .clone()
            .oneshot(Request::get(endpoint).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{endpoint}");
        let body = response_json(response).await;
        let project = if endpoint == "/v1/projects/rootless" {
            &body
        } else {
            &body["projects"][0]
        };
        assert_eq!(project["id"], "rootless");
        assert_eq!(project["cwd"], "");
    }
}

#[tokio::test]
async fn rootless_projects_cannot_fall_back_to_the_process_working_directory() {
    let (state, server) = test_state().await;
    let mut project = native_project("rootless", "/unused");
    project["roots"] = json!([]);
    server
        .native_projects
        .lock()
        .unwrap()
        .insert("rootless".to_string(), project);
    let response = build_router(state)
        .oneshot(
            Request::post("/v1/threads")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"projectId":"rootless"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].0, "project/read");
}
