use anyhow::Context;
use serde_json::json;
use tokio::time::{timeout, Duration};

use super::fixture::{api, Fixture, ModelResponse, NativeSession};

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_ephemeral_side_thread_runs_projects_and_unsubscribes() -> anyhow::Result<()> {
    let mut fixture = Fixture::new().await?;
    let mut session = NativeSession::start(&fixture).await?;
    let result = timeout(
        Duration::from_secs(75),
        exercise(&mut fixture, &mut session),
    )
    .await;
    session.shutdown().await?;
    drop(session);
    let (parent_id, closed_side_id, live_side_id) = result??;

    let reopened = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(20), async {
        anyhow::ensure!(api(
            &reopened.app,
            "GET",
            &format!("/v1/threads/{parent_id}/side-thread"),
            None,
        )
        .await
        .is_err());
        let loaded = reopened.native_loaded_threads().await?;
        let loaded = loaded["data"]
            .as_array()
            .context("missing loaded thread list after restart")?;
        for side_id in [&closed_side_id, &live_side_id] {
            anyhow::ensure!(
                !loaded.iter().any(|thread| thread.as_str() == Some(side_id)),
                "ephemeral side thread survived app-server restart: {side_id}"
            );
        }
        anyhow::ensure!(
            reopened.native_thread_read(&live_side_id).await.is_err(),
            "live ephemeral side thread was recoverable after app-server restart"
        );
        Ok::<_, anyhow::Error>(())
    })
    .await;
    reopened.shutdown().await?;
    result??;
    Ok(())
}

