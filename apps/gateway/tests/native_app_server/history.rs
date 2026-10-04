use std::collections::HashSet;

use anyhow::Context;
use serde_json::{json, Value};
use tokio::time::{timeout, Duration};

use super::fixture::{api, Fixture, ModelResponse, NativeSession};

const MESSAGE: &str = "Native history message — 相同文本，独立身份";
const COMPLETED_TURNS: usize = 51;

#[derive(Debug)]
struct Receipt {
    turn_id: String,
    item_id: String,
    client_id: String,
}

struct HistoryBranches {
    parent_id: String,
    parent: Vec<Receipt>,
    fork_id: String,
    fork: Vec<Receipt>,
}

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_native_attach_bootstraps_history_live_state_and_cold_cursor_continuity(
) -> anyhow::Result<()> {
    let mut fixture = Fixture::new().await?;
    let mut session = NativeSession::start(&fixture).await?;
    let result = timeout(
        Duration::from_secs(90),
        seed_history(&mut fixture, &mut session),
    )
    .await;
    session.shutdown().await?;
    drop(session);
    let (thread_id, receipts) = result??;

    let mut reopened = NativeSession::start(&fixture).await?;
    let result = timeout(
        Duration::from_secs(45),
        cold_and_live_history(&mut fixture, &mut reopened, &thread_id, receipts),
    )
    .await;
    reopened.shutdown().await?;
    drop(reopened);
    let branches = result??;

    let cold = NativeSession::start(&fixture).await?;
    let result = timeout(
        Duration::from_secs(30),
        assert_cold_branches(&cold, &branches),
    )
    .await;
    cold.shutdown().await?;
    result??;
    anyhow::ensure!(!fixture.config.codex.home.join("auth.json").exists());
    Ok(())
}

async fn seed_history(
    fixture: &mut Fixture,
    session: &mut NativeSession,
) -> anyhow::Result<(String, Vec<Receipt>)> {
    let project = api(
        &session.app,
        "POST",
        "/v1/projects",
        Some(json!({
            "name":"Native history proof", "roots":[{"path":fixture.workspace}],
            "idempotencyKey":"native-history-proof",
        })),
    )
    .await?;
    let catalog = api(&session.app, "GET", "/v1/models", None).await?;
    let model = catalog["models"]
        .as_array()
        .context("native model catalog missing")?
        .iter()
        .find(|model| {
            model["supportedReasoningEfforts"]
                .as_array()
                .is_some_and(|efforts| {
                    efforts
                        .iter()
                        .any(|effort| effort["reasoningEffort"] == "high")
                })
                && model["rawPayload"]["serviceTiers"]
                    .as_array()
                    .is_some_and(|tiers| tiers.iter().any(|tier| tier["id"] == "priority"))
        })
        .and_then(|model| model["model"].as_str())
        .context("pinned catalog needs high effort and priority tier for the settings assertion")?;
    let created = api(
        &session.app,
        "POST",
        "/v1/threads",
        Some(json!({"projectId":project["id"], "model":model})),
    )
    .await?;
    let thread_id = created["thread"]["id"]
        .as_str()
        .context("native thread ID missing")?
        .to_owned();

    // 0.160 cannot resume this loaded shell before its first message. The
    // gateway must validate it with native history reads, not invent a chat or
    // interpret every missing-rollout error as an empty transcript.
    let empty = attach(session, &thread_id).await?;
    anyhow::ensure!(empty["thread"]["id"] == thread_id);
    anyhow::ensure!(empty["thread"]["status"] == "idle");
    anyhow::ensure!(empty["timeline"]["rows"] == json!([]));
    anyhow::ensure!(empty["timeline"]["turns"] == json!([]));
    anyhow::ensure!(empty["historyPage"]["hasOlder"] == false);
    anyhow::ensure!(empty["historyPage"]["olderCursor"].is_null());
    anyhow::ensure!(empty["historyPage"]["limit"] == 50);

    let mut receipts = Vec::new();
    // One more than the public initial turn-page limit gives the real native
    // opaque cursor work to do; completion heads use separate bounded headers.
    for index in 0..COMPLETED_TURNS {
        let client_id = if index >= COMPLETED_TURNS - 2 {
            "deliberately-reused-history-client".to_owned()
        } else {
            format!("history-client-{index}")
        };
        fixture.enqueue([ModelResponse::message("Native history fixture completed")]);
        let turn_id = submit(session, &thread_id, &client_id).await?;
        receipts.push(receipt(session, &thread_id, &turn_id, &client_id).await?);
        let completed = session.completed_turn(&thread_id, "completed").await?;
        anyhow::ensure!(completed["id"] == turn_id);
        fixture.next_model_request().await?;
    }
    anyhow::ensure!(
        receipts
            .iter()
            .map(|row| &row.item_id)
            .collect::<HashSet<_>>()
            .len()
            == COMPLETED_TURNS,
        "separate accepted inputs reused a native item ID"
    );
    Ok((thread_id, receipts))
}

