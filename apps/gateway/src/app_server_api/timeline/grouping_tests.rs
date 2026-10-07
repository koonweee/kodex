use super::*;
use serde_json::json;

fn turn(id: &str, items: Vec<Value>) -> ThreadTurnSnapshot {
    ThreadTurnSnapshot {
        id: id.into(),
        status: "inProgress".into(),
        started_at: None,
        completed_at: None,
        raw_payload: json!({}),
        items: items
            .iter()
            .map(|item| ThreadItemSnapshot::from_payload(item).unwrap())
            .collect(),
    }
}

fn command(id: &str) -> Value {
    json!({"id": id, "type": "commandExecution", "command": "pwd", "status": "completed"})
}

fn groups(snapshot: &ThreadTimelineSnapshot) -> Vec<Vec<&str>> {
    snapshot
        .rows
        .iter()
        .filter(|row| row.kind == "activity")
        .map(|row| row.items.iter().map(|item| item.item_id.as_str()).collect())
        .collect()
}

#[test]
fn invisible_separators_do_not_fragment_commands() {
    for separator in [
        json!({"id":"gap", "type":"reasoning", "summary":[], "content":[]}),
        json!({"id":"gap", "type":"hookPrompt", "text":"internal hook"}),
        json!({"id":"gap", "type":"subAgentActivity", "kind":"interacted"}),
        json!({"id":"gap", "type":"plan", "text":""}),
        json!({"id":"gap", "type":"futureUnsupportedItem"}),
    ] {
        let snapshot = ThreadTimelineSnapshot::from_turns(
            "thread",
            &[turn(
                "turn",
                vec![command("a"), separator.clone(), command("b")],
            )],
        );
        assert_eq!(groups(&snapshot), vec![vec!["a", "b"]], "{separator}");
        assert!(
            snapshot
                .rows
                .iter()
                .any(|row| row.item.as_ref().is_some_and(|item| item.item_id == "gap")),
            "retain native item"
        );
        assert!(snapshot
            .rows
            .windows(2)
            .all(|rows| rows[0].display_order <= rows[1].display_order));
    }
}

#[test]
fn visible_content_and_semantic_boundaries_split_commands() {
    for separator in [
        json!({"id":"gap", "type":"reasoning", "summary":["Checking"]}),
        json!({"id":"gap", "type":"reasoning", "content":[{"type":"text","text":"Checking"}]}),
        json!({"id":"gap", "type":"plan", "text":"Next step"}),
        json!({"id":"gap", "type":"agentMessage", "text":"Working"}),
        json!({"id":"gap", "type":"agentMessage", "text":"", "phase":"final_answer"}),
        json!({"id":"gap", "type":"agentMessage", "text":""}),
        json!({"id":"gap", "type":"userMessage", "content":[]}),
        json!({"id":"gap", "type":"contextCompaction"}),
        json!({"id":"gap", "type":"enteredReviewMode"}),
        json!({"id":"gap", "type":"imageGeneration"}),
        json!({"id":"gap", "type":"error", "text":"Failed"}),
    ] {
        let snapshot = ThreadTimelineSnapshot::from_turns(
            "thread",
            &[turn(
                "turn",
                vec![command("a"), separator.clone(), command("b")],
            )],
        );
        assert_eq!(groups(&snapshot), vec![vec!["a"], vec!["b"]], "{separator}");
    }
}

#[test]
fn activity_grouping_respects_turn_boundaries() {
    let snapshot = ThreadTimelineSnapshot::from_turns(
        "thread",
        &[
            turn("one", vec![command("a")]),
            turn("two", vec![command("b")]),
        ],
    );
    assert_eq!(groups(&snapshot), vec![vec!["a"], vec!["b"]]);
}

#[test]
fn reasoning_becoming_visible_rebuilds_groups_without_losing_commands() {
    let mut native_turn = turn(
        "turn",
        vec![
            command("a"),
            json!({"id":"gap","type":"reasoning","summary":[]}),
            command("b"),
        ],
    );
    let empty = ThreadTimelineSnapshot::from_turns("thread", &[native_turn.clone()]);
    assert_eq!(groups(&empty), vec![vec!["a", "b"]]);
    native_turn.items[1] = ThreadItemSnapshot::from_payload(
        &json!({"id":"gap","type":"reasoning","summary":["Checking"]}),
    )
    .unwrap();
    let visible = ThreadTimelineSnapshot::from_turns("thread", &[native_turn]);
    assert_eq!(groups(&visible), vec![vec!["a"], vec!["b"]]);
    assert_eq!(empty.items.len(), visible.items.len());
}

#[tokio::test]
async fn live_regrouping_patches_converge_with_native_refills() {
    use crate::thread_view::{
        build_thread_timeline, record_item_upsert, ThreadViewPatchScope, ThreadViewStore,
    };
    use std::future::ready;

    let sessions = ThreadViewStore::default();
    let mut native = turn(
        "turn",
        vec![
            command("a"),
            json!({"id":"gap", "type":"reasoning", "summary":[], "content":[]}),
            command("b"),
        ],
    );
    for (index, item) in native.items.iter().enumerate() {
        record_item_upsert(
            &sessions,
            "thread",
            "turn",
            item.raw_payload.clone(),
            item.clone(),
            Some("inProgress"),
            ready(Ok(index as i64 + 1)),
        )
        .await
        .unwrap();
    }
    let initial = build_thread_timeline(&sessions, "thread", &[native.clone()], 3)
        .await
        .unwrap();
    assert_eq!(groups(&initial), vec![vec!["a", "b"]]);

    for (revision, summary, expected) in [
        (4, json!(["Checking"]), vec![vec!["a"], vec!["b"]]),
        (5, json!([]), vec![vec!["a", "b"]]),
    ] {
        let raw = json!({"id":"gap", "type":"reasoning", "summary":summary, "content":[]});
        let item = ThreadItemSnapshot::from_payload(&raw).unwrap();
        native.items[1] = item.clone();
        // Client A receives the actual canonical patch produced by the native upsert.
        let patch = record_item_upsert(
            &sessions,
            "thread",
            "turn",
            raw,
            item,
            Some("inProgress"),
            ready(Ok(revision)),
        )
        .await
        .unwrap();
        let patch_groups = patch
            .rows
            .as_ref()
            .unwrap()
            .iter()
            .filter(|row| row.kind == "activity")
            .map(|row| {
                row.items
                    .iter()
                    .map(|item| item.item_id.as_str())
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        assert_eq!(patch_groups, expected);
        if revision == 5 {
            // Merging removes the second activity row; a turn replacement must
            // remove that obsolete row for clients that saw the earlier split.
            assert_eq!(patch.scope, ThreadViewPatchScope::Turn);
        }
        // Client B missed events. Native refill (also after restart) agrees.
        let refill = build_thread_timeline(
            &ThreadViewStore::default(),
            "thread",
            &[native.clone()],
            revision,
        )
        .await
        .unwrap();
        assert_eq!(groups(&refill), expected);
    }
}
