use anyhow::Context;
use axum::Router;
use serde_json::{json, Value};
use tokio::time::{timeout, Duration};

use super::{
    fixture::{api, Fixture, ModelResponse, NativeSession},
    start_turn,
};

// Native 0.160.0 state/src/lib.rs defines this built-in section identity.
const PINNED_ID: &str = "01984de2-8f74-7c91-a3b2-5c5e937cf318";

struct RetainedState {
    deleted_section: String,
    surviving_section: Value,
    projects: Vec<String>,
    threads: Vec<String>,
    blank_thread: String,
    cwd: String,
}

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_native_sections_own_pins_order_and_archived_membership_across_restart(
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
    let retained = result??;

    let reopened = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(30), async {
        let sections = api(&reopened.app, "GET", "/v1/thread-sections", None).await?;
        let listed = sections["sections"]
            .as_array()
            .context("missing sections")?;
        anyhow::ensure!(listed.iter().any(|section| section["id"] == PINNED_ID));
        anyhow::ensure!(!listed
            .iter()
            .any(|section| section["id"] == retained.deleted_section));
        anyhow::ensure!(listed
            .iter()
            .any(|section| section == &retained.surviving_section));
        let surviving_id = retained.surviving_section["id"]
            .as_str()
            .context("missing section ID")?;
        assert_section_order(
            &reopened.app,
            surviving_id,
            &[
                &retained.blank_thread,
                &retained.threads[1],
                &retained.threads[0],
            ],
        )
        .await?;
        assert_section_order(&reopened.app, PINNED_ID, &[&retained.threads[3]]).await?;
        for (index, project_id, section_id) in [
            (0, &retained.projects[1], Some(surviving_id)),
            (1, &retained.projects[0], Some(surviving_id)),
            (2, &retained.projects[0], None),
            (3, &retained.projects[0], Some(PINNED_ID)),
        ] {
            assert_history_and_membership(
                &reopened.app,
                &retained.threads[index],
                index,
                project_id,
                section_id,
                &retained.cwd,
            )
            .await?;
        }
        assert_archived_absent(&reopened.app, &retained.projects[0], &retained.threads[2]).await?;
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
) -> anyhow::Result<RetainedState> {
    let sections = api(&session.app, "GET", "/v1/thread-sections", None).await?;
    let pinned = sections["sections"]
        .as_array()
        .context("missing native sections")?
        .iter()
        .find(|section| section["id"] == PINNED_ID)
        .context("native Pinned section is missing")?;
    anyhow::ensure!(pinned["name"] == "Pinned");
    let pinned_path = format!("/v1/thread-sections/{PINNED_ID}");
    for (method, body, expected) in [
        (
            "PATCH",
            Some(json!({"name":"Renamed pinned"})),
            "cannot be renamed",
        ),
        ("DELETE", None, "cannot be deleted"),
    ] {
        let error = api(&session.app, method, &pinned_path, body)
            .await
            .expect_err("native Pinned protection must reject this operation");
        let message = format!("{error:#}");
        anyhow::ensure!(
            message.contains("built-in pinned") && message.contains(expected),
            "unexpected rejection: {message}"
        );
    }

    let created = api(&session.app, "POST", "/v1/thread-sections", Some(json!({
        "name":"Research", "appearance":{"icon":"future-native-symbol", "color":"future-native-palette"}
    }))).await?;
    let section_id = created["section"]["id"]
        .as_str()
        .context("missing custom section ID")?
        .to_owned();
    let path = format!("/v1/thread-sections/{section_id}");
    let renamed = api(
        &session.app,
        "PATCH",
        &path,
        Some(json!({"name":"Renamed research"})),
    )
    .await?;
    anyhow::ensure!(renamed["section"]["id"] == section_id);
    anyhow::ensure!(renamed["section"]["name"] == "Renamed research");
    // Appearance has native icon/color strings, not an arbitrary metadata bag.
    // Opaque values a UI does not recognize survive a name-only update.
    anyhow::ensure!(renamed["section"]["appearance"] == created["section"]["appearance"]);
    let replaced = api(
        &session.app,
        "PATCH",
        &path,
        Some(json!({
            "name":"Renamed research", "appearance":{"color":"replacement-native-color"}
        })),
    )
    .await?;
    anyhow::ensure!(replaced["section"]["appearance"]["icon"].is_null());
    anyhow::ensure!(replaced["section"]["appearance"]["color"] == "replacement-native-color");
    let cleared = api(
        &session.app,
        "PATCH",
        &path,
        Some(json!({"name":"Renamed research", "appearance":null})),
    )
    .await?;
    anyhow::ensure!(cleared["section"]["appearance"].is_null());
    let created_survivor = api(&session.app, "POST", "/v1/thread-sections", Some(json!({
        "name":"Surviving section", "appearance":{"icon":"native-icon-after-restart", "color":"native-color-after-restart"}
    }))).await?["section"].clone();
    let survivor_id = created_survivor["id"]
        .as_str()
        .context("missing surviving section ID")?
        .to_owned();
    let survivor = api(
        &session.app,
        "PATCH",
        &format!("/v1/thread-sections/{survivor_id}"),
        Some(json!({"name":"Renamed surviving section"})),
    )
    .await?["section"]
        .clone();
    anyhow::ensure!(survivor["name"] == "Renamed surviving section");
    anyhow::ensure!(survivor["appearance"] == created_survivor["appearance"]);

    let cwd = std::fs::canonicalize(&fixture.workspace)?
        .to_string_lossy()
        .to_string();
    let mut projects = Vec::new();
    for index in 0..2 {
        let project = api(
            &session.app,
            "POST",
            "/v1/projects",
            Some(json!({
                "name":format!("Sections project {index}"), "roots":[{"path":cwd}],
                "idempotencyKey":format!("sections-project-{index}"),
            })),
        )
        .await?;
        projects.push(
            project["id"]
                .as_str()
                .context("missing project ID")?
                .to_owned(),
        );
    }
    // Moving a loaded blank chat is the native persistence boundary: no turn
    // or eager history read is needed to make it a durable section member.
    let blank = api(
        &session.app,
        "POST",
        "/v1/threads",
        Some(json!({"projectId":projects[0], "cwd":cwd})),
    )
    .await?;
    let blank_thread = blank["thread"]["id"]
        .as_str()
        .context("missing blank thread ID")?
        .to_owned();
    move_thread(&session.app, &blank_thread, Some(&survivor_id), None).await?;
    assert_section_order(&session.app, &survivor_id, &[&blank_thread]).await?;

    let mut threads = Vec::new();
    for index in 0..4 {
        let thread = api(
            &session.app,
            "POST",
            "/v1/threads",
            Some(json!({"projectId":projects[0], "cwd":cwd})),
        )
        .await?;
        let thread_id = thread["thread"]["id"]
            .as_str()
            .context("missing thread ID")?
            .to_owned();
        fixture.enqueue([ModelResponse::message(&format!("section history {index}"))]);
        start_turn(&session.app, &thread_id, "Retain this chat history").await?;
        session.completed_turn(&thread_id, "completed").await?;
        fixture.next_model_request().await?;
        threads.push(thread_id);
    }

    for thread in &threads[..3] {
        move_thread(&session.app, thread, Some(&section_id), None).await?;
    }
    move_thread(
        &session.app,
        &threads[1],
        Some(&section_id),
        Some(&threads[0]),
    )
    .await?;
    assert_section_order(
        &session.app,
        &section_id,
        &[&threads[1], &threads[0], &threads[2]],
    )
    .await?;
    // Native section sorting and its opaque cursor, not activity timestamps,
    // determine the order through more than one page.
    let first_page = api(
        &session.app,
        "GET",
        &format!("{path}/threads?limit=1"),
        None,
    )
    .await?;
    anyhow::ensure!(first_page["threads"][0]["id"] == threads[1]);
    let cursor = first_page["nextCursor"]
        .as_str()
        .context("missing native section page cursor")?;
    let mut next = reqwest::Url::parse(&format!("http://fixture.invalid{path}/threads"))?;
    next.query_pairs_mut()
        .append_pair("limit", "1")
        .append_pair("cursor", cursor);
    let next_path = format!("{}?{}", next.path(), next.query().unwrap_or_default());
    let second_page = api(&session.app, "GET", &next_path, None).await?;
    anyhow::ensure!(second_page["threads"][0]["id"] == threads[0]);

    // Pinning is one native section assignment. Unpinning clears it and does
    // not restore a remembered custom-section membership or change project.
    move_thread(&session.app, &threads[0], Some(PINNED_ID), None).await?;
    assert_section_order(&session.app, PINNED_ID, &[&threads[0]]).await?;
    assert_section_order(&session.app, &section_id, &[&threads[1], &threads[2]]).await?;
    assert_history_and_membership(
        &session.app,
        &threads[0],
        0,
        &projects[0],
        Some(PINNED_ID),
        &cwd,
    )
    .await?;
    move_thread(&session.app, &threads[0], None, None).await?;
    assert_history_and_membership(&session.app, &threads[0], 0, &projects[0], None, &cwd).await?;
    let unsectioned = api(
        &session.app,
        "GET",
        &format!("/v1/threads?projectId={}", projects[0]),
        None,
    )
    .await?;
    anyhow::ensure!(unsectioned["threads"]
        .as_array()
        .context("missing unsectioned project list")?
        .iter()
        .any(|thread| thread["id"] == threads[0]));
    assert_section_order(&session.app, PINNED_ID, &[]).await?;

    move_thread(&session.app, &threads[0], Some(&survivor_id), None).await?;
    move_thread(
        &session.app,
        &threads[1],
        Some(&survivor_id),
        Some(&threads[0]),
    )
    .await?;
    move_thread(&session.app, &threads[3], Some(PINNED_ID), None).await?;
    api(
        &session.app,
        "PATCH",
        &format!("/v1/threads/{}/project", threads[0]),
        Some(json!({"projectId":projects[1]})),
    )
    .await?;
    assert_history_and_membership(
        &session.app,
        &threads[0],
        0,
        &projects[1],
        Some(&survivor_id),
        &cwd,
    )
    .await?;
    assert_section_order(
        &session.app,
        &survivor_id,
        &[&blank_thread, &threads[1], &threads[0]],
    )
    .await?;

    api(
        &session.app,
        "POST",
        &format!("/v1/threads/{}/archive", threads[2]),
        None,
    )
    .await?;
    session
        .notification("thread/archived", "threadId", &threads[2])
        .await?;
    assert_archived_absent(&session.app, &projects[0], &threads[2]).await?;
    // Confirm the archived member still belongs before deleting the section;
    // otherwise an empty active list would make this a false deletion proof.
    assert_history_and_membership(
        &session.app,
        &threads[2],
        2,
        &projects[0],
        Some(&section_id),
        &cwd,
    )
    .await?;
    let deleted = api(&session.app, "DELETE", &path, None).await?;
    anyhow::ensure!(deleted.is_null());
    assert_history_and_membership(&session.app, &threads[2], 2, &projects[0], None, &cwd).await?;
    assert_archived_absent(&session.app, &projects[0], &threads[2]).await?;

    Ok(RetainedState {
        deleted_section: section_id,
        surviving_section: survivor,
        projects,
        threads,
        blank_thread,
        cwd,
    })
}

async fn move_thread(
    app: &Router,
    thread_id: &str,
    section_id: Option<&str>,
    before: Option<&str>,
) -> anyhow::Result<()> {
    let response = api(
        app,
        "POST",
        &format!("/v1/threads/{thread_id}/section"),
        Some(json!({"sectionId":section_id, "beforeThreadId":before})),
    )
    .await?;
    anyhow::ensure!(response.is_null());
    Ok(())
}

async fn assert_section_order(
    app: &Router,
    section_id: &str,
    expected: &[&str],
) -> anyhow::Result<()> {
    let response = api(
        app,
        "GET",
        &format!("/v1/thread-sections/{section_id}/threads"),
        None,
    )
    .await?;
    let threads = response["threads"]
        .as_array()
        .context("missing native section members")?;
    let actual: Vec<_> = threads
        .iter()
        .map(|thread| thread["id"].as_str().unwrap_or_default())
        .collect();
    anyhow::ensure!(
        actual == expected,
        "section {section_id} order: {actual:?}, expected {expected:?}"
    );
    anyhow::ensure!(threads
        .iter()
        .all(|thread| thread["section"]["id"] == section_id));
    Ok(())
}

async fn assert_history_and_membership(
    app: &Router,
    thread_id: &str,
    history_index: usize,
    project_id: &str,
    section_id: Option<&str>,
    cwd: &str,
) -> anyhow::Result<()> {
    let detail = api(app, "GET", &format!("/v1/threads/{thread_id}"), None).await?;
    anyhow::ensure!(detail["thread"]["id"] == thread_id);
    anyhow::ensure!(detail["thread"]["projectId"] == project_id);
    anyhow::ensure!(detail["thread"]["cwd"] == cwd);
    anyhow::ensure!(
        detail["thread"]["section"]["id"].as_str() == section_id,
        "unexpected section membership: {}",
        detail["thread"]
    );
    if section_id.is_none() {
        anyhow::ensure!(detail["thread"]["sectionEnteredAt"].is_null());
    } else {
        anyhow::ensure!(detail["thread"]["sectionEnteredAt"]
            .as_i64()
            .is_some_and(|time| time > 0));
    }
    anyhow::ensure!(
        detail
            .to_string()
            .contains(&format!("section history {history_index}")),
        "section mutation lost chat history"
    );
    Ok(())
}

async fn assert_archived_absent(
    app: &Router,
    project_id: &str,
    thread_id: &str,
) -> anyhow::Result<()> {
    let response = api(
        app,
        "GET",
        &format!("/v1/threads?projectId={project_id}"),
        None,
    )
    .await?;
    anyhow::ensure!(
        !response["threads"]
            .as_array()
            .context("missing active project list")?
            .iter()
            .any(|thread| thread["id"] == thread_id),
        "archived thread appeared in active list"
    );
    Ok(())
}
