//! Real protocol proof with a pinned executable, disposable home, and local model.
//! Interactive account sign-in is deliberately not completed or claimed by this test.
#[path = "native_app_server/config.rs"]
mod config;
#[path = "native_app_server/fixture.rs"]
mod fixture;
#[path = "native_app_server/projects.rs"]
mod projects;
#[path = "native_app_server/sections.rs"]
mod sections;
#[path = "native_app_server/settings.rs"]
mod settings;
#[path = "native_app_server/subagents.rs"]
mod subagents;

use anyhow::Context;
use axum::Router;
use fixture::{api, upload, Fixture, ModelResponse, NativeSession};
use serde_json::{json, Value};
use tokio::time::{timeout, Duration};

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_native_project_approval_stop_upload_and_cold_reopen_use_fresh_state(
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
    let thread_id = result??;

    // A new native process and gateway projection must recover persisted history.
    let reopened = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(20), async {
        let detail = api(
            &reopened.app,
            "GET",
            &format!("/v1/threads/{thread_id}"),
            None,
        )
        .await?;
        for text in [
            "fixture completed",
            "upload readable",
            "image received",
            "approval completed",
        ] {
            anyhow::ensure!(
                detail.to_string().contains(text),
                "cold reopen missing {text}"
            );
        }
        anyhow::ensure!(detail["thread"]["id"] == thread_id);
        let stop = api(
            &reopened.app,
            "POST",
            &format!("/v1/threads/{thread_id}/interrupt-current"),
            None,
        )
        .await?;
        anyhow::ensure!(
            stop["disposition"] == "idle",
            "cold reopen retained a running turn: {stop}"
        );
        Ok::<_, anyhow::Error>(())
    })
    .await;
    reopened.shutdown().await?;
    result??;
    anyhow::ensure!(fixture.config.codex.home.join("sqlite").is_dir());
    anyhow::ensure!(!fixture.config.codex.home.join("auth.json").exists());
    Ok(())
}

async fn exercise(fixture: &mut Fixture, session: &mut NativeSession) -> anyhow::Result<String> {
    // The configured local provider needs no account. No inherited credentials are used.
    let account = api(&session.app, "GET", "/v1/account", None).await?;
    anyhow::ensure!(account["account"].is_null());
    anyhow::ensure!(account["requiresOpenaiAuth"] == false);
    let project = api(
        &session.app,
        "POST",
        "/v1/projects",
        Some(json!({
            "roots":[{"path":fixture.workspace}], "name":"Native integration",
            "idempotencyKey":"real-native-project-fixture",
        })),
    )
    .await?;
    let project_id = project["id"]
        .as_str()
        .context("missing native project ID")?;
    let listed = api(&session.app, "GET", "/v1/projects", None).await?;
    anyhow::ensure!(listed["projects"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["id"] == project_id));
    let thread = api(
        &session.app,
        "POST",
        "/v1/threads",
        Some(json!({"projectId":project_id})),
    )
    .await?;
    let thread_id = thread["thread"]["id"]
        .as_str()
        .context("missing native thread ID")?
        .to_string();
    api(
        &session.app,
        "GET",
        &format!("/v1/threads/{thread_id}"),
        None,
    )
    .await?;
    fixture.enqueue([ModelResponse::message("fixture completed")]);
    start_turn(&session.app, &thread_id, "Hello local fixture").await?;
    session.completed_turn(&thread_id, "completed").await?;
    fixture.next_model_request().await?;

    verify_native_upload_read(fixture, session, &thread_id).await?;
    verify_native_image_upload(fixture, session, &thread_id).await?;
    verify_native_approval(fixture, session, &thread_id).await?;
    verify_stop_pending_approval(fixture, session, &thread_id).await?;

    fixture.enqueue([ModelResponse::Hold]);
    start_turn(&session.app, &thread_id, "Wait for Stop").await?;
    fixture.next_model_request().await?;
    let stop = api(
        &session.app,
        "POST",
        &format!("/v1/threads/{thread_id}/interrupt-current"),
        None,
    )
    .await?;
    anyhow::ensure!(
        stop["disposition"] == "interrupted",
        "Stop did not interrupt: {stop}"
    );
    let interrupted = session.completed_turn(&thread_id, "interrupted").await?;
    anyhow::ensure!(stop["interruptedTurnId"] == interrupted["id"]);
    Ok(thread_id)
}

