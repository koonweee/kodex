//! Native 0.160 queue semantics, before replacing Kodex's legacy queue adapter.
//! Requests follow the checked-in ThreadQueue* schemas. Dispatch/pause assertions
//! exercise app-server/thread_queue_processor and ext/queue/src/service.rs.

use anyhow::Context;
use kodex_gateway::error::ApiError;
use serde_json::{json, Value};
use tokio::time::{timeout, Duration};

use super::{
    fixture::{api, Fixture, ModelResponse, NativeSession},
    start_turn,
};

// Native's external queue watcher ticks every ten seconds. Observing longer
// distinguishes an unloaded/paused queue from merely delayed dispatch.
const WATCHER_OBSERVATION: Duration = Duration::from_secs(11);

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_native_queue_mutations_preserve_identity_and_interrupt_pauses_dispatch(
) -> anyhow::Result<()> {
    let mut fixture = Fixture::new().await?;
    let mut session = NativeSession::start(&fixture).await?;
    let result = timeout(
        Duration::from_secs(60),
        exercise_mutations_and_pause(&mut fixture, &mut session),
    )
    .await;
    session.shutdown().await?;
    result??;
    anyhow::ensure!(!fixture.config.codex.home.join("auth.json").exists());
    Ok(())
}

async fn exercise_mutations_and_pause(
    fixture: &mut Fixture,
    session: &mut NativeSession,
) -> anyhow::Result<()> {
    let thread_id = create_thread(fixture, session).await?;
    fixture.enqueue([ModelResponse::Hold]);
    start_turn(&session.app, &thread_id, "Hold the native active turn").await?;
    fixture.next_model_request().await?;

    // Identical text is deliberately not identity. Updating B must preserve its
    // native row ID and caller correlation ID without affecting A.
    let a = add(
        session,
        &thread_id,
        "queue-client-a",
        "Identical queued input",
    )
    .await?;
    let b = add(
        session,
        &thread_id,
        "queue-client-b",
        "Identical queued input",
    )
    .await?;
    let c = add(
        session,
        &thread_id,
        "queue-client-c",
        "Delete this queued input",
    )
    .await?;
    anyhow::ensure!(a["id"] != b["id"] && b["id"] != c["id"] && a["id"] != c["id"]);
    assert_pages(session, &thread_id, &[a.clone(), b.clone(), c.clone()]).await?;
    // The client ID correlates eventual input; it is not an admission key.
    // Retrying an ambiguous add can create another durable native queue row.
    let duplicate = add(
        session,
        &thread_id,
        "queue-client-a",
        "Identical queued input",
    )
    .await?;
    anyhow::ensure!([&a, &b, &c].iter().all(|row| row["id"] != duplicate["id"]));
    assert_pages(
        session,
        &thread_id,
        &[a.clone(), b.clone(), c.clone(), duplicate.clone()],
    )
    .await?;
    let deleted_duplicate = session
        .native_queue_rpc(
            "delete",
            json!({"threadId":thread_id,"queuedSubmissionId":duplicate["id"]}),
        )
        .await?;
    anyhow::ensure!(deleted_duplicate == json!({"deleted":true}));
    assert_pages(session, &thread_id, &[a.clone(), b.clone(), c.clone()]).await?;
    let changed = session
        .notification("thread/queue/changed", "threadId", &thread_id)
        .await?;
    anyhow::ensure!(changed == json!({"threadId":thread_id}));

    let updated = session
        .native_queue_rpc(
            "update",
            json!({
                "threadId":thread_id, "queuedSubmissionId":b["id"],
                "input":input("Edited native queued input"),
            }),
        )
        .await?;
    anyhow::ensure!(updated["queuedSubmission"]["id"] == b["id"]);
    let b = updated["queuedSubmission"].clone();
    anyhow::ensure!(b["clientUserMessageId"] == "queue-client-b");
    anyhow::ensure!(b["input"] == input("Edited native queued input"));
    let bad_reorder = session
        .native_queue_rpc(
            "reorder",
            json!({
                "threadId":thread_id,"queuedSubmissionIds":[a["id"],b["id"]],
            }),
        )
        .await
        .expect_err("native reorder must reject a missing current row");
    assert_native_rejection(
        &bad_reorder,
        "queue reorder must include every queued submission exactly once",
    )?;
    assert_pages(session, &thread_id, &[a.clone(), b.clone(), c.clone()]).await?;
    session
        .native_queue_rpc(
            "reorder",
            json!({
                "threadId":thread_id,"queuedSubmissionIds":[b["id"],a["id"],c["id"]],
            }),
        )
        .await?;
    for deleted in [true, false] {
        let response = session
            .native_queue_rpc(
                "delete",
                json!({
                    "threadId":thread_id,"queuedSubmissionId":c["id"],
                }),
            )
            .await?;
        anyhow::ensure!(response == json!({"deleted":deleted}));
    }
    assert_pages(session, &thread_id, &[b.clone(), a.clone()]).await?;

    let busy = session
        .native_queue_rpc(
            "start",
            json!({
                "threadId":thread_id,"queuedSubmissionId":a["id"],
            }),
        )
        .await
        .expect_err("queue/start must not steer or consume a row while active");
    assert_native_rejection(&busy, "thread already has an active or pending turn")?;
    assert_pages(session, &thread_id, &[b.clone(), a.clone()]).await?;
    let stopped = api(
        &session.app,
        "POST",
        &format!("/v1/threads/{thread_id}/interrupt-current"),
        None,
    )
    .await?;
    let interrupted = session.completed_turn(&thread_id, "interrupted").await?;
    anyhow::ensure!(stopped["interruptedTurnId"] == interrupted["id"]);
    fixture.assert_no_model_request(WATCHER_OBSERVATION).await?;
    assert_pages(session, &thread_id, &[b.clone(), a.clone()]).await?;

    // Explicitly starting the non-head A is allowed while interrupted. Native
    // completion then drains B; Kodex does not run a dispatcher for either row.
    let (selected_response, release_selected) = ModelResponse::gated_message("Selected A finished");
    fixture.enqueue([
        selected_response,
        ModelResponse::message("Native B drained"),
    ]);
    let started = session
        .native_queue_rpc(
            "start",
            json!({
                "threadId":thread_id,"queuedSubmissionId":a["id"],
            }),
        )
        .await?;
    let user_a = queue_user_started(session, &thread_id, &a).await?;
    anyhow::ensure!(user_a["turnId"] == started["turn"]["id"]);
    fixture.next_model_request().await?;
    assert_pages(session, &thread_id, std::slice::from_ref(&b)).await?;
    release_selected
        .send(())
        .map_err(|_| anyhow::anyhow!("selected provider response dropped"))?;
    let completed_a = session.completed_turn(&thread_id, "completed").await?;
    anyhow::ensure!(completed_a["id"] == started["turn"]["id"]);
    queue_user_started(session, &thread_id, &b).await?;
    let model_b = fixture.next_model_request().await?;
    anyhow::ensure!(model_b["input"]
        .to_string()
        .contains("Edited native queued input"));
    session.completed_turn(&thread_id, "completed").await?;
    assert_pages(session, &thread_id, &[]).await?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_native_queue_cold_reads_leave_work_queued_until_explicit_attach() -> anyhow::Result<()>
{
    let mut fixture = Fixture::new().await?;
    let mut first = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(30), async {
        let thread_id = create_thread(&fixture, &first).await?;
        fixture.enqueue([ModelResponse::message("Native queue thread materialized")]);
        start_turn(
            &first.app,
            &thread_id,
            "Persist this native thread before restart",
        )
        .await?;
        fixture.next_model_request().await?;
        first.completed_turn(&thread_id, "completed").await?;
        Ok::<_, anyhow::Error>(thread_id)
    })
    .await;
    first.shutdown().await?;
    drop(first);
    let thread_id = result??;

    // Add to an unloaded, normally completed thread, then restart again. This
    // proves durability without relying on interruption's separate pause state.
    let cold = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(20), async {
        anyhow::ensure!(cold.native_loaded_threads().await?["data"] == json!([]));
        let row = add(
            &cold,
            &thread_id,
            "cold-queue-client",
            "Dispatch only after attach",
        )
        .await?;
        assert_pages(&cold, &thread_id, std::slice::from_ref(&row)).await?;
        anyhow::ensure!(cold.native_loaded_threads().await?["data"] == json!([]));
        Ok::<_, anyhow::Error>(row)
    })
    .await;
    cold.shutdown().await?;
    drop(cold);
    let queued = result??;

    let mut reopened = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(45), async {
        assert_pages(&reopened, &thread_id, std::slice::from_ref(&queued)).await?;
        let detail = api(
            &reopened.app,
            "GET",
            &format!("/v1/threads/{thread_id}"),
            None,
        )
        .await?;
        anyhow::ensure!(detail["thread"]["id"] == thread_id);
        anyhow::ensure!(detail["thread"]["status"] == "notLoaded");
        let listed = api(&reopened.app, "GET", "/v1/threads", None).await?;
        let listed_thread = listed["threads"]
            .as_array()
            .context("chat list missing threads")?
            .iter()
            .find(|thread| thread["id"] == thread_id)
            .context("cold native chat not listed")?;
        anyhow::ensure!(listed_thread["status"] == "notLoaded");
        anyhow::ensure!(reopened.native_loaded_threads().await?["data"] == json!([]));
        fixture.assert_no_model_request(WATCHER_OBSERVATION).await?;
        assert_pages(&reopened, &thread_id, std::slice::from_ref(&queued)).await?;
        anyhow::ensure!(reopened.native_loaded_threads().await?["data"] == json!([]));
        let unloaded_start = reopened
            .native_queue_rpc(
                "start",
                json!({
                    "threadId":thread_id,"queuedSubmissionId":queued["id"],
                }),
            )
            .await
            .expect_err("manual start must require explicit native loading");
        assert_native_rejection(
            &unloaded_start,
            "resume the thread before starting a queued message",
        )?;
        assert_pages(&reopened, &thread_id, std::slice::from_ref(&queued)).await?;

        fixture.enqueue([ModelResponse::message("Native cold queue dispatched")]);
        let attached = api(
            &reopened.app,
            "POST",
            &format!("/v1/threads/{thread_id}/attach"),
            None,
        )
        .await?;
        anyhow::ensure!(attached["thread"]["id"] == thread_id);
        queue_user_started(&mut reopened, &thread_id, &queued).await?;
        let request = fixture.next_model_request().await?;
        anyhow::ensure!(request["input"]
            .to_string()
            .contains("Dispatch only after attach"));
        reopened.completed_turn(&thread_id, "completed").await?;
        assert_pages(&reopened, &thread_id, &[]).await?;
        anyhow::ensure!(reopened.native_loaded_threads().await?["data"] == json!([thread_id]));
        Ok::<_, anyhow::Error>(())
    })
    .await;
    reopened.shutdown().await?;
    result??;
    anyhow::ensure!(!fixture.config.codex.home.join("auth.json").exists());
    Ok(())
}

