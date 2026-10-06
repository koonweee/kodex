use super::*;
use crate::app_server_api::ThreadTimelineRow;
use std::future::ready;

fn completed_turn() -> ThreadTurnSnapshot {
    let items = [
        json!({"id": "user", "type": "userMessage", "content": [{"type": "text", "text": "Implement the plan"}]}),
        json!({"id": "progress", "type": "agentMessage", "phase": "commentary", "text": "Checking the integration"}),
        json!({"id": "question", "type": "agentMessage", "phase": "final_answer", "delivery": "async", "text": "Please log in"}),
        json!({"id": "reply", "type": "userMessage", "content": [{"type": "text", "text": "Logged in"}]}),
        json!({"id": "answer", "type": "agentMessage", "phase": "final_answer", "text": "Implemented the plan"}),
    ];
    ThreadTurnSnapshot {
        id: "turn".into(),
        status: "completed".into(),
        started_at: Some(10),
        completed_at: Some(20),
        raw_payload: json!({}),
        items: items
            .iter()
            .map(|item| ThreadItemSnapshot::from_payload(item).unwrap())
            .collect(),
    }
}

fn assert_visible_answers(rows: &[ThreadTimelineRow]) {
    let visible_ids = rows
        .iter()
        .filter_map(|row| row.item.as_ref().map(|item| item.item_id.as_str()))
        .collect::<Vec<_>>();
    assert_eq!(visible_ids, ["user", "question", "reply", "answer"]);
    let work = rows.iter().find(|row| row.kind == "work").unwrap();
    assert_eq!(work.status, "completed");
    let collapsed_ids = work
        .collapsed_rows
        .iter()
        .filter_map(|row| row.item.as_ref().map(|item| item.item_id.as_str()))
        .collect::<Vec<_>>();
    assert_eq!(collapsed_ids, ["progress"]);
}

#[tokio::test]
async fn async_question_and_final_answer_stay_visible_for_live_and_reconnecting_clients() {
    let sessions = ThreadViewStore::default();
    let completed = completed_turn();
    let mut active = completed.clone();
    active.status = "inProgress".into();
    active.completed_at = None;
    active.items.clear();
    record_turn_status(&sessions, "thread", &active, ready(Ok(1)))
        .await
        .unwrap();
    for (index, item) in completed.items.iter().enumerate() {
        record_item_upsert(
            &sessions,
            "thread",
            "turn",
            item.raw_payload.clone(),
            item.clone(),
            Some("completed"),
            ready(Ok(index as i64 + 2)),
        )
        .await
        .unwrap();
    }

    // Client A receives the terminal canonical patch through SSE.
    let (_, patch) = record_turn_status(&sessions, "thread", &completed, ready(Ok(10)))
        .await
        .unwrap();
    assert_visible_answers(patch.rows.as_ref().unwrap());

    // Client B missed live events and refills from the native history snapshot.
    let snapshot = build_thread_timeline(&sessions, "thread", &[completed.clone()], 10)
        .await
        .unwrap();
    assert_visible_answers(&snapshot.rows);

    // The same grouping holds after a gateway restart with no live projection.
    let snapshot = build_thread_timeline(&ThreadViewStore::default(), "thread", &[completed], 1)
        .await
        .unwrap();
    assert_visible_answers(&snapshot.rows);
}

#[tokio::test]
async fn user_image_urls_survive_materialization_live_patches_and_history_refills() {
    let image_url = format!("data:image/png;base64,{}", "QUFB".repeat(5_000));
    let content = json!([
        {"type": "text", "text": "Inspect this"},
        {"type": "image", "url": image_url, "detail": "high"}
    ]);
    let raw_item = json!({
        "id": "native-user", "type": "userMessage", "clientId": "queued-client",
        "content": content
    });
    let native_item = ThreadItemSnapshot::from_payload(&raw_item).unwrap();
    let turn = ThreadTurnSnapshot {
        id: "turn".into(),
        status: "completed".into(),
        started_at: Some(10),
        completed_at: Some(20),
        raw_payload: json!({}),
        items: vec![native_item.clone()],
    };
    let sessions = ThreadViewStore::default();
    // Accepted local images initially use a path; native history materializes
    // them as inline image URLs, including after queued input is delivered.
    let pending = record_pending_user_input(
        &sessions,
        "thread",
        "turn",
        "queued-client",
        &[
            json!({"type": "text", "text": "Inspect this"}),
            json!({"type": "localImage", "path": "/tmp/upload.png"}),
        ],
        &[],
        (1, ready(Ok(1))),
    )
    .await
    .unwrap()
    .expect("accepted input creates a pending row");
    assert_eq!(
        pending.rows.as_ref().unwrap()[0]
            .item
            .as_ref()
            .unwrap()
            .item_id,
        "pending-user-queued-client"
    );
    let patch = record_item_upsert(
        &sessions,
        "thread",
        "turn",
        raw_item,
        native_item,
        Some("completed"),
        ready(Ok(2)),
    )
    .await
    .unwrap();
    let assert_image = |rows: &[ThreadTimelineRow]| {
        let messages = rows
            .iter()
            .filter_map(|row| row.item.as_ref())
            .collect::<Vec<_>>();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].item_id, "native-user");
        // Check the actual serialized client contract, not raw native storage.
        let serialized = serde_json::to_value(messages[0]).unwrap();
        assert!(
            serialized["payload"]["item"]["content"] == content,
            "serialized image content changed"
        );
    };
    // Client A receives the canonical live patch.
    assert_image(patch.rows.as_ref().unwrap());
    // Client B misses the patch and converges from the native snapshot.
    let snapshot = build_thread_timeline(&sessions, "thread", &[turn.clone()], 3)
        .await
        .unwrap();
    assert_image(&snapshot.rows);
    // Reload/restart works without the original tab's local blob preview.
    let snapshot = build_thread_timeline(&ThreadViewStore::default(), "thread", &[turn], 1)
        .await
        .unwrap();
    assert_image(&snapshot.rows);
}

#[test]
fn image_url_preservation_keeps_other_timeline_previews_bounded() {
    let large = "x".repeat(crate::app_server_api::TIMELINE_PREVIEW_STRING_LIMIT + 100);
    let payload = compact_timeline_item_payload(&json!({
        "type": "userMessage", "content": [
            {"type": "text", "text": large},
            {"type": "image", "url": large, "description": large},
            {"type": "mention", "url": large}
        ]
    }));
    let content = payload.content.unwrap();
    assert_eq!(content[1]["url"], large);
    for value in [
        &content[0]["text"],
        &content[1]["description"],
        &content[2]["url"],
    ] {
        assert!(value.as_str().unwrap().ends_with("...[truncated]"));
    }
    let tool = compact_timeline_item_payload(&json!({
        "type": "mcpToolCall", "arguments": {"type": "image", "url": large},
        "content": [{"type": "image", "url": large}]
    }));
    assert!(tool.arguments.unwrap()["url"]
        .as_str()
        .unwrap()
        .ends_with("...[truncated]"));
    assert!(tool.content.unwrap()[0]["url"]
        .as_str()
        .unwrap()
        .ends_with("...[truncated]"));
}