async fn verify_native_upload_read(
    fixture: &mut Fixture,
    session: &mut NativeSession,
    thread_id: &str,
) -> anyhow::Result<()> {
    let uploaded = upload(
        &session.app,
        &format!("/v1/threads/{thread_id}/uploads/files"),
        "files",
        "proof.txt",
        "text/plain",
        b"kodex-native-upload-proof",
    )
    .await?;
    let path = uploaded["files"][0]["absolutePath"]
        .as_str()
        .context("missing uploaded file path")?;
    anyhow::ensure!(
        std::path::Path::new(path).starts_with(std::fs::canonicalize(&fixture.workspace)?)
    );
    fixture.enqueue([
        ModelResponse::command(
            "fixture-upload",
            json!({
                "cmd":format!("cat {}", shlex::try_quote(path)?), "workdir":fixture.workspace,
                "shell":"/bin/sh", "login":false, "yield_time_ms":1000,
            }),
        ),
        ModelResponse::message("upload readable"),
    ]);
    start_turn(&session.app, thread_id, "Read the uploaded fixture file").await?;
    session.completed_turn(thread_id, "completed").await?;
    fixture.next_model_request().await?;
    let continuation = fixture.next_model_request().await?;
    let output = function_output(&continuation, "fixture-upload")?;
    anyhow::ensure!(
        output.to_string().contains("kodex-native-upload-proof"),
        "native sandbox could not read upload: {output}"
    );
    Ok(())
}

async fn verify_native_image_upload(
    fixture: &mut Fixture,
    session: &mut NativeSession,
    thread_id: &str,
) -> anyhow::Result<()> {
    const PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xb5,
        0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0xfc,
        0xff, 0x1f, 0x00, 0x03, 0x03, 0x02, 0x00, 0xef, 0xa2, 0xa7, 0x5b, 0x00, 0x00, 0x00, 0x00,
        0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];
    let uploaded = upload(
        &session.app,
        "/v1/uploads/images",
        "images",
        "proof.png",
        "image/png",
        PNG,
    )
    .await?;
    let path = uploaded["images"][0]["path"]
        .as_str()
        .context("missing uploaded image path")?;
    anyhow::ensure!(std::fs::canonicalize(path)?.starts_with(&fixture.config.instance.data_dir));
    fixture.enqueue([ModelResponse::message("image received")]);
    api(
        &session.app,
        "POST",
        &format!("/v1/threads/{thread_id}/turns"),
        Some(json!({"input":[
            {"type":"text", "text":"Inspect the uploaded image", "textElements":[]},
            {"type":"localImage", "path":path},
        ]})),
    )
    .await?;
    session.completed_turn(thread_id, "completed").await?;
    let request = fixture.next_model_request().await?;
    anyhow::ensure!(
        request["input"]
            .as_array()
            .context("model request missing input")?
            .iter()
            .any(|item| {
                item["role"] == "user"
                    && item["content"].as_array().is_some_and(|content| {
                        content.iter().any(|part| {
                            part["type"] == "input_image"
                                && part["image_url"]
                                    .as_str()
                                    .is_some_and(|url| url.starts_with("data:image/png;base64,"))
                        })
                    })
            }),
        "native input did not load the relocated image upload"
    );
    Ok(())
}

