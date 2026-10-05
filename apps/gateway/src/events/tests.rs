use serde_json::json;
use std::sync::{atomic::Ordering, Arc};

use crate::{
    api::AppState,
    app_server::tests::RecordingAppServer,
    config::Config,
    store::Store,
    thread_view::{THREAD_VIEW_ITEM_DELTA_EVENT_KIND, THREAD_VIEW_REFRESH_REQUIRED_EVENT_KIND},
};

use super::*;

async fn test_state_with_app_server() -> (AppState, Arc<RecordingAppServer>) {
    let store = Store::in_memory().await.unwrap();
    let app_server = Arc::new(RecordingAppServer::default());
    app_server.ready.store(true, Ordering::SeqCst);
    (
        AppState::new(Config::default(), store, app_server.clone()),
        app_server,
    )
}

async fn test_state() -> AppState {
    test_state_with_app_server().await.0
}

fn mcp_app_resource_response() -> Value {
    json!({
        "contents": [{
            "uri": "ui://docs/dashboard",
            "mimeType": "text/html;profile=mcp-app",
            "text": "<!doctype html><h1>Docs dashboard</h1>",
            "_meta": {
                "ui": {
                    "csp": {
                        "resourceDomains": ["data:"]
                    }
                }
            }
        }]
    })
}

fn mcp_server_status_response() -> Value {
    json!({
        "data": [{
            "name": "docs",
            "authStatus": "unsupported",
            "tools": {
                "lookup": {
                    "name": "lookup",
                    "inputSchema": {},
                    "_meta": {"ui": {"visibility": ["app"]}}
                },
                "model_only": {
                    "name": "model_only",
                    "inputSchema": {},
                    "_meta": {"ui": {"visibility": ["model"]}}
                }
            },
            "resources": [{
                "name": "extra",
                "uri": "ui://docs/extra",
                "mimeType": "text/plain"
            }],
            "resourceTemplates": []
        }],
        "nextCursor": null
    })
}

fn mcp_app_tool_item() -> Value {
    json!({
        "id": "item-mcp-app",
        "type": "mcpToolCall",
        "server": "docs",
        "tool": "lookup",
        "arguments": {"query": "widgets"},
        "status": "completed",
        "mcpAppResourceUri": "ui://docs/dashboard",
        "result": {
            "content": [{"type": "text", "text": "Dashboard ready"}],
            "structuredContent": {"count": 3},
            "_meta": {"trace": "mcp-result-1"}
        },
        "error": null
    })
}

#[tokio::test]
async fn notification_ingest_persists_thread_view_cursor_before_broadcast() {
    let state = test_state().await;
    let mut receiver = state.events.subscribe();

    ingest_inbound(
        InboundMessage::Notification {
            method: "turn/completed".to_string(),
            params: json!({"threadId": "thread-1", "turn": {"id": "turn-1"}}),
        },
        &state,
    )
    .await
    .unwrap();

    let broadcast = receiver.recv().await.unwrap();
    assert_eq!(broadcast.kind, THREAD_VIEW_PATCH_EVENT_KIND);
    let replay = state
        .store
        .replay_events(None, None, Some("thread-1".to_string()))
        .await
        .unwrap();
    assert!(replay.iter().any(|event| {
        event.kind == THREAD_VIEW_CURSOR_KIND
            && event.thread_id.as_deref() == Some("thread-1")
            && event.turn_id.as_deref() == Some("turn-1")
    }));
    assert!(replay
        .iter()
        .all(|event| event.kind != "codex.notification"));
}

