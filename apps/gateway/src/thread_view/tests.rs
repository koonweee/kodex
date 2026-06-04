use super::*;
use crate::app_server_api::{ThreadTimelineRow, ThreadTimelineWorkDetailRow};

fn agent_message_item(id: &str, text: &str) -> Value {
    json!({
        "id": id,
        "type": "agentMessage",
        "text": text,
    })
}

fn final_agent_message_item(id: &str, text: &str) -> Value {
    json!({
        "id": id,
        "type": "agentMessage",
        "text": text,
        "phase": "final_answer",
    })
}

fn user_message_item(id: &str, text: &str) -> Value {
    json!({
        "id": id,
        "type": "userMessage",
        "content": [{"type": "text", "text": text}],
    })
}

fn command_execution_item(id: &str, command: &str, output: &str) -> Value {
    json!({
        "id": id,
        "type": "commandExecution",
        "status": "completed",
        "command": command,
        "output": output,
    })
}

fn active_turn_with_large_assistant(large_text: &str) -> ThreadTurnSnapshot {
    ThreadTurnSnapshot {
        id: "turn-1".to_string(),
        status: "inProgress".to_string(),
        started_at: Some(1),
        completed_at: None,
        raw_payload: json!({}),
        items: vec![
            ThreadItemSnapshot::from_payload(&user_message_item(
                "user-1",
                "Run the command and report progress",
            ))
            .unwrap(),
            ThreadItemSnapshot::from_payload(&agent_message_item("agent-1", large_text)).unwrap(),
            ThreadItemSnapshot::from_payload(&command_execution_item(
                "command-1",
                "cargo test",
                "initial",
            ))
            .unwrap(),
        ],
    }
}

fn only_work_row(timeline: &ThreadTimelineSnapshot) -> &ThreadTimelineRow {
    timeline
        .rows
        .iter()
        .find(|row| row.kind == "work")
        .expect("work row")
}

fn only_activity_detail_row(work: &ThreadTimelineRow) -> &ThreadTimelineWorkDetailRow {
    work.collapsed_rows
        .iter()
        .find(|row| row.kind == "activity")
        .expect("activity row")
}

fn root_row_text(row: &ThreadTimelineRow) -> Option<String> {
    row.item
        .as_ref()
        .and_then(|item| item.payload.item.text.as_deref())
        .map(str::to_string)
        .or_else(|| {
            row.item
                .as_ref()
                .and_then(|item| item.payload.item.content.as_ref())
                .map(|content| content.to_string())
        })
}

fn file_change_item(id: &str, path: &str, diff: &str) -> Value {
    json!({
        "id": id,
        "type": "fileChange",
        "changes": [{
            "path": path,
            "kind": "update",
            "diff": diff,
        }],
    })
}

fn context_compaction_item(id: &str) -> Value {
    json!({
        "id": id,
        "type": "contextCompaction",
    })
}

#[tokio::test]
async fn session_reconciles_pending_user_input_when_snapshot_materializes_item() {
    let sessions = ThreadViewStore::default();
    record_pending_user_input(
        &sessions,
        "thread-1",
        "turn-1",
        &[UserInput::Text {
            text: "Hello".to_string(),
            text_elements: Vec::new(),
        }],
        &[],
        1,
    )
    .await
    .unwrap();
    let completed_turn = ThreadTurnSnapshot {
        id: "turn-1".to_string(),
        status: "completed".to_string(),
        started_at: Some(1),
        completed_at: Some(2),
        raw_payload: json!({}),
        items: vec![ThreadItemSnapshot::from_payload(&json!({
            "id": "user-1",
            "type": "userMessage",
            "content": [{"type": "text", "text": "Hello"}]
        }))
        .unwrap()],
    };

    let timeline = build_thread_timeline(&sessions, "thread-1", &[completed_turn], 2)
        .await
        .unwrap();

    assert_eq!(timeline.items.len(), 1);
    assert_eq!(timeline.items[0].item_id, "user-1");
    assert_eq!(timeline.live_state, ThreadLiveState::Idle);
}

#[tokio::test]
async fn pending_user_input_returns_turn_scoped_patch() {
    let sessions = ThreadViewStore::default();
    let old_turn = ThreadTurnSnapshot {
        id: "turn-old".to_string(),
        status: "completed".to_string(),
        started_at: Some(1),
        completed_at: Some(2),
        raw_payload: json!({}),
        items: vec![ThreadItemSnapshot::from_payload(&agent_message_item(
            "agent-old",
            "Large old output",
        ))
        .unwrap()],
    };
    build_thread_timeline(&sessions, "thread-1", &[old_turn], 1)
        .await
        .unwrap();

    let patch = record_pending_user_input(
        &sessions,
        "thread-1",
        "turn-new",
        &[UserInput::Text {
            text: "New prompt".to_string(),
            text_elements: Vec::new(),
        }],
        &[],
        2,
    )
    .await
    .unwrap()
    .unwrap();

    assert_eq!(patch.scope, ThreadViewPatchScope::Turn);
    assert!(patch.validate_scope().is_ok());
    assert_eq!(patch.affected_turn_ids, vec!["turn-new"]);
    let rows = patch.rows.as_ref().expect("turn patch rows");
    assert!(!rows.is_empty());
    assert!(rows.len() < 3);
    assert_eq!(patch.turns.len(), 1);
    assert_eq!(patch.turns[0].id, "turn-new");
    assert_eq!(patch.items.len(), 1);
    assert_eq!(patch.items[0].turn_id, "turn-new");
    let serialized_value = serde_json::to_value(&patch).unwrap();
    assert!(
        serialized_value.get("items").is_none(),
        "thread_view.patch should not serialize duplicate flat items"
    );
    let serialized = serde_json::to_vec(&serialized_value).unwrap();
    assert!(
        serialized.len() < 8_000,
        "pending user input patch should stay bounded, got {} bytes",
        serialized.len()
    );
}

#[tokio::test]
async fn session_applies_live_delta_then_snapshot_without_duplicate() {
    let sessions = ThreadViewStore::default();
    record_item_delta(&sessions, "thread-1", "turn-1", "agent-1", "Hello", 1)
        .await
        .unwrap();
    record_item_delta(&sessions, "thread-1", "turn-1", "agent-1", " world", 2)
        .await
        .unwrap();

    let patch = patch_for_thread(&sessions, "thread-1").await.unwrap();
    assert_eq!(patch.items.len(), 1);
    let rows = patch.rows.as_ref().expect("full patch rows");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].kind, "assistant_message");
    assert_eq!(
        patch.items[0].payload.item.text.as_deref(),
        Some("Hello world")
    );
    assert_eq!(patch.active_turn_id.as_deref(), Some("turn-1"));

    let completed_turn = ThreadTurnSnapshot {
        id: "turn-1".to_string(),
        status: "completed".to_string(),
        started_at: Some(1),
        completed_at: Some(2),
        raw_payload: json!({}),
        items: vec![ThreadItemSnapshot::from_payload(&agent_message_item(
            "agent-1",
            "Hello world",
        ))
        .unwrap()],
    };
    let timeline = build_thread_timeline(&sessions, "thread-1", &[completed_turn], 3)
        .await
        .unwrap();

    assert_eq!(timeline.items.len(), 1);
    assert_eq!(timeline.items[0].item_id, "agent-1");
    assert_eq!(timeline.turns.len(), 1);
    assert_eq!(timeline.turns[0].started_at, Some(1));
    assert_eq!(timeline.turns[0].completed_at, Some(2));
    assert_eq!(timeline.active_turn_id, None);
}

