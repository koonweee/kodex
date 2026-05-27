use serde_json::json;
use std::sync::{atomic::Ordering, Arc};

use crate::{
    api::AppState, app_server::tests::RecordingAppServer, config::Config, store::Store,
    thread_view::THREAD_VIEW_REFRESH_REQUIRED_EVENT_KIND,
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
async fn turn_completed_reconciles_bounded_full_recent_head_without_replaying_history() {
    let (state, app_server) = test_state_with_app_server().await;
    app_server.queued_responses.lock().unwrap().push(json!({
        "data": [{
            "id": "turn-2",
            "status": {"type": "completed"},
            "items": [{"id": "item-agent-2", "type": "agentMessage", "text": "durable second"}]
        }, {
            "id": "turn-1",
            "status": {"type": "completed"},
            "items": [{"id": "item-agent-1", "type": "agentMessage", "text": "durable first"}]
        }],
        "nextCursor": "older-cursor",
        "backwardsCursor": null
    }));
    let mut receiver = state.events.subscribe();

    ingest_inbound(
        InboundMessage::Notification {
            method: "turn/completed".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-2"
            }),
        },
        &state,
    )
    .await
    .unwrap();

    let patch = receiver.recv().await.unwrap();
    assert_eq!(patch.kind, THREAD_VIEW_PATCH_EVENT_KIND);
    assert_eq!(patch.payload["scope"], "full_snapshot");
    assert_eq!(patch.payload["liveState"], "idle");
    let rows = patch.payload["rows"].as_array().expect("patch rows");
    assert_eq!(rows[0]["item"]["turnId"], "turn-1");
    assert_eq!(rows[0]["item"]["payload"]["item"]["text"], "durable first");
    assert_eq!(rows[1]["item"]["turnId"], "turn-2");
    assert_eq!(rows[1]["item"]["payload"]["item"]["text"], "durable second");

    let requests = app_server.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].0, "thread/turns/list");
    assert_eq!(
        requests[0].1,
        json!({
            "threadId": "thread-1",
            "cursor": null,
            "sortDirection": "desc",
            "itemsView": "full",
            "limit": TURN_COMPLETION_HEAD_REFRESH_LIMIT
        })
    );
    drop(requests);

    let persisted = state.store.replay_events(None, None, None).await.unwrap();
    assert!(persisted.iter().any(|event| {
        event.kind == THREAD_VIEW_CURSOR_KIND && event.payload["sourceMethod"] == "turn/completed"
    }));
    assert!(persisted
        .iter()
        .all(|event| event.kind != "timeline.item_upsert"));
    let persisted_json = serde_json::to_string(&persisted).unwrap();
    assert!(!persisted_json.contains("item-agent-1"));
    assert!(!persisted_json.contains("durable second"));
}

