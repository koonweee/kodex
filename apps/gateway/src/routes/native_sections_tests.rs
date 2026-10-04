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

async fn state() -> (AppState, Arc<RecordingAppServer>) {
    let native = Arc::new(RecordingAppServer::default());
    (
        AppState::new(
            Config::default(),
            Store::in_memory().await.unwrap(),
            native.clone(),
        ),
        native,
    )
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
        if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into()))
        },
    )
}

#[tokio::test]
async fn native_sections_create_forwards_appearance_and_invalidates_all_clients() {
    let (state, native) = state().await;
    let section = json!({"id":"native-section","name":"Research","appearance":{"icon":"🧪","color":"future:color"}});
    *native.next_response.lock().unwrap() = Some(json!({"section":section}));
    let mut events = state.events.subscribe();
    let (status, body) = request(
        &state,
        Method::POST,
        "/v1/thread-sections",
        json!({"name":"Research","appearance":{"icon":"🧪","color":"future:color"}}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body, json!({"section":section}));
    assert_eq!(
        native.requests.lock().unwrap().as_slice(),
        &[(
            "threadSection/create".into(),
            json!({"name":"Research","appearance":{"icon":"🧪","color":"future:color"}})
        )]
    );
    let event = events.try_recv().unwrap();
    assert_eq!(event.kind, "thread.sections_updated");
    assert_eq!(event.thread_id, None);
    assert_eq!(event.project_id, None);
    assert_eq!(event.payload, json!({}));
    assert!(crate::events_replay::is_operational_replay_event(&event));
}

#[tokio::test]
async fn native_sections_move_preserves_explicit_null_and_does_not_read_each_thread() {
    let (state, native) = state().await;
    let (status, body) = request(
        &state,
        Method::POST,
        "/v1/threads/thread-1/section",
        json!({"sectionId":null}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(body, Value::Null);
    assert_eq!(
        native.requests.lock().unwrap().as_slice(),
        &[(
            "thread/section/move".into(),
            json!({"threadId":"thread-1","sectionId":null})
        )]
    );
}

#[tokio::test]
async fn native_sections_update_distinguishes_preserve_clear_and_replace() {
    let (state, native) = state().await;
    let mut events = state.events.subscribe();
    for patch in [
        json!({"name":"Renamed"}),
        json!({"name":"Renamed","appearance":null}),
        json!({"name":"Renamed","appearance":{"icon":"future:icon","color":"future:color"}}),
    ] {
        *native.next_response.lock().unwrap() =
            Some(json!({"section":{"id":"section-1","name":"Renamed","appearance":null}}));
        let (status, _) = request(
            &state,
            Method::PATCH,
            "/v1/thread-sections/section-1",
            patch.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let mut expected = patch;
        expected["sectionId"] = json!("section-1");
        assert_eq!(
            native.requests.lock().unwrap().last().unwrap(),
            &("threadSection/update".into(), expected)
        );
        assert_eq!(events.try_recv().unwrap().kind, "thread.sections_updated");
    }
    let (status, _) = request(
        &state,
        Method::PATCH,
        "/v1/thread-sections/section-1",
        json!({"appearance":null}),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(native.requests.lock().unwrap().len(), 3);
    assert!(events.try_recv().is_err());
}

#[tokio::test]
async fn native_sections_move_requires_section_id_and_uses_path_thread_identity() {
    for path in [
        "/v1/threads/real-thread/section",
        "/v1/self-control/threads/real-thread/section",
    ] {
        let (state, native) = state().await;
        let (status, _) = request(&state, Method::POST, path, json!({"beforeThreadId":null})).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{path}");
        assert!(native.requests.lock().unwrap().is_empty());
        let (status, _) = request(&state, Method::POST, path, json!({"threadId":"body-thread","sectionId":"section-1","beforeThreadId":"before-thread"})).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert_eq!(
            native.requests.lock().unwrap().as_slice(),
            &[(
                "thread/section/move".into(),
                json!({"threadId":"real-thread","sectionId":"section-1","beforeThreadId":"before-thread"})
            )]
        );
    }
}

#[tokio::test]
async fn native_sections_native_rejection_does_not_publish_success_or_erase_membership() {
    for method in [Method::DELETE, Method::PATCH] {
        let (state, native) = state().await;
        native
            .queued_errors
            .lock()
            .unwrap()
            .push(crate::error::ApiError::BadGateway(
                "the built-in pinned section cannot be changed".into(),
            ));
        let mut events = state.events.subscribe();
        let (status, body) = request(
            &state,
            method.clone(),
            &format!(
                "/v1/thread-sections/{}",
                crate::app_server_api::PINNED_THREAD_SECTION_ID
            ),
            json!({"name":"Other"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert!(body["message"]
            .as_str()
            .unwrap()
            .contains("built-in pinned"));
        let calls = native.requests.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0].0,
            if method == Method::DELETE {
                "threadSection/delete"
            } else {
                "threadSection/update"
            }
        );
        drop(calls);
        assert!(events.try_recv().is_err());
        assert_eq!(state.store.latest_event_seq().await.unwrap(), 0);
    }
}

fn section_thread(id: &str, section: Value, entered_at: i64) -> Value {
    json!({"id":id,"cwd":"/workspace","projectId":"project-1","section":section,"sectionEnteredAt":entered_at,
        "createdAt":1,"updatedAt":2,"status":{"type":"idle"}})
}

#[tokio::test]
async fn native_sections_list_preserves_native_order_and_cursor_with_only_bounded_read_headers() {
    let (state, native) = state().await;
    let section = json!({"id":"section-1","name":"Research","appearance":null});
    *native.next_response.lock().unwrap() = Some(
        json!({"data":[section_thread("z",section.clone(),1),section_thread("a",section.clone(),999)],"nextCursor":"next-native","backwardsCursor":"previous-native"}),
    );
    let (status, body) = request(
        &state,
        Method::GET,
        "/v1/thread-sections/section-1/threads?cursor=native-cursor&limit=2",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["threads"]
            .as_array()
            .unwrap()
            .iter()
            .map(|thread| thread["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["z", "a"]
    );
    assert_eq!(body["threads"][0]["section"], section);
    assert_eq!(body["threads"][1]["sectionEnteredAt"], 999);
    assert_eq!(body["threads"][0]["projectId"], "project-1");
    assert_eq!(body["nextCursor"], "next-native");
    assert_eq!(body["backwardsCursor"], "previous-native");
    let calls = native.requests.lock().unwrap();
    assert_eq!(calls.len(), 3);
    assert_eq!(calls[0].0, "thread/list");
    for (call, id) in calls[1..].iter().zip(["z", "a"]) {
        assert_eq!(
            call,
            &(
                "thread/turns/list".into(),
                json!({
                    "threadId":id,"cursor":null,"sortDirection":"desc","itemsView":"notLoaded","limit":8
                })
            )
        );
    }
    let params = &calls[0].1;
    assert_eq!(params["sectionId"], "section-1");
    assert_eq!(params["sortKey"], "section_position");
    assert_eq!(params["sortDirection"], "asc");
    assert_eq!(params["cursor"], "native-cursor");
    assert_eq!(params["limit"], 2);
    assert_eq!(params["archived"], false);
    assert_eq!(params["useStateDbOnly"], true);
    assert_eq!(params["modelProviders"], json!([]));
    assert!(params["sourceKinds"]
        .as_array()
        .unwrap()
        .contains(&json!("subAgent")));
    assert!(params.get("projectId").is_none());
    assert!(params.get("cwd").is_none());
}

#[tokio::test]
async fn native_sections_heading_pages_are_native_and_sidebar_collects_them_in_order() {
    let (state, native) = state().await;
    let first = json!({"id":"z-section","name":"First native","appearance":null});
    let second = json!({"id":"a-section","name":"Second native","appearance":null});
    *native.next_response.lock().unwrap() =
        Some(json!({"data":[second.clone()],"nextCursor":"next-native"}));
    let (status, body) = request(
        &state,
        Method::GET,
        "/v1/thread-sections?cursor=heading-page&limit=2",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        json!({"sections":[second.clone()],"nextCursor":"next-native"})
    );
    assert_eq!(
        native.requests.lock().unwrap().as_slice(),
        &[(
            "threadSection/list".into(),
            json!({"cursor":"heading-page","limit":2})
        )]
    );

    // The sidebar eagerly collects headings, while each membership remains a
    // bounded native page. IDs/names/entry timestamps never become sort keys.
    native.seed_project("Project".into(), "/workspace".into());
    native.queued_responses.lock().unwrap().extend([
        json!({"data":[first.clone()],"nextCursor":"second-page"}),
        json!({"data":[second.clone()],"nextCursor":null}),
    ]);
    let (status, body) = request(&state, Method::GET, "/v1/sidebar/threads", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["sections"], json!([first, second]));
    assert!(body.get("pinnedThreads").is_none());
    let calls = native.requests.lock().unwrap();
    assert!(calls.iter().any(
        |(method, params)| method == "threadSection/list" && params["cursor"] == "second-page"
    ));
    assert_eq!(
        calls
            .iter()
            .filter(|(method, params)| method == "thread/list" && params["sectionId"].is_string())
            .count(),
        2
    );
    for (_, params) in calls.iter().filter(|(method, _)| method == "thread/list") {
        assert_eq!(params["limit"], 10);
        if params.get("projectId").is_some() {
            assert_eq!(params.get("sectionId"), Some(&Value::Null));
        }
    }
    assert!(!calls.iter().any(|(method, _)| method == "thread/read"));
}

#[tokio::test]
async fn native_sections_delete_and_control_move_emit_global_refill_markers_replayable_by_other_panes(
) {
    let (state, native) = state().await;
    let mut events = state.events.subscribe();
    let (status, _) = request(
        &state,
        Method::DELETE,
        "/v1/self-control/thread-sections/custom",
        json!({"source":{"sourceThreadId":"origin"}}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let event = events.try_recv().unwrap();
    assert_eq!(event.kind, "thread.sections_updated");
    let query = crate::events::EventsQuery {
        cursor: Some(0),
        project_id: None,
        thread_id: None,
        exclude_thread_id: None,
        include_global: Some(true),
        thread_ids: Some("unrelated-pane".into()),
    };
    let replay =
        crate::events_replay::workspace_sse_replay_events(vec![event.clone()], &query).unwrap();
    assert_eq!(replay.len(), 1);
    assert_eq!(replay[0].payload, json!({}));
    let audit = events.try_recv().unwrap();
    assert_eq!(audit.kind, "self_control.thread_section_deleted");
    assert_eq!(audit.payload["source"]["sourceThreadId"], "origin");
    assert_eq!(
        native.requests.lock().unwrap().as_slice(),
        &[("threadSection/delete".into(), json!({"sectionId":"custom"}))]
    );
}

#[tokio::test]
async fn native_sections_started_metadata_preserves_membership_for_live_clients() {
    let (state, _) = state().await;
    state
        .store
        .set_thread_notifications_enabled("thread-1", false)
        .await
        .unwrap();
    let head = state
        .store
        .record_thread_completion("thread-1", "completed-before-start")
        .await
        .unwrap();
    let seen = state
        .store
        .mark_thread_seen("thread-1", "completed-before-start", head.read_revision)
        .await
        .unwrap();
    let section =
        json!({"id":"custom-section","name":"Research","appearance":{"icon":"unknown:icon"}});
    let thread = section_thread("thread-1", section.clone(), 42);
    let mut events = state.events.subscribe();
    crate::events::ingest_inbound(
        crate::app_server::InboundMessage::Notification {
            method: "thread/started".into(),
            params: json!({"thread":thread}),
        },
        &state,
    )
    .await
    .unwrap();
    let mut metadata = None;
    while let Ok(event) = events.try_recv() {
        if event.kind == "timeline.thread_metadata" {
            metadata = Some(event);
        }
    }
    let event = metadata.expect("native started metadata");
    assert_eq!(event.payload["thread"]["section"], section);
    assert_eq!(event.payload["thread"]["sectionEnteredAt"], 42);
    assert_eq!(event.payload["thread"]["projectId"], "project-1");
    assert_eq!(event.payload["thread"]["notificationsEnabled"], false);
    assert_eq!(
        event.payload["thread"]["seenCompletedTurnId"],
        "completed-before-start"
    );
    assert_eq!(
        event.payload["thread"]["latestCompletedTurnId"],
        "completed-before-start"
    );
    assert_eq!(event.payload["thread"]["readRevision"], seen.read_revision);
    assert_eq!(event.payload["thread"]["readStateKnown"], true);
    assert_eq!(event.payload["thread"]["unreadCompletedAgentTurn"], false);
    assert!(event.payload["thread"].get("pinnedAt").is_none());
}
