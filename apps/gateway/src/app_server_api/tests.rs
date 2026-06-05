use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex as StdMutex,
};

use async_trait::async_trait;

use crate::{
    app_server::AppServer,
    error::{ApiError, ApiResult},
};

use std::sync::Arc;

use super::*;

#[derive(Default)]
struct RecordingServer {
    ready: AtomicBool,
    requests: StdMutex<Vec<(String, Value)>>,
    queued_responses: StdMutex<Vec<Value>>,
    response: StdMutex<Value>,
}

#[async_trait]
impl AppServer for RecordingServer {
    fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    fn readiness_error(&self) -> Option<String> {
        None
    }

    async fn request(&self, method: &str, params: Value) -> ApiResult<Value> {
        self.requests
            .lock()
            .unwrap()
            .push((method.to_string(), params));
        let mut queued_responses = self.queued_responses.lock().unwrap();
        if !queued_responses.is_empty() {
            return Ok(queued_responses.remove(0));
        }
        drop(queued_responses);
        Ok(self.response.lock().unwrap().clone())
    }

    async fn respond(&self, _request_id: &str, _result: Value) -> ApiResult<()> {
        Ok(())
    }
}

#[derive(Default)]
struct NotMaterializedHistoryServer {
    requests: StdMutex<Vec<(String, Value)>>,
}

#[async_trait]
impl AppServer for NotMaterializedHistoryServer {
    fn is_ready(&self) -> bool {
        true
    }

    fn readiness_error(&self) -> Option<String> {
        None
    }

    async fn request(&self, method: &str, params: Value) -> ApiResult<Value> {
        self.requests
            .lock()
            .unwrap()
            .push((method.to_string(), params));
        if method == "thread/turns/list" {
            return Err(ApiError::BadGateway(
                    "app-server error -32600: thread thread-1 is not materialized yet; thread/turns/list is unavailable before first user message".to_string(),
                ));
        }
        Ok(json!({
            "thread": {
                "id": "thread-1",
                "cliVersion": "0.130.0",
                "cwd": "/workspace",
                "ephemeral": false,
                "modelProvider": "openai",
                "preview": "pending",
                "source": "cli",
                "status": {"type": "active"},
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_600_i64
            }
        }))
    }

    async fn respond(&self, _request_id: &str, _result: Value) -> ApiResult<()> {
        Ok(())
    }
}

#[tokio::test]
async fn adapter_maps_thread_and_turn_methods() {
    let server = Arc::new(RecordingServer {
        ready: AtomicBool::new(true),
        response: StdMutex::new(thread_command_payload("thread-1")),
        ..Default::default()
    });
    let client = CodexClient::new(server.clone());

    let _ = client
        .thread_start(
            "project-1".to_string(),
            "/workspace".to_string(),
            json!({"prompt": "hi"}),
        )
        .await
        .unwrap();
    let _ = client
        .thread_resume("thread-1".to_string(), json!({"target": "latest"}))
        .await
        .unwrap();
    let _ = client
        .thread_fork("thread-1".to_string(), json!({"fromItemId": "item-1"}))
        .await
        .unwrap();
    let _ = client
        .turn_steer(
            "thread-1".to_string(),
            "turn-1".to_string(),
            vec![UserInput::Text {
                text: "continue".to_string(),
                text_elements: Vec::new(),
            }],
        )
        .await
        .unwrap();

    let requests = server.requests.lock().unwrap();
    assert_eq!(requests[0].0, "thread/start");
    assert_eq!(requests[0].1["projectId"], "project-1");
    assert_eq!(requests[0].1["cwd"], "/workspace");
    assert_eq!(requests[0].1["persistExtendedHistory"], true);
    assert_eq!(requests[1].0, "thread/resume");
    assert_eq!(requests[1].1["persistExtendedHistory"], true);
    assert_eq!(requests[1].1["excludeTurns"], true);
    assert_eq!(requests[2].0, "thread/fork");
    assert_eq!(requests[2].1["persistExtendedHistory"], true);
    assert_eq!(requests[3].0, "turn/steer");
    assert_eq!(requests[3].1["expectedTurnId"], "turn-1");
}

