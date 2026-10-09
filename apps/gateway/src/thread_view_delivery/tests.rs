use super::*;
use crate::app_server_api::{ThreadItemSnapshot, ThreadTurnSnapshot};
use crate::thread_view::ThreadViewPatch;
use serde_json::{json, Value};

fn snapshot() -> ThreadTimelineSnapshot {
    let values = [
        json!({"id":"user", "type":"userMessage", "clientId":"attempt-1", "content":[{"type":"text", "text":"hello $example", "text_elements":[{"byteRange":{"start":6,"end":14},"placeholder":"$example"}]}, {"type":"skill", "name":"example", "path":"/tmp/skill"}]}),
        json!({"id":"command", "type":"commandExecution", "command":"echo hi", "cwd":"/tmp", "status":"completed", "aggregatedOutput":"private output", "stdout":"private stdout", "stderr":"private stderr"}),
        json!({"id":"hidden", "type":"subAgentActivity", "text":"diagnostic body", "output":"diagnostic output"}),
    ];
    ThreadTimelineSnapshot::from_turns(
        "thread",
        &[ThreadTurnSnapshot {
            id: "turn".into(),
            status: "inProgress".into(),
            started_at: Some(100),
            completed_at: None,
            items: values
                .iter()
                .map(|item| ThreadItemSnapshot::from_payload(item).unwrap())
                .collect(),
            raw_payload: Value::Null,
        }],
    )
}

fn contains(value: &impl serde::Serialize, text: &str) -> bool {
    serde_json::to_string(value).unwrap().contains(text)
}

#[test]
fn two_readers_have_independent_details_without_losing_canonical_state() {
    let source = snapshot();
    let mut ordinary = source.clone();
    ThreadViewDeliveryQuery::default().project_snapshot(&mut ordinary);
    assert!(!contains(&ordinary, "private output"));
    assert!(!contains(&ordinary, "private stdout"));
    assert!(!contains(&ordinary, "diagnostic body"));
    assert!(contains(&ordinary, "echo hi"));
    assert!(contains(&ordinary, "attempt-1"));
    assert_eq!(ordinary.view_revision, source.view_revision);
    assert_eq!(ordinary.active_turn_id, source.active_turn_id);
    assert_eq!(
        ordinary.rows.iter().map(|row| &row.id).collect::<Vec<_>>(),
        source.rows.iter().map(|row| &row.id).collect::<Vec<_>>()
    );
    let mut detailed = source.clone();
    ThreadViewDeliveryQuery {
        include_debug_events: true,
        include_command_outputs: true,
    }
    .project_snapshot(&mut detailed);
    assert!(contains(&detailed, "private output"));
    assert!(contains(&detailed, "diagnostic body"));
    assert!(contains(&source, "private output"));
}

#[test]
fn debug_does_not_restore_disabled_command_outputs() {
    let mut view = snapshot();
    ThreadViewDeliveryQuery {
        include_debug_events: true,
        include_command_outputs: false,
    }
    .project_snapshot(&mut view);
    assert!(contains(&view, "diagnostic body"));
    assert!(!contains(&view, "private output"));
    assert!(!contains(&view, "private stdout"));
}

