use anyhow::Context;
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::time::{timeout, Duration};
use tower::ServiceExt;

use super::fixture::{api, Fixture, ModelResponse, NativeSession};

struct SavedMarkers {
    thread_id: String,
    first: String,
    second: String,
    seen_revision: i64,
    other_threads: Vec<String>,
}

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_native_read_markers_preserve_exact_seen_identity_and_unloaded_badge_scope(
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
    let saved = result??;

    let mut reopened = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(30), async {
        let before = inventory(&reopened).await?;
        assert_all_unloaded(&before, &saved)?;
        let persisted = find_thread(&before, &saved.thread_id)?;
        assert_read(persisted, Some(&saved.second), Some(&saved.second), false)?;
        anyhow::ensure!(revision(persisted)? == saved.seen_revision);
        assert_badge(&reopened, 2).await?;
        assert_all_unloaded(&inventory(&reopened).await?, &saved)?;

        // Native revert requires a loaded runtime. Loading is explicit and
        // occurs only after the read-only inventory/badge checks above.
        api(
            &reopened.app,
            "POST",
            &format!("/v1/threads/{}/attach", saved.thread_id),
            None,
        )
        .await?;
        let reverted = reopened
            .native_revert_without_gateway_ingestion(&saved.thread_id, &saved.second)
            .await?;
        anyhow::ensure!(reverted["thread"]["id"] == saved.thread_id);
        Ok::<_, anyhow::Error>(())
    })
    .await;
    reopened.shutdown().await?;
    drop(reopened);
    result??;

    // Both native process and gateway projection are new. No online revert
    // event changed the persisted seen ID, so the unequal retained head is
    // conservatively unread; opaque turn IDs cannot reveal why it changed.
    let cold = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(20), async {
        let threads = inventory(&cold).await?;
        assert_all_unloaded(&threads, &saved)?;
        let rewound = find_thread(&threads, &saved.thread_id)?;
        assert_read(rewound, Some(&saved.first), Some(&saved.second), true)?;
        anyhow::ensure!(revision(rewound)? > saved.seen_revision);
        assert_badge(&cold, 3).await?;
        reject_seen(&cold, &saved.thread_id, &saved.second, saved.seen_revision).await?;
        let acknowledged =
            acknowledge(&cold, &saved.thread_id, &saved.first, revision(rewound)?).await?;
        assert_read(&acknowledged, Some(&saved.first), Some(&saved.first), false)?;
        assert_badge(&cold, 2).await?;
        assert_all_unloaded(&inventory(&cold).await?, &saved)?;
        Ok::<_, anyhow::Error>(())
    })
    .await;
    cold.shutdown().await?;
    result??;
    anyhow::ensure!(!fixture.config.codex.home.join("auth.json").exists());
    Ok(())
}

async fn exercise(
    fixture: &mut Fixture,
    session: &mut NativeSession,
) -> anyhow::Result<SavedMarkers> {
    let project = api(
        &session.app,
        "POST",
        "/v1/projects",
        Some(json!({
            "name":"Native shared read proof", "roots":[{"path":fixture.workspace}],
            "idempotencyKey":"native-read-markers-proof",
        })),
    )
    .await?;
    let project_id = project["id"]
        .as_str()
        .context("native project ID missing")?;
    let thread_id = create_thread(session, project_id).await?;
    let first = complete(fixture, session, &thread_id, "first-completion").await?;
    let threads = inventory(session).await?;
    let unread = find_thread(&threads, &thread_id)?;
    assert_read(unread, Some(&first), None, true)?;
    let seen = acknowledge(session, &thread_id, &first, revision(unread)?).await?;
    assert_read(&seen, Some(&first), Some(&first), false)?;

    let (held, release) = ModelResponse::gated_message("Second completed answer");
    fixture.enqueue([held]);
    let second = submit(session, &thread_id, "second-completion").await?;
    anyhow::ensure!(second != first);
    fixture.next_model_request().await?;
    let started = session
        .notification("turn/started", "threadId", &thread_id)
        .await?;
    anyhow::ensure!(started["turn"]["id"] == second);
    let threads = inventory(session).await?;
    let active = find_thread(&threads, &thread_id)?;
    anyhow::ensure!(active["status"] == "active");
    assert_read(active, Some(&first), Some(&first), false)?;
    release
        .send(())
        .map_err(|_| anyhow::anyhow!("model response gate closed"))?;
    let completed = session.completed_turn(&thread_id, "completed").await?;
    anyhow::ensure!(completed["id"] == second);

    let threads = inventory(session).await?;
    let latest = find_thread(&threads, &thread_id)?;
    assert_read(latest, Some(&second), Some(&first), true)?;
    reject_seen(session, &thread_id, &first, revision(&seen)?).await?;
    reject_seen(session, &thread_id, &first, revision(latest)?).await?;
    let seen = acknowledge(session, &thread_id, &second, revision(latest)?).await?;
    assert_read(&seen, Some(&second), Some(&second), false)?;
    let repeated = acknowledge(session, &thread_id, &second, revision(&seen)?).await?;
    anyhow::ensure!(
        repeated == seen,
        "same current marker must be an idempotent acknowledgement"
    );

    let mut other_threads = Vec::new();
    for label in ["off-page-one", "off-page-two"] {
        let other = create_thread(session, project_id).await?;
        complete(fixture, session, &other, label).await?;
        other_threads.push(other);
    }
    let page = api(&session.app, "GET", "/v1/threads?limit=1", None).await?;
    anyhow::ensure!(
        page["threads"]
            .as_array()
            .context("thread page missing")?
            .len()
            == 1
    );
    anyhow::ensure!(
        page["nextCursor"].as_str().is_some(),
        "native inventory must exceed the visible page"
    );
    assert_badge(session, 2).await?;
    Ok(SavedMarkers {
        thread_id,
        first,
        second,
        seen_revision: revision(&seen)?,
        other_threads,
    })
}

