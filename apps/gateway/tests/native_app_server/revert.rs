use anyhow::Context;
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::time::{timeout, Duration};
use tower::ServiceExt;

use super::fixture::{api, Fixture, ModelResponse, NativeSession};

#[derive(Debug)]
struct Receipt {
    turn_id: String,
    item_id: String,
    client_id: String,
}

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_native_revert_invalidates_live_history_and_persists_only_retained_prefix(
) -> anyhow::Result<()> {
    let mut fixture = Fixture::new().await?;
    let mut session = NativeSession::start(&fixture).await?;
    let result = timeout(
        Duration::from_secs(60),
        exercise(&mut fixture, &mut session),
    )
    .await;
    session.shutdown().await?;
    drop(session);
    let (thread_id, retained, new_receipt) = result??;

    let reopened = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(20), async {
        let cold = api(
            &reopened.app,
            "GET",
            &format!("/v1/threads/{thread_id}"),
            None,
        )
        .await?;
        anyhow::ensure!(cold["thread"]["status"] == "notLoaded");
        assert_receipts(&cold["timeline"], &[&retained, &new_receipt])?;
        anyhow::ensure!(cold["timeline"]["activeTurnId"].is_null());
        anyhow::ensure!(cold["historyPage"]["hasOlder"] == false);
        Ok::<_, anyhow::Error>(())
    })
    .await;
    reopened.shutdown().await?;
    result??;
    anyhow::ensure!(!fixture.config.codex.home.join("auth.json").exists());
    Ok(())
}

async fn exercise(
    fixture: &mut Fixture,
    session: &mut NativeSession,
) -> anyhow::Result<(String, Receipt, Receipt)> {
    let project = api(
        &session.app,
        "POST",
        "/v1/projects",
        Some(json!({
            "name":"Native revert proof", "roots":[{"path":fixture.workspace}],
            "idempotencyKey":"native-revert-proof",
        })),
    )
    .await?;
    let created = api(
        &session.app,
        "POST",
        "/v1/threads",
        Some(json!({"projectId":project["id"]})),
    )
    .await?;
    let thread_id = created["thread"]["id"]
        .as_str()
        .context("native thread ID missing")?
        .to_owned();
    let mut receipts = Vec::new();
    for client_id in [
        "retained-prefix",
        "excluded-boundary",
        "excluded-after-boundary",
    ] {
        fixture.enqueue([ModelResponse::message("Native revert fixture completed")]);
        let turn_id = submit(session, &thread_id, client_id).await?;
        receipts.push(receipt(session, &thread_id, &turn_id, client_id).await?);
        let completed = session.completed_turn(&thread_id, "completed").await?;
        anyhow::ensure!(completed["id"] == turn_id);
        fixture.next_model_request().await?;
    }
    let before = api(
        &session.app,
        "POST",
        &format!("/v1/threads/{thread_id}/attach"),
        None,
    )
    .await?;
    assert_receipts(&before["timeline"], &receipts.iter().collect::<Vec<_>>())?;

    fixture.enqueue([ModelResponse::Hold]);
    let active_turn = submit(session, &thread_id, "excluded-active").await?;
    receipts.push(receipt(session, &thread_id, &active_turn, "excluded-active").await?);
    fixture.next_model_request().await?;
    anyhow::ensure!(submit(session, &thread_id, "excluded-pending").await? == active_turn);
    let live = session.canonical_view(&thread_id).await?;
    anyhow::ensure!(live["activeTurnId"] == active_turn);
    anyhow::ensure!(user_items(&live)?.len() == 5);
    let before_revision = live["viewRevision"]
        .as_i64()
        .context("live canonical revision missing")?;

    // Observe the same HTTP stream a browser uses, before issuing the native
    // mutation. The fixture's native notification observer runs after ingestion.
    let stream = session
        .app
        .clone()
        .oneshot(
            Request::get(format!("/v1/events?threadId={thread_id}"))
                .header("accept", "text/event-stream")
                .body(Body::empty())?,
        )
        .await?;
    anyhow::ensure!(stream.status().is_success());
    let reverted = session
        .native_revert(&thread_id, &receipts[1].turn_id)
        .await?;
    anyhow::ensure!(reverted["thread"]["id"] == thread_id);
    anyhow::ensure!(reverted["thread"]["turns"] == json!([]));
    let interrupted = session.completed_turn(&thread_id, "interrupted").await?;
    anyhow::ensure!(interrupted["id"] == active_turn);
    session
        .notification("thread/reverted", "threadId", &thread_id)
        .await?;

    // Inspect before any GET/attach can repair stale gateway state. Revert
    // excludes the boundary turn and everything after it, including accepted
    // pending input; retaining an old active row is not a history refill.
    let cleared = session.canonical_view(&thread_id).await?;
    let cleared_revision = cleared["viewRevision"]
        .as_i64()
        .context("post-revert canonical revision missing")?;
    anyhow::ensure!(cleared_revision > before_revision);
    anyhow::ensure!(cleared["activeTurnId"].is_null());
    anyhow::ensure!(cleared["liveState"] == "idle");
    assert_only_turns(&cleared, &[&receipts[0]])?;
    for item in user_items(&cleared)? {
        anyhow::ensure!(
            item["itemId"] == receipts[0].item_id,
            "native revert left an excluded or pending row in the canonical view: {item}"
        );
    }
    await_refresh(stream.into_body(), &thread_id, cleared_revision).await?;

    let refilled = api(
        &session.app,
        "GET",
        &format!("/v1/threads/{thread_id}"),
        None,
    )
    .await?;
    assert_receipts(&refilled["timeline"], &[&receipts[0]])?;
    anyhow::ensure!(refilled["historyPage"]["hasOlder"] == false);
    anyhow::ensure!(refilled["historyPage"]["olderCursor"].is_null());

    // Native revert replaces/reloads the same runtime and keeps it usable.
    // Reusing the discarded client's ID must still create a distinct native
    // turn/item; correlation is not an idempotency or replay operation.
    fixture.enqueue([ModelResponse::message("New history after revert")]);
    let new_turn = submit(session, &thread_id, "excluded-boundary").await?;
    let new_receipt = receipt(session, &thread_id, &new_turn, "excluded-boundary").await?;
    anyhow::ensure!(receipts
        .iter()
        .all(|old| old.turn_id != new_receipt.turn_id && old.item_id != new_receipt.item_id));
    let completed = session.completed_turn(&thread_id, "completed").await?;
    anyhow::ensure!(completed["id"] == new_turn);
    fixture.next_model_request().await?;
    let after = api(
        &session.app,
        "POST",
        &format!("/v1/threads/{thread_id}/attach"),
        None,
    )
    .await?;
    assert_receipts(&after["timeline"], &[&receipts[0], &new_receipt])?;
    let retained = receipts.remove(0);
    Ok((thread_id, retained, new_receipt))
}