#[tokio::test]
async fn adapter_maps_thread_list_read_archive_and_turn_start_interrupt_methods() {
    let server = Arc::new(RecordingServer {
        ready: AtomicBool::new(true),
        response: StdMutex::new(json!({"data": [], "nextCursor": null})),
        ..Default::default()
    });
    let client = CodexClient::new(server.clone());

    client
        .thread_list(
            Some("/workspace".to_string()),
            Some("cursor-1".to_string()),
            Some(25),
        )
        .await
        .unwrap();
    client.thread_list_recent_updated(10).await.unwrap();
    client
        .thread_list_cwds_updated(
            vec!["/chat/a".to_string(), "/chat/b".to_string()],
            None,
            Some(50),
        )
        .await
        .unwrap();
    *server.response.lock().unwrap() = json!({"thread": thread_summary_payload("thread-1")});
    client.thread_read("thread-1".to_string()).await.unwrap();
    *server.response.lock().unwrap() = json!({"thread": thread_summary_payload("thread-1")});
    client
        .thread_read_summary("thread-1".to_string())
        .await
        .unwrap();
    *server.response.lock().unwrap() = json!({"archived": true});
    client.thread_archive("thread-1".to_string()).await.unwrap();
    client
        .turn_start(
            "thread-1".to_string(),
            vec![UserInput::Text {
                text: "hi".to_string(),
                text_elements: Vec::new(),
            }],
            TurnStartOptions::default(),
        )
        .await
        .unwrap();
    client
        .turn_interrupt("thread-1".to_string(), "turn-1".to_string())
        .await
        .unwrap();

    let requests = server.requests.lock().unwrap();
    assert_eq!(
        requests[0],
        (
            "thread/list".to_string(),
            json!({
                "cursor": "cursor-1",
                "limit": 25,
                "cwd": "/workspace",
                "sortKey": "updated_at",
                "sortDirection": "desc",
                "archived": false,
                "useStateDbOnly": true
            })
        )
    );
    assert_eq!(
        requests[1],
        (
            "thread/list".to_string(),
            json!({
                "cursor": null,
                "limit": 10,
                "cwd": null,
                "sortKey": "updated_at",
                "sortDirection": "desc",
                "archived": false,
                "useStateDbOnly": true
            })
        )
    );
    assert_eq!(
        requests[2],
        (
            "thread/list".to_string(),
            json!({
                "cursor": null,
                "limit": 50,
                "cwd": ["/chat/a", "/chat/b"],
                "sortKey": "updated_at",
                "sortDirection": "desc",
                "archived": false,
                "useStateDbOnly": true
            })
        )
    );
    assert_eq!(
        requests[3],
        (
            "thread/read".to_string(),
            json!({"threadId": "thread-1", "includeTurns": true})
        )
    );
    assert_eq!(
        requests[4],
        (
            "thread/read".to_string(),
            json!({"threadId": "thread-1", "includeTurns": false})
        )
    );
    assert_eq!(
        requests[5],
        (
            "thread/archive".to_string(),
            json!({"threadId": "thread-1"})
        )
    );
    assert_eq!(
        requests[6],
        (
            "turn/start".to_string(),
            json!({"threadId": "thread-1", "input": [{"type": "text", "text": "hi"}]})
        )
    );
    assert_eq!(
        requests[7],
        (
            "turn/interrupt".to_string(),
            json!({"threadId": "thread-1", "turnId": "turn-1"})
        )
    );
}

#[tokio::test]
async fn adapter_uses_schema_values_for_thread_turns_list() {
    let server = Arc::new(RecordingServer {
        ready: AtomicBool::new(true),
        response: StdMutex::new(json!({"data": [], "nextCursor": null, "backwardsCursor": null})),
        ..Default::default()
    });
    let client = CodexClient::new(server.clone());

    client
        .thread_turns_list_page(
            "thread-1".to_string(),
            Some("cursor-1".to_string()),
            SortDirection::Desc,
            ThreadTurnItemsView::NotLoaded,
            Some(10),
        )
        .await
        .unwrap();
    client
        .thread_turns_list_page(
            "thread-1".to_string(),
            None,
            SortDirection::Asc,
            ThreadTurnItemsView::Summary,
            None,
        )
        .await
        .unwrap();
    client
        .thread_turns_list_page(
            "thread-1".to_string(),
            None,
            SortDirection::Asc,
            ThreadTurnItemsView::Full,
            None,
        )
        .await
        .unwrap();

    let requests = server.requests.lock().unwrap();
    assert_eq!(
        requests[0],
        (
            "thread/turns/list".to_string(),
            json!({
                "threadId": "thread-1",
                "cursor": "cursor-1",
                "sortDirection": "desc",
                "itemsView": "notLoaded",
                "limit": 10
            })
        )
    );
    assert_eq!(requests[1].1["itemsView"], "summary");
    assert_eq!(requests[2].1["itemsView"], "full");
}