async fn cold_and_live_history(
    fixture: &mut Fixture,
    session: &mut NativeSession,
    thread_id: &str,
    mut receipts: Vec<Receipt>,
) -> anyhow::Result<HistoryBranches> {
    let detail = api(
        &session.app,
        "GET",
        &format!("/v1/threads/{thread_id}"),
        None,
    )
    .await?;
    anyhow::ensure!(detail["thread"]["status"] == "notLoaded");
    anyhow::ensure!(detail["thread"]["canAcceptDirectInput"].is_null());
    assert_receipts(&detail, &receipts[1..])?;

    // A second read confirms history inspection did not load the native chat.
    let read_again = api(
        &session.app,
        "GET",
        &format!("/v1/threads/{thread_id}"),
        None,
    )
    .await?;
    anyhow::ensure!(read_again["thread"]["status"] == "notLoaded");
    let attached = attach(session, thread_id).await?;
    anyhow::ensure!(attached["thread"]["status"] == "idle");
    anyhow::ensure!(attached["thread"]["canAcceptDirectInput"] == true);
    anyhow::ensure!(attached["historyPage"]["loadedTurnCount"] == 50);
    anyhow::ensure!(attached["historyPage"]["hasOlder"] == true);
    assert_receipts(&attached, &receipts[1..])?;
    let cursor = attached["historyPage"]["olderCursor"]
        .as_str()
        .context("initial native page omitted its older cursor")?;
    let older = older_page(session, thread_id, cursor).await?;
    anyhow::ensure!(older["historyPage"]["hasOlder"] == false);
    anyhow::ensure!(older["historyPage"]["olderCursor"].is_null());
    assert_receipts(&older, &receipts)?;

    api(
        &session.app,
        "PATCH",
        &format!("/v1/threads/{thread_id}/settings"),
        Some(json!({"effort":"high", "serviceTier":"priority"})),
    )
    .await?;
    session
        .notification("thread/settings/updated", "threadId", thread_id)
        .await?;
    let settings = read_settings(session, thread_id).await?;
    anyhow::ensure!(settings["effort"] == "high");
    anyhow::ensure!(settings["serviceTier"] == "priority");

    let (first, release_first) = ModelResponse::gated_message("Native live boundary");
    let (second, release_second) = ModelResponse::gated_message("Native live input completed");
    fixture.enqueue([first, second]);
    let turn_id = submit(session, thread_id, "history-active").await?;
    receipts.push(receipt(session, thread_id, &turn_id, "history-active").await?);
    fixture.next_model_request().await?;
    anyhow::ensure!(submit(session, thread_id, "history-pending").await? == turn_id);

    // The first response remains held: native has an active turn and the
    // gateway has an accepted input waiting for a native model boundary.
    // Reattachment must keep both while reading the same effective settings.
    for _ in 0..2 {
        let active = attach(session, thread_id).await?;
        anyhow::ensure!(active["thread"]["status"] == "active");
        anyhow::ensure!(active["timeline"]["activeTurnId"] == turn_id);
        anyhow::ensure!(active["timeline"]["liveState"] == "streaming");
        let items = user_items(&active)?;
        anyhow::ensure!(
            items.len() == receipts.len() + 1,
            "active attach returned unexpected native/pending rows: {}",
            serde_json::to_string(
                &items
                    .iter()
                    .map(|item| json!({
                        "turnId":item["turnId"], "itemId":item["itemId"],
                        "clientId":item["payload"]["item"]["clientId"], "status":item["status"],
                    }))
                    .collect::<Vec<_>>()
            )?
        );
        for client_id in ["history-active", "history-pending"] {
            anyhow::ensure!(
                items
                    .iter()
                    .filter(|item| item["payload"]["item"]["clientId"] == client_id)
                    .count()
                    == 1
            );
        }
        anyhow::ensure!(read_settings(session, thread_id).await? == settings);
    }
    release_first
        .send(())
        .map_err(|_| anyhow::anyhow!("first held response disconnected"))?;
    fixture.next_model_request().await?;
    receipts.push(receipt(session, thread_id, &turn_id, "history-pending").await?);
    release_second
        .send(())
        .map_err(|_| anyhow::anyhow!("second held response disconnected"))?;
    let completed = session.completed_turn(thread_id, "completed").await?;
    anyhow::ensure!(completed["id"] == turn_id);
    assert_receipts(&attach(session, thread_id).await?, &receipts)?;
    anyhow::ensure!(read_settings(session, thread_id).await? == settings);

    // Capture the fork's actual inherited identities. Native owns whether they
    // match the parent; branch continuation and cold reads must retain its IDs.
    let fork = api(
        &session.app,
        "POST",
        &format!("/v1/threads/{thread_id}/fork"),
        Some(json!({"beforeTurnId":receipts[2].turn_id})),
    )
    .await?;
    let fork_id = fork["thread"]["id"]
        .as_str()
        .context("native fork ID missing")?
        .to_owned();
    anyhow::ensure!(fork_id != thread_id);
    let fork = api(&session.app, "GET", &format!("/v1/threads/{fork_id}"), None).await?;
    let fork_items = user_items(&fork)?;
    anyhow::ensure!(fork_items.len() == 2);
    let mut fork_receipts = Vec::new();
    for (item, original) in fork_items.iter().zip(&receipts[..2]) {
        anyhow::ensure!(item["threadId"] == fork_id);
        anyhow::ensure!(item["payload"]["item"]["clientId"] == original.client_id);
        anyhow::ensure!(item["payload"]["item"]["content"][0]["text"] == MESSAGE);
        fork_receipts.push(Receipt {
            turn_id: item["turnId"]
                .as_str()
                .context("fork turn ID missing")?
                .into(),
            item_id: item["itemId"]
                .as_str()
                .context("fork item ID missing")?
                .into(),
            client_id: original.client_id.clone(),
        });
    }

    fixture.enqueue([ModelResponse::message(
        "Independent native fork continuation",
    )]);
    let fork_turn = submit(session, &fork_id, "fork-only-client").await?;
    let fork_receipt = receipt(session, &fork_id, &fork_turn, "fork-only-client").await?;
    anyhow::ensure!(receipts
        .iter()
        .all(|parent| parent.turn_id != fork_receipt.turn_id
            && parent.item_id != fork_receipt.item_id));
    fork_receipts.push(fork_receipt);
    anyhow::ensure!(session.completed_turn(&fork_id, "completed").await?["id"] == fork_turn);
    fixture.next_model_request().await?;
    assert_receipts(&attach(session, &fork_id).await?, &fork_receipts)?;
    assert_receipts(&attach(session, thread_id).await?, &receipts)?;
    Ok(HistoryBranches {
        parent_id: thread_id.into(),
        parent: receipts,
        fork_id,
        fork: fork_receipts,
    })
}