async fn submit(
    session: &NativeSession,
    thread_id: &str,
    client_id: &str,
) -> anyhow::Result<String> {
    let accepted = api(
        &session.app,
        "POST",
        &format!("/v1/threads/{thread_id}/input"),
        Some(json!({"input":[{"type":"text", "text":client_id}], "clientUserMessageId":client_id})),
    )
    .await?;
    Ok(accepted["payload"]["turn"]["id"]
        .as_str()
        .context("native accepted turn ID missing")?
        .into())
}

async fn receipt(
    session: &mut NativeSession,
    thread_id: &str,
    turn_id: &str,
    client_id: &str,
) -> anyhow::Result<Receipt> {
    loop {
        let params = session
            .notification("item/started", "threadId", thread_id)
            .await?;
        let item = &params["item"];
        if item["type"] != "userMessage" {
            continue;
        }
        anyhow::ensure!(params["turnId"] == turn_id);
        anyhow::ensure!(item["clientId"] == client_id);
        return Ok(Receipt {
            turn_id: turn_id.into(),
            item_id: item["id"]
                .as_str()
                .context("native item ID missing")?
                .into(),
            client_id: client_id.into(),
        });
    }
}

fn user_items(view: &Value) -> anyhow::Result<Vec<&Value>> {
    Ok(view["rows"]
        .as_array()
        .context("canonical rows missing")?
        .iter()
        .filter_map(|row| row.get("item"))
        .filter(|item| item["itemType"] == "userMessage")
        .collect())
}

fn assert_receipts(view: &Value, expected: &[&Receipt]) -> anyhow::Result<()> {
    assert_only_turns(view, expected)?;
    let items = user_items(view)?;
    anyhow::ensure!(
        items.len() == expected.len(),
        "native revert history expected {} user rows, got {}",
        expected.len(),
        items.len()
    );
    for (item, receipt) in items.iter().zip(expected) {
        anyhow::ensure!(item["turnId"] == receipt.turn_id);
        anyhow::ensure!(item["itemId"] == receipt.item_id);
        anyhow::ensure!(item["payload"]["item"]["clientId"] == receipt.client_id);
        anyhow::ensure!(item["payload"]["item"]["content"][0]["text"] == receipt.client_id);
    }
    Ok(())
}

fn assert_only_turns(view: &Value, expected: &[&Receipt]) -> anyhow::Result<()> {
    for (field, id_field) in [("rows", "turnId"), ("turns", "id")] {
        // Canonical full patches omit an empty turns vector; detail snapshots
        // always serialize it. Rows remain required for both forms.
        if field == "turns" && view["scope"] == "full_snapshot" && view.get(field).is_none() {
            continue;
        }
        for row in view[field]
            .as_array()
            .context("canonical history missing")?
        {
            anyhow::ensure!(
                expected
                    .iter()
                    .any(|receipt| row[id_field] == receipt.turn_id),
                "native revert left an excluded canonical {field} entry: {row}"
            );
        }
    }
    Ok(())
}

async fn await_refresh(
    mut body: Body,
    thread_id: &str,
    minimum_revision: i64,
) -> anyhow::Result<()> {
    timeout(Duration::from_secs(5), async {
        let mut buffer = String::new();
        while let Some(frame) = body.frame().await {
            let frame = frame?;
            let Some(bytes) = frame.data_ref() else {
                continue;
            };
            buffer.push_str(std::str::from_utf8(bytes)?);
            while let Some(end) = buffer.find("\n\n") {
                let event = buffer.drain(..end + 2).collect::<String>();
                for data in event.lines().filter_map(|line| line.strip_prefix("data: ")) {
                    let event: Value = serde_json::from_str(data)?;
                    if event["kind"] == "thread_view.refresh_required"
                        && event["threadId"] == thread_id
                        && event["seq"]
                            .as_i64()
                            .is_some_and(|seq| seq >= minimum_revision)
                    {
                        return Ok(());
                    }
                }
            }
        }
        anyhow::bail!("gateway stream closed before revert refresh marker")
    })
    .await
    .context("gateway did not publish a post-revert history refresh")?
}
