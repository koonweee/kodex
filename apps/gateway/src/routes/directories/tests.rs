use std::sync::Arc;

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::Value;
use tempfile::tempdir;
use tower::ServiceExt;

use crate::{
    api::{build_router, AppState},
    app_server::tests::RecordingAppServer,
    config::Config,
    store::Store,
};

async fn app(home: &std::path::Path) -> axum::Router {
    let mut config = Config::default();
    config.projects.home_dir = home.into();
    build_router(AppState::new(
        config,
        Store::in_memory().await.unwrap(),
        Arc::new(RecordingAppServer::default()),
    ))
}

async fn get(app: axum::Router, path: Option<&str>) -> (StatusCode, Value) {
    let uri = path.map_or_else(
        || "/v1/directories".to_owned(),
        |path| format!("/v1/directories?path={path}"),
    );
    let response = app
        .oneshot(Request::get(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn default_home_lists_only_immediate_directories_and_stops_up_navigation() {
    let home = tempdir().unwrap();
    std::fs::create_dir(home.path().join("Zeta")).unwrap();
    std::fs::create_dir_all(home.path().join("Alpha/nested")).unwrap();
    std::fs::write(home.path().join("file.txt"), "file").unwrap();
    let canonical = std::fs::canonicalize(home.path()).unwrap();
    let app = app(home.path()).await;
    let (status, response) = get(app.clone(), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(response["path"], canonical.to_str().unwrap());
    assert_eq!(response["homePath"], canonical.to_str().unwrap());
    assert!(response["parentPath"].is_null());
    let entries = response["directories"].as_array().unwrap();
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["Alpha", "Zeta"]
    );
    let (status, child) = get(app, Some(entries[0]["path"].as_str().unwrap())).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(child["parentPath"], canonical.to_str().unwrap());
    assert_eq!(child["directories"][0]["name"], "nested");
}

#[tokio::test]
async fn directory_navigation_rejects_outside_paths_traversal_files_and_missing_entries() {
    let home = tempdir().unwrap();
    std::fs::write(home.path().join("file"), "file").unwrap();
    let app = app(home.path()).await;
    for path in [
        home.path().parent().unwrap().to_owned(),
        home.path().join(".."),
        home.path().join("file"),
    ] {
        assert_eq!(
            get(app.clone(), Some(path.to_str().unwrap())).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        get(app.clone(), Some("relative")).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        get(app, Some(home.path().join("missing").to_str().unwrap()))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
}

#[cfg(unix)]
#[tokio::test]
async fn symlinks_cannot_browse_or_list_directories_outside_home() {
    let home = tempdir().unwrap();
    let outside = tempdir().unwrap();
    std::fs::create_dir(home.path().join("inside")).unwrap();
    std::os::unix::fs::symlink(outside.path(), home.path().join("escape")).unwrap();
    std::os::unix::fs::symlink(home.path().join("inside"), home.path().join("alias")).unwrap();
    let app = app(home.path()).await;
    let (status, response) = get(app.clone(), None).await;
    assert_eq!(status, StatusCode::OK);
    let names = response["directories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(names, ["alias", "inside"]);
    assert_eq!(
        get(app, Some(home.path().join("escape").to_str().unwrap()))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
}