#[tokio::test]
async fn native_skill_content_projects_live_canonical_patch_without_catalog_or_fifo() {
    let (state, native) = test_state_with_app_server().await;
    let mut receiver = state.events.subscribe();
    let content = json!([
        {"type":"text","text":"🧪 $missing","text_elements":[{"byteRange":{"start":5,"end":13}}]},
        {"type":"skill","name":"missing","path":"/unavailable/SKILL.md"}
    ]);
    ingest_inbound(
        InboundMessage::Notification {
            method: "item/completed".to_string(),
            params: json!({"threadId":"thread-1","turnId":"turn-1","item":{
                "id":"native-user","type":"userMessage","content":content
            }}),
        },
        &state,
    )
    .await
    .unwrap();
    let patch = receiver.recv().await.unwrap();
    assert_eq!(patch.kind, THREAD_VIEW_PATCH_EVENT_KIND);
    let row = &patch.payload["rows"][0]["item"];
    assert_eq!(row["itemId"], "native-user");
    assert_eq!(row["payload"]["item"]["content"], content);
    assert_eq!(
        row["payload"]["itemSnapshot"]["skillMentions"],
        json!([
            {"start":3,"end":11,"name":"missing","path":"/unavailable/SKILL.md"}
        ])
    );
    assert!(native.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn mcp_tool_item_with_app_resource_creates_app_surface_session() {
    let (state, app_server) = test_state_with_app_server().await;
    let worker = app_surfaces::start_import_worker(&state).unwrap();
    app_server
        .queued_responses
        .lock()
        .unwrap()
        .extend([mcp_app_resource_response(), mcp_server_status_response()]);
    let mut receiver = state.events.subscribe();

    ingest_inbound(
        InboundMessage::Notification {
            method: "item/completed".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": mcp_app_tool_item()
            }),
        },
        &state,
    )
    .await
    .unwrap();

    let patch = receiver.recv().await.unwrap();
    assert_eq!(patch.kind, THREAD_VIEW_PATCH_EVENT_KIND);
    let app_surface_event = receiver.recv().await.unwrap();
    assert_eq!(app_surface_event.kind, "app_surface.session_upserted");
    assert_eq!(app_surface_event.thread_id.as_deref(), Some("thread-1"));
    assert_eq!(app_surface_event.payload["provider"], "mcp");
    assert_eq!(
        app_surface_event.payload["resourceUri"],
        "ui://docs/dashboard"
    );
    assert_eq!(
        app_surface_event.payload["fallbackContent"],
        "Dashboard ready"
    );
    assert_eq!(
        app_surface_event.payload["grants"]["tools"],
        json!([{"name": "lookup", "server": "docs", "tool": "lookup"}])
    );

    let session = state
        .store
        .latest_app_surface_session("thread-1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(session.provider.as_str(), "mcp");
    assert_eq!(session.revision, 1);
    assert!(session.html.contains("Docs dashboard"));
    assert_eq!(
        session.provenance["mcp"]["result"]["structuredContent"]["count"],
        3
    );

    worker.shutdown().await;
    let requests = app_server.requests.lock().unwrap();
    assert_eq!(requests[0].0, "mcpServer/resource/read");
    assert_eq!(requests[0].1["server"], "docs");
    assert_eq!(requests[0].1["uri"], "ui://docs/dashboard");
    assert_eq!(requests[1].0, "mcpServerStatus/list");
}

#[tokio::test]
async fn turn_completed_requests_canonical_refill_without_blocking_ingestion_on_history() {
    let (state, app_server) = test_state_with_app_server().await;
    let mut receiver = state.events.subscribe();
    ingest_inbound(
        InboundMessage::Notification {
            method: "turn/completed".into(),
            params: json!({"threadId": "thread-1", "turnId": "turn-2"}),
        },
        &state,
    )
    .await
    .unwrap();
    let refill = receiver.recv().await.unwrap();
    assert_eq!(
        refill.kind,
        thread_view::THREAD_VIEW_REFRESH_REQUIRED_EVENT_KIND
    );
    assert_eq!(refill.thread_id.as_deref(), Some("thread-1"));
    assert!(
        refill.payload.get("rows").is_none(),
        "refill is not transcript history"
    );
    assert!(
        app_server.requests.lock().unwrap().is_empty(),
        "completion ingestion cannot await its own transport"
    );
    let persisted = state.store.replay_events(None, None, None).await.unwrap();
    assert!(persisted.iter().any(|event| {
        event.kind == THREAD_VIEW_CURSOR_KIND && event.payload["sourceMethod"] == "turn/completed"
    }));
    assert!(persisted
        .iter()
        .all(|event| event.kind != "thread_view.item_upsert_observed"));
}

#[tokio::test]
async fn notification_ingest_emits_thread_view_item_delta_for_timeline_delta() {
    let state = test_state().await;
    let mut receiver = state.events.subscribe();

    ingest_inbound(
        InboundMessage::Notification {
            method: "item/agentMessage/delta".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "item-1",
                "delta": "hello"
            }),
        },
        &state,
    )
    .await
    .unwrap();

    let patch = timeout(Duration::from_secs(1), receiver.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(patch.kind, THREAD_VIEW_PATCH_EVENT_KIND);
    assert_eq!(patch.payload["scope"], "full_snapshot");
    assert_eq!(
        patch.payload["rows"][0]["item"]["payload"]["item"]["text"],
        "hello"
    );
    assert!(patch.payload.get("items").is_none());

    ingest_inbound(
        InboundMessage::Notification {
            method: "item/agentMessage/delta".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "item-1",
                "delta": " world"
            }),
        },
        &state,
    )
    .await
    .unwrap();

    let patch = timeout(Duration::from_secs(1), receiver.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(patch.kind, THREAD_VIEW_ITEM_DELTA_EVENT_KIND);
    assert_eq!(
        patch.codex_method.as_deref(),
        Some("thread_view/item_delta")
    );
    assert_eq!(patch.thread_id.as_deref(), Some("thread-1"));
    assert_eq!(patch.payload["threadId"], "thread-1");
    assert_eq!(patch.payload["turnId"], "turn-1");
    assert_eq!(patch.payload["itemId"], "item-1");
    assert_eq!(patch.payload["delta"], " world");
    assert_eq!(patch.payload["viewRevision"], patch.seq);
    assert!(patch.payload.get("items").is_none());
    assert!(patch.payload.get("rows").is_none());

    let replay = state
        .store
        .replay_events(None, None, Some("thread-1".to_string()))
        .await
        .unwrap();
    assert_eq!(replay.len(), 2);
    assert!(replay.iter().all(|event| {
        event.kind == THREAD_VIEW_CURSOR_KIND
            && event.payload["sourceMethod"] == "item/agentMessage/delta"
            && event.payload.get("delta").is_none()
    }));
    assert!(replay
        .iter()
        .all(|event| event.kind != "thread_view.refresh_required"));
}