#[tokio::test]
async fn completed_snapshot_drops_unmaterialized_live_items_for_terminal_turn() {
    let sessions = ThreadViewStore::default();
    record_item_delta(
        &sessions,
        "thread-1",
        "turn-1",
        "agent-live",
        "Draft answer",
        1,
    )
    .await
    .unwrap();

    let completed_turn = ThreadTurnSnapshot {
        id: "turn-1".to_string(),
        status: "completed".to_string(),
        started_at: Some(1),
        completed_at: Some(2),
        raw_payload: json!({}),
        items: vec![ThreadItemSnapshot::from_payload(&agent_message_item(
            "agent-final",
            "Final answer",
        ))
        .unwrap()],
    };
    let timeline = build_thread_timeline(&sessions, "thread-1", &[completed_turn], 3)
        .await
        .unwrap();

    assert_eq!(timeline.items.len(), 1);
    assert_eq!(timeline.items[0].item_id, "agent-final");
    assert_eq!(
        timeline.items[0].payload.item.text.as_deref(),
        Some("Final answer")
    );
    assert_eq!(timeline.active_turn_id, None);
    assert_eq!(timeline.live_state, ThreadLiveState::Idle);
}

#[tokio::test]
async fn item_delta_patch_upserts_only_affected_turn_rows() {
    let sessions = ThreadViewStore::default();
    build_thread_timeline(
        &sessions,
        "thread-1",
        &[ThreadTurnSnapshot {
            id: "turn-0".to_string(),
            status: "completed".to_string(),
            started_at: Some(1),
            completed_at: Some(2),
            raw_payload: json!({}),
            items: vec![
                ThreadItemSnapshot::from_payload(&user_message_item("user-0", "Previous")).unwrap(),
            ],
        }],
        1,
    )
    .await
    .unwrap();

    let patch = record_item_delta_patch(&sessions, "thread-1", "turn-1", "agent-1", "Hello", 2)
        .await
        .unwrap();

    assert_eq!(patch.scope, ThreadViewPatchScope::Turn);
    assert!(patch.validate_scope().is_ok());
    assert_eq!(patch.affected_turn_ids, vec!["turn-1"]);
    let turn_rows = patch.rows.as_ref().expect("turn patch rows");
    assert_eq!(turn_rows.len(), 1);
    assert_eq!(turn_rows[0].kind, "assistant_message");
    assert_eq!(patch.items.len(), 1);
    assert_eq!(patch.items[0].payload.item.text.as_deref(), Some("Hello"));
    let serialized_value = serde_json::to_value(&patch).unwrap();
    assert!(
        serialized_value.get("items").is_none(),
        "turn patches should serialize rows, not duplicate flat items"
    );
    assert_eq!(patch.turns.len(), 1);
    assert_eq!(patch.turns[0].id, "turn-1");
    assert_eq!(patch.active_turn_id.as_deref(), Some("turn-1"));

    let full_patch = patch_for_thread(&sessions, "thread-1").await.unwrap();
    assert_eq!(full_patch.scope, ThreadViewPatchScope::FullSnapshot);
    assert!(full_patch.validate_scope().is_ok());
    assert!(full_patch
        .rows
        .as_ref()
        .expect("full patch rows")
        .iter()
        .any(|row| row.id == turn_rows[0].id));
}

#[tokio::test]
async fn serialized_patch_sizes_do_not_include_historical_flat_items() {
    let sessions = ThreadViewStore::default();
    let large_text = "Large historical output ".repeat(200);
    let turns = (0..30)
        .map(|index| ThreadTurnSnapshot {
            id: format!("turn-{index}"),
            status: "completed".to_string(),
            started_at: Some(index),
            completed_at: Some(index + 1),
            raw_payload: json!({}),
            items: vec![ThreadItemSnapshot::from_payload(&agent_message_item(
                &format!("agent-{index}"),
                &large_text,
            ))
            .unwrap()],
        })
        .collect::<Vec<_>>();
    build_thread_timeline(&sessions, "thread-1", &turns, 1)
        .await
        .unwrap();

    let full_patch = patch_for_thread(&sessions, "thread-1").await.unwrap();
    let serialized_full = serde_json::to_value(&full_patch).unwrap();
    assert!(serialized_full.get("items").is_none());
    assert!(
        serde_json::to_vec(&serialized_full).unwrap().len() < 500_000,
        "full snapshot patch should not duplicate flat timeline items"
    );

    let turn_patch =
        record_item_delta_patch(&sessions, "thread-1", "turn-live", "agent-live", "hello", 2)
            .await
            .unwrap();
    let serialized_turn = serde_json::to_value(&turn_patch).unwrap();
    assert!(serialized_turn.get("items").is_none());
    assert!(
        !serialized_turn.to_string().contains(&large_text),
        "turn patch should not carry historical row payloads"
    );
    assert!(
        serde_json::to_vec(&serialized_turn).unwrap().len() < 20_000,
        "active-turn patch should scale with the active turn, not historical rows"
    );

    let lifecycle_patch = record_thread_live_state(&sessions, "thread-1", ThreadLiveState::Idle, 3)
        .await
        .unwrap();
    let serialized_lifecycle = serde_json::to_value(&lifecycle_patch).unwrap();
    assert!(serialized_lifecycle.get("items").is_none());
    assert!(
        serde_json::to_vec(&serialized_lifecycle).unwrap().len() < 2_000,
        "lifecycle patch should remain small"
    );
}

#[tokio::test]
async fn lifecycle_patch_carries_no_timeline_payload() {
    let sessions = ThreadViewStore::default();
    record_item_delta_patch(&sessions, "thread-1", "turn-1", "agent-1", "Hello", 1)
        .await
        .unwrap();

    let patch = record_thread_live_state(&sessions, "thread-1", ThreadLiveState::Idle, 2)
        .await
        .unwrap();

    assert_eq!(patch.scope, ThreadViewPatchScope::Lifecycle);
    assert!(patch.validate_scope().is_ok());
    assert!(patch.rows.is_none());
    assert!(patch.affected_turn_ids.is_empty());
    assert!(patch.turns.is_empty());
    assert!(patch.items.is_empty());
    let serialized = serde_json::to_vec(&patch).unwrap();
    assert!(
        serialized.len() < 2_000,
        "lifecycle patch should stay tiny, got {} bytes",
        serialized.len()
    );
}