#[tokio::test]
async fn adapter_calls_mcp_server_tool_and_preserves_result_payload() {
    let server = Arc::new(RecordingServer {
        ready: AtomicBool::new(true),
        response: StdMutex::new(json!({
            "content": [{"type": "text", "text": "lookup complete"}],
            "structuredContent": {"answer": 42},
            "isError": false,
            "_meta": {"trace": "tool-call-1"}
        })),
        ..Default::default()
    });
    let client = CodexClient::new(server.clone());

    let response = client
        .mcp_tool_call(McpServerToolCallRequest {
            server: "docs".to_string(),
            thread_id: "thread-1".to_string(),
            tool: "lookup".to_string(),
            arguments: Some(json!({"query": "answer"})),
            meta: Some(json!({"source": "iframe"})),
        })
        .await
        .unwrap();

    assert_eq!(
        response.content,
        vec![json!({"type": "text", "text": "lookup complete"})]
    );
    assert_eq!(response.structured_content, Some(json!({"answer": 42})));
    assert_eq!(response.is_error, Some(false));
    assert_eq!(response.meta, Some(json!({"trace": "tool-call-1"})));

    let requests = server.requests.lock().unwrap();
    assert_eq!(
        requests[0],
        (
            "mcpServer/tool/call".to_string(),
            json!({
                "server": "docs",
                "threadId": "thread-1",
                "tool": "lookup",
                "arguments": {"query": "answer"},
                "_meta": {"source": "iframe"}
            })
        )
    );
}

#[tokio::test]
async fn adapter_reads_bounded_recent_history_window_and_counts_lightly() {
    let server = Arc::new(RecordingServer {
        ready: AtomicBool::new(true),
        queued_responses: StdMutex::new(vec![
            json!({
                "thread": {
                    "id": "thread-1",
                    "cliVersion": "0.130.0",
                    "cwd": "/workspace",
                    "status": {"type": "idle"},
                    "source": "cli",
                    "preview": "hi",
                    "createdAt": 1_i64,
                    "updatedAt": 2_i64
                }
            }),
            json!({
                "data": [{
                    "id": "turn-2",
                    "status": {"type": "completed"},
                    "items": [{"id": "agent-2", "type": "agentMessage", "text": "new"}]
                }],
                "nextCursor": "older",
                "backwardsCursor": "newer"
            }),
            json!({
                "data": [
                    {"id": "turn-2", "status": {"type": "completed"}},
                    {"id": "turn-1", "status": {"type": "completed"}}
                ],
                "nextCursor": null,
                "backwardsCursor": null
            }),
        ]),
        ..Default::default()
    });
    let client = CodexClient::new(server.clone());

    let response = client
        .thread_read_history_window("thread-1".to_string(), 50)
        .await
        .unwrap();

    assert_eq!(response.turns[0].id, "turn-2");
    assert_eq!(response.thread.last_completed_agent_turn_seq, Some(2));
    let history_page = response.history_page.unwrap();
    assert_eq!(history_page.older_cursor.as_deref(), Some("older"));
    assert!(history_page.has_older);

    let requests = server.requests.lock().unwrap();
    assert_eq!(requests[1].0, "thread/turns/list");
    assert_eq!(requests[1].1["sortDirection"], "desc");
    assert_eq!(requests[1].1["itemsView"], "full");
    assert_eq!(requests[1].1["limit"], 50);
    assert_eq!(requests[2].0, "thread/turns/list");
    assert_eq!(requests[2].1["itemsView"], "notLoaded");
    assert_eq!(requests[2].1["limit"], 200);
}

#[tokio::test]
async fn thread_read_full_history_returns_thread_shell_when_turns_not_materialized() {
    let server = Arc::new(NotMaterializedHistoryServer::default());
    let client = CodexClient::new(server.clone());

    let response = client
        .thread_read_full_history("thread-1".to_string())
        .await
        .unwrap();

    assert_eq!(response.thread.id, "thread-1");
    assert!(response.turns.is_empty());
    assert_eq!(response.timeline.items.len(), 0);
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests[0].0, "thread/read");
    assert_eq!(requests[1].0, "thread/turns/list");
}

#[test]
fn user_message_snapshot_projects_skill_mentions_from_text_elements() {
    let item = ThreadItemSnapshot::from_payload(&json!({
        "id": "user-1",
        "type": "userMessage",
        "content": [
            {
                "type": "text",
                "text": "Use 🚀 $review-fix",
                "text_elements": [{
                    "byteRange": {
                        "start": "Use 🚀 ".len(),
                        "end": "Use 🚀 $review-fix".len()
                    },
                    "placeholder": "$review-fix"
                }]
            },
            {"type": "skill", "name": "review-fix", "path": "/skills/review-fix/SKILL.md"}
        ]
    }))
    .unwrap();

    assert_eq!(
        item.skill_mentions,
        vec![TimelineSkillMention {
            start: "Use 🚀 ".encode_utf16().count() as u32,
            end: "Use 🚀 $review-fix".encode_utf16().count() as u32,
            name: "review-fix".to_string(),
            path: "/skills/review-fix/SKILL.md".to_string(),
            display_name: None,
            scope: None,
            short_description: None,
            brand_color: None,
            icon_small_url: None,
        }]
    );
}