#[tokio::test]
async fn late_assistant_delta_after_terminal_turn_does_not_emit_item_delta() {
    let state = test_state().await;
    let mut receiver = state.events.subscribe();

    ingest_inbound(
        InboundMessage::Notification {
            method: "turn/completed".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "status": {"type": "completed"},
                    "items": [{"id": "item-1", "type": "agentMessage", "text": "Final"}]
                }
            }),
        },
        &state,
    )
    .await
    .unwrap();
    let terminal_patch = receiver.recv().await.unwrap();
    assert_eq!(terminal_patch.kind, THREAD_VIEW_PATCH_EVENT_KIND);
    while timeout(Duration::from_millis(10), receiver.recv())
        .await
        .is_ok()
    {}

    ingest_inbound(
        InboundMessage::Notification {
            method: "item/agentMessage/delta".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "item-1",
                "delta": " stale"
            }),
        },
        &state,
    )
    .await
    .unwrap();

    let late_event = timeout(Duration::from_millis(50), receiver.recv()).await;
    assert!(
        late_event.is_err(),
        "late terminal delta should not broadcast a live item delta"
    );
}

#[tokio::test]
async fn assistant_delta_events_stay_under_synthetic_byte_budget() {
    let state = test_state().await;
    let mut receiver = state.events.subscribe();
    let mut total_bytes = 0usize;
    let mut max_bytes = 0usize;

    for index in 0..100 {
        ingest_inbound(
            InboundMessage::Notification {
                method: "item/agentMessage/delta".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-1",
                    "delta": format!("chunk-{index};")
                }),
            },
            &state,
        )
        .await
        .unwrap();

        let event = timeout(Duration::from_secs(1), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        if index == 0 {
            assert_eq!(event.kind, THREAD_VIEW_PATCH_EVENT_KIND);
            continue;
        }
        assert_eq!(event.kind, THREAD_VIEW_ITEM_DELTA_EVENT_KIND);
        let bytes = serde_json::to_string(&event).unwrap().len();
        total_bytes += bytes;
        max_bytes = max_bytes.max(bytes);
    }

    assert!(
        max_bytes < 1024,
        "single assistant delta event should stay compact; max was {max_bytes} bytes"
    );
    assert!(
        total_bytes < 64 * 1024,
        "100 assistant delta events should stay compact; total was {total_bytes} bytes"
    );
}