async fn verify_native_approval(
    fixture: &mut Fixture,
    session: &mut NativeSession,
    thread_id: &str,
) -> anyhow::Result<()> {
    fixture.enqueue([
        ModelResponse::command("fixture-approval", json!({
            "cmd":"printf approved > approved.txt", "workdir":fixture.workspace,
            "shell":"/bin/sh", "login":false, "yield_time_ms":1000,
            "sandbox_permissions":"require_escalated", "justification":"Create the disposable approval proof file.",
        })),
        ModelResponse::message("approval completed"),
    ]);
    start_turn(
        &session.app,
        thread_id,
        "Run the command that requires approval",
    )
    .await?;
    let approval = timeout(Duration::from_secs(15), async {
        loop {
            let listed = api(
                &session.app,
                "GET",
                &format!("/v1/approvals?status=pending&threadId={thread_id}"),
                None,
            )
            .await?;
            if let Some(approval) = listed["approvals"].as_array().and_then(|rows| rows.first()) {
                break Ok::<_, anyhow::Error>(approval.clone());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .context("real command approval was not displayed")??;
    anyhow::ensure!(approval["method"] == "item/commandExecution/requestApproval");
    anyhow::ensure!(approval["threadId"] == thread_id);
    anyhow::ensure!(approval["payload"]["command"]
        .as_str()
        .is_some_and(|command| command.contains("approved.txt")));
    anyhow::ensure!(
        !fixture.workspace.join("approved.txt").exists(),
        "command ran before approval"
    );
    let approval_id = approval["id"].as_str().context("missing approval ID")?;
    let first_request = session.next_server_request().await?;
    anyhow::ensure!(approval["requestId"] == first_request.0);
    api(
        &session.app,
        "POST",
        &format!("/v1/threads/{thread_id}/resume"),
        Some(json!({})),
    )
    .await?;
    anyhow::ensure!(session.next_server_request().await? == first_request);
    let replayed = api(
        &session.app,
        "GET",
        &format!("/v1/approvals?threadId={thread_id}"),
        None,
    )
    .await?;
    let replayed = replayed["approvals"]
        .as_array()
        .context("missing replay snapshot")?;
    anyhow::ensure!(
        replayed.len() == 1,
        "native replay created duplicate prompts: {replayed:?}"
    );
    anyhow::ensure!(replayed[0]["id"] == approval_id);
    // Another client can read and resolve the same native request through gateway state.
    let second_read = api(
        &session.app.clone(),
        "GET",
        &format!("/v1/approvals/{approval_id}"),
        None,
    )
    .await?;
    anyhow::ensure!(second_read["status"] == "pending");
    let submitted = api(
        &session.app,
        "POST",
        &format!("/v1/approvals/{approval_id}/decision"),
        Some(json!({"decision":{"decision":"accept"}})),
    )
    .await?;
    anyhow::ensure!(matches!(
        submitted["status"].as_str(),
        Some("responding" | "resolved")
    ));
    session
        .completed_turn_and_resolution(thread_id, "completed", &first_request.0)
        .await?;
    anyhow::ensure!(std::fs::read_to_string(fixture.workspace.join("approved.txt"))? == "approved");
    fixture.next_model_request().await?;
    let continuation = fixture.next_model_request().await?;
    anyhow::ensure!(function_output(&continuation, "fixture-approval")?
        .to_string()
        .contains("Process exited with code 0"));
    let second_read = api(
        &session.app.clone(),
        "GET",
        &format!("/v1/approvals/{approval_id}"),
        None,
    )
    .await?;
    anyhow::ensure!(second_read["status"] == "resolved");
    Ok(())
}

async fn verify_stop_pending_approval(
    fixture: &mut Fixture,
    session: &mut NativeSession,
    thread_id: &str,
) -> anyhow::Result<()> {
    fixture.enqueue([ModelResponse::command("fixture-stopped-approval", json!({
        "cmd":"printf forbidden > stopped-approval.txt", "workdir":fixture.workspace,
        "shell":"/bin/sh", "login":false, "yield_time_ms":1000,
        "sandbox_permissions":"require_escalated", "justification":"This disposable command must be stopped before approval.",
    }))]);
    start_turn(
        &session.app,
        thread_id,
        "Prepare another approval then stop",
    )
    .await?;
    let (request_id, _) = session.next_server_request().await?;
    let pending = api(
        &session.app,
        "GET",
        &format!("/v1/approvals?threadId={thread_id}"),
        None,
    )
    .await?;
    anyhow::ensure!(pending["approvals"]
        .as_array()
        .is_some_and(|rows| rows.len() == 1));
    let stopped = api(
        &session.app,
        "POST",
        &format!("/v1/threads/{thread_id}/interrupt-current"),
        None,
    )
    .await?;
    let turn = session
        .completed_turn_and_resolution(thread_id, "interrupted", &request_id)
        .await?;
    anyhow::ensure!(stopped["interruptedTurnId"] == turn["id"]);
    let after = api(
        &session.app,
        "GET",
        &format!("/v1/approvals?threadId={thread_id}"),
        None,
    )
    .await?;
    anyhow::ensure!(
        after["approvals"].as_array().is_some_and(Vec::is_empty),
        "Stop retained pending native approval: {after}"
    );
    anyhow::ensure!(!fixture.workspace.join("stopped-approval.txt").exists());
    fixture.next_model_request().await?;
    Ok(())
}

async fn start_turn(app: &Router, thread_id: &str, text: &str) -> anyhow::Result<Value> {
    api(
        app,
        "POST",
        &format!("/v1/threads/{thread_id}/turns"),
        Some(json!({
            "input":[{"type":"text", "text":text, "textElements":[]}],
        })),
    )
    .await
}

fn function_output<'a>(request: &'a Value, call_id: &str) -> anyhow::Result<&'a Value> {
    request["input"]
        .as_array()
        .context("model request missing input")?
        .iter()
        .find(|item| item["type"] == "function_call_output" && item["call_id"] == call_id)
        .and_then(|item| item.get("output"))
        .context("model continuation missing native tool output")
}
