use anyhow::Context;
use kodex_gateway::app_server_api::{SortDirection, ThreadItemsListPage};
use serde_json::json;
use tokio::time::{timeout, Duration};

use super::fixture::{api, Fixture, ModelResponse, NativeSession};

#[derive(Debug)]
struct CompletedAnswer {
    turn_id: String,
    client_id: String,
    text: String,
    agent_item_id: String,
    user_item_id: String,
}

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_native_item_pages_keep_turn_scope_order_and_reverted_history() -> anyhow::Result<()> {
    let mut fixture = Fixture::new().await?;
    let mut session = NativeSession::start(&fixture).await?;
    let result = timeout(
        Duration::from_secs(45),
        exercise(&mut fixture, &mut session),
    )
    .await;
    session.shutdown().await?;
    drop(session);
    let (thread_id, retained, removed) = result??;

    // Item history reads must preserve the unloaded state in a new native
    // process, including when the requested turn is no longer visible.
    let reopened = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(20), async {
        assert_unloaded(&reopened, &thread_id).await?;
        let retained_page = turn_items(&reopened, &thread_id, &retained.turn_id).await?;
        assert_answer(&retained_page, &retained)?;
        assert_empty(turn_items(&reopened, &thread_id, &removed.turn_id).await?)?;
        assert_unloaded(&reopened, &thread_id).await?;
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
) -> anyhow::Result<(String, CompletedAnswer, CompletedAnswer)> {
    let project = api(
        &session.app,
        "POST",
        "/v1/projects",
        Some(json!({
            "name":"Native item history proof", "roots":[{"path":fixture.workspace}],
            "idempotencyKey":"native-item-history-proof",
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
    let older = complete_answer(
        fixture,
        session,
        &thread_id,
        "older-notification",
        "The older turn's answer belongs to its own notification.",
    )
    .await?;
    let newer = complete_answer(
        fixture,
        session,
        &thread_id,
        "newer-notification",
        "A newer unrelated turn must never replace the older preview.",
    )
    .await?;
    anyhow::ensure!(older.turn_id != newer.turn_id);
    anyhow::ensure!(older.agent_item_id != newer.agent_item_id);
    anyhow::ensure!(older.user_item_id != newer.user_item_id);

    // A delayed notification for the older turn must not read the latest
    // answer. Native filtering is independent of which turn completed last.
    let older_page = turn_items(session, &thread_id, &older.turn_id).await?;
    assert_answer(&older_page, &older)?;
    anyhow::ensure!(older_page
        .data
        .iter()
        .all(|entry| entry.item.raw_payload["text"] != newer.text));
    assert_answer(
        &turn_items(session, &thread_id, &newer.turn_id).await?,
        &newer,
    )?;

    // Descending pages preserve native creation order and opaque continuation.
    // This fixture produces exactly one user item and one assistant item.
    let first = session
        .native_items_page(
            &thread_id,
            Some(&older.turn_id),
            None,
            SortDirection::Desc,
            1,
        )
        .await?;
    anyhow::ensure!(first.data.len() == 1);
    anyhow::ensure!(first.data[0].turn_id == older.turn_id);
    anyhow::ensure!(first.data[0].item.id == older.agent_item_id);
    anyhow::ensure!(first.data[0].item.raw_payload["text"] == older.text);
    anyhow::ensure!(first.backwards_cursor.is_some());
    let cursor = first
        .next_cursor
        .context("older user item must have a cursor")?;
    let second = session
        .native_items_page(
            &thread_id,
            Some(&older.turn_id),
            Some(cursor),
            SortDirection::Desc,
            1,
        )
        .await?;
    anyhow::ensure!(second.data.len() == 1);
    anyhow::ensure!(second.data[0].turn_id == older.turn_id);
    anyhow::ensure!(second.data[0].item.id == older.user_item_id);
    anyhow::ensure!(second.data[0].item.client_id.as_deref() == Some(older.client_id.as_str()));
    anyhow::ensure!(second.next_cursor.is_none());
    anyhow::ensure!(second.backwards_cursor.is_some());

    let reverted = session.native_revert(&thread_id, &newer.turn_id).await?;
    anyhow::ensure!(reverted["thread"]["id"] == thread_id);
    session
        .notification("thread/reverted", "threadId", &thread_id)
        .await?;
    // The native turn filter returns an empty successful page for a removed
    // turn. It does not substitute another turn or require an error fallback.
    assert_empty(turn_items(session, &thread_id, &newer.turn_id).await?)?;
    assert_answer(
        &turn_items(session, &thread_id, &older.turn_id).await?,
        &older,
    )?;
    Ok((thread_id, older, newer))
}

async fn complete_answer(
    fixture: &mut Fixture,
    session: &mut NativeSession,
    thread_id: &str,
    client_id: &str,
    text: &str,
) -> anyhow::Result<CompletedAnswer> {
    // A provider item ID is native identity, so each response in this proof
    // supplies a distinct ID instead of the general fixture's reused default.
    fixture.enqueue([ModelResponse::Items(vec![json!({
        "type":"message", "role":"assistant", "id":format!("answer-{client_id}"),
        "content":[{"type":"output_text", "text":text}],
    })])]);
    let accepted = api(
        &session.app,
        "POST",
        &format!("/v1/threads/{thread_id}/input"),
        Some(json!({
            "input":[{"type":"text", "text":client_id}],
            "clientUserMessageId":client_id,
        })),
    )
    .await?;
    let turn_id = accepted["payload"]["turn"]["id"]
        .as_str()
        .context("native accepted turn ID missing")?
        .to_owned();
    let completed = session.completed_turn(thread_id, "completed").await?;
    anyhow::ensure!(completed["id"] == turn_id);
    fixture.next_model_request().await?;
    let page = turn_items(session, thread_id, &turn_id).await?;
    anyhow::ensure!(
        page.data.len() == 2,
        "unexpected fixture item page: {page:?}"
    );
    let answer = CompletedAnswer {
        turn_id,
        client_id: client_id.to_owned(),
        text: text.to_owned(),
        agent_item_id: page.data[0].item.id.clone(),
        user_item_id: page.data[1].item.id.clone(),
    };
    assert_answer(&page, &answer)?;
    Ok(answer)
}

async fn turn_items(
    session: &NativeSession,
    thread_id: &str,
    turn_id: &str,
) -> anyhow::Result<ThreadItemsListPage> {
    session
        .native_items_page(thread_id, Some(turn_id), None, SortDirection::Desc, 16)
        .await
}

fn assert_answer(page: &ThreadItemsListPage, expected: &CompletedAnswer) -> anyhow::Result<()> {
    anyhow::ensure!(
        page.data.len() == 2,
        "unexpected fixture item page: {page:?}"
    );
    anyhow::ensure!(page
        .data
        .iter()
        .all(|entry| entry.turn_id == expected.turn_id));
    anyhow::ensure!(page.data[0].item.item_type == "agentMessage");
    anyhow::ensure!(page.data[0].item.id == expected.agent_item_id);
    anyhow::ensure!(page.data[0].item.raw_payload["text"] == expected.text);
    anyhow::ensure!(page.data[1].item.item_type == "userMessage");
    anyhow::ensure!(page.data[1].item.id == expected.user_item_id);
    anyhow::ensure!(page.data[1].item.client_id.as_deref() == Some(expected.client_id.as_str()));
    anyhow::ensure!(page.data[1].item.raw_payload["content"][0]["text"] == expected.client_id);
    anyhow::ensure!(page.next_cursor.is_none());
    anyhow::ensure!(page.backwards_cursor.is_some());
    Ok(())
}

fn assert_empty(page: ThreadItemsListPage) -> anyhow::Result<()> {
    anyhow::ensure!(
        page.data.is_empty(),
        "removed turn returned items: {page:?}"
    );
    anyhow::ensure!(page.next_cursor.is_none());
    anyhow::ensure!(page.backwards_cursor.is_none());
    Ok(())
}

async fn assert_unloaded(session: &NativeSession, thread_id: &str) -> anyhow::Result<()> {
    let detail = api(
        &session.app,
        "GET",
        &format!("/v1/threads/{thread_id}"),
        None,
    )
    .await?;
    anyhow::ensure!(detail["thread"]["status"] == "notLoaded");
    Ok(())
}
