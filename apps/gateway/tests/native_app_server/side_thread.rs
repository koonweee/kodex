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
        Duration::from_secs(45),
        exercise(&mut fixture, &mut session),
    )
    .await;
    session.shutdown().await?;
    result??;
    Ok(())
}

async fn exercise(fixture: &mut Fixture, session: &mut NativeSession) -> anyhow::Result<()> {
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
        .context("missing side parent id")?;

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
    session.completed_turn(parent_id, "completed").await?;
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
        .context("missing side child id")?;
    anyhow::ensure!(side["parentThread"]["id"] == parent_id);
    anyhow::ensure!(side["timeline"]["rows"] == json!([]));

    fixture.enqueue([ModelResponse::message("side fixture completed")]);
    api(
        &session.app,
        "POST",
        &format!("/v1/threads/{side_id}/turns"),
        Some(json!({
            "queueIfPending":true,
            "input":[{"type":"text","text":"Use inherited context","textElements":[]}]
        })),
    )
    .await?;
    let side_request = fixture.next_model_request().await?;
    let side_request_text = side_request.to_string();
    anyhow::ensure!(side_request_text.contains("PARENT_CONTEXT_REQUEST_MARKER"));
    anyhow::ensure!(side_request_text.contains("PARENT_CONTEXT_RESPONSE_MARKER"));
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

    let closed = api(
        &session.app,
        "DELETE",
        &format!("/v1/threads/{parent_id}/side-thread"),
        None,
    )
    .await?;
    anyhow::ensure!(closed["closed"] == true);
    anyhow::ensure!(closed["sideThreadId"] == side_id);
    let absent = api(
        &session.app,
        "GET",
        &format!("/v1/threads/{parent_id}/side-thread"),
        None,
    )
    .await;
    anyhow::ensure!(absent.is_err());

    // Unsubscribe removes this connection's subscription immediately, while
    // app-server deliberately keeps the idle session loaded for its native
    // 30-minute unload grace period. There is no immediate unload RPC in the
    // pinned protocol; fixture shutdown reclaims the disposable process.
    let loaded = session.native_loaded_threads().await?;
    anyhow::ensure!(loaded["data"].as_array().is_some_and(|threads| {
        threads
            .iter()
            .any(|thread| thread.as_str() == Some(side_id))
    }));
    Ok(())
}
