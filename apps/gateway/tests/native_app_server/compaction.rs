use anyhow::Context;
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::time::{timeout, Duration};
use tower::ServiceExt;

use super::fixture::{api, Fixture, ModelResponse, NativeSession};

const COMPACT_PROMPT: &str = "Summarize this fixture conversation: native-compaction-marker";

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_native_compaction_preserves_busy_work_and_cold_send_loads_once() -> anyhow::Result<()>
{
    let mut fixture = Fixture::new().await?;
    let config_path = fixture.config.codex.home.join("config.toml");
    let config = std::fs::read_to_string(&config_path)?;
    std::fs::write(
        &config_path,
        format!("compact_prompt = {COMPACT_PROMPT:?}\n{config}"),
    )?;
    let mut session = NativeSession::start(&fixture).await?;
    let result = timeout(
        Duration::from_secs(60),
        exercise(&mut fixture, &mut session),
    )
    .await;
    session.shutdown().await?;
    drop(session);
    let thread_id = result??;

    let mut cold = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(30), async {
        anyhow::ensure!(cold.native_loaded_threads().await?["data"] == json!([]));
        fixture.enqueue([ModelResponse::message("Cold native send completed")]);
        // This is the first mutating request in the new native process. There
        // is no preceding attach/resume or history read to load this thread.
        let turn_id = submit(&cold, &thread_id, "cold-send").await?;
        fixture.next_model_request().await?;
        let echo = user_echo(&mut cold, &thread_id, &turn_id, "cold-send").await?;
        let completed = cold.completed_turn(&thread_id, "completed").await?;
        anyhow::ensure!(completed["id"] == turn_id);
        assert_one_user_receipt(&cold.canonical_view(&thread_id).await?, "cold-send", &echo)?;
        let detail = api(&cold.app, "GET", &format!("/v1/threads/{thread_id}"), None).await?;
        assert_one_user_receipt(&detail["timeline"], "cold-send", &echo)?;
        anyhow::ensure!(
            detail.to_string().contains("after-compaction"),
            "cold Send lost prior native history"
        );
        fixture
            .assert_no_model_request(Duration::from_millis(100))
            .await?;
        Ok::<_, anyhow::Error>(())
    })
    .await;
    cold.shutdown().await?;
    result??;
    anyhow::ensure!(!fixture.config.codex.home.join("auth.json").exists());
    Ok(())
}

