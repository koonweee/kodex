use super::{
    fixture::{api, Fixture, ModelResponse, NativeSession},
    start_turn,
};
use anyhow::Context;
use serde_json::json;
use tokio::time::{timeout, Duration};

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_native_control_standalone_archive_restore() -> anyhow::Result<()> {
    let mut fixture = Fixture::new().await?;
    fixture.config.projects.home_dir = fixture.workspace.clone();
    let mut session = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(45), async {
        let created = api(
            &session.app,
            "POST",
            "/v1/self-control/threads",
            Some(json!({})),
        )
        .await?;
        let id = created["thread"]["id"]
            .as_str()
            .context("missing thread ID")?;
        let fresh = api(&session.app, "POST", "/v1/self-control/threads/wait", Some(json!({"targets":[{"threadId":id}],"timeoutMs":0}))).await?;
        anyhow::ensure!(fresh["status"] == "timeout" && fresh["results"][0]["condition"] == "idle", "{fresh}");
        fixture.enqueue([ModelResponse::message("Standalone complete")]);
        start_turn(&session.app, id, "Standalone Control proof").await?;
        session.completed_turn(id, "completed").await?;
        let compact = api(
            &session.app,
            "GET",
            &format!("/v1/self-control/threads/{id}/turns/compact?limit=1"),
            None,
        )
        .await?;
        anyhow::ensure!(compact["turns"][0]["status"] == "completed", "{compact}");
        let excerpt = compact.to_string();
        anyhow::ensure!(
            excerpt.contains("Standalone complete") && excerpt.contains("Standalone Control proof"),
            "{compact}"
        );
        let first_wait = api(&session.app, "POST", "/v1/self-control/threads/wait", Some(json!({"targets":[{"threadId":id}],"timeoutMs":0}))).await?;
        anyhow::ensure!(first_wait["status"] == "matched" && first_wait.to_string().contains("Standalone complete"), "{first_wait}");
        let repeated_wait = api(&session.app, "POST", "/v1/self-control/threads/wait", Some(json!({"targets":[{"threadId":id,"afterCursor":first_wait["results"][0]["cursor"]}],"timeoutMs":0}))).await?;
        anyhow::ensure!(repeated_wait["status"] == "timeout" && !repeated_wait.to_string().contains("Standalone complete"), "{repeated_wait}");
        let (held, release) = ModelResponse::gated_message("Second wait completed");
        fixture.enqueue([held]);
        start_turn(&session.app, id, "Keep this turn active for the wait proof").await?;
        let active = api(&session.app, "POST", "/v1/self-control/threads/wait", Some(json!({"targets":[{"threadId":id,"afterCursor":first_wait["results"][0]["cursor"]}],"timeoutMs":0}))).await?;
        anyhow::ensure!(active["status"] == "timeout" && active["results"][0]["condition"] == "inProgress", "{active}");
        anyhow::ensure!(!active.to_string().contains("Standalone complete"), "old answer leaked into active wait: {active}");
        let _ = release.send(());
        let finished = api(&session.app, "POST", "/v1/self-control/threads/wait", Some(json!({"targets":[{"threadId":id,"afterCursor":active["results"][0]["cursor"]}],"timeoutMs":5000}))).await?;
        anyhow::ensure!(finished["status"] == "matched" && finished.to_string().contains("Second wait completed"), "{finished}");
        let list = api(&session.app, "GET", "/v1/chats/threads", None).await?;
        anyhow::ensure!(list["threads"]
            .as_array()
            .context("missing threads")?
            .iter()
            .any(|row| row["id"] == id));
        api(
            &session.app,
            "POST",
            &format!("/v1/self-control/threads/{id}/archive"),
            Some(json!({})),
        )
        .await?;
        let archived = api(
            &session.app,
            "GET",
            "/v1/self-control/threads?archived=true&limit=1",
            None,
        )
        .await?;
        anyhow::ensure!(
            archived["threads"][0]["id"] == id,
            "archived membership missing: {archived}"
        );
        api(
            &session.app,
            "POST",
            &format!("/v1/self-control/threads/{id}/unarchive"),
            Some(json!({})),
        )
        .await?;
        let restored = api(&session.app, "GET", "/v1/chats/threads", None).await?;
        anyhow::ensure!(restored["threads"]
            .as_array()
            .context("missing threads")?
            .iter()
            .any(|row| row["id"] == id));
        let archived = api(
            &session.app,
            "GET",
            "/v1/self-control/threads?archived=true",
            None,
        )
        .await?;
        anyhow::ensure!(archived["threads"]
            .as_array()
            .context("missing threads")?
            .is_empty());
        Ok::<_, anyhow::Error>(())
    })
    .await;
    session.shutdown().await?;
    result??;
    Ok(())
}
