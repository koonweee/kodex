use super::fixture::{api, Fixture, ModelResponse, NativeSession};
use serde_json::json;
use tokio::time::{timeout, Duration};

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn native_code_mode_exec_returns_output() -> anyhow::Result<()> {
    let mut fixture = Fixture::new().await?;
    let config_path = fixture.config.codex.home.join("config.toml");
    let config = std::fs::read_to_string(&config_path)?.replace(
        "[features]\n",
        "[features]\ncode_mode = true\ncode_mode_only = true\ncode_mode_host = true\n",
    );
    std::fs::write(&config_path, config)?;
    let mut session = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(45), async {
        let project = api(&session.app, "POST", "/v1/projects", Some(json!({"name":"Disposable Code Mode proof", "roots":[{"path":fixture.workspace}],"idempotencyKey":"disposable-code-mode-proof"}))).await?;
        let created = api(&session.app, "POST", "/v1/threads", Some(json!({"projectId":project["id"]}))).await?;
        let thread_id = created["thread"]["id"].as_str().unwrap();
        fixture.enqueue([
            ModelResponse::Items(vec![json!({"type":"custom_tool_call","call_id":"proof-code-mode-call","name":"exec","input":"text('KODEX_CODE_MODE_OK')"})]),
            ModelResponse::message("Code Mode proof complete"),
        ]);
        api(&session.app, "POST", &format!("/v1/threads/{thread_id}/input"), Some(json!({"input":[{"type":"text","text":"Execute the supplied Code Mode proof."}]}))).await?;
        let first = fixture.next_model_request().await?;
        anyhow::ensure!(first["tools"].to_string().contains("exec"), "Code Mode exec was not exposed");
        let second = fixture.next_model_request().await?;
        let output = second["input"].as_array().and_then(|items| items.iter().find(|item| item["type"] == "custom_tool_call_output" && item["call_id"] == "proof-code-mode-call"));
        anyhow::ensure!(output.is_some(), "model's next input did not contain the custom tool output: {}", second["input"]);
        let output = output.unwrap();
        anyhow::ensure!(output["output"].as_array().is_some_and(|items| items.iter().any(|item| item["type"] == "input_text" && item["text"] == "KODEX_CODE_MODE_OK")), "helper did not execute text(): {output}");
        anyhow::ensure!(!output["output"].to_string().contains("Error"), "helper reported an error: {output}");
        session.completed_turn(thread_id, "completed").await?;
        anyhow::ensure!(!fixture.config.codex.home.join("auth.json").exists(), "proof must not create account auth");
        Ok::<_, anyhow::Error>(())
    }).await;
    session.shutdown().await?;
    result??;
    Ok(())
}