#[tokio::test]
async fn row_delta_scope_validation_rejects_empty_or_cross_turn_payloads() {
    let sessions = ThreadViewStore::default();
    let large_text = "Large active assistant row ".repeat(500);
    build_thread_timeline(
        &sessions,
        "thread-1",
        &[active_turn_with_large_assistant(&large_text)],
        1,
    )
    .await
    .unwrap();
    let item = command_execution_item("command-1", "cargo test", "status update");
    let item_snapshot = ThreadItemSnapshot::from_payload(&item).unwrap();
    let patch = record_item_upsert(
        &sessions,
        "thread-1",
        "turn-1",
        item,
        item_snapshot,
        Some("running"),
        1,
    )
    .await
    .unwrap();
    assert_eq!(patch.scope, ThreadViewPatchScope::RowDelta);
    assert!(patch.validate_scope().is_ok());

    let mut empty = patch.clone();
    empty.rows = Some(Vec::new());
    empty.removed_row_ids = Vec::new();
    assert_eq!(
        empty.validate_scope(),
        Err("row_delta patches must carry changed rows or removed row ids")
    );

    let mut valid_removal = patch.clone();
    valid_removal.rows = Some(Vec::new());
    valid_removal.removed_row_ids = vec!["work-turn-1".to_string()];
    assert!(valid_removal.validate_scope().is_ok());

    let mut cross_turn = patch.clone();
    cross_turn.rows.as_mut().unwrap()[0].turn_id = Some("turn-2".to_string());
    assert_eq!(
        cross_turn.validate_scope(),
        Err("row_delta rows must belong to affected turn ids")
    );

    let mut missing_turns = patch;
    missing_turns.affected_turn_ids.clear();
    assert_eq!(
        missing_turns.validate_scope(),
        Err("row_delta patches must carry affected turn ids")
    );

    let mut invalid_full_snapshot = valid_removal.clone();
    invalid_full_snapshot.scope = ThreadViewPatchScope::FullSnapshot;
    assert_eq!(
        invalid_full_snapshot.validate_scope(),
        Err("full_snapshot patches must carry rows and no affected turn or removed row ids")
    );

    let mut invalid_lifecycle = valid_removal;
    invalid_lifecycle.scope = ThreadViewPatchScope::Lifecycle;
    invalid_lifecycle.affected_turn_ids.clear();
    assert_eq!(
        invalid_lifecycle.validate_scope(),
        Err("lifecycle patches must not carry row, turn, removed row, or item payloads")
    );
}

#[tokio::test]
async fn item_upsert_returns_row_delta_and_terminal_turn_status_returns_turn_patch() {
    let sessions = ThreadViewStore::default();
    let large_text = "Large active assistant row ".repeat(500);
    build_thread_timeline(
        &sessions,
        "thread-1",
        &[active_turn_with_large_assistant(&large_text)],
        1,
    )
    .await
    .unwrap();
    let item = command_execution_item("command-1", "cargo test", "status update");
    let item_snapshot = ThreadItemSnapshot::from_payload(&item).unwrap();

    let upsert_patch = record_item_upsert(
        &sessions,
        "thread-1",
        "turn-1",
        item,
        item_snapshot,
        Some("running"),
        1,
    )
    .await
    .unwrap();
    assert_eq!(upsert_patch.scope, ThreadViewPatchScope::RowDelta);
    assert!(upsert_patch.validate_scope().is_ok());
    assert_eq!(upsert_patch.affected_turn_ids, vec!["turn-1"]);
    assert!(upsert_patch.removed_row_ids.is_empty());
    assert!(upsert_patch
        .rows
        .as_ref()
        .is_some_and(|rows| !rows.is_empty()));

    let completed_turn = ThreadTurnSnapshot {
        id: "turn-1".to_string(),
        status: "completed".to_string(),
        started_at: Some(1),
        completed_at: Some(2),
        raw_payload: json!({}),
        items: Vec::new(),
    };
    let (_newly_terminal, status_patch) =
        record_turn_status(&sessions, "thread-1", &completed_turn, 2)
            .await
            .unwrap();
    assert_eq!(status_patch.scope, ThreadViewPatchScope::Turn);
    assert!(status_patch.validate_scope().is_ok());
    assert_eq!(status_patch.affected_turn_ids, vec!["turn-1"]);
    assert!(status_patch.rows.as_ref().is_some_and(|rows| rows
        .iter()
        .all(|row| row.turn_id.as_deref() == Some("turn-1"))));
}

#[tokio::test]
async fn first_live_item_upsert_without_base_falls_back_to_turn_patch() {
    let sessions = ThreadViewStore::default();
    let item = command_execution_item("command-1", "cargo test", "initial");
    let item_snapshot = ThreadItemSnapshot::from_payload(&item).unwrap();

    let patch = record_item_upsert(
        &sessions,
        "thread-1",
        "turn-1",
        item,
        item_snapshot,
        Some("running"),
        1,
    )
    .await
    .unwrap();

    assert_eq!(patch.scope, ThreadViewPatchScope::Turn);
    assert!(patch.validate_scope().is_ok());
}

#[tokio::test]
async fn repeated_live_item_upserts_emit_bounded_row_delta_patches() {
    let sessions = ThreadViewStore::default();
    let large_text = "Large active assistant row ".repeat(500);
    build_thread_timeline(
        &sessions,
        "thread-1",
        &[active_turn_with_large_assistant(&large_text)],
        1,
    )
    .await
    .unwrap();

    let mut total_bytes = 0usize;
    let mut max_bytes = 0usize;
    for index in 0..100 {
        let item =
            command_execution_item("command-1", "cargo test", &format!("status update {index}"));
        let item_snapshot = ThreadItemSnapshot::from_payload(&item).unwrap();
        let patch = record_item_upsert(
            &sessions,
            "thread-1",
            "turn-1",
            item,
            item_snapshot,
            Some("running"),
            index + 2,
        )
        .await
        .unwrap();

        assert_eq!(patch.scope, ThreadViewPatchScope::RowDelta);
        assert!(patch.validate_scope().is_ok());
        assert_eq!(patch.affected_turn_ids, vec!["turn-1"]);
        assert!(patch
            .rows
            .as_ref()
            .is_some_and(|rows| !rows.is_empty() && rows.len() < 3));
        let serialized = serde_json::to_vec(&patch).unwrap();
        assert!(
            !String::from_utf8_lossy(&serialized).contains(&large_text),
            "row delta should not resend unchanged large assistant rows"
        );
        total_bytes += serialized.len();
        max_bytes = max_bytes.max(serialized.len());
    }

    assert!(
        max_bytes < 16_000,
        "single row-delta patch should stay bounded; max was {max_bytes} bytes"
    );
    assert!(
        total_bytes < 512 * 1024,
        "100 row-delta patches should stay bounded; total was {total_bytes} bytes"
    );
}