#[test]
fn canonical_item_omits_duplicate_envelope_but_retains_correlation_and_skills() {
    let view = snapshot();
    let value = serde_json::to_value(&view.rows[0].item).unwrap();
    assert_eq!(value["itemId"], "user");
    assert_eq!(value["payload"]["clientId"], "attempt-1");
    assert!(value["payload"]["skillMentions"].is_array());
    for field in ["source", "turnId", "itemId", "itemSnapshot"] {
        assert!(value["payload"].get(field).is_none(), "duplicate {field}");
    }
    for field in ["id", "type", "kind", "clientId", "fileAttachments"] {
        assert!(
            value["payload"]["item"].get(field).is_none(),
            "duplicate item {field}"
        );
    }
    assert!(contains(&view, "hello"));
}
#[tokio::test]
async fn two_sse_clients_receive_the_same_projection_with_different_details() {
    use crate::{
        api::{build_router, AppState},
        app_server::{tests::RecordingAppServer, InboundMessage},
        config::Config,
        events::ingest_inbound,
        store::Store,
    };
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use std::sync::Arc;
    use tower::ServiceExt;

    async fn next(body: &mut Body) -> Value {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(2), body.frame())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let data = frame.into_data().unwrap();
        let text = std::str::from_utf8(&data).unwrap();
        let value = text
            .lines()
            .find_map(|line| line.strip_prefix("data: "))
            .unwrap();
        serde_json::from_str(value).unwrap()
    }
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        Arc::new(RecordingAppServer::default()),
    );
    let router = build_router(state.clone());
    let mut bodies = Vec::new();
    for options in ["", "&includeDebugEvents=true&includeCommandOutputs=true"] {
        let response = router
            .clone()
            .oneshot(
                Request::get(format!("/v1/events?threadId=thread{options}"))
                    .header("accept", "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        bodies.push(response.into_body());
    }
    for (id, kind, text) in [
        ("command", "commandExecution", "accumulated output"),
        ("hidden", "subAgentActivity", "hidden detail"),
    ] {
        ingest_inbound(InboundMessage::Notification {method:"item/updated".into(), params:json!({
            "threadId":"thread", "turnId":"turn", "item":{"id":id, "type":kind, "command":"echo hi", "output":text, "text": if kind == "subAgentActivity" {Some(text)} else {None}}
        })}, &state).await.unwrap();
        let ordinary = next(&mut bodies[0]).await;
        let detailed = next(&mut bodies[1]).await;
        assert_eq!(ordinary["kind"], "thread_view.patch");
        assert_eq!(ordinary["seq"], detailed["seq"]);
        assert_eq!(
            ordinary["payload"]["viewRevision"],
            detailed["payload"]["viewRevision"]
        );
        assert_eq!(
            ordinary["payload"]["activeTurnId"],
            detailed["payload"]["activeTurnId"]
        );
        assert_eq!(ordinary["payload"]["scope"], detailed["payload"]["scope"]);
        assert!(contains(&detailed, text));
        assert!(!contains(&ordinary, text));
    }
}

#[test]
fn diagnostic_only_row_delta_keeps_identity_removals_and_turn_base() {
    let source = snapshot();
    let hidden = source
        .rows
        .iter()
        .find_map(|row| {
            if row
                .item
                .as_ref()
                .is_some_and(|item| item.item_id == "hidden")
            {
                Some(row.clone())
            } else {
                row.collapsed_rows
                    .iter()
                    .find(|row| {
                        row.item
                            .as_ref()
                            .is_some_and(|item| item.item_id == "hidden")
                    })
                    .cloned()
                    .map(Into::into)
            }
        })
        .unwrap();
    let mut patch = ThreadViewPatch::row_delta(
        42,
        "thread".into(),
        Some("turn".into()),
        source.live_state,
        source.pending_approval_requests.clone(),
        source.pending_user_input_requests.clone(),
        vec![hidden.into()],
        vec!["removed-row".into()],
        vec!["turn".into()],
        source.turns.clone(),
        vec![],
    );
    let before_id = patch.rows.as_ref().unwrap()[0].id.clone();
    ThreadViewDeliveryQuery::default().project_patch(&mut patch);
    assert_eq!(patch.rows.as_ref().unwrap()[0].id, before_id);
    assert_eq!(
        patch.rows.as_ref().unwrap()[0].turn_id.as_deref(),
        Some("turn")
    );
    assert_eq!(patch.removed_row_ids, ["removed-row"]);
    assert_eq!(patch.affected_turn_ids, ["turn"]);
    assert_eq!(patch.view_revision, 42);
    assert!(!contains(&patch, "diagnostic body"));
    assert_eq!(
        serde_json::to_value(&patch.rows.as_ref().unwrap()[0].item).unwrap()["payload"]["item"],
        json!({})
    );
}
#[test]
fn typed_and_wire_policy_match_for_every_detail_combination() {
    let mut source = snapshot();
    let extras = [
        json!({"id":"empty-reasoning", "type":"reasoning", "summary":[]}),
        json!({"id":"reasoning", "type":"reasoning", "summary":["visible reasoning"]}),
        json!({"id":"plan", "type":"plan", "text":"visible plan"}),
        json!({"id":"empty-plan", "type":"plan"}),
        json!({"id":"hook", "type":"hookPrompt", "text":"hidden prompt"}),
        json!({"id":"mcp", "type":"mcpToolCall", "tool":"read", "result":"visible tool result"}),
        json!({"id":"error", "type":"error", "text":"visible error"}),
        json!({"id":"warning", "type":"warning", "text":"visible warning"}),
    ];
    let extra = ThreadTimelineSnapshot::from_turns(
        "thread",
        &[ThreadTurnSnapshot {
            id: "other-turn".into(),
            status: "completed".into(),
            started_at: Some(90),
            completed_at: Some(95),
            items: extras
                .iter()
                .map(|item| ThreadItemSnapshot::from_payload(item).unwrap())
                .collect(),
            raw_payload: Value::Null,
        }],
    );
    source.rows.extend(extra.rows);
    for debug in [false, true] {
        for outputs in [false, true] {
            let delivery = ThreadViewDeliveryQuery {
                include_debug_events: debug,
                include_command_outputs: outputs,
            };
            let mut typed = source.clone();
            let mut wire = serde_json::to_value(&source).unwrap();
            delivery.project_snapshot(&mut typed);
            delivery.project_patch_payload(&mut wire);
            assert_eq!(serde_json::to_value(&typed).unwrap(), wire);
            assert!(contains(&wire, "visible error"));
            assert!(contains(&wire, "visible warning"));
            assert!(contains(&wire, "visible tool result"));
        }
    }
}

#[tokio::test]
async fn canonical_http_reads_apply_the_same_independent_detail_policy() {
    use crate::{
        api::{build_router, AppState},
        app_server::tests::RecordingAppServer,
        config::Config,
        store::Store,
    };
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
    };
    use std::sync::{atomic::Ordering, Arc};
    use tower::ServiceExt;
    for route in ["detail", "attach", "page"] {
        for (debug, outputs) in [(false, false), (true, false), (false, true), (true, true)] {
            let native = Arc::new(RecordingAppServer::default());
            native.ready.store(true, Ordering::SeqCst);
            let state = AppState::new(
                Config::default(),
                Store::in_memory().await.unwrap(),
                native.clone(),
            );
            let metadata = json!({"thread":{"id":"thread", "cwd":"/tmp", "createdAt":1, "updatedAt":2, "status":{"type":"idle"}, "turns":[]}});
            let page = json!({"data":[{"id":"turn", "status":"completed", "startedAt":1, "completedAt":2, "items":[
                {"id":"user", "type":"userMessage", "clientId":"client", "content":[{"type":"text", "text":"hello"}]},
                {"id":"command", "type":"commandExecution", "command":"echo hi", "status":"completed", "aggregatedOutput":"command body"},
                {"id":"hidden", "type":"subAgentActivity", "text":"hidden body"}
            ]}], "nextCursor":null});
            let headers = json!({"data":[{"id":"turn", "status":"completed", "items":[]}], "nextCursor":null});
            if route == "attach" {
                let mut resume = metadata.clone();
                resume["initialTurnsPage"] = page.clone();
                native
                    .queued_responses
                    .lock()
                    .unwrap()
                    .extend([resume, headers]);
            } else {
                native
                    .queued_responses
                    .lock()
                    .unwrap()
                    .extend([metadata, page, headers]);
            }
            let flags = format!("includeDebugEvents={debug}&includeCommandOutputs={outputs}");
            let uri = match route {
                "attach" => format!("/v1/threads/thread/attach?{flags}"),
                "page" => format!("/v1/threads/thread/timeline/pages?cursor=older&{flags}"),
                _ => format!("/v1/threads/thread?{flags}"),
            };
            let request = Request::builder()
                .method(if route == "attach" { "POST" } else { "GET" })
                .uri(uri)
                .body(Body::empty())
                .unwrap();
            let response = build_router(state.clone()).oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body: Value =
                serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                    .unwrap();
            assert_eq!(contains(&body, "command body"), outputs);
            assert_eq!(contains(&body, "hidden body"), debug);
            assert!(contains(&body, "echo hi"));
            assert_eq!(body["historyPage"]["loadedTurnCount"], 1);
            assert_eq!(body["timeline"]["liveState"], "idle");
            let source = state.thread_views.patch_for_thread("thread").await;
            assert!(
                contains(&source, "command body"),
                "response policy must not mutate shared source"
            );
            assert!(contains(&source, "hidden body"));
        }
    }
}