#[test]
fn timeline_snapshot_item_serializes_compact_display_payload() {
    let large_output = "x".repeat(TIMELINE_PREVIEW_STRING_LIMIT + 1024);
    let turn = ThreadTurnSnapshot {
        id: "turn-1".to_string(),
        status: "completed".to_string(),
        started_at: Some(1),
        completed_at: Some(2),
        items: Vec::new(),
        raw_payload: json!({}),
    };
    let item = ThreadItemSnapshot::from_payload(&json!({
        "id": "command-1",
        "type": "commandExecution",
        "command": "cargo test",
        "aggregatedOutput": large_output,
        "internal": { "unbounded": "raw payload ballast" }
    }))
    .unwrap();

    let snapshot = ThreadTimelineSnapshotItem::from_turn_item("thread-1", &turn, &item, 1, true);
    let serialized = serde_json::to_value(&snapshot).unwrap();

    assert_eq!(serialized["payload"]["item"]["command"], "cargo test");
    assert!(serialized["payload"]["item"]["output"]
        .as_str()
        .unwrap()
        .ends_with("...[truncated]"));
    assert!(serialized["payload"]["item"]["internal"].is_null());
    assert!(serialized["payload"]["itemSnapshot"]["rawPayload"].is_null());
    assert!(serde_json::to_vec(&serialized).unwrap().len() < TIMELINE_PREVIEW_STRING_LIMIT + 2_000);
}

#[test]
fn user_message_snapshot_ignores_unstructured_or_mismatched_skill_ranges() {
    let manual = ThreadItemSnapshot::from_payload(&json!({
        "id": "user-1",
        "type": "userMessage",
        "content": [{"type": "text", "text": "Use $review-fix"}]
    }))
    .unwrap();
    assert!(manual.skill_mentions.is_empty());

    let mismatched = ThreadItemSnapshot::from_payload(&json!({
        "id": "user-1",
        "type": "userMessage",
        "content": [
            {
                "type": "text",
                "text": "Use $other",
                "text_elements": [{"byteRange": {"start": 4, "end": 10}}]
            },
            {"type": "skill", "name": "review-fix", "path": "/skills/review-fix/SKILL.md"}
        ]
    }))
    .unwrap();
    assert!(mismatched.skill_mentions.is_empty());
}

#[test]
fn skill_mention_enrichment_requires_enabled_name_and_path_match() {
    let mentions = vec![TimelineSkillMention {
        start: 4,
        end: 15,
        name: "review-fix".to_string(),
        path: "/skills/review-fix/SKILL.md".to_string(),
        display_name: None,
        scope: None,
        short_description: None,
        brand_color: None,
        icon_small_url: None,
    }];
    let skill = SkillMetadata {
        name: "other".to_string(),
        path: "/skills/review-fix/SKILL.md".to_string(),
        description: "Should not apply".to_string(),
        enabled: true,
        scope: "user".to_string(),
        short_description: Some("Wrong skill".to_string()),
        interface: Some(SkillInterface {
            display_name: Some("Wrong".to_string()),
            short_description: Some("Wrong skill".to_string()),
            brand_color: Some("#f00".to_string()),
            default_prompt: None,
            icon_small: Some("/skills/review-fix/icon.png".to_string()),
            icon_large: None,
        }),
    };

    let enriched = enrich_timeline_skill_mentions(mentions, &[skill]);

    assert!(enriched[0].display_name.is_none());
    assert!(enriched[0].scope.is_none());
    assert!(enriched[0].short_description.is_none());
    assert!(enriched[0].brand_color.is_none());
    assert!(enriched[0].icon_small_url.is_none());
}

#[test]
fn user_message_snapshot_recovers_file_attachments_from_path_envelope() {
    let snapshot = ThreadItemSnapshot::from_payload(&json!({
        "id": "user-1",
        "type": "userMessage",
        "content": [
            {
                "type": "text",
                "text": "Review this\n\n```kodex-attachments\n- .kodex/uploads/thread-1/upload-1/notes.md\n```"
            }
        ]
    }))
    .unwrap();

    assert_eq!(snapshot.file_attachments.len(), 1);
    assert_eq!(snapshot.file_attachments[0].file_name, "notes.md");
    assert_eq!(snapshot.file_attachments[0].extension, "md");
    assert_eq!(
        snapshot.file_attachments[0].relative_path,
        ".kodex/uploads/thread-1/upload-1/notes.md"
    );
}