#[tokio::test]
async fn completed_turn_exposes_canonical_work_row_with_deduped_file_changes() {
    let sessions = ThreadViewStore::default();
    let completed_turn = ThreadTurnSnapshot {
        id: "turn-1".to_string(),
        status: "completed".to_string(),
        started_at: Some(10),
        completed_at: Some(20),
        raw_payload: json!({}),
        items: vec![
            ThreadItemSnapshot::from_payload(&user_message_item("user-1", "Edit src/a.rs"))
                .unwrap(),
            ThreadItemSnapshot::from_payload(&file_change_item(
                "file-1",
                "./src/a.rs",
                "--- a/src/a.rs\n+++ b/src/a.rs\n+one\n-two",
            ))
            .unwrap(),
            ThreadItemSnapshot::from_payload(&file_change_item(
                "file-3",
                "src/b.rs",
                "--- a/src/b.rs\n+++ b/src/b.rs\n+side",
            ))
            .unwrap(),
            ThreadItemSnapshot::from_payload(&file_change_item(
                "file-2",
                "src/a.rs",
                "--- a/src/a.rs\n+++ b/src/a.rs\n+three",
            ))
            .unwrap(),
            ThreadItemSnapshot::from_payload(&final_agent_message_item("agent-1", "Done")).unwrap(),
        ],
    };

    let timeline = build_thread_timeline(&sessions, "thread-1", &[completed_turn], 1)
        .await
        .unwrap();

    assert_eq!(
        timeline
            .rows
            .iter()
            .map(|row| row.kind.as_str())
            .collect::<Vec<_>>(),
        vec!["user_message", "work", "assistant_message"]
    );
    let work = timeline
        .rows
        .iter()
        .find(|row| row.kind == "work")
        .expect("work row");
    assert_eq!(work.work.as_ref().unwrap().state, "completed");
    assert_eq!(
        work.collapsed_rows
            .iter()
            .map(|row| row.kind.as_str())
            .collect::<Vec<_>>(),
        vec!["file_changes"]
    );
    let file_changes = &work.collapsed_rows[0].file_changes;
    assert_eq!(file_changes.len(), 2);
    assert_eq!(file_changes[0].path, "src/a.rs");
    assert_eq!(file_changes[0].action, "Modified");
    assert_eq!(
        file_changes[0].item_ids,
        vec!["projection-turn-1-file-1", "projection-turn-1-file-2"]
    );
    assert_eq!(file_changes[0].additions, 2);
    assert_eq!(file_changes[0].deletions, 1);
    assert_eq!(file_changes[1].path, "src/b.rs");
    assert_eq!(file_changes[1].additions, 1);
}

#[tokio::test]
async fn terminal_snapshot_preserves_unmaterialized_live_command_rows() {
    let sessions = ThreadViewStore::default();
    let command = command_execution_item(
        "live-command",
        "printf 'kodex-reconnect-command-test\\n'",
        "kodex-reconnect-command-test\n",
    );
    let command_snapshot = ThreadItemSnapshot::from_payload(&command).unwrap();
    record_item_upsert(
        &sessions,
        "thread-1",
        "turn-1",
        command,
        command_snapshot,
        Some("completed"),
        1,
    )
    .await
    .unwrap();

    let completed_turn = ThreadTurnSnapshot {
        id: "turn-1".to_string(),
        status: "completed".to_string(),
        started_at: Some(10),
        completed_at: Some(20),
        raw_payload: json!({}),
        items: vec![
            ThreadItemSnapshot::from_payload(&user_message_item("user-1", "Run command")).unwrap(),
            ThreadItemSnapshot::from_payload(&agent_message_item("agent-1", "I will run it"))
                .unwrap(),
            ThreadItemSnapshot::from_payload(&final_agent_message_item("agent-final", "Done"))
                .unwrap(),
        ],
    };
    let timeline = build_thread_timeline(&sessions, "thread-1", &[completed_turn], 2)
        .await
        .unwrap();

    let activity = only_activity_detail_row(only_work_row(&timeline));
    assert_eq!(activity.items.len(), 1);
    assert_eq!(activity.items[0].item_id, "live-command");
    assert_eq!(
        activity.items[0].payload.item.command.as_deref(),
        Some("printf 'kodex-reconnect-command-test\\n'")
    );
    assert_eq!(
        activity.items[0].payload.item.output.as_deref(),
        Some("kodex-reconnect-command-test\n")
    );
}

#[tokio::test]
async fn terminal_snapshot_preserves_unmaterialized_active_snapshot_command_rows() {
    let sessions = ThreadViewStore::default();
    let active_turn = ThreadTurnSnapshot {
        id: "turn-1".to_string(),
        status: "inProgress".to_string(),
        started_at: Some(10),
        completed_at: None,
        raw_payload: json!({}),
        items: vec![
            ThreadItemSnapshot::from_payload(&user_message_item("user-1", "Run command")).unwrap(),
            ThreadItemSnapshot::from_payload(&command_execution_item(
                "snapshot-command-active",
                "printf 'kodex-terminal-preserve-test\\n'",
                "kodex-terminal-preserve-test\n",
            ))
            .unwrap(),
            ThreadItemSnapshot::from_payload(&agent_message_item("agent-1", "Working")).unwrap(),
        ],
    };
    build_thread_timeline(&sessions, "thread-1", &[active_turn], 1)
        .await
        .unwrap();

    let completed_turn = ThreadTurnSnapshot {
        id: "turn-1".to_string(),
        status: "completed".to_string(),
        started_at: Some(10),
        completed_at: Some(20),
        raw_payload: json!({}),
        items: vec![
            ThreadItemSnapshot::from_payload(&user_message_item("user-1", "Run command")).unwrap(),
            ThreadItemSnapshot::from_payload(&agent_message_item("agent-1", "Working")).unwrap(),
            ThreadItemSnapshot::from_payload(&final_agent_message_item("agent-final", "Done"))
                .unwrap(),
        ],
    };
    let timeline = build_thread_timeline(&sessions, "thread-1", &[completed_turn], 2)
        .await
        .unwrap();

    let activity = only_activity_detail_row(only_work_row(&timeline));
    assert_eq!(activity.items.len(), 1);
    assert_eq!(activity.items[0].item_id, "snapshot-command-active");
    assert_eq!(
        activity.items[0].payload.item.command.as_deref(),
        Some("printf 'kodex-terminal-preserve-test\\n'")
    );
    assert_eq!(
        activity.items[0].payload.item.output.as_deref(),
        Some("kodex-terminal-preserve-test\n")
    );
}

