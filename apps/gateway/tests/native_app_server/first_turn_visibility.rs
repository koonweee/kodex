use anyhow::Context;
use serde_json::json;
use tokio::time::{timeout, Duration};

use super::fixture::{api, Fixture, ModelResponse, NativeSession};

const INITIAL_INPUT: &str = "First user input visible before its native task completes";

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_native_first_turn_preview_is_listed_at_user_completion_before_model_completion(
) -> anyhow::Result<()> {
    let mut fixture = Fixture::new().await?;
    let mut session = NativeSession::start(&fixture).await?;
    let result = timeout(
        Duration::from_secs(30),
        exercise(&mut fixture, &mut session),
    )
    .await;
    session.shutdown().await?;
    result??;
    anyhow::ensure!(!fixture.config.codex.home.join("auth.json").exists());
    Ok(())
}

async fn exercise(fixture: &mut Fixture, session: &mut NativeSession) -> anyhow::Result<()> {
    let project = api(
        &session.app,
        "POST",
        "/v1/projects",
        Some(json!({
            "name":"First turn visibility", "roots":[{"path":fixture.workspace}],
            "idempotencyKey":"first-turn-visibility",
        })),
    )
    .await?;
    let project_id = project["id"].as_str().context("missing project ID")?;
    let created = api(
        &session.app,
        "POST",
        "/v1/threads",
        Some(json!({"projectId":project_id})),
    )
    .await?;
    let thread_id = created["thread"]["id"]
        .as_str()
        .context("missing thread ID")?
        .to_owned();
    let (held, release) = ModelResponse::gated_message("First native task completed");
    fixture.enqueue([held]);
    let mut events = session.state.events.subscribe();
    let accepted = api(
        &session.app,
        "POST",
        &format!("/v1/threads/{thread_id}/input"),
        Some(json!({
            "input":[{"type":"text","text":INITIAL_INPUT}],"clientUserMessageId":"first-turn-probe"
        })),
    )
    .await?;
    loop {
        let receipt = session
            .notification("item/completed", "threadId", &thread_id)
            .await?;
        if receipt["item"]["type"] == "userMessage" {
            anyhow::ensure!(receipt["item"]["clientId"] == "first-turn-probe");
            break;
        }
    }
    // Read DB-only inventory before any summary/history read could repair metadata.
    // Paginated native user-item delivery follows canonical flush + SQLite projection.
    let stored = session.native_thread_list().await?;
    anyhow::ensure!(
        stored["data"]
            .as_array()
            .context("missing native stored list")?
            .iter()
            .any(|row| row["id"] == thread_id
                && row["preview"] == INITIAL_INPUT
                && row["status"]["type"] == "active"),
        "native DB-only list did not expose the first user preview at item completion"
    );
    let read = session.native_thread_read(&thread_id).await?;
    anyhow::ensure!(
        read["thread"]["preview"] == INITIAL_INPUT && read["thread"]["status"]["type"] == "active",
        "native metadata read did not expose first-turn preview at item completion"
    );
    let sidebar = api(&session.app, "GET", "/v1/sidebar/threads", None).await?;
    anyhow::ensure!(
        sidebar["projectThreads"][project_id]["threads"]
            .as_array()
            .context("missing project sidebar threads")?
            .iter()
            .any(|row| row["id"] == thread_id && row["preview"] == INITIAL_INPUT),
        "gateway sidebar lost native first-turn preview while the model was held"
    );
    let mut summary_changed = false;
    while let Ok(event) = events.try_recv() {
        summary_changed |= event.kind == "thread.summary_changed"
            && event.thread_id.as_deref() == Some(thread_id.as_str());
    }
    anyhow::ensure!(summary_changed,
        "accepted native user item did not invalidate sidebar and tab metadata before first turn completed");
    fixture.next_model_request().await?;
    release
        .send(())
        .map_err(|_| anyhow::anyhow!("model gate closed"))?;
    let completed = session.completed_turn(&thread_id, "completed").await?;
    anyhow::ensure!(completed["id"] == accepted["payload"]["turn"]["id"]);
    Ok(())
}