#[test]
fn file_attachment_validation_rejects_forged_or_unsafe_paths() {
    let valid = TimelineFileAttachment {
        id: "file-1".to_string(),
        file_name: "notes.md".to_string(),
        extension: "wrong".to_string(),
        relative_path: ".kodex/uploads/thread-1/file-1/notes.md".to_string(),
        absolute_path: Some("/tmp/forged".to_string()),
        mime_type: Some("text/markdown".to_string()),
        size_bytes: 7,
    };
    let normalized = validate_file_attachments_for_thread("thread-1", vec![valid.clone()]).unwrap();
    assert_eq!(normalized[0].extension, "md");
    assert!(normalized[0].absolute_path.is_none());

    for relative_path in [
        "/etc/passwd",
        ".kodex/uploads/thread-1/file-1/../../secret.txt",
        ".kodex/uploads/thread-2/file-1/notes.md",
        ".kodex/uploads/thread-1/file-1/notes.md\n```",
    ] {
        let mut attachment = valid.clone();
        attachment.relative_path = relative_path.to_string();
        assert!(validate_file_attachments_for_thread("thread-1", vec![attachment]).is_err());
    }
}

#[tokio::test]
async fn adapter_maps_account_login_rate_limit_and_model_methods() {
    let server = Arc::new(RecordingServer {
        ready: AtomicBool::new(true),
        response: StdMutex::new(json!({"requiresOpenaiAuth": true, "account": null})),
        ..Default::default()
    });
    let client = CodexClient::new(server.clone());

    client.account_read(true).await.unwrap();
    *server.response.lock().unwrap() =
        json!({"type": "chatgpt", "loginId": "login-1", "authUrl": "https://example.test"});
    client.login_start(Some(false)).await.unwrap();
    client.login_cancel("login-1".to_string()).await.unwrap();
    client.logout().await.unwrap();
    *server.response.lock().unwrap() = json!({"rateLimits": null, "rateLimitsByLimitId": null});
    client.rate_limits_read().await.unwrap();
    *server.response.lock().unwrap() = json!({"data": [], "nextCursor": null});
    client.model_list(false).await.unwrap();

    let requests = server.requests.lock().unwrap();
    assert_eq!(
        requests[0],
        ("account/read".to_string(), json!({"refreshToken": true}))
    );
    assert_eq!(
        requests[1],
        (
            "account/login/start".to_string(),
            json!({"type": "chatgpt", "codexStreamlinedLogin": false})
        )
    );
    assert_eq!(
        requests[2],
        (
            "account/login/cancel".to_string(),
            json!({"loginId": "login-1"})
        )
    );
    assert_eq!(requests[3], ("account/logout".to_string(), Value::Null));
    assert_eq!(
        requests[4],
        ("account/rateLimits/read".to_string(), Value::Null)
    );
    assert_eq!(
        requests[5],
        ("model/list".to_string(), json!({"includeHidden": false}))
    );
}

#[tokio::test]
async fn adapter_reads_and_writes_composer_settings_with_execution_defaults() {
    let server = Arc::new(RecordingServer {
        ready: AtomicBool::new(true),
        response: StdMutex::new(json!({
            "config": {
                "model": "gpt-5.4",
                "model_reasoning_effort": "high",
                "service_tier": "fast",
                "default_permissions": ":workspace",
                "approval_policy": "on-request",
                "approvals_reviewer": "auto_review",
                "sandbox_mode": "workspace-write"
            },
            "origins": {}
        })),
        ..Default::default()
    });
    let client = CodexClient::new(server.clone());

    let settings = client
        .composer_settings(Some("/workspace".to_string()))
        .await
        .unwrap();
    assert_eq!(settings.model.as_deref(), Some("gpt-5.4"));
    assert_eq!(settings.effort.as_deref(), Some("high"));
    assert_eq!(settings.service_tier.as_deref(), Some("fast"));
    assert_eq!(
        settings.permission_profile_id.as_deref(),
        Some(":workspace")
    );
    assert_eq!(settings.approval_policy.as_deref(), Some("on-request"));
    assert_eq!(settings.approvals_reviewer.as_deref(), Some("auto_review"));
    assert_eq!(
        settings.permissions_preset,
        Some(ComposerPermissionsPreset::AutoReview)
    );

    *server.response.lock().unwrap() = json!({"ok": true});
    client
        .update_composer_settings(ComposerSettingsUpdateRequest {
            model: Some(Some("gpt-5.4".to_string())),
            effort: Some(Some("medium".to_string())),
            service_tier: Some(None),
            permission_profile_id: Some(Some(":read-only".to_string())),
            approval_policy: Some(Some("on-request".to_string())),
            approvals_reviewer: Some(Some("user".to_string())),
        })
        .await
        .unwrap();

    let requests = server.requests.lock().unwrap();
    assert_eq!(
        requests[0],
        (
            "config/read".to_string(),
            json!({"cwd": "/workspace", "includeLayers": false})
        )
    );
    assert_eq!(requests[1].0, "config/batchWrite");
    assert_eq!(
        requests[1].1,
        json!({
            "edits": [
                {"keyPath": "model", "mergeStrategy": "replace", "value": "gpt-5.4"},
                {"keyPath": "model_reasoning_effort", "mergeStrategy": "replace", "value": "medium"},
                {"keyPath": "service_tier", "mergeStrategy": "replace", "value": null},
                {"keyPath": "default_permissions", "mergeStrategy": "replace", "value": ":read-only"},
                {"keyPath": "approval_policy", "mergeStrategy": "replace", "value": "on-request"},
                {"keyPath": "approvals_reviewer", "mergeStrategy": "replace", "value": "user"}
            ],
            "reloadUserConfig": true
        })
    );
}