#[tokio::test]
async fn terminal_snapshot_preserves_unmaterialized_activity_interleaving() {
    let sessions = ThreadViewStore::default();
    let active_turn = ThreadTurnSnapshot {
        id: "turn-1".to_string(),
        status: "inProgress".to_string(),
        started_at: Some(10),
        completed_at: None,
        raw_payload: json!({}),
        items: vec![
            ThreadItemSnapshot::from_payload(&user_message_item("user-1", "Run commands")).unwrap(),
            ThreadItemSnapshot::from_payload(&agent_message_item("agent-1", "First command"))
                .unwrap(),
            ThreadItemSnapshot::from_payload(&command_execution_item(
                "snapshot-command-1",
                "printf 'kodex-two-command-test-1\\n'",
                "kodex-two-command-test-1\n",
            ))
            .unwrap(),
            ThreadItemSnapshot::from_payload(&agent_message_item("agent-2", "Second command"))
                .unwrap(),
            ThreadItemSnapshot::from_payload(&command_execution_item(
                "snapshot-command-2",
                "printf 'kodex-two-command-test-2\\n'",
                "kodex-two-command-test-2\n",
            ))
            .unwrap(),
        ],
    };
    build_thread_timeline(&sessions, "thread-1", &[active_turn], 1)
        .await
        .unwrap();

    let completed_turn = ThreadTurnSnapshot {
        id: "turn-1".to_string(),
        status: "completed".to_string(),
        started_at: Some(10),
        completed_at: Some(20),
        raw_payload: json!({}),
        items: vec![
            ThreadItemSnapshot::from_payload(&user_message_item("user-1", "Run commands")).unwrap(),
            ThreadItemSnapshot::from_payload(&agent_message_item("agent-1", "First command"))
                .unwrap(),
            ThreadItemSnapshot::from_payload(&agent_message_item("agent-2", "Second command"))
                .unwrap(),
            ThreadItemSnapshot::from_payload(&final_agent_message_item("agent-final", "Done"))
                .unwrap(),
        ],
    };
    let timeline = build_thread_timeline(&sessions, "thread-1", &[completed_turn], 2)
        .await
        .unwrap();

    let work = only_work_row(&timeline);
    assert_eq!(
        work.collapsed_rows
            .iter()
            .map(|row| (
                row.kind.as_str(),
                row.item
                    .as_ref()
                    .and_then(|item| item.payload.item.text.as_deref()),
                row.items
                    .iter()
                    .map(|item| item.item_id.as_str())
                    .collect::<Vec<_>>()
            ))
            .collect::<Vec<_>>(),
        vec![
            ("assistant_message", Some("First command"), vec![]),
            ("activity", None, vec!["snapshot-command-1"]),
            ("assistant_message", Some("Second command"), vec![]),
            ("activity", None, vec!["snapshot-command-2"]),
        ]
    );
}

#[tokio::test]
async fn terminal_snapshot_keeps_final_answers_before_later_turns() {
    let sessions = ThreadViewStore::default();
    let active_command_turn = ThreadTurnSnapshot {
        id: "turn-1".to_string(),
        status: "inProgress".to_string(),
        started_at: Some(10),
        completed_at: None,
        raw_payload: json!({}),
        items: vec![
            ThreadItemSnapshot::from_payload(&user_message_item("user-1", "test")).unwrap(),
            ThreadItemSnapshot::from_payload(&command_execution_item(
                "snapshot-command",
                "printf 'kodex-persistence-test-command\\n'",
                "kodex-persistence-test-command\n",
            ))
            .unwrap(),
        ],
    };
    build_thread_timeline(&sessions, "thread-1", &[active_command_turn], 1)
        .await
        .unwrap();

    let completed_command_turn = ThreadTurnSnapshot {
        id: "turn-1".to_string(),
        status: "completed".to_string(),
        started_at: Some(10),
        completed_at: Some(20),
        raw_payload: json!({}),
        items: vec![
            ThreadItemSnapshot::from_payload(&user_message_item("user-1", "test")).unwrap(),
            ThreadItemSnapshot::from_payload(&final_agent_message_item(
                "agent-final-1",
                "Ran:\n\n```text\nkodex-persistence-test-command\n```",
            ))
            .unwrap(),
        ],
    };
    let completed_reply_turn_1 = ThreadTurnSnapshot {
        id: "turn-2".to_string(),
        status: "completed".to_string(),
        started_at: Some(30),
        completed_at: Some(35),
        raw_payload: json!({}),
        items: vec![
            ThreadItemSnapshot::from_payload(&user_message_item("user-2", "message 1")).unwrap(),
            ThreadItemSnapshot::from_payload(&final_agent_message_item("agent-final-2", "Reply 1"))
                .unwrap(),
        ],
    };
    let completed_reply_turn_2 = ThreadTurnSnapshot {
        id: "turn-3".to_string(),
        status: "completed".to_string(),
        started_at: Some(40),
        completed_at: Some(43),
        raw_payload: json!({}),
        items: vec![
            ThreadItemSnapshot::from_payload(&user_message_item("user-3", "message 2")).unwrap(),
            ThreadItemSnapshot::from_payload(&final_agent_message_item("agent-final-3", "Reply 2"))
                .unwrap(),
        ],
    };
    let timeline = build_thread_timeline(
        &sessions,
        "thread-1",
        &[
            completed_command_turn,
            completed_reply_turn_1,
            completed_reply_turn_2,
        ],
        2,
    )
    .await
    .unwrap();

    assert_eq!(
        timeline
            .rows
            .iter()
            .filter_map(root_row_text)
            .collect::<Vec<_>>(),
        vec![
            serde_json::to_string(&json!([{"text":"test","type":"text"}])).unwrap(),
            "Ran:\n\n```text\nkodex-persistence-test-command\n```".to_string(),
            serde_json::to_string(&json!([{"text":"message 1","type":"text"}])).unwrap(),
            "Reply 1".to_string(),
            serde_json::to_string(&json!([{"text":"message 2","type":"text"}])).unwrap(),
            "Reply 2".to_string(),
        ]
    );
}

#[tokio::test]
async fn terminal_turn_patch_preserves_live_command_rows() {
    let sessions = ThreadViewStore::default();
    let command = command_execution_item(
        "live-command",
        "printf 'kodex-terminal-preserve-test\\n'",
        "kodex-terminal-preserve-test\n",
    );
    let command_snapshot = ThreadItemSnapshot::from_payload(&command).unwrap();
    record_item_upsert(
        &sessions,
        "thread-1",
        "turn-1",
        command,
        command_snapshot,
        Some("running"),
        1,
    )
    .await
    .unwrap();

    let completed_turn = ThreadTurnSnapshot {
        id: "turn-1".to_string(),
        status: "completed".to_string(),
        started_at: Some(10),
        completed_at: Some(20),
        raw_payload: json!({}),
        items: Vec::new(),
    };
    let (_newly_terminal, status_patch) =
        record_turn_status(&sessions, "thread-1", &completed_turn, 2)
            .await
            .unwrap();

    let activity = status_patch
        .rows
        .as_ref()
        .expect("turn rows")
        .iter()
        .find(|row| row.kind == "activity")
        .expect("activity row");
    assert_eq!(activity.items.len(), 1);
    assert_eq!(activity.items[0].item_id, "live-command");
    assert_eq!(
        activity.items[0].payload.item.command.as_deref(),
        Some("printf 'kodex-terminal-preserve-test\\n'")
    );
}