#[tokio::test]
async fn item_upsert_events_use_row_delta_when_live_turn_patch_would_resend_large_rows() {
    let state = test_state().await;
    let mut receiver = state.events.subscribe();
    let large_text = "Large active assistant row ".repeat(500);

    ingest_inbound(
        InboundMessage::Notification {
            method: "item/upsert".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {
                    "id": "agent-1",
                    "type": "agentMessage",
                    "text": large_text
                }
            }),
        },
        &state,
    )
    .await
    .unwrap();
    let seed_patch = timeout(Duration::from_secs(1), receiver.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(seed_patch.kind, THREAD_VIEW_PATCH_EVENT_KIND);

    ingest_inbound(
        InboundMessage::Notification {
            method: "item/upsert".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {
                    "id": "command-1",
                    "type": "commandExecution",
                    "status": "running",
                    "command": "cargo test",
                    "output": "still running"
                }
            }),
        },
        &state,
    )
    .await
    .unwrap();

    let event = timeout(Duration::from_secs(1), receiver.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event.kind, THREAD_VIEW_PATCH_EVENT_KIND);
    assert_eq!(event.payload["scope"], "row_delta");
    assert_eq!(event.payload["affectedTurnIds"], json!(["turn-1"]));
    assert!(event.payload["removedRowIds"]
        .as_array()
        .is_none_or(Vec::is_empty));
    let rows = event.payload["rows"].as_array().expect("row delta rows");
    assert!(!rows.is_empty());
    assert!(
        !serde_json::to_string(&event).unwrap().contains(&large_text),
        "row delta should not resend unchanged large assistant rows"
    );
}