async fn exercise(fixture: &mut Fixture, session: &mut NativeSession) -> anyhow::Result<String> {
    let project = api(
        &session.app,
        "POST",
        "/v1/projects",
        Some(json!({
            "name":"Native compaction proof", "roots":[{"path":fixture.workspace}],
            "idempotencyKey":"native-compaction-proof",
        })),
    )
    .await?;
    let created = api(
        &session.app,
        "POST",
        "/v1/threads",
        Some(json!({
            "projectId":project["id"]
        })),
    )
    .await?;
    let thread_id = created["thread"]["id"]
        .as_str()
        .context("native thread ID missing")?
        .to_owned();
    fixture.enqueue([ModelResponse::message("Seed history")]);
    let seed_id = submit(session, &thread_id, "seed").await?;
    anyhow::ensure!(session.completed_turn(&thread_id, "completed").await?["id"] == seed_id);
    fixture.next_model_request().await?;

    let (held, release) = ModelResponse::gated_message("Busy work completed without interruption");
    fixture.enqueue([held]);
    let active_id = submit(session, &thread_id, "busy-work").await?;
    fixture.next_model_request().await?;
    let started = session
        .notification("turn/started", "threadId", &thread_id)
        .await?;
    anyhow::ensure!(started["turn"]["id"] == active_id);
    let (status, body) = compact(session, &thread_id).await?;
    anyhow::ensure!(
        status == 409 && body["code"] == "conflict",
        "busy compaction was not rejected: {status} {body}"
    );
    release
        .send(())
        .map_err(|_| anyhow::anyhow!("busy native response gate closed"))?;
    let completed = session.completed_turn(&thread_id, "completed").await?;
    anyhow::ensure!(
        completed["id"] == active_id,
        "compaction replaced active native work"
    );

    let (summary, release) = ModelResponse::gated_message("NATIVE_COMPACTION_SUMMARY");
    fixture.enqueue([summary]);
    let (status, body) = compact(session, &thread_id).await?;
    anyhow::ensure!(
        status == 200 && body == json!({"disposition":"started","rawPayload":{}}),
        "native compact acknowledgement changed: {status} {body}"
    );
    let compact_request = fixture.next_model_request().await?;
    anyhow::ensure!(
        compact_request["input"]
            .to_string()
            .contains(COMPACT_PROMPT),
        "native local compaction did not use the configured summary prompt"
    );
    let started = context_compaction(session, "item/started", &thread_id).await?;
    let compact_turn_id = started["turnId"]
        .as_str()
        .context("compaction turn ID missing")?;
    let live = session.canonical_view(&thread_id).await?;
    anyhow::ensure!(
        live["activeTurnId"] == compact_turn_id,
        "native compaction did not drive active projection: {live}"
    );
    anyhow::ensure!(live["liveState"] != "idle");
    release
        .send(())
        .map_err(|_| anyhow::anyhow!("native compaction response gate closed"))?;
    let completed_item = context_compaction(session, "item/completed", &thread_id).await?;
    anyhow::ensure!(completed_item["item"]["id"] == started["item"]["id"]);
    let completed = session.completed_turn(&thread_id, "completed").await?;
    anyhow::ensure!(completed["id"] == compact_turn_id);
    let live = session.canonical_view(&thread_id).await?;
    anyhow::ensure!(
        live["liveState"] == "idle" && live["activeTurnId"].is_null(),
        "native completion did not return projection to idle: {live}"
    );

    // A post-compaction turn is the native checkpoint boundary used by the
    // pinned upstream compaction test before a cold resume.
    fixture.enqueue([ModelResponse::message("After compaction completed")]);
    let continued = submit(session, &thread_id, "after-compaction").await?;
    anyhow::ensure!(session.completed_turn(&thread_id, "completed").await?["id"] == continued);
    fixture.next_model_request().await?;
    Ok(thread_id)
}

async fn compact(session: &NativeSession, thread_id: &str) -> anyhow::Result<(u16, Value)> {
    let response = session
        .app
        .clone()
        .oneshot(Request::post(format!("/v1/threads/{thread_id}/compact")).body(Body::empty())?)
        .await?;
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await?.to_bytes();
    Ok((status, serde_json::from_slice(&bytes)?))
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
        Some(json!({
            "input":[{"type":"text","text":client_id}], "clientUserMessageId":client_id,
        })),
    )
    .await?;
    Ok(response["payload"]["turn"]["id"]
        .as_str()
        .context("native turn ID missing")?
        .to_owned())
}

async fn context_compaction(
    session: &mut NativeSession,
    method: &str,
    thread_id: &str,
) -> anyhow::Result<Value> {
    loop {
        let params = session.notification(method, "threadId", thread_id).await?;
        if params["item"]["type"] == "contextCompaction" {
            return Ok(params);
        }
    }
}

async fn user_echo(
    session: &mut NativeSession,
    thread_id: &str,
    turn_id: &str,
    client_id: &str,
) -> anyhow::Result<Value> {
    loop {
        let params = session
            .notification("item/started", "threadId", thread_id)
            .await?;
        if params["item"]["type"] == "userMessage" {
            anyhow::ensure!(params["turnId"] == turn_id && params["item"]["clientId"] == client_id);
            anyhow::ensure!(params["item"]["id"].as_str().is_some());
            return Ok(params["item"].clone());
        }
    }
}

fn assert_one_user_receipt(view: &Value, client_id: &str, echo: &Value) -> anyhow::Result<()> {
    let matching = view["rows"]
        .as_array()
        .context("canonical rows missing")?
        .iter()
        .filter_map(|row| row.get("item"))
        .filter(|item| {
            item["itemType"] == "userMessage" && item["payload"]["item"]["clientId"] == client_id
        })
        .collect::<Vec<_>>();
    anyhow::ensure!(
        matching.len() == 1,
        "cold Send created duplicate/missing correlated rows: {matching:?}"
    );
    anyhow::ensure!(matching[0]["itemId"] == echo["id"]);
    anyhow::ensure!(matching[0]["payload"]["item"]["content"][0]["text"] == client_id);
    Ok(())
}