#[tokio::test]
async fn live_item_activity_does_not_invent_turn_timestamps() {
    let sessions = ThreadViewStore::default();
    record_item_delta(&sessions, "thread-1", "turn-1", "agent-1", "Working", 1)
        .await
        .unwrap();

    let patch = patch_for_thread(&sessions, "thread-1").await.unwrap();

    assert_eq!(patch.live_state, ThreadLiveState::Streaming);
    assert_eq!(patch.active_turn_id.as_deref(), Some("turn-1"));
    assert_eq!(patch.turns.len(), 1);
    assert_eq!(patch.turns[0].id, "turn-1");
    assert_eq!(patch.turns[0].status, "running");
    assert_eq!(patch.turns[0].started_at, None);
    assert_eq!(patch.turns[0].completed_at, None);
}

#[tokio::test]
async fn terminal_turn_status_preserves_turn_duration_in_live_patch() {
    let sessions = ThreadViewStore::default();
    record_item_delta(&sessions, "thread-1", "turn-1", "agent-1", "Working", 1)
        .await
        .unwrap();

    let completed_turn = ThreadTurnSnapshot {
        id: "turn-1".to_string(),
        status: "completed".to_string(),
        started_at: Some(10),
        completed_at: Some(15),
        raw_payload: json!({}),
        items: Vec::new(),
    };
    record_turn_status(&sessions, "thread-1", &completed_turn, 2)
        .await
        .unwrap();

    let patch = patch_for_thread(&sessions, "thread-1").await.unwrap();

    assert_eq!(patch.live_state, ThreadLiveState::Idle);
    assert_eq!(patch.turns.len(), 1);
    assert_eq!(patch.turns[0].id, "turn-1");
    assert_eq!(patch.turns[0].status, "completed");
    assert_eq!(patch.turns[0].started_at, Some(10));
    assert_eq!(patch.turns[0].completed_at, Some(15));
}

#[tokio::test]
async fn item_completion_does_not_complete_active_turn() {
    let sessions = ThreadViewStore::default();
    let item = agent_message_item("agent-1", "partial");
    let item_snapshot = ThreadItemSnapshot::from_payload(&item).unwrap();

    record_item_upsert(
        &sessions,
        "thread-1",
        "turn-1",
        item,
        item_snapshot,
        Some("completed"),
        1,
    )
    .await
    .unwrap();

    let patch = patch_for_thread(&sessions, "thread-1").await.unwrap();
    assert_eq!(patch.active_turn_id.as_deref(), Some("turn-1"));
    assert_eq!(patch.live_state, ThreadLiveState::Streaming);
    assert_eq!(patch.items[0].status, "completed");
    assert_eq!(patch.turns[0].status, "running");
    assert_eq!(patch.turns[0].completed_at, None);
}

#[tokio::test]
async fn session_ignores_late_delta_after_turn_completion() {
    let sessions = ThreadViewStore::default();
    record_item_delta(&sessions, "thread-1", "turn-1", "agent-1", "Done", 1)
        .await
        .unwrap();
    let completed_turn = ThreadTurnSnapshot {
        id: "turn-1".to_string(),
        status: "completed".to_string(),
        started_at: Some(1),
        completed_at: Some(2),
        raw_payload: json!({}),
        items: vec![
            ThreadItemSnapshot::from_payload(&agent_message_item("agent-1", "Done")).unwrap(),
        ],
    };
    record_turn_status(&sessions, "thread-1", &completed_turn, 2)
        .await
        .unwrap();

    record_item_delta(&sessions, "thread-1", "turn-1", "agent-1", " stale", 3)
        .await
        .unwrap();

    let patch = patch_for_thread(&sessions, "thread-1").await.unwrap();
    assert_eq!(patch.live_state, ThreadLiveState::Idle);
    assert_eq!(patch.active_turn_id, None);
    assert_eq!(patch.items[0].status, "completed");
    assert_eq!(patch.items[0].payload.item.text.as_deref(), Some("Done"));
}

#[tokio::test]
async fn active_snapshot_does_not_truncate_newer_live_text() {
    let sessions = ThreadViewStore::default();
    record_item_delta(&sessions, "thread-1", "turn-1", "agent-1", "Hello", 1)
        .await
        .unwrap();
    record_item_delta(&sessions, "thread-1", "turn-1", "agent-1", " world", 2)
        .await
        .unwrap();

    let stale_active_turn = ThreadTurnSnapshot {
        id: "turn-1".to_string(),
        status: "inProgress".to_string(),
        started_at: Some(1),
        completed_at: None,
        raw_payload: json!({}),
        items: vec![
            ThreadItemSnapshot::from_payload(&agent_message_item("agent-1", "Hello")).unwrap(),
        ],
    };
    let timeline = build_thread_timeline(&sessions, "thread-1", &[stale_active_turn], 3)
        .await
        .unwrap();

    assert_eq!(timeline.items.len(), 1);
    assert_eq!(timeline.items[0].id, "projection-turn-1-agent-1");
    assert_eq!(
        timeline.items[0].payload.item.text.as_deref(),
        Some("Hello world")
    );
    assert_eq!(timeline.turns.len(), 1);
    assert_eq!(timeline.turns[0].started_at, Some(1));
    assert_eq!(timeline.turns[0].completed_at, None);
    assert_eq!(timeline.active_turn_id.as_deref(), Some("turn-1"));
}

#[tokio::test]
async fn active_snapshot_collapses_duplicate_live_assistant_text() {
    let sessions = ThreadViewStore::default();
    record_item_delta(&sessions, "thread-1", "turn-1", "delta-item", "Repeated", 1)
        .await
        .unwrap();

    let active_turn = ThreadTurnSnapshot {
        id: "turn-1".to_string(),
        status: "inProgress".to_string(),
        started_at: Some(1),
        completed_at: None,
        raw_payload: json!({}),
        items: vec![ThreadItemSnapshot::from_payload(&agent_message_item(
            "snapshot-item",
            "Repeated",
        ))
        .unwrap()],
    };
    let timeline = build_thread_timeline(&sessions, "thread-1", &[active_turn], 2)
        .await
        .unwrap();

    assert_eq!(
        timeline
            .items
            .iter()
            .map(|item| (
                item.item_id.as_str(),
                item.payload.item.text.as_deref().unwrap_or("")
            ))
            .collect::<Vec<_>>(),
        vec![("snapshot-item", "Repeated")]
    );
    let rows = timeline.rows;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].kind, "assistant_message");
}