#[tokio::test]
async fn native_thread_status_changed_emits_exact_canonical_status_patch() {
    let state = test_state().await;
    let mut receiver = state.events.subscribe();

    ingest_inbound(
        InboundMessage::Notification {
            method: "thread/status/changed".to_string(),
            params: json!({
                "threadId": "thread-1",
                "status": {"type": "systemError"},
            }),
        },
        &state,
    )
    .await
    .unwrap();

    let patch = timeout(Duration::from_secs(1), receiver.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(patch.kind, THREAD_VIEW_PATCH_EVENT_KIND);
    assert_eq!(patch.thread_id.as_deref(), Some("thread-1"));
    assert_eq!(patch.payload["scope"], "lifecycle");
    assert_eq!(patch.payload["liveState"], "idle");
    assert_eq!(patch.payload["threadStatus"], "systemError");

    let replay = state
        .store
        .replay_events(None, None, Some("thread-1".to_string()))
        .await
        .unwrap();
    assert!(replay.iter().any(|event| {
        event.kind == THREAD_VIEW_CURSOR_KIND
            && event.payload["sourceKind"] == "thread_view.status_changed"
            && event.payload["sourceMethod"] == "thread/status/changed"
    }));
}

#[tokio::test]
async fn native_not_loaded_status_clears_active_canonical_projection() {
    let state = test_state().await;
    ingest_inbound(
        InboundMessage::Notification {
            method: "turn/started".to_string(),
            params: json!({
                "threadId":"thread-1",
                "turn":{"id":"stale-turn","status":"inProgress","items":[]}
            }),
        },
        &state,
    )
    .await
    .unwrap();
    assert_eq!(
        state
            .thread_views
            .active_turn_id("thread-1")
            .await
            .as_deref(),
        Some("stale-turn")
    );
    let mut receiver = state.events.subscribe();

    ingest_inbound(
        InboundMessage::Notification {
            method: "thread/status/changed".to_string(),
            params: json!({
                "threadId": "thread-1",
                "status": {"type": "notLoaded"},
            }),
        },
        &state,
    )
    .await
    .unwrap();

    let patch = timeout(Duration::from_secs(1), receiver.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(patch.kind, THREAD_VIEW_PATCH_EVENT_KIND);
    assert_eq!(patch.payload["liveState"], "notLoaded");
    assert_eq!(patch.payload["threadStatus"], "notLoaded");

    assert_eq!(state.thread_views.active_turn_id("thread-1").await, None);
    assert_eq!(
        state
            .thread_views
            .patch_for_thread("thread-1")
            .await
            .live_state,
        ThreadLiveState::NotLoaded
    );
}

#[tokio::test]
async fn realtime_transcript_notifications_persist_only_cursor_metadata() {
    let state = test_state().await;

    ingest_inbound(
        InboundMessage::Notification {
            method: "thread/realtime/transcript/delta".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "delta": "secret live transcript"
            }),
        },
        &state,
    )
    .await
    .unwrap();

    let replay = state.store.replay_events(None, None, None).await.unwrap();
    let raw = replay
        .iter()
        .find(|event| event.payload["sourceMethod"] == "thread/realtime/transcript/delta")
        .unwrap();
    assert_eq!(raw.kind, THREAD_VIEW_CURSOR_KIND);
    assert_eq!(raw.thread_id.as_deref(), Some("thread-1"));
    assert_eq!(raw.turn_id.as_deref(), Some("turn-1"));
    assert_eq!(
        raw.payload["sourceMethod"],
        "thread/realtime/transcript/delta"
    );
    assert!(raw.payload.get("delta").is_none());
    assert!(raw.payload.get("text").is_none());
}

#[tokio::test]
async fn notification_ingest_emits_normalized_mcp_lifecycle_events() {
    let state = test_state().await;
    let mut receiver = state.events.subscribe();

    ingest_inbound(
        InboundMessage::Notification {
            method: "mcpServer/startupStatus/updated".to_string(),
            params: json!({
                "name": "docs",
                "status": "ready",
                "error": null
            }),
        },
        &state,
    )
    .await
    .unwrap();

    let normalized = receiver.recv().await.unwrap();
    assert_eq!(normalized.kind, MCP_SERVER_STATUS_UPDATED_EVENT);
    assert_eq!(
        normalized.codex_method.as_deref(),
        Some("mcpServer/startupStatus/updated")
    );
    assert_eq!(normalized.payload["name"], "docs");
    assert_eq!(normalized.payload["status"], "ready");

    ingest_inbound(
        InboundMessage::Notification {
            method: "mcpServer/oauthLogin/completed".to_string(),
            params: json!({
                "name": "docs",
                "success": true,
                "error": null
            }),
        },
        &state,
    )
    .await
    .unwrap();

    let normalized = receiver.recv().await.unwrap();
    assert_eq!(normalized.kind, MCP_OAUTH_LOGIN_COMPLETED_EVENT);
    assert_eq!(
        normalized.codex_method.as_deref(),
        Some("mcpServer/oauthLogin/completed")
    );
    assert_eq!(normalized.payload["success"], true);

    let replay = state.store.replay_events(None, None, None).await.unwrap();
    assert!(replay
        .iter()
        .any(|event| event.kind == MCP_SERVER_STATUS_UPDATED_EVENT));
    assert!(replay
        .iter()
        .any(|event| event.kind == MCP_OAUTH_LOGIN_COMPLETED_EVENT));
}