#[test]
fn composer_settings_permission_hint_is_read_only_and_conservative() {
    let default = ComposerSettingsResponse::from_payload(json!({
        "config": {
            "approval_policy": "on-request",
            "approvals_reviewer": "user",
            "sandbox_mode": "workspace-write"
        },
        "origins": {}
    }))
    .unwrap();
    assert_eq!(
        default.permissions_preset,
        Some(ComposerPermissionsPreset::Default)
    );

    let full_access = ComposerSettingsResponse::from_payload(json!({
        "config": {
            "approval_policy": "never",
            "approvals_reviewer": "user",
            "sandbox_mode": "workspace-write"
        },
        "origins": {}
    }))
    .unwrap();
    assert_eq!(
        full_access.permissions_preset,
        Some(ComposerPermissionsPreset::FullAccess)
    );
}

#[test]
fn thread_list_normalization_accepts_missing_optional_fields_and_rejects_drift() {
    let response = ThreadListResponse::from_payload(json!({
        "data": [thread_summary_payload("thread-1")]
    }))
    .unwrap();

    assert_eq!(response.threads[0].id, "thread-1");
    assert_eq!(response.threads[0].name, None);
    assert_eq!(response.next_cursor, None);
    assert!(ThreadListResponse::from_payload(json!({"data": [{"cwd": "/workspace"}]})).is_err());
    assert!(ThreadListResponse::from_payload(json!({
        "data": [{
            "id": "thread-1",
            "cwd": "/workspace",
            "status": "idle",
            "createdAt": 1_767_225_600_i64,
            "updatedAt": 1_767_225_600_i64
        }]
    }))
    .is_err());
    assert!(ThreadListResponse::from_payload(json!({
        "data": [{
            "id": "thread-1",
            "cwd": "/workspace",
            "status": {"type": "idle"},
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": 1_767_225_600_i64
        }]
    }))
    .is_err());
    assert!(ThreadListResponse::from_payload(json!({
        "data": [{
            "id": "thread-1",
            "cwd": "/workspace",
            "status": {"type": "unknown"},
            "createdAt": 1_767_225_600_i64,
            "updatedAt": 1_767_225_600_i64
        }]
    }))
    .is_err());
}

#[test]
fn thread_normalization_accepts_schema_correct_status_and_timestamps() {
    let response = ThreadListResponse::from_payload(json!({
        "data": [{
            "id": "thread-1",
            "cliVersion": "0.130.0",
            "cwd": "/workspace",
            "ephemeral": false,
            "gitInfo": {
                "branch": "feature/git-underflow",
                "originUrl": "git@github.com:example/kodex.git",
                "sha": "abc123"
            },
            "modelProvider": "openai",
            "preview": "hello",
            "source": "cli",
            "status": {"type": "active", "activeFlags": ["waitingOnUserInput"]},
            "turns": [],
            "createdAt": 1_767_225_600_i64,
            "updatedAt": 1_767_225_660_i64
        }]
    }))
    .unwrap();

    let thread = &response.threads[0];
    assert_eq!(thread.status, ThreadStatus::Active);
    assert_eq!(thread.created_at, 1_767_225_600);
    assert_eq!(thread.updated_at, 1_767_225_660);
    assert_eq!(
        thread
            .git_info
            .as_ref()
            .and_then(|git_info| git_info.branch.as_deref()),
        Some("feature/git-underflow")
    );
}

