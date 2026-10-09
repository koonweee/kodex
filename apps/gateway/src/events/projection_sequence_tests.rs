use std::sync::Arc;

use http_body_util::BodyExt;

use super::*;
use crate::{app_server::tests::RecordingAppServer, config::Config, store::Store};

const THREAD: &str = "streaming-thread";

#[tokio::test]
async fn canonical_delta_survives_an_equal_transport_cursor() {
    concurrent_projection_delivery(true, true).await;
}

#[tokio::test]
async fn canonical_delta_survives_a_later_transport_cursor() {
    concurrent_projection_delivery(true, false).await;
}

#[tokio::test]
async fn canonical_patch_survives_an_equal_transport_cursor() {
    concurrent_projection_delivery(false, true).await;
}

#[tokio::test]
async fn canonical_patch_survives_a_later_transport_cursor() {
    concurrent_projection_delivery(false, false).await;
}

#[tokio::test]
async fn delayed_live_queue_invalidation_survives_a_later_publisher_for_both_clients() {
    let mut state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        Arc::new(RecordingAppServer::default()),
    );
    state.events = broadcast::channel(1).0;
    let previous = append_warning(&state, "Already in the replay snapshot").await;
    let mut first_query = query(false);
    first_query.cursor = Some(0);
    let mut second_query = query(true);
    second_query.cursor = Some(0);
    let mut first = open_sse(&state, first_query).await;
    let mut second = open_sse(&state, second_query).await;
    for body in [&mut first, &mut second] {
        assert_eq!(next_sse(body).await.id, previous.id);
    }

    // The queue command has committed its refill marker but has not resumed
    // after append_event().await to broadcast it. An independent task wins.
    let queued = state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: Some(THREAD.into()),
            turn_id: None,
            item_id: None,
            kind: queue::QUEUE_CHANGED_EVENT.into(),
            codex_method: None,
            payload: json!({"threadId": THREAD}),
        })
        .await
        .unwrap();
    let later = append_warning(&state, "Concurrent native widget warning").await;
    state.events.send(later.clone()).unwrap();
    for body in [&mut first, &mut second] {
        assert_eq!(next_sse(body).await.id, later.id);
    }
    assert!(previous.seq < queued.seq && queued.seq < later.seq);

    state.events.send(queued.clone()).unwrap();
    for body in [&mut first, &mut second] {
        let event = next_sse(body).await;
        assert_eq!(event.id, queued.id);
        assert_eq!(event.payload, json!({"threadId": THREAD}));
    }

    // The delayed live marker must not rewind the cursor used after lag. The
    // persisted changes lost below must still replay from that maximum.
    let mut missed = Vec::new();
    for index in 0..3 {
        let event = append_warning(&state, &format!("Missed warning {index}")).await;
        state.events.send(event.clone()).unwrap();
        missed.push(event);
    }
    for body in [&mut first, &mut second] {
        let approval = next_sse(body).await;
        assert_eq!(approval.kind, crate::approvals::APPROVAL_CHANGED_EVENT);
        assert_eq!(approval.seq, later.seq);
        let refill = next_sse(body).await;
        assert_eq!(
            refill.kind,
            thread_view::THREAD_VIEW_REFRESH_REQUIRED_EVENT_KIND
        );
        assert_eq!(refill.seq, later.seq);
        assert!(timeout(Duration::from_secs(1), body.frame())
            .await
            .unwrap()
            .is_none());
    }
    let mut reconnect_query = query(true);
    reconnect_query.cursor = Some(later.seq);
    let mut reconnect = open_sse(&state, reconnect_query).await;
    for expected in missed {
        assert_eq!(next_sse(&mut reconnect).await.id, expected.id);
    }
}