#[test]
fn thread_view_refresh_required_uses_current_cursor_without_advancing_high_water() {
    let event = thread_view_refresh_required_event(42, "thread-1".to_string(), "lagged").unwrap();

    assert_eq!(event.seq, 42);
    assert_eq!(event.kind, THREAD_VIEW_REFRESH_REQUIRED_EVENT_KIND);
    assert_eq!(event.thread_id.as_deref(), Some("thread-1"));
    assert_eq!(event.payload["reason"], "lagged");
}

#[test]
fn thread_metadata_summary_preserves_git_branch() {
    let thread = ThreadSummary::from_payload(&json!({
        "id": "thread-1",
        "cliVersion": "0.130.0",
        "cwd": "/workspace",
        "ephemeral": false,
        "gitInfo": {
            "branch": "feature/git-underflow",
            "originUrl": null,
            "sha": "abc123"
        },
        "modelProvider": "openai",
        "preview": "hello",
        "source": "cli",
        "status": {"type": "idle"},
        "turns": [],
        "createdAt": 1_i64,
        "updatedAt": 2_i64
    }))
    .unwrap();

    assert_eq!(
        thread
            .git_info
            .as_ref()
            .and_then(|git_info| git_info.branch.as_deref()),
        Some("feature/git-underflow")
    );
}

#[tokio::test]
async fn thread_metadata_patch_emits_git_info_update() {
    let state = test_state().await;
    let mut receiver = state.events.subscribe();

    ingest_inbound(
        InboundMessage::Notification {
            method: "thread/metadata/update".to_string(),
            params: json!({
                "threadId": "thread-1",
                "gitInfo": {
                    "branch": "feature/git-underflow",
                    "originUrl": null,
                    "sha": "abc123"
                }
            }),
        },
        &state,
    )
    .await
    .unwrap();

    let normalized = receiver.recv().await.unwrap();
    assert_eq!(normalized.kind, "timeline.thread_metadata");
    assert_eq!(normalized.thread_id.as_deref(), Some("thread-1"));
    assert_eq!(normalized.payload["threadId"], "thread-1");
    assert_eq!(normalized.payload["thread"], Value::Null);
    assert_eq!(
        normalized.payload["gitInfo"]["branch"],
        "feature/git-underflow"
    );
}

#[tokio::test]
async fn thread_metadata_patch_preserves_omitted_git_info_fields() {
    let state = test_state().await;
    let mut receiver = state.events.subscribe();

    ingest_inbound(
        InboundMessage::Notification {
            method: "thread/metadata/update".to_string(),
            params: json!({
                "threadId": "thread-1",
                "gitInfo": {
                    "sha": "abc123"
                }
            }),
        },
        &state,
    )
    .await
    .unwrap();

    let normalized = receiver.recv().await.unwrap();
    assert_eq!(normalized.kind, "timeline.thread_metadata");
    assert_eq!(normalized.payload["threadId"], "thread-1");
    assert!(normalized.payload["gitInfo"].get("branch").is_none());
    assert_eq!(normalized.payload["gitInfo"]["sha"], "abc123");
}

#[tokio::test]
async fn unsupported_callback_returns_method_not_found_instead_of_hanging() {
    let (state, app_server) = test_state_with_app_server().await;
    ingest_inbound(
        InboundMessage::ServerRequest {
            request_id: "42".into(),
            method: "unknown/request".into(),
            params: json!({"threadId":"thread-1"}),
        },
        &state,
    )
    .await
    .unwrap();
    let errors = app_server.error_responses.lock().unwrap();
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].0, "42");
    assert_eq!(errors[0].1.code, -32601);
    assert!(errors[0].1.message.contains("unknown/request"));
    assert!(state
        .store
        .list_approvals(None, None)
        .await
        .unwrap()
        .is_empty());
}