#[test]
fn thread_list_normalization_does_not_derive_completed_marker_from_turns() {
    let mut thread = thread_summary_payload("thread-1");
    thread["turns"] = json!([{
        "id": "turn-1",
        "status": {"type": "completed"},
        "items": []
    }]);
    let response = ThreadListResponse::from_payload(json!({"data": [thread]})).unwrap();

    assert_eq!(response.threads[0].last_completed_agent_turn_seq, None);
    assert_eq!(response.threads[0].seen_completed_agent_turn_seq, 0);
    assert!(!response.threads[0].unread_completed_agent_turn);
}

#[test]
fn thread_detail_normalization_accepts_missing_optional_fields_and_rejects_drift() {
    let response = ThreadDetailResponse::from_payload(json!({
        "thread": thread_summary_payload("thread-1")
    }))
    .unwrap();

    assert_eq!(response.thread.id, "thread-1");
    assert_eq!(response.thread.source.as_deref(), Some("cli"));
    assert!(ThreadDetailResponse::from_payload(json!({"thread": {"id": "thread-1"}})).is_err());
    assert!(ThreadDetailResponse::from_payload(json!({})).is_err());
}

#[test]
fn thread_detail_builds_canonical_timeline_snapshot_from_turns() {
    let mut thread = thread_summary_payload("thread-1");
    thread["turns"] = json!([{
        "id": "turn-1",
        "status": {"type": "completed"},
        "startedAt": 10,
        "completedAt": 12,
        "items": [
            {
                "id": "user-1",
                "type": "userMessage",
                "content": [{"type": "text", "text": "Hello"}]
            },
            {
                "id": "agent-1",
                "type": "agentMessage",
                "text": "Hi"
            }
        ]
    }]);

    let response = ThreadDetailResponse::from_payload(json!({ "thread": thread })).unwrap();

    assert_eq!(response.timeline.view_revision, 0);
    assert_eq!(response.timeline.items.len(), 2);
    assert_eq!(response.timeline.items[0].id, "projection-turn-1-user-1");
    assert_eq!(response.timeline.items[0].display_order, 1);
    assert_eq!(response.timeline.items[0].codex_method, "item/completed");
    assert_eq!(response.timeline.items[0].timestamp_ms, Some(10_000));
    assert_eq!(
        response.timeline.items[0].payload.source,
        TimelineUpdateSource::AppServerSnapshot
    );
    assert_eq!(response.timeline.items[1].id, "projection-turn-1-agent-1");
    assert_eq!(response.timeline.items[1].display_order, 2);
    assert_eq!(response.timeline.items[1].timestamp_ms, Some(12_000));
    let serialized_timeline = serde_json::to_value(&response.timeline).unwrap();
    assert!(
        serialized_timeline.get("items").is_none(),
        "selected-thread timeline responses should serialize rows without duplicate flat items"
    );
}

#[test]
fn thread_detail_live_state_requires_active_turn_not_just_active_thread() {
    let response = ThreadDetailResponse::from_payload(json!({
        "thread": {
            "id": "thread-1",
            "cliVersion": "0.130.0",
            "cwd": "/workspace",
            "ephemeral": false,
            "modelProvider": "openai",
            "preview": "hello",
            "source": "cli",
            "status": {"type": "active"},
            "turns": [{
                "id": "turn-1",
                "status": {"type": "completed"},
                "items": []
            }],
            "createdAt": 1_767_225_600_i64,
            "updatedAt": 1_767_225_600_i64
        }
    }))
    .unwrap();
    assert_eq!(response.live_state, ThreadLiveState::Idle);

    let response = ThreadDetailResponse::from_payload(json!({
        "thread": {
            "id": "thread-1",
            "cliVersion": "0.130.0",
            "cwd": "/workspace",
            "ephemeral": false,
            "modelProvider": "openai",
            "preview": "hello",
            "source": "cli",
            "status": {"type": "active"},
            "turns": [{
                "id": "turn-1",
                "status": {"type": "running"},
                "items": []
            }],
            "createdAt": 1_767_225_600_i64,
            "updatedAt": 1_767_225_600_i64
        }
    }))
    .unwrap();
    assert_eq!(response.live_state, ThreadLiveState::Streaming);
}

#[test]
fn thread_command_normalization_accepts_missing_optional_fields_and_rejects_drift() {
    let response = ThreadCommandResponse::from_payload(json!({
        "thread": thread_summary_payload("thread-1")
    }))
    .unwrap();

    assert_eq!(response.thread.id, "thread-1");
    assert_eq!(response.model, None);
    assert_eq!(response.model_provider, None);
    let response = ThreadCommandResponse::from_payload(thread_command_payload("thread-1")).unwrap();
    assert_eq!(response.thread.model.as_deref(), Some("gpt-5.4"));
    assert_eq!(response.thread.reasoning_effort.as_deref(), Some("high"));
    assert_eq!(response.thread.service_tier.as_deref(), Some("fast"));
    assert_eq!(
        response.thread.approvals_reviewer.as_deref(),
        Some("auto_review")
    );
    assert_eq!(response.sandbox, Some(json!({"type": "dangerFullAccess"})));
    assert_eq!(
        response.thread.sandbox,
        Some(json!({"type": "dangerFullAccess"}))
    );
    assert!(ThreadCommandResponse::from_payload(json!({"thread": {"id": "thread-1"}})).is_err());
    assert!(ThreadCommandResponse::from_payload(json!({})).is_err());
}