async fn assert_cold_branches(
    session: &NativeSession,
    branches: &HistoryBranches,
) -> anyhow::Result<()> {
    let parent = api(
        &session.app,
        "GET",
        &format!("/v1/threads/{}", branches.parent_id),
        None,
    )
    .await?;
    anyhow::ensure!(parent["thread"]["status"] == "notLoaded");
    anyhow::ensure!(parent["historyPage"]["loadedTurnCount"] == 50);
    let cursor = parent["historyPage"]["olderCursor"]
        .as_str()
        .context("cold parent cursor missing")?;
    let parent = older_page(session, &branches.parent_id, cursor).await?;
    anyhow::ensure!(parent["thread"]["status"] == "notLoaded");
    anyhow::ensure!(parent["historyPage"]["hasOlder"] == false);
    assert_receipts(&parent, &branches.parent)?;

    let fork = api(
        &session.app,
        "GET",
        &format!("/v1/threads/{}", branches.fork_id),
        None,
    )
    .await?;
    anyhow::ensure!(fork["thread"]["id"] == branches.fork_id);
    anyhow::ensure!(fork["thread"]["status"] == "notLoaded");
    anyhow::ensure!(fork["historyPage"]["hasOlder"] == false);
    assert_receipts(&fork, &branches.fork)?;
    Ok(())
}