#[tokio::test]
async fn notification_ingest_emits_thread_view_patch_for_timeline_delta() {
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
    assert_eq!(patch.codex_method.as_deref(), Some("thread_view/patch"));
    assert_eq!(patch.thread_id.as_deref(), Some("thread-1"));
    assert_eq!(patch.payload["threadId"], "thread-1");
    assert_eq!(patch.payload["scope"], "turn");
    assert_eq!(patch.payload["activeTurnId"], "turn-1");
    assert_eq!(patch.payload["liveState"], "streaming");
    assert!(patch.payload.get("rows").is_none());
    assert_eq!(
        patch.payload["upsertRows"][0]["item"]["payload"]["item"]["text"],
        "hello"
    );
    assert!(patch.payload.get("items").is_none());

    let replay = state
        .store
        .replay_events(None, None, Some("thread-1".to_string()))
        .await
        .unwrap();
    assert_eq!(replay.len(), 1);
    assert_eq!(replay[0].kind, THREAD_VIEW_CURSOR_KIND);
    assert_eq!(replay[0].payload["sourceMethod"], "item/agentMessage/delta");
    assert!(replay[0].payload.get("delta").is_none());
    assert!(replay
        .iter()
        .all(|event| event.kind != "thread_view.refresh_required"));
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

#[tokio::test]
async fn notification_ingest_commits_pending_skill_mentions_to_user_item() {
    let state = test_state().await;
    let mut receiver = state.events.subscribe();
    state
        .store
        .insert_pending_timeline_skill_mentions(
            "thread-1",
            "Use $agent-browser",
            &[app_server_api::TimelineSkillMention {
                start: 4,
                end: 18,
                name: "agent-browser".to_string(),
                path: "/skills/agent-browser/SKILL.md".to_string(),
                display_name: Some("Agent Browser".to_string()),
                scope: Some("user".to_string()),
                short_description: Some("Automate browser tasks".to_string()),
                brand_color: Some("#23a55a".to_string()),
                icon_small_url: Some(
                    "/v1/skills/icon?path=%2Fskills%2Fagent-browser%2Ficon.png".to_string(),
                ),
            }],
        )
        .await
        .unwrap();

    ingest_inbound(
        InboundMessage::Notification {
            method: "item/completed".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "item-user-1",
                "item": {
                    "id": "item-user-1",
                    "type": "userMessage",
                    "content": [
                        {
                            "type": "text",
                            "text": "Use $agent-browser",
                            "text_elements": [{
                                "byteRange": {"start": 4, "end": 18},
                                "placeholder": "$agent-browser"
                            }]
                        },
                        {"type": "skill", "name": "agent-browser", "path": "/skills/agent-browser/SKILL.md"}
                    ]
                }
            }),
        },
        &state,
    )
    .await
    .unwrap();

    let patch = receiver.recv().await.unwrap();
    assert_eq!(patch.kind, THREAD_VIEW_PATCH_EVENT_KIND);
    let rows = patch.payload["upsertRows"].as_array().expect("patch rows");
    assert_eq!(
        rows[0]["item"]["payload"]["itemSnapshot"]["skillMentions"],
        json!([{
            "start": 4,
            "end": 18,
            "name": "agent-browser",
            "path": "/skills/agent-browser/SKILL.md",
            "displayName": "Agent Browser",
            "scope": "user",
            "shortDescription": "Automate browser tasks",
            "brandColor": "#23a55a",
            "iconSmallUrl": "/v1/skills/icon?path=%2Fskills%2Fagent-browser%2Ficon.png"
        }])
    );
    let persisted = state
        .store
        .timeline_skill_mentions_for_items("thread-1", &["item-user-1".to_string()])
        .await
        .unwrap();
    assert_eq!(persisted["item-user-1"][0].name, "agent-browser");
    assert_eq!(
        persisted["item-user-1"][0].display_name.as_deref(),
        Some("Agent Browser")
    );
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
    let thread = thread_summary_from_value(&json!({
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
async fn selected_thread_reconciliation_polls_recent_threads_and_coalesces_reads() {
    let store = Store::in_memory().await.unwrap();
    let app_server = Arc::new(RecordingAppServer::default());
    app_server.ready.store(true, Ordering::SeqCst);
    let state = AppState::new(Config::default(), store, app_server.clone());
    *app_server.next_response.lock().unwrap() = Some(json!({
        "data": [{
            "id": "thread-1",
            "cliVersion": "0.130.0",
            "cwd": "/workspace",
            "ephemeral": false,
            "modelProvider": "openai",
            "preview": "hello",
            "source": "cli",
            "status": {"type": "active"},
            "turns": [],
            "createdAt": 1_i64,
            "updatedAt": 2_i64
        }],
        "nextCursor": null,
        "backwardsCursor": null
    }));
    let mut sync = SelectedThreadSync::default();

    let event = reconcile_selected_thread(&state, "thread-1", 10, &mut sync)
        .await
        .unwrap()
        .unwrap();
    sync.last_snapshot_updated_at = Some(2);
    *app_server.next_response.lock().unwrap() = Some(json!({
        "data": [{
            "id": "thread-1",
            "cliVersion": "0.130.0",
            "cwd": "/workspace",
            "ephemeral": false,
            "modelProvider": "openai",
            "preview": "hello",
            "source": "cli",
            "status": {"type": "active"},
            "turns": [],
            "createdAt": 1_i64,
            "updatedAt": 2_i64
        }],
        "nextCursor": null,
        "backwardsCursor": null
    }));
    let coalesced = reconcile_selected_thread(&state, "thread-1", 10, &mut sync)
        .await
        .unwrap();

    assert_eq!(event.kind, THREAD_VIEW_REFRESH_REQUIRED_EVENT_KIND);
    assert_eq!(event.seq, 10);
    assert_eq!(event.thread_id.as_deref(), Some("thread-1"));
    assert_eq!(event.payload["reason"], "thread_changed");
    assert!(coalesced.is_none());
    let requests = app_server.requests.lock().unwrap();
    assert_eq!(requests[0].0, "thread/list");
    assert_eq!(requests[0].1["sortKey"], "updated_at");
    assert_eq!(requests[0].1["limit"], SELECTED_THREAD_POLL_LIMIT);
    assert_eq!(requests[1].0, "thread/list");
    assert_eq!(requests.len(), 2);
}