#[tokio::test]
async fn active_snapshot_collapses_equivalent_gateway_stream_user_item() {
    let sessions = ThreadViewStore::default();
    let live_user = user_message_item("live-user", "Same prompt");
    let live_user_snapshot = ThreadItemSnapshot::from_payload(&live_user).unwrap();
    record_item_upsert(
        &sessions,
        "thread-1",
        "turn-1",
        live_user,
        live_user_snapshot,
        Some("completed"),
        1,
    )
    .await
    .unwrap();

    let active_turn = ThreadTurnSnapshot {
        id: "turn-1".to_string(),
        status: "inProgress".to_string(),
        started_at: Some(1),
        completed_at: None,
        raw_payload: json!({}),
        items: vec![ThreadItemSnapshot::from_payload(&user_message_item(
            "snapshot-user",
            "Same prompt",
        ))
        .unwrap()],
    };
    let timeline = build_thread_timeline(&sessions, "thread-1", &[active_turn], 2)
        .await
        .unwrap();

    assert_eq!(
        timeline
            .items
            .iter()
            .map(|item| item.item_id.as_str())
            .collect::<Vec<_>>(),
        vec!["snapshot-user"]
    );
    assert_eq!(
        timeline
            .rows
            .iter()
            .filter(|row| row.kind == "user_message")
            .count(),
        1
    );
}

#[tokio::test]
async fn active_snapshot_collapses_equivalent_gateway_stream_assistant_item() {
    let sessions = ThreadViewStore::default();
    let live_assistant = agent_message_item("live-assistant", "Same update");
    let live_assistant_snapshot = ThreadItemSnapshot::from_payload(&live_assistant).unwrap();
    record_item_upsert(
        &sessions,
        "thread-1",
        "turn-1",
        live_assistant,
        live_assistant_snapshot,
        Some("completed"),
        1,
    )
    .await
    .unwrap();

    let active_turn = ThreadTurnSnapshot {
        id: "turn-1".to_string(),
        status: "inProgress".to_string(),
        started_at: Some(1),
        completed_at: None,
        raw_payload: json!({}),
        items: vec![ThreadItemSnapshot::from_payload(&agent_message_item(
            "snapshot-assistant",
            "Same update",
        ))
        .unwrap()],
    };
    let timeline = build_thread_timeline(&sessions, "thread-1", &[active_turn], 2)
        .await
        .unwrap();

    assert_eq!(
        timeline
            .items
            .iter()
            .map(|item| item.item_id.as_str())
            .collect::<Vec<_>>(),
        vec!["snapshot-assistant"]
    );
    assert_eq!(
        timeline
            .rows
            .iter()
            .filter(|row| row.kind == "assistant_message")
            .count(),
        1
    );
}

#[tokio::test]
async fn history_window_prepends_older_rows_without_deleting_live_tail() {
    let sessions = ThreadViewStore::default();
    let recent_turn = ThreadTurnSnapshot {
        id: "turn-2".to_string(),
        status: "completed".to_string(),
        started_at: Some(20),
        completed_at: Some(25),
        raw_payload: json!({}),
        items: vec![
            ThreadItemSnapshot::from_payload(&agent_message_item("agent-2", "Recent")).unwrap(),
        ],
    };
    build_thread_timeline_window(
        &sessions,
        "thread-1",
        &[recent_turn.clone()],
        Some(ThreadTimelineWindowPage {
            older_cursor: Some("older-1".to_string()),
            newer_cursor: None,
            has_older: true,
            limit: 50,
            loaded_turn_count: 1,
            reset_window: false,
        }),
        1,
    )
    .await
    .unwrap();
    record_item_delta(&sessions, "thread-1", "turn-3", "agent-3", "Live", 2)
        .await
        .unwrap();

    let older_turn = ThreadTurnSnapshot {
        id: "turn-1".to_string(),
        status: "completed".to_string(),
        started_at: Some(10),
        completed_at: Some(15),
        raw_payload: json!({}),
        items: vec![
            ThreadItemSnapshot::from_payload(&agent_message_item("agent-1", "Older")).unwrap(),
        ],
    };
    let timeline = prepend_thread_timeline_page(
        &sessions,
        "thread-1",
        &[older_turn],
        Some(ThreadTimelineWindowPage {
            older_cursor: None,
            newer_cursor: Some("newer-1".to_string()),
            has_older: false,
            limit: 50,
            loaded_turn_count: 1,
            reset_window: false,
        }),
        3,
    )
    .await
    .unwrap();

    assert_eq!(
        timeline
            .items
            .iter()
            .map(|item| item.payload.item.text.as_deref().unwrap_or(""))
            .collect::<Vec<_>>(),
        vec!["Older", "Recent", "Live"]
    );
    assert_eq!(timeline.active_turn_id.as_deref(), Some("turn-3"));
    assert_eq!(timeline.live_state, ThreadLiveState::Streaming);

    let refreshed = build_thread_timeline_window(
        &sessions,
        "thread-1",
        &[recent_turn],
        Some(ThreadTimelineWindowPage {
            older_cursor: Some("older-ignored".to_string()),
            newer_cursor: None,
            has_older: true,
            limit: 50,
            loaded_turn_count: 1,
            reset_window: false,
        }),
        4,
    )
    .await
    .unwrap();

    assert_eq!(
        refreshed
            .items
            .iter()
            .map(|item| item.payload.item.text.as_deref().unwrap_or(""))
            .collect::<Vec<_>>(),
        vec!["Older", "Recent", "Live"]
    );
    assert_eq!(refreshed.active_turn_id.as_deref(), Some("turn-3"));
}

#[tokio::test]
async fn head_refresh_preserves_expanded_window_older_cursor() {
    let sessions = ThreadViewStore::default();
    let turn = |id: &str, text: &str| ThreadTurnSnapshot {
        id: id.to_string(),
        status: "completed".to_string(),
        started_at: None,
        completed_at: None,
        raw_payload: json!({}),
        items: vec![ThreadItemSnapshot::from_payload(&agent_message_item(
            &format!("agent-{id}"),
            text,
        ))
        .unwrap()],
    };
    let turn_4 = turn("turn-4", "Four");
    let turn_3 = turn("turn-3", "Three");
    let turn_2 = turn("turn-2", "Two");
    let turn_1 = turn("turn-1", "One");

    build_thread_timeline_window(
        &sessions,
        "thread-1",
        &[turn_3.clone(), turn_4.clone()],
        Some(ThreadTimelineWindowPage {
            older_cursor: Some("cursor-before-turn-3".to_string()),
            newer_cursor: None,
            has_older: true,
            limit: 2,
            loaded_turn_count: 2,
            reset_window: false,
        }),
        1,
    )
    .await
    .unwrap();

    prepend_thread_timeline_page(
        &sessions,
        "thread-1",
        &[turn_1.clone(), turn_2.clone()],
        Some(ThreadTimelineWindowPage {
            older_cursor: Some("cursor-before-turn-1".to_string()),
            newer_cursor: Some("cursor-before-turn-3".to_string()),
            has_older: true,
            limit: 2,
            loaded_turn_count: 4,
            reset_window: false,
        }),
        2,
    )
    .await
    .unwrap();

    build_thread_timeline_window(
        &sessions,
        "thread-1",
        &[turn_4.clone()],
        Some(ThreadTimelineWindowPage {
            older_cursor: Some("overlapping-head-cursor".to_string()),
            newer_cursor: None,
            has_older: true,
            limit: 1,
            loaded_turn_count: 1,
            reset_window: false,
        }),
        3,
    )
    .await
    .unwrap();

    let history_page = sessions.history_page("thread-1").await.unwrap();
    assert_eq!(
        history_page.older_cursor.as_deref(),
        Some("cursor-before-turn-1")
    );
    assert!(history_page.has_older);

    let refreshed = prepend_thread_timeline_page(
        &sessions,
        "thread-1",
        &[turn("turn-0", "Zero")],
        Some(ThreadTimelineWindowPage {
            older_cursor: None,
            newer_cursor: Some("cursor-before-turn-1".to_string()),
            has_older: false,
            limit: 1,
            loaded_turn_count: 5,
            reset_window: false,
        }),
        4,
    )
    .await
    .unwrap();

    assert_eq!(
        refreshed
            .items
            .iter()
            .map(|item| item.payload.item.text.as_deref().unwrap_or(""))
            .collect::<Vec<_>>(),
        vec!["Zero", "One", "Two", "Three", "Four"]
    );
    let history_page = sessions.history_page("thread-1").await.unwrap();
    assert_eq!(history_page.older_cursor, None);
    assert!(!history_page.has_older);
    assert_eq!(history_page.loaded_turn_count, 5);
}

