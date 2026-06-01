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

fn subagent_thread_summary(
    id: &str,
    parent_thread_id: &str,
    created_at: i64,
    updated_at: i64,
    nickname: &str,
    role: &str,
    status: &str,
) -> Value {
    json!({
        "id": id,
        "cliVersion": "0.135.0",
        "cwd": "/workspace",
        "ephemeral": false,
        "modelProvider": "openai",
        "preview": "hello",
        "source": {
            "subAgent": {
                "thread_spawn": {
                    "parent_thread_id": parent_thread_id,
                    "depth": 1,
                    "agent_nickname": nickname,
                    "agent_role": role
                }
            }
        },
        "agentNickname": nickname,
        "agentRole": role,
        "status": {"type": status},
        "turns": [],
        "createdAt": created_at,
        "updatedAt": updated_at
    })
}

fn thread_read_response_with_context_compaction(thread_id: &str) -> Value {
    json!({
        "thread": {
            "id": thread_id,
            "cliVersion": "0.135.0",
            "cwd": "/workspace",
            "ephemeral": false,
            "modelProvider": "openai",
            "source": "cli",
            "status": {"type": "idle"},
            "turns": [{
                "id": "turn-compact",
                "status": {"type": "completed"},
                "items": [{
                    "id": "compact-1",
                    "type": "contextCompaction"
                }]
            }],
            "createdAt": 1_767_225_600_i64,
            "updatedAt": 1_767_225_600_i64
        }
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
        .all(|event| event.kind != "thread_view.item_upsert_observed"));
    let persisted_json = serde_json::to_string(&persisted).unwrap();
    assert!(!persisted_json.contains("item-agent-1"));
    assert!(!persisted_json.contains("durable second"));
}

#[tokio::test]
async fn thread_compacted_refetches_snapshot_and_clears_runtime() {
    let (state, app_server) = test_state_with_app_server().await;
    state
        .store
        .upsert_thread_runtime_state(ThreadRuntimeState {
            thread_id: "thread-1".to_string(),
            status: "syncing".to_string(),
            active_turn_id: None,
            updated_at: Utc::now(),
            last_event_seq: Some(10),
        })
        .await
        .unwrap();
    app_server
        .queued_responses
        .lock()
        .unwrap()
        .push(thread_read_response_with_context_compaction("thread-1"));
    let mut receiver = state.events.subscribe();

    ingest_inbound(
        InboundMessage::Notification {
            method: "thread/compacted".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-compact"
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
    assert_eq!(patch.payload["scope"], "full_snapshot");
    assert_eq!(patch.payload["liveState"], "idle");
    assert_eq!(patch.payload["rows"][0]["kind"], "context_compaction");

    let runtime = state
        .store
        .get_thread_runtime_state("thread-1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(runtime.status, "idle");
    assert_eq!(runtime.active_turn_id, None);

    let requests = app_server.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].0, "thread/read");
    assert_eq!(
        requests[0].1,
        json!({"threadId": "thread-1", "includeTurns": true})
    );
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
    assert_eq!(patch.payload["affectedTurnIds"], json!(["turn-1"]));
    assert_eq!(
        patch.payload["rows"][0]["item"]["payload"]["item"]["text"],
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
async fn thread_started_subagent_updates_projection_and_emits_parent_event() {
    let state = test_state().await;
    let mut receiver = state.events.subscribe();

    ingest_inbound(
        InboundMessage::Notification {
            method: "thread/started".to_string(),
            params: json!({
                "thread": subagent_thread_summary("subagent-1", "thread-parent", 10, 20, "Scout", "explorer", "active")
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
    assert_eq!(event.kind, THREAD_SUBAGENT_STARTED_EVENT);
    assert_eq!(event.thread_id.as_deref(), Some("thread-parent"));
    assert_eq!(event.payload["parentThreadId"], "thread-parent");
    assert_eq!(event.payload["subagentId"], "subagent-1");
    assert_eq!(event.payload["subagent"]["agentNickname"], "Scout");
    assert_eq!(event.payload["subagent"]["liveState"], "streaming");

    let subagents = state.subagents.list_descendants("thread-parent").await;
    assert_eq!(subagents.len(), 1);
    assert_eq!(subagents[0].id, "subagent-1");
}

#[tokio::test]
async fn duplicate_thread_started_subagent_does_not_emit_duplicate_projection_event() {
    let state = test_state().await;

    for _ in 0..2 {
        ingest_inbound(
            InboundMessage::Notification {
                method: "thread/started".to_string(),
                params: json!({
                    "thread": subagent_thread_summary("subagent-1", "thread-parent", 10, 20, "Scout", "explorer", "active")
                }),
            },
            &state,
        )
        .await
        .unwrap();
    }

    let replay = state
        .store
        .replay_events(None, None, Some("thread-parent".to_string()))
        .await
        .unwrap();
    assert_eq!(
        replay
            .iter()
            .filter(|event| event.kind == THREAD_SUBAGENT_STARTED_EVENT)
            .count(),
        1
    );
}

#[tokio::test]
async fn thread_status_changed_updates_known_subagent_under_parent() {
    let state = test_state().await;
    let _ = state
        .subagents
        .upsert_from_thread_summary(
            &thread_summary_from_value(&subagent_thread_summary(
                "subagent-1",
                "thread-parent",
                10,
                20,
                "Scout",
                "explorer",
                "active",
            ))
            .unwrap(),
        )
        .await;
    let mut receiver = state.events.subscribe();

    ingest_inbound(
        InboundMessage::Notification {
            method: "thread/status/changed".to_string(),
            params: json!({
                "threadId": "subagent-1",
                "status": {"type": "idle"},
                "updatedAt": 30
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
    assert_eq!(event.kind, THREAD_SUBAGENT_UPDATED_EVENT);
    assert_eq!(event.thread_id.as_deref(), Some("thread-parent"));
    assert_eq!(event.payload["subagent"]["status"], "idle");
    assert_eq!(event.payload["subagent"]["liveState"], "idle");
    assert_eq!(event.payload["subagent"]["updatedAt"], 30);
}

#[tokio::test]
async fn thread_closed_removes_known_subagent_without_fabricating_unknown_parent() {
    let state = test_state().await;
    let _ = state
        .subagents
        .upsert_from_thread_summary(
            &thread_summary_from_value(&subagent_thread_summary(
                "subagent-1",
                "thread-parent",
                10,
                20,
                "Scout",
                "explorer",
                "active",
            ))
            .unwrap(),
        )
        .await;
    let mut receiver = state.events.subscribe();

    ingest_inbound(
        InboundMessage::Notification {
            method: "thread/closed".to_string(),
            params: json!({"threadId": "subagent-1"}),
        },
        &state,
    )
    .await
    .unwrap();

    let event = timeout(Duration::from_secs(1), receiver.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event.kind, THREAD_SUBAGENT_STOPPED_EVENT);
    assert_eq!(event.thread_id.as_deref(), Some("thread-parent"));
    assert!(state
        .subagents
        .list_descendants("thread-parent")
        .await
        .is_empty());

    ingest_inbound(
        InboundMessage::Notification {
            method: "thread/closed".to_string(),
            params: json!({"threadId": "unknown-subagent"}),
        },
        &state,
    )
    .await
    .unwrap();
    let replay = state
        .store
        .replay_events(None, None, Some("unknown-subagent".to_string()))
        .await
        .unwrap();
    assert!(replay
        .iter()
        .all(|event| event.kind != THREAD_SUBAGENT_STOPPED_EVENT));
}

#[tokio::test]
async fn subagent_hook_marks_parent_for_repair_and_emits_parent_refresh_event() {
    let state = test_state().await;
    state
        .subagents
        .replace_repaired_descendants("thread-parent", Vec::new())
        .await;
    assert!(!state.subagents.needs_repair("thread-parent").await);
    let mut receiver = state.events.subscribe();

    ingest_inbound(
        InboundMessage::Notification {
            method: "hook/started".to_string(),
            params: json!({
                "threadId": "thread-parent",
                "run": {
                    "id": "hook-1",
                    "eventName": "subagentStart"
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
    assert_eq!(event.kind, THREAD_SUBAGENTS_CHANGED_EVENT);
    assert_eq!(event.thread_id.as_deref(), Some("thread-parent"));
    assert!(state.subagents.needs_repair("thread-parent").await);
}

#[tokio::test]
async fn native_not_loaded_status_clears_active_runtime_routing() {
    let state = test_state().await;
    state
        .store
        .upsert_thread_runtime_state(ThreadRuntimeState {
            thread_id: "thread-1".to_string(),
            status: "active".to_string(),
            active_turn_id: Some("stale-turn".to_string()),
            updated_at: Utc::now(),
            last_event_seq: Some(10),
        })
        .await
        .unwrap();
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

    let runtime = state
        .store
        .get_thread_runtime_state("thread-1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(runtime.status, "idle");
    assert_eq!(runtime.active_turn_id, None);
    assert!(runtime.last_event_seq.is_some());

    let routed_active_turn_id = crate::turn_lifecycle::routed_active_turn_id(&state, "thread-1")
        .await
        .unwrap();
    assert_eq!(routed_active_turn_id, None);
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
    let rows = patch.payload["rows"].as_array().expect("patch rows");
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