async fn exercise(
    fixture: &mut Fixture,
    session: &mut NativeSession,
) -> anyhow::Result<(String, String, String)> {
    let project = api(
        &session.app,
        "POST",
        "/v1/projects",
        Some(json!({
            "roots":[{"path":fixture.workspace}],
            "name":"Side thread fixture",
            "idempotencyKey":"real-side-thread-fixture"
        })),
    )
    .await?;
    let parent = api(
        &session.app,
        "POST",
        "/v1/threads",
        Some(json!({"projectId": project["id"]})),
    )
    .await?;
    let parent_id = parent["thread"]["id"]
        .as_str()
        .context("missing side parent id")?
        .to_owned();

    // Native forks require the parent rollout to have materialized. The marker
    // also lets the child request prove that excluded visible turns still
    // remain inherited model context.
    fixture.enqueue([ModelResponse::message("PARENT_CONTEXT_RESPONSE_MARKER")]);
    let parent_turn = api(
        &session.app,
        "POST",
        &format!("/v1/threads/{parent_id}/turns"),
        Some(json!({"input":[{"type":"text","text":"PARENT_CONTEXT_REQUEST_MARKER","textElements":[]}]})),
    )
    .await?;
    fixture.next_model_request().await?;
    session.completed_turn(&parent_id, "completed").await?;
    anyhow::ensure!(parent_turn["payload"]["turn"]["id"].is_string());

    let side = api(
        &session.app,
        "POST",
        &format!("/v1/threads/{parent_id}/side-thread"),
        None,
    )
    .await?;
    let side_id = side["thread"]["id"]
        .as_str()
        .context("missing side child id")?
        .to_owned();
    anyhow::ensure!(side["parentThread"]["id"] == parent_id);
    anyhow::ensure!(side["timeline"]["rows"] == json!([]));
    let reused = api(
        &session.app,
        "POST",
        &format!("/v1/threads/{parent_id}/side-thread"),
        None,
    )
    .await?;
    anyhow::ensure!(reused["thread"]["id"] == side_id);
    anyhow::ensure!(reused["reused"] == true);
    let queue = api(
        &session.app,
        "GET",
        &format!("/v1/threads/{side_id}/queued-inputs"),
        None,
    )
    .await?;
    anyhow::ensure!(queue["queuedInputs"] == json!([]));
    anyhow::ensure!(api(
        &session.app,
        "POST",
        &format!("/v1/threads/{side_id}/queued-inputs"),
        Some(json!({
            "input":[{"type":"text","text":"unsupported explicit queue"}],
            "clientUserMessageId":"side-explicit-queue"
        })),
    )
    .await
    .is_err());

    fixture.enqueue([ModelResponse::message("side fixture completed")]);
    let first = api(
        &session.app,
        "POST",
        &format!("/v1/threads/{side_id}/input"),
        Some(json!({
            "queueIfPending":true,
            "clientUserMessageId":"side-first-input",
            "input":[{"type":"text","text":"Use inherited context","textElements":[]}]
        })),
    )
    .await?;
    anyhow::ensure!(first["disposition"] == "submitted");
    let side_request = fixture.next_model_request().await?;
    let side_request_text = side_request.to_string();
    anyhow::ensure!(side_request_text.contains("PARENT_CONTEXT_REQUEST_MARKER"));
    anyhow::ensure!(side_request_text.contains("PARENT_CONTEXT_RESPONSE_MARKER"));
    session.completed_turn(&side_id, "completed").await?;
    timeout(Duration::from_secs(20), async {
        loop {
            let snapshot = api(
                &session.app,
                "GET",
                &format!("/v1/threads/{parent_id}/side-thread"),
                None,
            )
            .await?;
            if snapshot.to_string().contains("side fixture completed") {
                return Ok::<_, anyhow::Error>(());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await??;

    let (initial_response, release_initial) =
        ModelResponse::gated_message("side active boundary reached");
    let (followup_response, release_followup) =
        ModelResponse::gated_message("side steering completed");
    fixture.enqueue([initial_response, followup_response]);
    let active = api(
        &session.app,
        "POST",
        &format!("/v1/threads/{side_id}/input"),
        Some(json!({
            "queueIfPending":true,
            "clientUserMessageId":"side-active-initial",
            "input":[{"type":"text","text":"Hold this side turn at the model boundary"}]
        })),
    )
    .await?;
    anyhow::ensure!(active["disposition"] == "submitted");
    let active_turn_id = active["payload"]["turn"]["id"]
        .as_str()
        .context("missing active side turn id")?
        .to_owned();
    fixture.next_model_request().await?;
    let steered = api(
        &session.app,
        "POST",
        &format!("/v1/threads/{side_id}/input"),
        Some(json!({
            "queueIfPending":true,
            "clientUserMessageId":"side-active-followup",
            "input":[{"type":"text","text":"Steer this active side turn"}]
        })),
    )
    .await?;
    anyhow::ensure!(steered["disposition"] == "submitted");
    anyhow::ensure!(steered["payload"]["turn"]["id"] == active_turn_id);
    release_initial
        .send(())
        .map_err(|_| anyhow::anyhow!("side initial response disconnected before release"))?;
    let followup_request = fixture.next_model_request().await?;
    anyhow::ensure!(followup_request
        .to_string()
        .contains("Steer this active side turn"));
    release_followup
        .send(())
        .map_err(|_| anyhow::anyhow!("side follow-up response disconnected before release"))?;
    let completed = session.completed_turn(&side_id, "completed").await?;
    anyhow::ensure!(completed["id"] == active_turn_id);

    let closed = api(
        &session.app,
        "DELETE",
        &format!("/v1/threads/{parent_id}/side-thread"),
        None,
    )
    .await?;
    anyhow::ensure!(closed["closed"] == true);
    anyhow::ensure!(closed["sideThreadId"] == side_id);
    let closed_again = api(
        &session.app,
        "DELETE",
        &format!("/v1/threads/{parent_id}/side-thread"),
        None,
    )
    .await?;
    anyhow::ensure!(closed_again["closed"] == false);
    let absent = api(
        &session.app,
        "GET",
        &format!("/v1/threads/{parent_id}/side-thread"),
        None,
    )
    .await;
    anyhow::ensure!(absent.is_err());

    let replacement = api(
        &session.app,
        "POST",
        &format!("/v1/threads/{parent_id}/side-thread"),
        None,
    )
    .await?;
    let replacement_id = replacement["thread"]["id"]
        .as_str()
        .context("missing replacement side child id")?
        .to_owned();
    anyhow::ensure!(replacement_id != side_id);
    anyhow::ensure!(replacement["reused"] == false);
    // Unsubscribe removes this connection's subscription immediately, while
    // app-server deliberately keeps the first idle session loaded for its
    // native 30-minute unload grace period. The replacement remains open so
    // the restart phase proves that a live ephemeral child is not recoverable.
    // There is no immediate unload RPC in the pinned protocol; fixture
    // shutdown reclaims the disposable process.
    let loaded = session.native_loaded_threads().await?;
    let loaded = loaded["data"]
        .as_array()
        .context("missing loaded thread list before restart")?;
    for expected in [&side_id, &replacement_id] {
        anyhow::ensure!(
            loaded
                .iter()
                .any(|thread| thread.as_str() == Some(expected)),
            "expected side thread to remain loaded before restart: {expected}"
        );
    }
    Ok((parent_id, side_id, replacement_id))
}