#[tokio::test]
async fn completed_snapshot_collapses_live_duplicate_assistant_text() {
    let sessions = ThreadViewStore::default();
    record_item_delta(&sessions, "thread-1", "turn-1", "item-2", "Done", 1)
        .await
        .unwrap();
    record_item_delta(&sessions, "thread-1", "turn-1", "msg-final", "Done", 2)
        .await
        .unwrap();

    let completed_turn = ThreadTurnSnapshot {
        id: "turn-1".to_string(),
        status: "completed".to_string(),
        started_at: Some(1),
        completed_at: Some(2),
        raw_payload: json!({}),
        items: vec![
            ThreadItemSnapshot::from_payload(&agent_message_item("item-2", "Done")).unwrap(),
        ],
    };
    let timeline = build_thread_timeline(&sessions, "thread-1", &[completed_turn], 3)
        .await
        .unwrap();

    assert_eq!(timeline.items.len(), 1);
    assert_eq!(timeline.items[0].item_id, "item-2");
    assert_eq!(timeline.items[0].payload.item.text.as_deref(), Some("Done"));
}

#[tokio::test]
async fn completed_snapshot_prunes_missing_live_context_compaction_marker() {
    let sessions = ThreadViewStore::default();
    let compact_item = context_compaction_item("compact-1");
    let compact_snapshot = ThreadItemSnapshot::from_payload(&compact_item).unwrap();
    record_item_upsert(
        &sessions,
        "thread-1",
        "turn-1",
        compact_item,
        compact_snapshot,
        Some("running"),
        1,
    )
    .await
    .unwrap();

    let completed_turn = ThreadTurnSnapshot {
        id: "turn-1".to_string(),
        status: "completed".to_string(),
        started_at: Some(1),
        completed_at: Some(2),
        raw_payload: json!({}),
        items: vec![
            ThreadItemSnapshot::from_payload(&json!({
                "id": "user-1",
                "type": "userMessage",
                "content": [{"type": "text", "text": "Hello"}]
            }))
            .unwrap(),
            ThreadItemSnapshot::from_payload(&agent_message_item("agent-1", "Done")).unwrap(),
        ],
    };
    let timeline = build_thread_timeline(&sessions, "thread-1", &[completed_turn], 2)
        .await
        .unwrap();

    assert_eq!(
        timeline
            .items
            .iter()
            .map(|item| item.item_id.as_str())
            .collect::<Vec<_>>(),
        vec!["user-1", "agent-1"]
    );
    assert_eq!(timeline.live_state, ThreadLiveState::Idle);
    assert_eq!(timeline.active_turn_id, None);
}

#[tokio::test]
async fn terminal_turn_patch_removes_missing_live_context_compaction_marker() {
    let sessions = ThreadViewStore::default();
    let compact_item = context_compaction_item("compact-1");
    let compact_snapshot = ThreadItemSnapshot::from_payload(&compact_item).unwrap();
    let upsert_patch = record_item_upsert(
        &sessions,
        "thread-1",
        "turn-1",
        compact_item,
        compact_snapshot,
        Some("running"),
        1,
    )
    .await
    .unwrap();
    let turn_rows = upsert_patch.rows.as_ref().expect("turn patch rows");
    assert_eq!(turn_rows.len(), 1);
    assert_eq!(turn_rows[0].kind, "context_compaction");

    let completed_turn = ThreadTurnSnapshot {
        id: "turn-1".to_string(),
        status: "completed".to_string(),
        started_at: Some(1),
        completed_at: Some(2),
        raw_payload: json!({}),
        items: vec![
            ThreadItemSnapshot::from_payload(&user_message_item("user-1", "Hello")).unwrap(),
            ThreadItemSnapshot::from_payload(&agent_message_item("agent-1", "Done")).unwrap(),
        ],
    };
    let (_newly_terminal, status_patch) =
        record_turn_status(&sessions, "thread-1", &completed_turn, 2)
            .await
            .unwrap();

    assert_eq!(status_patch.affected_turn_ids, vec!["turn-1"]);
    assert!(status_patch
        .rows
        .as_ref()
        .expect("turn patch rows")
        .iter()
        .all(|row| row.kind != "context_compaction"));
    let patch = patch_for_thread(&sessions, "thread-1").await.unwrap();
    assert!(patch.items.iter().all(|item| item.item_id != "compact-1"));
}

#[tokio::test]
async fn recent_snapshot_prunes_live_context_compaction_when_source_turn_dropped() {
    let sessions = ThreadViewStore::default();
    let compact_item = context_compaction_item("compact-1");
    let compact_snapshot = ThreadItemSnapshot::from_payload(&compact_item).unwrap();
    record_item_upsert(
        &sessions,
        "thread-1",
        "turn-compact",
        compact_item,
        compact_snapshot,
        Some("running"),
        1,
    )
    .await
    .unwrap();

    let later_turn = ThreadTurnSnapshot {
        id: "turn-later".to_string(),
        status: "completed".to_string(),
        started_at: Some(10),
        completed_at: Some(12),
        raw_payload: json!({}),
        items: vec![ThreadItemSnapshot::from_payload(&agent_message_item(
            "agent-later",
            "Later answer",
        ))
        .unwrap()],
    };
    let timeline = build_thread_timeline(&sessions, "thread-1", &[later_turn], 2)
        .await
        .unwrap();

    assert_eq!(
        timeline
            .items
            .iter()
            .map(|item| item.item_id.as_str())
            .collect::<Vec<_>>(),
        vec!["agent-later"]
    );
    assert_eq!(timeline.live_state, ThreadLiveState::Idle);
    assert_eq!(timeline.active_turn_id, None);
}