async fn older_page(
    session: &NativeSession,
    thread_id: &str,
    cursor: &str,
) -> anyhow::Result<Value> {
    let mut url = reqwest::Url::parse(&format!(
        "http://fixture.invalid/v1/threads/{thread_id}/timeline/pages"
    ))?;
    url.query_pairs_mut().append_pair("cursor", cursor);
    api(
        &session.app,
        "GET",
        &format!("{}?{}", url.path(), url.query().unwrap_or_default()),
        None,
    )
    .await
}

async fn attach(session: &NativeSession, thread_id: &str) -> anyhow::Result<Value> {
    api(
        &session.app,
        "POST",
        &format!("/v1/threads/{thread_id}/attach"),
        None,
    )
    .await
}

async fn read_settings(session: &NativeSession, thread_id: &str) -> anyhow::Result<Value> {
    api(
        &session.app,
        "GET",
        &format!("/v1/threads/{thread_id}/settings"),
        None,
    )
    .await
}

async fn submit(
    session: &NativeSession,
    thread_id: &str,
    client_id: &str,
) -> anyhow::Result<String> {
    let response = api(
        &session.app,
        "POST",
        &format!("/v1/threads/{thread_id}/input"),
        Some(json!({"input":[{"type":"text", "text":MESSAGE}], "clientUserMessageId":client_id})),
    )
    .await?;
    Ok(response["payload"]["turn"]["id"]
        .as_str()
        .context("native turn ID missing")?
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
        anyhow::ensure!(item["content"][0]["text"] == MESSAGE);
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
    Ok(view["timeline"]["rows"]
        .as_array()
        .context("canonical timeline rows missing")?
        .iter()
        .filter_map(|row| row.get("item"))
        .filter(|item| item["itemType"] == "userMessage")
        .collect())
}

fn assert_receipts(view: &Value, expected: &[Receipt]) -> anyhow::Result<()> {
    let items = user_items(view)?;
    anyhow::ensure!(
        items.len() == expected.len(),
        "expected {} native messages, got {}",
        expected.len(),
        items.len()
    );
    for (item, receipt) in items.iter().zip(expected) {
        anyhow::ensure!(
            item["itemId"] == receipt.item_id,
            "native chronological item identity changed: {item}"
        );
        anyhow::ensure!(item["turnId"] == receipt.turn_id);
        anyhow::ensure!(item["payload"]["item"]["clientId"] == receipt.client_id);
        anyhow::ensure!(item["payload"]["item"]["content"][0]["text"] == MESSAGE);
    }
    Ok(())
}