async fn concurrent_projection_delivery(delta: bool, same_envelope: bool) {
    let native = Arc::new(RecordingAppServer::default());
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    ingest_inbound(
        InboundMessage::Notification {
            method: "item/started".into(),
            params: json!({"threadId": THREAD, "turnId": "turn", "item": {
                "id": "answer", "type": "agentMessage", "text": "Seed"
            }}),
        },
        &state,
    )
    .await
    .unwrap();

    // Separate native normalization from broadcast at its existing await
    // boundary. Another task can publish an artifact warning in between.
    let params = if delta {
        json!({"threadId": THREAD, "turnId": "turn", "itemId": "answer", "delta": " A"})
    } else {
        json!({"threadId": THREAD, "turnId": "turn", "item": {
            "id": "answer", "type": "agentMessage", "text": "Seed A"
        }})
    };
    let metadata = EventMetadata::from_payload(&params);
    let mut projection = if delta {
        timeline_item_delta_event(&state, "item/agentMessage/delta", &params, &metadata)
            .await
            .unwrap()
    } else {
        timeline_item_upsert_event(
            &state,
            "item/completed",
            &params,
            &metadata,
            TimelineUpdateSource::GatewayStream,
        )
        .await
        .unwrap()
    }
    .pop()
    .unwrap();
    let projection_revision = projection.payload["viewRevision"].as_i64().unwrap();
    let previous = append_warning(&state, "Already in the replay snapshot").await;
    let mut first_query = query(false);
    first_query.cursor = Some(projection.seq);
    let mut second_query = query(true);
    second_query.cursor = Some(projection.seq);
    let mut first = open_sse(&state, first_query).await;
    let mut second = open_sse(&state, second_query).await;
    for body in [&mut first, &mut second] {
        assert_eq!(next_sse(body).await.id, previous.id);
    }

    let warning = append_warning(
        &state,
        "Widget unavailable; the tool result remains available",
    )
    .await;
    state.events.send(warning.clone()).unwrap();
    for body in [&mut first, &mut second] {
        assert_eq!(next_sse(body).await.id, warning.id);
    }
    assert!(warning.seq > projection_revision);

    if same_envelope {
        // The real wrappers query the latest SQL cursor after capturing their
        // projection. This is the other possible side of the same interleave.
        projection = if delta {
            thread_view_item_delta_payload_event(
                &state,
                serde_json::from_value(projection.payload).unwrap(),
            )
            .await
            .unwrap()
        } else {
            thread_view_patch_payload_event(
                &state,
                serde_json::from_value(projection.payload).unwrap(),
            )
            .await
            .unwrap()
        };
        assert_eq!(projection.seq, warning.seq);
    } else {
        assert!(projection.seq < warning.seq);
    }
    state.events.send(projection.clone()).unwrap();
    for body in [&mut first, &mut second] {
        let delivered = next_sse(body).await;
        assert_eq!(delivered.kind, projection.kind);
        assert_eq!(delivered.seq, projection.seq);
        assert_eq!(delivered.payload, projection.payload);
        assert_eq!(delivered.payload["viewRevision"], projection_revision);
    }

    // An event already delivered by replay must not be delivered again when its
    // delayed live broadcast arrives after a canonical projection.
    state.events.send(previous).unwrap();
    let later = append_warning(&state, "Later notification").await;
    state.events.send(later.clone()).unwrap();
    for body in [&mut first, &mut second] {
        assert_eq!(next_sse(body).await.id, later.id);
    }

    let persisted = state
        .store
        .replay_events(None, None, Some(THREAD.into()))
        .await
        .unwrap();
    let replay = workspace_sse_replay_events(persisted, &query(true)).unwrap();
    assert!(replay
        .iter()
        .any(|event| event.kind == thread_view::THREAD_VIEW_REFRESH_REQUIRED_EVENT_KIND));
    assert!(replay.iter().all(|event| !matches!(
        event.kind.as_str(),
        THREAD_VIEW_PATCH_EVENT_KIND | THREAD_VIEW_ITEM_DELTA_EVENT_KIND
    )));
    assert!(native.requests.lock().unwrap().is_empty());
}

fn query(workspace: bool) -> EventsQuery {
    EventsQuery {
        cursor: None,
        project_id: None,
        thread_id: (!workspace).then(|| THREAD.into()),
        exclude_thread_id: None,
        include_global: workspace.then_some(true),
        thread_ids: workspace.then(|| THREAD.into()),
        include_debug_events: None,
        include_command_outputs: None,
    }
}

async fn open_sse(state: &AppState, query: EventsQuery) -> axum::body::Body {
    let mut headers = HeaderMap::new();
    headers.insert(header::ACCEPT, "text/event-stream".parse().unwrap());
    events(headers, State(state.clone()), Query(query))
        .await
        .unwrap()
        .into_body()
}

async fn append_warning(state: &AppState, message: &str) -> EventEnvelope {
    state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: Some(THREAD.into()),
            turn_id: None,
            item_id: None,
            kind: "gateway.warning".into(),
            codex_method: None,
            payload: json!({"message": message, "source": "app_surface_import"}),
        })
        .await
        .unwrap()
}

async fn next_sse(body: &mut axum::body::Body) -> EventEnvelope {
    let frame = timeout(Duration::from_secs(1), body.frame())
        .await
        .expect("a concurrent publisher must not hide a subscribed event")
        .unwrap()
        .unwrap()
        .into_data()
        .unwrap();
    let data = std::str::from_utf8(&frame)
        .unwrap()
        .lines()
        .find_map(|line| line.strip_prefix("data: "))
        .unwrap();
    serde_json::from_str(data).unwrap()
}
