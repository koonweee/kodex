use super::{
    fixture::{api, Fixture, ModelResponse, NativeSession},
    start_turn,
};
use anyhow::Context;
use axum::Router;
use serde_json::json;
use tokio::time::{timeout, Duration};

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_native_pins_preserve_order_history_and_custom_members_visibility_across_restart(
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
    let (project, threads, custom_id) = result??;
    let reopened = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(30), async {
        assert_pin_order(&reopened.app, &[&threads[1], &threads[0]]).await?;
        let listed = api(
            &reopened.app,
            "GET",
            &format!("/v1/threads?projectId={project}"),
            None,
        )
        .await?;
        anyhow::ensure!(listed["threads"]
            .as_array()
            .context("missing project threads")?
            .iter()
            .any(|thread| thread["id"] == threads[2] && thread["pinned"] == false));
        let detail = api(
            &reopened.app,
            "GET",
            &format!("/v1/threads/{}", threads[0]),
            None,
        )
        .await?;
        anyhow::ensure!(detail["thread"]["pinned"] == true);
        anyhow::ensure!(detail.to_string().contains("pin history 0"));
        let native_custom = reopened
            .state
            .app_server
            .request("threadSection/list", json!({}))
            .await?;
        anyhow::ensure!(
            native_custom["data"]
                .as_array()
                .context("missing native sections")?
                .iter()
                .any(|section| section["id"] == custom_id),
            "existing native section must remain untouched"
        );
        let native_thread = reopened
            .state
            .app_server
            .request(
                "thread/read",
                json!({"threadId":threads[2],"includeTurns":false}),
            )
            .await?;
        anyhow::ensure!(native_thread["thread"]["section"]["id"] == custom_id);
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
) -> anyhow::Result<(String, Vec<String>, String)> {
    let cwd = std::fs::canonicalize(&fixture.workspace)?
        .to_string_lossy()
        .to_string();
    let project = api(
        &session.app,
        "POST",
        "/v1/projects",
        Some(json!({"name":"Pins project","roots":[{"path":cwd}],"idempotencyKey":"pins-project"})),
    )
    .await?;
    let project_id = project["id"]
        .as_str()
        .context("missing project ID")?
        .to_owned();
    let mut threads = Vec::new();
    for index in 0..3 {
        let created = api(
            &session.app,
            "POST",
            "/v1/threads",
            Some(json!({"projectId":project_id})),
        )
        .await?;
        let id = created["thread"]["id"]
            .as_str()
            .context("missing thread ID")?
            .to_owned();
        fixture.enqueue([ModelResponse::message(&format!("pin history {index}"))]);
        start_turn(&session.app, &id, "Retain history").await?;
        session.completed_turn(&id, "completed").await?;
        fixture.next_model_request().await?;
        threads.push(id);
    }
    // Seed pre-existing custom native storage through the wire, since Kodex no
    // longer exposes section management. Removal must not migrate or delete it.
    let custom = session
        .state
        .app_server
        .request("threadSection/create", json!({"name":"Existing custom"}))
        .await?;
    let custom_id = custom["section"]["id"]
        .as_str()
        .context("missing custom section ID")?
        .to_owned();
    session
        .state
        .app_server
        .request(
            "thread/section/move",
            json!({"threadId":threads[2],"sectionId":custom_id}),
        )
        .await?;
    for id in &threads[..2] {
        pin(&session.app, id, true, None).await?;
    }
    pin(&session.app, &threads[1], true, Some(&threads[0])).await?;
    assert_pin_order(&session.app, &[&threads[1], &threads[0]]).await?;
    let page = api(&session.app, "GET", "/v1/pinned-threads?limit=1", None).await?;
    anyhow::ensure!(page["threads"][0]["id"] == threads[1]);
    let cursor = page["nextCursor"]
        .as_str()
        .context("missing native cursor")?;
    let mut url = reqwest::Url::parse("http://fixture.invalid/v1/pinned-threads")?;
    url.query_pairs_mut()
        .append_pair("limit", "1")
        .append_pair("cursor", cursor);
    let page = api(
        &session.app,
        "GET",
        &format!("{}?{}", url.path(), url.query().unwrap_or_default()),
        None,
    )
    .await?;
    anyhow::ensure!(page["threads"][0]["id"] == threads[0]);
    pin(&session.app, &threads[0], false, None).await?;
    let detail = api(
        &session.app,
        "GET",
        &format!("/v1/threads/{}", threads[0]),
        None,
    )
    .await?;
    anyhow::ensure!(detail["thread"]["pinned"] == false);
    anyhow::ensure!(detail["thread"]["projectId"] == project_id);
    pin(&session.app, &threads[0], true, None).await?;
    let sidebar = api(&session.app, "GET", "/v1/sidebar/threads", None).await?;
    anyhow::ensure!(sidebar.get("sections").is_none());
    anyhow::ensure!(sidebar["projectThreads"][&project_id]["threads"]
        .as_array()
        .context("missing sidebar project threads")?
        .iter()
        .any(|thread| thread["id"] == threads[2]));
    Ok((project_id, threads, custom_id))
}

async fn pin(app: &Router, id: &str, pinned: bool, before: Option<&str>) -> anyhow::Result<()> {
    api(
        app,
        "POST",
        &format!("/v1/threads/{id}/pin"),
        Some(json!({"pinned":pinned,"beforeThreadId":before})),
    )
    .await?;
    Ok(())
}

async fn assert_pin_order(app: &Router, expected: &[&str]) -> anyhow::Result<()> {
    let page = api(app, "GET", "/v1/pinned-threads", None).await?;
    let ids = page["threads"]
        .as_array()
        .context("missing pinned threads")?
        .iter()
        .filter_map(|thread| thread["id"].as_str())
        .collect::<Vec<_>>();
    anyhow::ensure!(ids == expected, "unexpected native pin order: {ids:?}");
    Ok(())
}
