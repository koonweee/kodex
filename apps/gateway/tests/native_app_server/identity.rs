use std::collections::HashSet;

use anyhow::Context;
use serde_json::{json, Value};
use tokio::time::{timeout, Duration};

use super::fixture::{api, Fixture, ModelResponse, NativeSession};

#[derive(Debug)]
struct NativeMessage {
    item_id: String,
    turn_id: String,
    client_id: String,
    text: String,
}

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_native_client_identity_preserves_each_submission_and_cold_history(
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
    let (thread_id, expected) = result??;

    // A new gateway projection and native process must retain native item and
    // client identities, including two successful submissions of one client ID.
    let reopened = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(20), async {
        let detail = api(
            &reopened.app,
            "GET",
            &format!("/v1/threads/{thread_id}"),
            None,
        )
        .await?;
        assert_native_messages(&detail["timeline"], &expected)?;
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
) -> anyhow::Result<(String, Vec<NativeMessage>)> {
    let project = api(
        &session.app,
        "POST",
        "/v1/projects",
        Some(json!({
            "name":"Native identity proof", "roots":[{"path":fixture.workspace}],
            "idempotencyKey":"native-identity-proof",
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
    let mut expected = Vec::new();
    let text = "Identical message text — 每次都是独立输入";

    // Client IDs are opaque correlation values, not an idempotency promise.
    // Each acknowledged submission below is deliberately allowed to complete.
    for (route, client_id) in [
        ("input", " native-client-one 🧭 "),
        ("turns", "native-client-two"),
        ("input", "intentionally-reused-client-id"),
        ("input", "intentionally-reused-client-id"),
    ] {
        fixture.enqueue([ModelResponse::message("identity fixture completed")]);
        let accepted = submit(session, &thread_id, route, client_id, text).await?;
        let turn_id = accepted["payload"]["turn"]["id"]
            .as_str()
            .context("native turn/start acknowledgement omitted turn ID")?;
        expected.push(user_echo(session, &thread_id, turn_id, client_id, text).await?);
        let completed = session.completed_turn(&thread_id, "completed").await?;
        anyhow::ensure!(completed["id"] == turn_id);
        fixture.next_model_request().await?;
        // This is the unrefreshed live projection: a history GET cannot conceal
        // an extra pending echo or content-based collapse of identical inputs.
        assert_native_messages(&session.canonical_view(&thread_id).await?, &expected)?;
    }

    let (first_response, release_first) = ModelResponse::gated_message("boundary reached");
    let (second_response, release_second) = ModelResponse::gated_message("steering completed");
    fixture.enqueue([first_response, second_response]);
    let accepted = submit(
        session,
        &thread_id,
        "input",
        "active-initial",
        "Hold this active turn at the model response boundary",
    )
    .await?;
    let turn_id = accepted["payload"]["turn"]["id"]
        .as_str()
        .context("active native turn ID missing")?
        .to_owned();
    expected.push(
        user_echo(
            session,
            &thread_id,
            &turn_id,
            "active-initial",
            "Hold this active turn at the model response boundary",
        )
        .await?,
    );
    fixture.next_model_request().await?;

    let steer_text = "Identical active input sent through both native entry points";
    let atomic = submit(session, &thread_id, "input", "atomic-steer", steer_text).await?;
    anyhow::ensure!(
        atomic["payload"]["turn"]["id"] == turn_id,
        "native turn/start must select the already-active turn"
    );
    let explicit = submit(
        session,
        &thread_id,
        &format!("turns/{turn_id}/steer"),
        "explicit-steer",
        steer_text,
    )
    .await?;
    anyhow::ensure!(explicit["payload"]["turnId"] == turn_id);

    let mut accepted_ids = expected
        .iter()
        .map(|item| item.client_id.as_str())
        .collect::<Vec<_>>();
    accepted_ids.extend(["atomic-steer", "explicit-steer"]);
    assert_client_ids(&session.canonical_view(&thread_id).await?, accepted_ids)?;

    // Acceptance is distinct from native materialization. Releasing the first
    // response lets native ingest both pending inputs into the same active turn.
    release_first
        .send(())
        .map_err(|_| anyhow::anyhow!("first model response disconnected before release"))?;
    let followup = fixture.next_model_request().await?;
    anyhow::ensure!(
        followup["input"]
            .as_array()
            .context("model request input missing")?
            .iter()
            .filter(
                |item| item["role"] == "user" && item["content"].to_string().contains(steer_text)
            )
            .count()
            == 2,
        "native model boundary did not consume both accepted steering messages"
    );
    for client_id in ["atomic-steer", "explicit-steer"] {
        expected.push(user_echo(session, &thread_id, &turn_id, client_id, steer_text).await?);
    }
    assert_native_messages(&session.canonical_view(&thread_id).await?, &expected)?;
    release_second
        .send(())
        .map_err(|_| anyhow::anyhow!("second model response disconnected before release"))?;
    let completed = session.completed_turn(&thread_id, "completed").await?;
    anyhow::ensure!(completed["id"] == turn_id);
    assert_native_messages(&session.canonical_view(&thread_id).await?, &expected)?;

    let detail = api(
        &session.app,
        "GET",
        &format!("/v1/threads/{thread_id}"),
        None,
    )
    .await?;
    assert_native_messages(&detail["timeline"], &expected)?;
    Ok((thread_id, expected))
}

async fn submit(
    session: &NativeSession,
    thread_id: &str,
    route: &str,
    client_id: &str,
    text: &str,
) -> anyhow::Result<Value> {
    api(
        &session.app,
        "POST",
        &format!("/v1/threads/{thread_id}/{route}"),
        Some(json!({
            "input":[{"type":"text","text":text}],
            "clientUserMessageId":client_id,
        })),
    )
    .await
}

async fn user_echo(
    session: &mut NativeSession,
    thread_id: &str,
    turn_id: &str,
    client_id: &str,
    text: &str,
) -> anyhow::Result<NativeMessage> {
    loop {
        let params = session
            .notification("item/started", "threadId", thread_id)
            .await?;
        let item = &params["item"];
        if item["type"] != "userMessage" {
            continue;
        }
        anyhow::ensure!(
            params["turnId"] == turn_id,
            "unexpected native user turn: {params}"
        );
        anyhow::ensure!(
            item["clientId"] == client_id,
            "native client ID changed: {item}"
        );
        anyhow::ensure!(item["content"][0]["text"] == text);
        return Ok(NativeMessage {
            item_id: item["id"]
                .as_str()
                .context("native item ID missing")?
                .into(),
            turn_id: turn_id.into(),
            client_id: client_id.into(),
            text: text.into(),
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

fn assert_client_ids(view: &Value, mut expected: Vec<&str>) -> anyhow::Result<()> {
    let items = user_items(view)?;
    let mut actual = items
        .iter()
        .map(|item| {
            item["payload"]["item"]["clientId"]
                .as_str()
                .unwrap_or("<missing>")
        })
        .collect::<Vec<_>>();
    actual.sort_unstable();
    expected.sort_unstable();
    anyhow::ensure!(
        actual == expected,
        "canonical client identity counts changed: {actual:?} != {expected:?}"
    );
    Ok(())
}

fn assert_native_messages(view: &Value, expected: &[NativeMessage]) -> anyhow::Result<()> {
    let items = user_items(view)?;
    anyhow::ensure!(
        items.len() == expected.len(),
        "expected {} native user rows, got {}",
        expected.len(),
        items.len()
    );
    anyhow::ensure!(
        expected
            .iter()
            .map(|item| &item.item_id)
            .collect::<HashSet<_>>()
            .len()
            == expected.len(),
        "native reused an item ID for separate accepted submissions"
    );
    for native in expected {
        let matches = items
            .iter()
            .filter(|item| item["itemId"] == native.item_id)
            .collect::<Vec<_>>();
        anyhow::ensure!(
            matches.len() == 1,
            "expected one canonical row for native item {}",
            native.item_id
        );
        let item = matches[0];
        anyhow::ensure!(item["turnId"] == native.turn_id);
        anyhow::ensure!(item["payload"]["item"]["clientId"] == native.client_id);
        anyhow::ensure!(item["payload"]["item"]["content"][0]["text"] == native.text);
    }
    Ok(())
}
