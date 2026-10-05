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
