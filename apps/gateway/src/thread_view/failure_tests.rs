use super::*;
use std::future::ready;

fn turn(status: &str, started_at: Option<i64>, include_user: bool) -> ThreadTurnSnapshot {
    ThreadTurnSnapshot {
        id: "turn-failure".into(),
        status: status.into(),
        started_at,
        completed_at: None,
        items: if include_user {
            vec![ThreadItemSnapshot::from_payload(&json!({
                "id": "user-1", "type": "userMessage",
                "content": [{"type": "text", "text": "hi"}]
            }))
            .unwrap()]
        } else {
            Vec::new()
        },
        raw_payload: json!({"error": {"message": "Please sign in to continue."}}),
    }
}

fn assert_failure(snapshot: &ThreadTimelineSnapshot, status: &str) {
    let snapshot = serde_json::to_value(snapshot).unwrap();
    assert_eq!(snapshot["turns"][0]["status"], status);
    assert_eq!(
        snapshot["turns"][0]["errorMessage"],
        "Please sign in to continue."
    );
    let work = snapshot["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["kind"] == "work")
        .expect("failed or interrupted turns have a visible work row");
    assert_eq!(work["status"], status);
    assert_eq!(work["work"]["state"], status);
    assert_eq!(work["work"]["errorMessage"], "Please sign in to continue.");
}

#[test]
fn native_failed_and_interrupted_turns_keep_error_and_outcome_without_timing() {
    for status in ["failed", "interrupted"] {
        for started_at in [None, Some(1)] {
            assert_failure(
                &ThreadTimelineSnapshot::from_turns("thread", &[turn(status, started_at, true)]),
                status,
            );
        }
    }
}

#[test]
fn native_failure_without_items_remains_visible() {
    assert_failure(
        &ThreadTimelineSnapshot::from_turns("thread", &[turn("failed", None, false)]),
        "failed",
    );
}

#[tokio::test]
async fn empty_failure_turns_keep_native_order_among_loaded_turns() {
    let mut before = turn("completed", Some(1), true);
    before.id = "before".into();
    before.raw_payload = json!({"error": null});
    let mut first = turn("failed", None, false);
    first.id = "first".into();
    let mut second = turn("interrupted", None, false);
    second.id = "second".into();
    second.raw_payload = json!({"error": null});
    let mut after = before.clone();
    after.id = "after".into();
    let turns = [before, first, second, after];
    let snapshot = build_thread_timeline(&ThreadViewStore::default(), "thread", &turns, 1)
        .await
        .unwrap();
    let ids = snapshot
        .rows
        .iter()
        .filter(|row| row.kind == "work")
        .map(|row| row.turn_id.as_deref().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(ids, ["before", "first", "second", "after"]);
    let interrupted = snapshot
        .rows
        .iter()
        .find(|row| row.turn_id.as_deref() == Some("second"))
        .unwrap();
    assert_eq!(interrupted.work.as_ref().unwrap().state, "interrupted");
    assert!(interrupted.work.as_ref().unwrap().error_message.is_none());
}

#[tokio::test]
async fn live_native_failure_survives_stale_reads_and_fresh_history_reload() {
    let sessions = ThreadViewStore::default();
    let mut active = turn("inProgress", None, true);
    active.raw_payload = json!({"error": null});
    build_thread_timeline(&sessions, "thread", &[active.clone()], 1)
        .await
        .unwrap();
    let failed = turn("failed", None, true);
    let (_, patch) = record_turn_status(&sessions, "thread", &failed, ready(Ok(2)))
        .await
        .unwrap();
    let patch = serde_json::to_value(patch).unwrap();
    let work = patch["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["kind"] == "work")
        .unwrap();
    assert_eq!(work["work"]["state"], "failed");
    assert_eq!(work["work"]["errorMessage"], "Please sign in to continue.");
    let stale = build_thread_timeline(&sessions, "thread", &[active], 1)
        .await
        .unwrap();
    assert_failure(&stale, "failed");
    let fresh = build_thread_timeline(&sessions, "thread", &[failed.clone()], 3)
        .await
        .unwrap();
    assert_failure(&fresh, "failed");
    let reloaded = build_thread_timeline(&ThreadViewStore::default(), "thread", &[failed], 3)
        .await
        .unwrap();
    assert_failure(&reloaded, "failed");
}

#[tokio::test]
async fn failed_turn_notice_follows_output_in_live_and_reloaded_views() {
    for include_user in [false, true] {
        let mut active = turn("inProgress", Some(1), include_user);
        active.raw_payload = json!({"error": null});
        for payload in [
            json!({"id": "commentary", "type": "agentMessage", "phase": "commentary", "text": "Checking now."}),
            json!({"id": "command", "type": "commandExecution", "command": "pwd", "status": "completed", "output": "/tmp"}),
            json!({"id": "partial-answer", "type": "agentMessage", "phase": "final_answer", "text": "Partial response."}),
        ] {
            active
                .items
                .push(ThreadItemSnapshot::from_payload(&payload).unwrap());
        }
        let sessions = ThreadViewStore::default();
        build_thread_timeline(&sessions, "thread", &[active.clone()], 1)
            .await
            .unwrap();
        let mut failed = active.clone();
        failed.status = "failed".into();
        failed.completed_at = Some(10);
        failed.raw_payload = json!({"error": {"message": "Model at capacity."}});
        let (_, patch) = record_turn_status(&sessions, "thread", &failed, ready(Ok(2)))
            .await
            .unwrap();
        // A connected client gets the canonical patch; a second client can miss
        // it and attach from native history. Both must place the failure last.
        let live_rows = serde_json::to_value(patch).unwrap()["rows"].clone();
        let mut next = turn("completed", Some(11), true);
        next.id = "next-turn".into();
        next.items[0] = ThreadItemSnapshot::from_payload(&json!({
            "id": "next-user", "type": "userMessage",
            "content": [{"type": "text", "text": "Try again."}]
        }))
        .unwrap();
        let fresh =
            build_thread_timeline(&ThreadViewStore::default(), "thread", &[failed, next], 3)
                .await
                .unwrap();
        let reloaded = serde_json::to_value(fresh).unwrap();
        for rows in [
            live_rows.as_array().unwrap(),
            reloaded["rows"].as_array().unwrap(),
        ] {
            let failed_rows = rows
                .iter()
                .filter(|row| row["turnId"] == "turn-failure")
                .collect::<Vec<_>>();
            let notice = failed_rows.last().unwrap();
            assert_eq!(
                notice["kind"], "work",
                "failure belongs after all turn output"
            );
            assert_eq!(notice["work"]["errorMessage"], "Model at capacity.");
            assert_eq!(
                failed_rows[failed_rows.len() - 2]["item"]["itemId"],
                "partial-answer"
            );
            assert!(
                notice["displayOrder"].as_i64().unwrap()
                    > failed_rows[failed_rows.len() - 2]["displayOrder"]
                        .as_i64()
                        .unwrap()
            );
        }
        let rows = reloaded["rows"].as_array().unwrap();
        let failure_index = rows
            .iter()
            .position(|row| row["kind"] == "work" && row["turnId"] == "turn-failure")
            .unwrap();
        assert_eq!(rows[failure_index + 1]["turnId"], "next-turn");
    }
}
