use std::sync::Arc;

use axum::{
    body::Body,
    http::{header, Request},
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::{
    sync::broadcast,
    time::{timeout, Duration},
};
use tower::ServiceExt;

use crate::{
    api::{build_router, AppState},
    app_server::{tests::RecordingAppServer, InboundMessage},
    config::Config,
    store::{NewEvent, Store},
};

#[tokio::test]
async fn lagged_sse_closes_at_previous_cursor_and_reconnect_replays_missed_project_changes() {
    let mut state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        Arc::new(RecordingAppServer::default()),
    );
    state.events = broadcast::channel(1).0;
    let previous = state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: None,
            turn_id: None,
            item_id: None,
            kind: "gateway.warning".into(),
            codex_method: None,
            payload: json!({"message":"already seen"}),
        })
        .await
        .unwrap();
    let app = build_router(state.clone());
    let response = app
        .clone()
        .oneshot(
            Request::get("/v1/events?includeGlobal=true&threadIds=selected")
                .header(header::ACCEPT, "text/event-stream")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mut body = response.into_body();
    for index in 0..3 {
        super::ingest_inbound(
            InboundMessage::Notification {
                method: "project/changed".into(),
                params: json!({"projectId":format!("project-{index}"),"changeType":"updated"}),
            },
            &state,
        )
        .await
        .unwrap();
    }

    let approval = next_event(&mut body).await;
    assert_eq!(approval["kind"], "approval.changed");
    assert_eq!(approval["seq"], previous.seq);
    let refresh = next_event(&mut body).await;
    assert_eq!(refresh["kind"], "thread_view.refresh_required");
    assert_eq!(refresh["seq"], previous.seq);
    assert_eq!(refresh["payload"]["reason"], "lagged");
    assert!(
        timeout(Duration::from_secs(1), body.frame())
            .await
            .unwrap()
            .is_none(),
        "lagged stream must close before newer events can skip missed global changes"
    );

    let response = app
        .oneshot(
            Request::get(format!(
                "/v1/events?cursor={}&includeGlobal=true&threadIds=selected",
                previous.seq
            ))
            .header(header::ACCEPT, "text/event-stream")
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    let mut body = response.into_body();
    for index in 0..3 {
        let event = next_event(&mut body).await;
        assert_eq!(event["kind"], "project.changed");
        assert_eq!(event["payload"]["projectId"], format!("project-{index}"));
        assert_eq!(event["seq"], previous.seq + index + 1);
    }
}

async fn next_event(body: &mut Body) -> Value {
    let frame = timeout(Duration::from_secs(1), body.frame())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let bytes = frame.into_data().unwrap();
    let frame = std::str::from_utf8(&bytes).unwrap();
    serde_json::from_str(
        frame
            .lines()
            .find_map(|line| line.strip_prefix("data: "))
            .unwrap(),
    )
    .unwrap()
}
