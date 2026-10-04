//! The retained queue-to-steer transfer against pinned native admission and
//! receipt behavior. Ordinary queued work is never copied into gateway storage.

use anyhow::Context;
use kodex_gateway::{
    app_server_api::NativeQueuedSubmission,
    queue_transfer::{self, PromotionOutcome},
    store::QueueTransferPhase,
};
use serde_json::{json, Value};
use tokio::{
    sync::oneshot,
    time::{timeout, Duration},
};

use super::fixture::{api, Fixture, ModelResponse, NativeSession};

const ORIGINAL_CLIENT: &str = "reused-queued-client";
const INITIAL_CLIENT: &str = "promotion-initial-client";
const QUEUED_TEXT: &str = "Identical queued correction — 保留原始内容";

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_native_promotion_uses_fresh_receipt_and_does_not_replay_on_restart(
) -> anyhow::Result<()> {
    let mut fixture = Fixture::new().await?;
    let mut session = NativeSession::start(&fixture).await?;
    let result = timeout(
        Duration::from_secs(45),
        exercise(&mut fixture, &mut session),
    )
    .await;
    session.shutdown().await?;
    drop(session);
    let (thread_id, retained, transfer_id, native_item_id) = result??;

    let reopened = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(25), async {
        queue_transfer::recover(&reopened.state).await?;
        anyhow::ensure!(reopened
            .state
            .store
            .list_queue_transfers(None)
            .await?
            .is_empty());
        anyhow::ensure!(reopened.native_loaded_threads().await?["data"] == json!([]));
        assert_native_queue(&reopened, &thread_id, std::slice::from_ref(&retained)).await?;
        let detail = api(
            &reopened.app,
            "GET",
            &format!("/v1/threads/{thread_id}"),
            None,
        )
        .await?;
        anyhow::ensure!(detail["thread"]["status"] == "notLoaded");
        assert_user_projection(&detail["timeline"], &transfer_id, &native_item_id)?;
        // Longer than the native ten-second watcher: a transient lack of
        // dispatch cannot masquerade as the selected unloaded restart behavior.
        fixture
            .assert_no_model_request(Duration::from_secs(11))
            .await?;
        anyhow::ensure!(reopened.native_loaded_threads().await?["data"] == json!([]));
        assert_native_queue(&reopened, &thread_id, std::slice::from_ref(&retained)).await?;
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
) -> anyhow::Result<(String, NativeQueuedSubmission, String, String)> {
    let project = api(
        &session.app,
        "POST",
        "/v1/projects",
        Some(json!({
            "name":"Native promotion proof", "roots":[{"path":fixture.workspace}],
            "idempotencyKey":"native-promotion-proof",
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
    let (release, wait) = oneshot::channel();
    fixture.enqueue([
        ModelResponse::GatedItems(
            vec![json!({
                "type":"message", "role":"assistant", "id":"promotion-boundary-answer",
                "content":[{"type":"output_text", "text":"Consume pending correction next"}],
            })],
            wait,
        ),
        ModelResponse::Hold,
    ]);
    let started = api(
        &session.app,
        "POST",
        &format!("/v1/threads/{thread_id}/input"),
        Some(json!({
            "input":[{"type":"text","text":"Hold the original turn at its model boundary"}],
            "clientUserMessageId":INITIAL_CLIENT,
        })),
    )
    .await?;
    let turn_id = started["payload"]["turn"]["id"]
        .as_str()
        .context("native original turn ID missing")?
        .to_owned();
    user_receipt(session, &thread_id, &turn_id, INITIAL_CLIENT).await?;
    fixture.next_model_request().await?;

    let retained = queue_transfer::enqueue(
        &session.state,
        &thread_id,
        queued_input(),
        ORIGINAL_CLIENT.into(),
    )
    .await?;
    let selected = queue_transfer::enqueue(
        &session.state,
        &thread_id,
        queued_input(),
        ORIGINAL_CLIENT.into(),
    )
    .await?;
    anyhow::ensure!(retained.id != selected.id);
    anyhow::ensure!(retained.client_user_message_id == ORIGINAL_CLIENT);
    anyhow::ensure!(selected.client_user_message_id == ORIGINAL_CLIENT);
    anyhow::ensure!(retained.input == queued_input() && selected.input == queued_input());
    assert_native_queue(session, &thread_id, &[retained.clone(), selected.clone()]).await?;

    let outcome = queue_transfer::promote(&session.state, &thread_id, &selected.id).await?;
    let PromotionOutcome::Transfer { transfer } = outcome else {
        anyhow::bail!("held native input must remain accepted until its materialized receipt");
    };
    anyhow::ensure!(transfer.phase == QueueTransferPhase::Accepted);
    anyhow::ensure!(transfer.native_queue_id == selected.id);
    anyhow::ensure!(transfer.expected_turn_id == turn_id);
    anyhow::ensure!(transfer.client_user_message_id == ORIGINAL_CLIENT);
    anyhow::ensure!(transfer.id != ORIGINAL_CLIENT && transfer.input == queued_input());
    let saved = session
        .state
        .store
        .get_queue_transfer(&transfer.id)
        .await?
        .context("accepted transfer input disappeared before native consumption")?;
    anyhow::ensure!(saved.phase == QueueTransferPhase::Accepted);
    assert_native_queue(session, &thread_id, std::slice::from_ref(&retained)).await?;

    release
        .send(())
        .map_err(|_| anyhow::anyhow!("first model response disconnected before release"))?;
    let followup = fixture.next_model_request().await?;
    let consumed = followup["input"]
        .as_array()
        .context("followup model input missing")?
        .iter()
        .filter(|item| item["role"] == "user" && item["content"].to_string().contains(QUEUED_TEXT))
        .count();
    anyhow::ensure!(
        consumed == 1,
        "expected one promoted correction, got {consumed}"
    );
    let native_item = user_receipt(session, &thread_id, &turn_id, &transfer.id).await?;
    anyhow::ensure!(native_item["content"] == json!(queued_input()));
    let native_item_id = native_item["id"]
        .as_str()
        .context("promoted native user item ID missing")?
        .to_owned();
    // The observer follows gateway ingestion. No GET repairs the live view or
    // settles the transfer before these exact native receipt assertions.
    anyhow::ensure!(session
        .state
        .store
        .get_queue_transfer(&transfer.id)
        .await?
        .is_none());
    assert_user_projection(
        &session.canonical_view(&thread_id).await?,
        &transfer.id,
        &native_item_id,
    )?;
    assert_native_queue(session, &thread_id, std::slice::from_ref(&retained)).await?;

    // Pause the original turn while its second model request is held, so the
    // other native row cannot dispatch merely because this test finishes it.
    let stopped = api(
        &session.app,
        "POST",
        &format!("/v1/threads/{thread_id}/interrupt-current"),
        None,
    )
    .await?;
    anyhow::ensure!(stopped["interruptedTurnId"] == turn_id);
    anyhow::ensure!(session.completed_turn(&thread_id, "interrupted").await?["id"] == turn_id);
    assert_native_queue(session, &thread_id, std::slice::from_ref(&retained)).await?;
    Ok((thread_id, retained, transfer.id, native_item_id))
}

fn queued_input() -> Vec<Value> {
    vec![json!({"type":"text","text":QUEUED_TEXT,"text_elements":[]})]
}

async fn assert_native_queue(
    session: &NativeSession,
    thread_id: &str,
    expected: &[NativeQueuedSubmission],
) -> anyhow::Result<()> {
    let page = session
        .native_queue_rpc("list", json!({"threadId":thread_id,"limit":100}))
        .await?;
    anyhow::ensure!(page["data"] == serde_json::to_value(expected)?);
    anyhow::ensure!(page["nextCursor"].is_null());
    Ok(())
}

async fn user_receipt(
    session: &mut NativeSession,
    thread_id: &str,
    turn_id: &str,
    client_id: &str,
) -> anyhow::Result<Value> {
    loop {
        let params = session
            .notification("item/started", "threadId", thread_id)
            .await?;
        if params["item"]["type"] != "userMessage" {
            continue;
        }
        anyhow::ensure!(
            params["turnId"] == turn_id,
            "receipt used another native turn: {params}"
        );
        anyhow::ensure!(
            params["item"]["clientId"] == client_id,
            "unexpected native user receipt: {params}"
        );
        return Ok(params["item"].clone());
    }
}

fn assert_user_projection(
    view: &Value,
    transfer_id: &str,
    native_item_id: &str,
) -> anyhow::Result<()> {
    let users = view["rows"]
        .as_array()
        .context("canonical rows missing")?
        .iter()
        .filter_map(|row| row.get("item"))
        .filter(|item| item["itemType"] == "userMessage")
        .collect::<Vec<_>>();
    anyhow::ensure!(
        users.len() == 2,
        "expected initial and promoted native input: {users:?}"
    );
    anyhow::ensure!(
        users
            .iter()
            .filter(|item| item["payload"]["item"]["clientId"] == INITIAL_CLIENT)
            .count()
            == 1
    );
    let promoted = users
        .iter()
        .filter(|item| item["payload"]["item"]["clientId"] == transfer_id)
        .collect::<Vec<_>>();
    anyhow::ensure!(
        promoted.len() == 1,
        "promoted correction must have one canonical receipt"
    );
    anyhow::ensure!(promoted[0]["itemId"] == native_item_id);
    anyhow::ensure!(promoted[0]["payload"]["item"]["content"] == json!(queued_input()));
    Ok(())
}
