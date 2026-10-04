use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use serde_json::json;
use tower::ServiceExt;

use super::tests::{native_project, response_json, test_state};
use crate::build_router;

#[tokio::test]
async fn native_project_read_preserves_all_roots_metadata_and_native_timestamps() {
    let (state, server) = test_state().await;
    let mut project = native_project("project-1", "/workspace/first");
    project["roots"] = json!([{"path":"/workspace/first"},{"path":"/workspace/second"}]);
    project["recencyAt"] = json!(1_767_225_605_i64);
    server
        .native_projects
        .lock()
        .unwrap()
        .insert("project-1".into(), project.clone());
    let response = build_router(state)
        .oneshot(
            Request::get("/v1/projects/project-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response_json(response).await, project);
}

#[tokio::test]
async fn native_project_create_passes_roots_without_creating_directories() {
    let (state, server) = test_state().await;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("not-created");
    let body = json!({"name":"Virtual project", "roots":[{"path":root}], "metadata":{"color":"red"}, "idempotencyKey":"stable-create"});
    let response = build_router(state)
        .oneshot(
            Request::post("/v1/projects")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(
        server.requests.lock().unwrap()[0],
        ("project/create".into(), body)
    );
    assert!(!root.exists());
}

#[tokio::test]
async fn native_project_multiple_roots_require_an_explicit_execution_cwd() {
    for endpoint in ["/v1/threads", "/v1/self-control/threads"] {
        let (state, server) = test_state().await;
        let mut project = native_project("project-1", "/workspace/first");
        project["roots"] = json!([{"path":"/workspace/first"},{"path":"/workspace/second"}]);
        server
            .native_projects
            .lock()
            .unwrap()
            .insert("project-1".into(), project);
        let response = build_router(state)
            .oneshot(
                Request::post(endpoint)
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"projectId":"project-1"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{endpoint}");
        assert!(server
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|(method, _)| method != "thread/start"));
    }
}

#[tokio::test]
async fn native_unassigned_listing_is_independent_of_scratch_directories() {
    let (state, server) = test_state().await;
    let response = build_router(state)
        .oneshot(
            Request::get("/v1/chats/threads")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].0, "thread/list");
    assert_eq!(
        requests[0].1.get("projectId"),
        Some(&serde_json::Value::Null)
    );
    assert!(requests[0].1.get("cwd").is_none());
}

#[tokio::test]
async fn native_project_update_preserves_omitted_fields_and_forwards_explicit_empty_maps() {
    for (patch, expected) in [
        (
            json!({"name":"Renamed"}),
            json!({"projectId":"project-1","name":"Renamed"}),
        ),
        (
            json!({"metadata":{}}),
            json!({"projectId":"project-1","metadata":{}}),
        ),
        (
            json!({"roots":[]}),
            json!({"projectId":"project-1","roots":[]}),
        ),
        (
            json!({"name":null,"metadata":null,"roots":null}),
            json!({"projectId":"project-1"}),
        ),
    ] {
        let (state, server) = test_state().await;
        server
            .queued_responses
            .lock()
            .unwrap()
            .push(json!({"project":native_project("project-1","/workspace")}));
        let response = build_router(state)
            .oneshot(
                Request::patch("/v1/projects/project-1")
                    .header("content-type", "application/json")
                    .body(Body::from(patch.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            server.requests.lock().unwrap().as_slice(),
            &[("project/update".into(), expected)]
        );
    }
}

#[tokio::test]
async fn native_project_move_and_delete_forward_single_native_commands() {
    for before in [json!("project-2"), json!(null)] {
        let (state, server) = test_state().await;
        server.queued_responses.lock().unwrap().push(json!({}));
        let response = build_router(state)
            .oneshot(
                Request::post("/v1/projects/project-1/move")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"beforeProjectId":before}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            server.requests.lock().unwrap().as_slice(),
            &[(
                "project/move".into(),
                json!({"projectId":"project-1","beforeProjectId":before})
            )]
        );
    }
    let (state, server) = test_state().await;
    server.queued_responses.lock().unwrap().push(json!({}));
    let response = build_router(state)
        .oneshot(
            Request::delete("/v1/projects/project-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        server.requests.lock().unwrap().as_slice(),
        &[("project/delete".into(), json!({"projectId":"project-1"}))]
    );
}

#[tokio::test]
async fn native_membership_update_requires_an_explicit_nullable_project_id_and_keeps_cwd() {
    let (state, server) = test_state().await;
    let app = build_router(state);
    let missing = app
        .clone()
        .oneshot(
            Request::patch("/v1/threads/thread-1/project")
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert!(server.requests.lock().unwrap().is_empty());
    for project_id in [json!("project-2"), json!(null)] {
        server.queued_responses.lock().unwrap().push(json!({"thread":{
            "id":"thread-1","projectId":project_id,"cwd":"/execution/unchanged","status":{"type":"idle"},"createdAt":1,"updatedAt":2,
        }}));
        let response = app
            .clone()
            .oneshot(
                Request::patch("/v1/threads/thread-1/project")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"projectId":project_id}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let response = response_json(response).await;
        assert_eq!(response["thread"]["projectId"], project_id);
        assert_eq!(response["thread"]["cwd"], "/execution/unchanged");
        let expected = project_id.as_str().unwrap_or("");
        assert_eq!(
            server.requests.lock().unwrap().last().unwrap(),
            &(
                "thread/metadata/update".into(),
                json!({"threadId":"thread-1","projectId":expected})
            )
        );
    }
}

#[tokio::test]
async fn explicit_execution_cwd_is_independent_of_zero_one_or_multiple_project_roots() {
    for roots in [
        json!([]),
        json!([{"path":"/root/one"}]),
        json!([{"path":"/root/one"},{"path":"/root/two"}]),
    ] {
        for endpoint in ["/v1/threads", "/v1/self-control/threads"] {
            let (state, server) = test_state().await;
            let mut project = native_project("project-1", "/unused");
            project["roots"] = roots.clone();
            server
                .native_projects
                .lock()
                .unwrap()
                .insert("project-1".into(), project);
            let response = build_router(state)
                .oneshot(
                    Request::post(endpoint)
                        .header("content-type", "application/json")
                        .body(Body::from(
                            json!({"projectId":"project-1","cwd":"/outside/roots"}).to_string(),
                        ))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{endpoint}: {roots}");
            let response = response_json(response).await;
            assert_eq!(response["thread"]["projectId"], "project-1");
            assert_eq!(response["thread"]["cwd"], "/outside/roots");
            let requests = server.requests.lock().unwrap();
            let (_, params) = requests
                .iter()
                .find(|(method, _)| method == "thread/start")
                .unwrap();
            assert_eq!(params["cwd"], "/outside/roots");
            assert!(params.get("runtimeWorkspaceRoots").is_none());
            assert!(params.get("additionalWritableRoots").is_none());
        }
    }
}

#[tokio::test]
async fn project_config_queries_require_an_unambiguous_cwd_and_accept_explicit_context() {
    for roots in [
        json!([]),
        json!([{"path":"/root/one"},{"path":"/root/two"}]),
    ] {
        for (endpoint, method, payload) in [
            ("/v1/composer-settings", "config/read", json!({"config":{}})),
            (
                "/v1/permission-profiles",
                "permissionProfile/list",
                json!({"data":[],"nextCursor":null}),
            ),
        ] {
            let (state, server) = test_state().await;
            let mut project = native_project("project-1", "/unused");
            project["roots"] = roots.clone();
            server
                .native_projects
                .lock()
                .unwrap()
                .insert("project-1".into(), project);
            let app = build_router(state);
            let response = app
                .clone()
                .oneshot(
                    Request::get(format!("{endpoint}?projectId=project-1"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            assert_eq!(server.requests.lock().unwrap().len(), 1);
            server.queued_responses.lock().unwrap().push(payload);
            let response = app
                .oneshot(
                    Request::get(format!("{endpoint}?projectId=project-1&cwd=/outside/roots"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{endpoint}");
            let requests = server.requests.lock().unwrap();
            let (_, params) = requests
                .iter()
                .find(|(requested, _)| requested == method)
                .unwrap();
            assert_eq!(params["cwd"], "/outside/roots");
        }
    }
}

#[tokio::test]
async fn native_project_changes_replay_globally_and_another_client_refetches_native_state() {
    use crate::{app_server::InboundMessage, events::ingest_inbound};
    let (state, server) = test_state().await;
    let project = native_project("project-1", "/workspace");
    server
        .native_projects
        .lock()
        .unwrap()
        .insert("project-1".into(), project);
    let app = build_router(state.clone());
    let initial = app
        .clone()
        .oneshot(Request::get("/v1/projects").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(
        response_json(initial).await["projects"][0]["name"],
        "Native project"
    );
    server
        .native_projects
        .lock()
        .unwrap()
        .get_mut("project-1")
        .unwrap()["name"] = json!("Changed elsewhere");
    for (method, params) in [
        (
            "project/changed",
            json!({"projectId":"project-1","changeType":"updated"}),
        ),
        (
            "thread/project/updated",
            json!({"threadId":"not-selected","projectId":null}),
        ),
        (
            "project/changed",
            json!({"projectId":"project-2","changeType":"deleted"}),
        ),
    ] {
        ingest_inbound(
            InboundMessage::Notification {
                method: method.into(),
                params,
            },
            &state,
        )
        .await
        .unwrap();
    }
    let events = app
        .clone()
        .oneshot(
            Request::get("/v1/events?includeGlobal=true&threadIds=selected")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = response_json(events).await;
    let kinds = body["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|event| event["kind"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        kinds,
        [
            "project.changed",
            "thread.project_updated",
            "project.changed"
        ]
    );
    assert_eq!(
        body["events"][1]["payload"],
        json!({"threadId":"not-selected","projectId":null})
    );
    assert_eq!(body["events"][2]["payload"]["changeType"], "deleted");
    let latest = app
        .oneshot(Request::get("/v1/projects").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(
        response_json(latest).await["projects"][0]["name"],
        "Changed elsewhere"
    );
}