#[test]
fn model_list_normalization_accepts_optional_fields_and_rejects_drift() {
    let response = ModelListResponse::from_payload(
        json!({
            "data": [model_payload("visible", false), model_payload("hidden", true)]
        }),
        false,
    )
    .unwrap();

    assert_eq!(response.models.len(), 1);
    assert_eq!(response.models[0].input_modalities, vec!["text", "image"]);
    assert_eq!(response.models[0].upgrade, None);
    assert!(ModelListResponse::from_payload(json!({"data": [{"id": "model"}]}), false).is_err());
}

#[test]
fn account_normalization_accepts_optional_account_fields_and_rejects_drift() {
    let unauthenticated = AccountResponse::from_payload(json!({
        "requiresOpenaiAuth": true,
        "account": null
    }))
    .unwrap();
    assert!(unauthenticated.account.is_none());

    let authenticated = AccountResponse::from_payload(json!({
        "requiresOpenaiAuth": false,
        "account": {"type": "chatgpt"}
    }))
    .unwrap();
    let account = authenticated.account.unwrap();
    assert_eq!(account.account_type, "chatgpt");
    assert_eq!(account.email, None);
    assert!(AccountResponse::from_payload(json!({"account": null})).is_err());
    assert!(AccountResponse::from_payload(json!({
        "requiresOpenaiAuth": false,
        "account": {}
    }))
    .is_err());
}

#[test]
fn rate_limit_normalization_accepts_optional_fields_and_rejects_drift() {
    let empty = RateLimitsResponse::from_payload(json!({
        "rateLimits": null,
        "rateLimitsByLimitId": null
    }))
    .unwrap();
    assert!(empty.rate_limits.is_none());

    let response = RateLimitsResponse::from_payload(json!({
        "rateLimits": {
            "primary": {"usedPercent": 42},
            "credits": {"hasCredits": false, "unlimited": true}
        },
        "rateLimitsByLimitId": {
            "codex": {"limitId": "codex"}
        }
    }))
    .unwrap();
    assert_eq!(
        response.rate_limits.unwrap().primary.unwrap().used_percent,
        42
    );
    assert!(RateLimitsResponse::from_payload(json!({})).is_err());
    assert!(RateLimitsResponse::from_payload(json!({
        "rateLimits": {"primary": {}}
    }))
    .is_err());
    assert!(RateLimitsResponse::from_payload(json!({
        "rateLimits": {"credits": {"hasCredits": true}}
    }))
    .is_err());
}

#[test]
fn login_start_normalization_accepts_optional_fields_and_rejects_drift() {
    let response = LoginStartResponse::from_payload(json!({"type": "chatgpt"})).unwrap();

    assert_eq!(response.login_type, "chatgpt");
    assert_eq!(response.login_id, None);
    assert_eq!(response.auth_url, None);
    assert!(LoginStartResponse::from_payload(json!({"loginId": "login-1"})).is_err());
}

fn thread_command_payload(id: &str) -> Value {
    json!({
        "thread": thread_summary_payload(id),
        "cwd": "/workspace",
        "model": "gpt-5.4",
        "modelProvider": "openai",
        "reasoningEffort": "high",
        "serviceTier": "fast",
        "approvalPolicy": "on-request",
        "approvalsReviewer": "auto_review",
        "sandbox": {"type": "dangerFullAccess"}
    })
}

fn thread_summary_payload(id: &str) -> Value {
    json!({
        "id": id,
        "cliVersion": "0.130.0",
        "cwd": "/workspace",
        "ephemeral": false,
        "modelProvider": "openai",
        "preview": "hello",
        "source": "cli",
        "status": {"type": "idle"},
        "turns": [],
        "createdAt": 1_767_225_600_i64,
        "updatedAt": 1_767_225_600_i64
    })
}

fn model_payload(id: &str, hidden: bool) -> Value {
    json!({
        "id": id,
        "model": id,
        "displayName": id,
        "description": "Test model",
        "hidden": hidden,
        "isDefault": false,
        "defaultReasoningEffort": "medium",
        "supportedReasoningEfforts": [
            {"reasoningEffort": "medium", "description": "Balanced"}
        ]
    })
}
