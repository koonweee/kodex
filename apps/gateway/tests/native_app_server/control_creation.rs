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
        fixture.enqueue([ModelResponse::message("Standalone complete")]);
        start_turn(&session.app, id, "Standalone Control proof").await?;
        session.completed_turn(id, "completed").await?;
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
