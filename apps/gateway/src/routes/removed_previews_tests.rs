use std::sync::Arc;

use axum::{
    body::{to_bytes, Body},
    http::{Method, Request, StatusCode},
};
use serde_json::Value;
use tower::ServiceExt;

use crate::{
    app_server::tests::RecordingAppServer, build_router, config::Config, store::Store, AppState,
};

async fn state() -> AppState {
    AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        Arc::new(RecordingAppServer::default()),
    )
}

#[tokio::test]
async fn removed_preview_routes_are_not_served() {
    let app = build_router(state().await);
    for (method, path) in [
        (Method::POST, "/v1/project-previews/reload"),
        (Method::POST, "/v1/projects/project-1/preview-services"),
        (
            Method::PATCH,
            "/v1/projects/project-1/preview-services/service-1",
        ),
        (
            Method::DELETE,
            "/v1/projects/project-1/preview-services/service-1",
        ),
        (Method::GET, "/v1/projects/project-1/previews"),
        (Method::POST, "/v1/projects/project-1/previews"),
        (Method::PATCH, "/v1/projects/project-1/previews/preview-1"),
        (Method::DELETE, "/v1/projects/project-1/previews/preview-1"),
        (
            Method::POST,
            "/v1/projects/project-1/previews/preview-1/routes",
        ),
        (
            Method::PATCH,
            "/v1/projects/project-1/previews/preview-1/routes/route-1",
        ),
        (
            Method::DELETE,
            "/v1/projects/project-1/previews/preview-1/routes/route-1",
        ),
        (Method::GET, "/v1/self-control/projects/project-1/previews"),
        (Method::POST, "/v1/self-control/project-previews/apply"),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method.clone())
                    .uri(path)
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{method} {path}");
    }
}

#[tokio::test]
async fn removed_preview_contract_keeps_native_projects_file_previews_and_app_surfaces() {
    let response = build_router(state().await)
        .oneshot(Request::get("/openapi.json").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let document: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    let paths = document["paths"].as_object().unwrap();
    assert!(paths.keys().all(|path| !path.contains("/project-previews")
        && !path.contains("/previews")
        && !path.contains("/preview-services")));
    assert!(paths.contains_key("/v1/projects"));
    assert!(paths.contains_key("/v1/projects/{projectId}"));
    assert!(paths.contains_key("/v1/threads/{threadId}/files/preview"));
    assert!(paths.contains_key("/v1/threads/{threadId}/app-surface"));
    let schemas = document["components"]["schemas"].as_object().unwrap();
    assert!(schemas.keys().all(|name| !name.contains("ProjectPreview")
        && !name.starts_with("Preview")
        && !name.contains("SelfControlDesiredPreview")
        && !name.contains("SelfControlPreview")));
}

#[tokio::test]
async fn fresh_schema_has_no_preview_or_gateway_project_registry() {
    let store = Store::in_memory().await.unwrap();
    let tables: Vec<String> = sqlx::query_scalar("select name from sqlite_schema where type = 'table' and (name = 'projects' or name like 'project_preview%')")
        .fetch_all(store.pool()).await.unwrap();
    assert!(tables.is_empty(), "removed tables remain: {tables:?}");
}