async fn create_thread(fixture: &Fixture, session: &NativeSession) -> anyhow::Result<String> {
    let account = api(&session.app, "GET", "/v1/account", None).await?;
    anyhow::ensure!(account["account"].is_null() && account["requiresOpenaiAuth"] == false);
    let project = api(
        &session.app,
        "POST",
        "/v1/projects",
        Some(json!({
            "name":"Native queue proof", "roots":[{"path":fixture.workspace}],
            "idempotencyKey":"native-queue-proof",
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
    Ok(created["thread"]["id"]
        .as_str()
        .context("native thread ID missing")?
        .to_owned())
}

fn input(text: &str) -> Value {
    json!([{"type":"text","text":text,"text_elements":[]}])
}

async fn add(
    session: &NativeSession,
    thread_id: &str,
    client_id: &str,
    text: &str,
) -> anyhow::Result<Value> {
    let added = session
        .native_queue_rpc(
            "add",
            json!({
                "threadId":thread_id,"clientUserMessageId":client_id,"input":input(text),
            }),
        )
        .await?;
    let row = &added["queuedSubmission"];
    anyhow::ensure!(row["id"].as_str().is_some_and(|id| !id.is_empty()));
    anyhow::ensure!(row["clientUserMessageId"] == client_id && row["input"] == input(text));
    Ok(row.clone())
}

async fn assert_pages(
    session: &NativeSession,
    thread_id: &str,
    expected: &[Value],
) -> anyhow::Result<()> {
    let mut cursor = Value::Null;
    let mut rows = Vec::new();
    // A one-row page exercises opaque continuation and terminal null without
    // assuming that the current native implementation encodes an offset.
    for _ in 0..=expected.len() {
        let page = session
            .native_queue_rpc(
                "list",
                json!({
                    "threadId":thread_id,"limit":1,"cursor":cursor,
                }),
            )
            .await?;
        let data = page["data"]
            .as_array()
            .context("native queue page missing data")?;
        anyhow::ensure!(data.len() <= 1);
        rows.extend(data.iter().cloned());
        cursor = page["nextCursor"].clone();
        if cursor.is_null() {
            anyhow::ensure!(
                rows == expected,
                "native queue order/content differs: {rows:?}"
            );
            return Ok(());
        }
        anyhow::ensure!(cursor.is_string(), "queue returned a non-string cursor");
    }
    anyhow::bail!("native queue pagination exceeded expected rows")
}

fn assert_native_rejection(error: &anyhow::Error, message: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        matches!(error.downcast_ref::<ApiError>(), Some(ApiError::NativeRpc(actual))
            if actual.code == -32600 && actual.message == message),
        "expected definitive native invalid request, got {error:#}",
    );
    Ok(())
}

async fn queue_user_started(
    session: &mut NativeSession,
    thread_id: &str,
    row: &Value,
) -> anyhow::Result<Value> {
    let started = session
        .notification("item/started", "threadId", thread_id)
        .await?;
    anyhow::ensure!(
        started["item"]["type"] == "userMessage",
        "queued turn did not start with user input: {started}"
    );
    anyhow::ensure!(started["item"]["clientId"] == row["clientUserMessageId"]);
    anyhow::ensure!(started["item"]["content"] == row["input"]);
    Ok(started)
}