async fn create_thread(session: &NativeSession, project_id: &str) -> anyhow::Result<String> {
    let created = api(
        &session.app,
        "POST",
        "/v1/threads",
        Some(json!({"projectId":project_id})),
    )
    .await?;
    Ok(created["thread"]["id"]
        .as_str()
        .context("native thread ID missing")?
        .to_owned())
}

async fn submit(session: &NativeSession, thread_id: &str, label: &str) -> anyhow::Result<String> {
    let accepted = api(
        &session.app,
        "POST",
        &format!("/v1/threads/{thread_id}/input"),
        Some(json!({"input":[{"type":"text","text":label}],"clientUserMessageId":label})),
    )
    .await?;
    Ok(accepted["payload"]["turn"]["id"]
        .as_str()
        .context("native turn ID missing")?
        .to_owned())
}

async fn complete(
    fixture: &mut Fixture,
    session: &mut NativeSession,
    thread_id: &str,
    label: &str,
) -> anyhow::Result<String> {
    fixture.enqueue([ModelResponse::Items(vec![json!({
        "type":"message","role":"assistant","id":format!("answer-{label}"),
        "content":[{"type":"output_text","text":format!("Answer for {label}")}],
    })])]);
    let turn_id = submit(session, thread_id, label).await?;
    let completed = session.completed_turn(thread_id, "completed").await?;
    anyhow::ensure!(completed["id"] == turn_id);
    fixture.next_model_request().await?;
    Ok(turn_id)
}

async fn inventory(session: &NativeSession) -> anyhow::Result<Value> {
    let threads = api(&session.app, "GET", "/v1/threads?limit=100", None).await?;
    anyhow::ensure!(
        threads["nextCursor"].is_null(),
        "fixture inventory unexpectedly needs another page"
    );
    Ok(threads)
}

fn find_thread<'a>(inventory: &'a Value, thread_id: &str) -> anyhow::Result<&'a Value> {
    inventory["threads"]
        .as_array()
        .context("native thread list missing")?
        .iter()
        .find(|thread| thread["id"] == thread_id)
        .context("native thread absent from inventory")
}

fn revision(read: &Value) -> anyhow::Result<i64> {
    read["readRevision"]
        .as_i64()
        .context("shared read revision missing")
}

fn assert_read(
    read: &Value,
    latest: Option<&str>,
    seen: Option<&str>,
    unread: bool,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        read["readStateKnown"] == true,
        "read head must be known: {read}"
    );
    anyhow::ensure!(read["latestCompletedTurnId"] == json!(latest));
    anyhow::ensure!(read["seenCompletedTurnId"] == json!(seen));
    anyhow::ensure!(read["unreadCompletedAgentTurn"] == unread);
    anyhow::ensure!(revision(read)? > 0);
    anyhow::ensure!(read.get("lastCompletedAgentTurnSeq").is_none());
    anyhow::ensure!(read.get("seenCompletedAgentTurnSeq").is_none());
    Ok(())
}

async fn acknowledge(
    session: &NativeSession,
    thread_id: &str,
    turn_id: &str,
    read_revision: i64,
) -> anyhow::Result<Value> {
    api(
        &session.app,
        "POST",
        &format!("/v1/threads/{thread_id}/seen"),
        Some(json!({"completedTurnId":turn_id,"readRevision":read_revision})),
    )
    .await
}

async fn reject_seen(
    session: &NativeSession,
    thread_id: &str,
    turn_id: &str,
    read_revision: i64,
) -> anyhow::Result<()> {
    let response = session
        .app
        .clone()
        .oneshot(
            Request::post(format!("/v1/threads/{thread_id}/seen"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"completedTurnId":turn_id,"readRevision":read_revision}).to_string(),
                ))?,
        )
        .await?;
    anyhow::ensure!(response.status() == axum::http::StatusCode::CONFLICT);
    let error: Value = serde_json::from_slice(&response.into_body().collect().await?.to_bytes())?;
    anyhow::ensure!(error["code"] == "conflict");
    anyhow::ensure!(error["retryable"] == false);
    Ok(())
}

async fn assert_badge(session: &NativeSession, count: i64) -> anyhow::Result<()> {
    let badge = api(&session.app, "GET", "/v1/threads/unread-badge", None).await?;
    anyhow::ensure!(
        badge["count"] == count,
        "unexpected unread aggregate: {badge}"
    );
    anyhow::ensure!(revision(&badge)? > 0);
    Ok(())
}

fn assert_all_unloaded(inventory: &Value, saved: &SavedMarkers) -> anyhow::Result<()> {
    anyhow::ensure!(
        inventory["threads"]
            .as_array()
            .context("thread inventory missing")?
            .len()
            == 3
    );
    for id in std::iter::once(&saved.thread_id).chain(saved.other_threads.iter()) {
        let thread = find_thread(inventory, id)?;
        anyhow::ensure!(
            thread["status"] == "notLoaded",
            "read query loaded chat {id}: {thread}"
        );
    }
    Ok(())
}
