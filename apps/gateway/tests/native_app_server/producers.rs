//! Retained unattended producers share native queue admission. No ordinary
//! startup activation, frozen options, or second queue payload store is involved.
use super::fixture::{api, Fixture, ModelResponse, NativeSession};
use anyhow::Context;
use kodex_gateway::{automations, store::AutomationRunPhase};
use serde_json::json;
use tokio::time::{timeout, Duration};

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_native_control_and_automation_admit_fresh_shells_without_resume_fallback(
) -> anyhow::Result<()> {
    let mut fixture = Fixture::new().await?;
    let mut session = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(45), async {
        let project = project(&fixture, &session).await?;
        let control = chat(&session, &project).await?;
        fixture.enqueue([ModelResponse::Hold]);
        let admission = api(&session.app, "POST", &format!("/v1/self-control/threads/{control}/input"), Some(json!({
            "input":[{"type":"text","text":"Control first native input","text_elements":[]}],
            "source":{"sourceThreadId":control, "sourceToolCallId":"control-native-proof"},
        }))).await?;
        anyhow::ensure!(admission["action"] == "queued" && admission["turn"].is_null(), "Control must truthfully acknowledge native queue admission: {admission}");
        let request = fixture.next_model_request().await?;
        anyhow::ensure!(request.to_string().contains("Control first native input"));
        api(&session.app, "POST", &format!("/v1/threads/{control}/interrupt-current"), None).await?;
        session.completed_turn(&control, "interrupted").await?;

        // Explicit Control input preserves native pause. It does not turn an
        // interrupted target into a hidden inference scheduler.
        let paused = api(&session.app, "POST", &format!("/v1/self-control/threads/{control}/input"), Some(json!({"input":[{"type":"text","text":"Control paused next turn","text_elements":[]}]}))).await?;
        fixture.assert_no_model_request(Duration::from_millis(150)).await?;
        let paused_id = paused["queuedInput"]["id"].as_str().context("native Control row ID")?.to_owned();
        let queue = api(&session.app, "GET", &format!("/v1/threads/{control}/queued-inputs"), None).await?;
        anyhow::ensure!(queue["queuedInputs"].as_array().unwrap().iter().any(|row| row["id"] == paused_id));
        fixture.enqueue([ModelResponse::Hold]);
        let start = api(&session.app, "POST", &format!("/v1/threads/{control}/queued-inputs/start"), Some(json!({"queuedSubmissionId":paused_id}))).await?;
        anyhow::ensure!(start["payload"]["turn"]["id"].is_string());
        anyhow::ensure!(fixture.next_model_request().await?.to_string().contains("Control paused next turn"));
        api(&session.app, "POST", &format!("/v1/threads/{control}/interrupt-current"), None).await?;
        session.completed_turn(&control, "interrupted").await?;

        let target = chat(&session, &project).await?;
        let automation = automation(&session, &target).await?;
        fixture.enqueue([ModelResponse::Hold]);
        let run = automations::run_now(&session.state, &automation).await?;
        let request = fixture.next_model_request().await?;
        anyhow::ensure!(request.to_string().contains("Native producer scheduled input"));
        wait_dispatched(&session, &run.id).await?;
        let definition = session.state.store.get_automation(&automation).await?;
        anyhow::ensure!(definition.last_run_at.is_none() && definition.last_native_queue_id.is_none(), "Run-now must not alter scheduled cadence/statistics");
        api(&session.app, "POST", &format!("/v1/threads/{target}/interrupt-current"), None).await?;
        session.completed_turn(&target, "interrupted").await?;
        let history = api(&session.app, "GET", &format!("/v1/automations/{automation}/runs"), None).await?;
        anyhow::ensure!(history["runs"][0]["id"] == run.id && history["runs"][0]["phase"] == "dispatched");
        Ok::<_,anyhow::Error>(())
    }).await;
    session.shutdown().await?;
    result??;
    Ok(())
}

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_native_automation_restart_activates_only_its_acknowledged_target(
) -> anyhow::Result<()> {
    let mut fixture = Fixture::new().await?;
    let mut session = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(40), async {
        let project = project(&fixture, &session).await?;
        let ordinary = chat(&session, &project).await?;
        fixture.enqueue([ModelResponse::message("ordinary shell materialized")]);
        api(
            &session.app,
            "POST",
            &format!("/v1/threads/{ordinary}/input"),
            Some(json!({"input":[{"type":"text","text":"materialize ordinary chat"}]})),
        )
        .await?;
        fixture.next_model_request().await?;
        session.completed_turn(&ordinary, "completed").await?;

        let target = chat(&session, &project).await?;
        fixture.enqueue([ModelResponse::Hold]);
        api(
            &session.app,
            "POST",
            &format!("/v1/threads/{target}/input"),
            Some(json!({"input":[{"type":"text","text":"hold automation target"}]})),
        )
        .await?;
        fixture.next_model_request().await?;
        let automation = automation(&session, &target).await?;
        let next_due = session
            .state
            .store
            .get_automation(&automation)
            .await?
            .next_run_at;
        anyhow::ensure!(automations::process_due_automations(&session.state, next_due).await? == 1);
        let run = session
            .state
            .store
            .list_automation_runs(&automation)
            .await?
            .remove(0);
        anyhow::ensure!(run.phase == AutomationRunPhase::Queued && run.native_queue_id.is_some());
        let queue = api(
            &session.app,
            "GET",
            &format!("/v1/threads/{target}/queued-inputs"),
            None,
        )
        .await?;
        anyhow::ensure!(queue["queuedInputs"][0]["clientUserMessageId"] == run.id);
        Ok::<_, anyhow::Error>((ordinary, target, run))
    })
    .await;
    session.shutdown().await?;
    drop(session);
    let (ordinary, target, run) = result??;
    let mut reopened = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(40), async {
        anyhow::ensure!(reopened.native_loaded_threads().await?["data"] == json!([]));
        // Public ordinary queue mutation intentionally leaves a cold chat cold.
        let ordinary_row = api(&reopened.app,"POST",&format!("/v1/threads/{ordinary}/queued-inputs"),Some(json!({"input":[{"type":"text","text":"Ordinary cold work stays dormant"}],"clientUserMessageId":"ordinary-dormant-producer-proof"}))).await?;
        let original_id = ordinary_row["queuedInput"]["id"].as_str().context("ordinary native row ID")?.to_owned();
        let edited = api(&reopened.app,"PUT",&format!("/v1/threads/{ordinary}/queued-inputs/{original_id}"),Some(json!({"input":[{"type":"text","text":"Ordinary cold work stays dormant — edited","text_elements":[]}]}))).await?;
        anyhow::ensure!(edited["queuedInput"]["clientUserMessageId"] == "ordinary-dormant-producer-proof");
        let extra = api(&reopened.app,"POST",&format!("/v1/threads/{ordinary}/queued-inputs"),Some(json!({"input":[{"type":"text","text":"Extra native ordinary row"}]}))).await?;
        let extra_id=extra["queuedInput"]["id"].as_str().context("extra native row ID")?;
        api(&reopened.app,"POST",&format!("/v1/threads/{ordinary}/queued-inputs/reorder"),Some(json!({"queuedSubmissionIds":[extra_id,original_id]}))).await?;
        let order=api(&reopened.app,"GET",&format!("/v1/threads/{ordinary}/queued-inputs"),None).await?;
        anyhow::ensure!(order["queuedInputs"][0]["id"] == extra_id && order["queuedInputs"][1]["id"] == original_id);
        let removed=api(&reopened.app,"DELETE",&format!("/v1/threads/{ordinary}/queued-inputs/{extra_id}"),None).await?;
        anyhow::ensure!(removed["deleted"] == true);
        anyhow::ensure!(ordinary_row["queuedInput"]["canSteer"] == false);
        anyhow::ensure!(reopened.native_loaded_threads().await?["data"] == json!([]));
        fixture.enqueue([ModelResponse::Hold]);
        automations::recover_automations_after_restart(&reopened.state).await?;
        let request = fixture.next_model_request().await?;
        anyhow::ensure!(request.to_string().contains("Native producer scheduled input"));
        anyhow::ensure!(!request.to_string().contains("Ordinary cold work stays dormant"));
        wait_dispatched(&reopened,&run.id).await?;
        let loaded = reopened.native_loaded_threads().await?;
        anyhow::ensure!(loaded["data"].as_array().unwrap().iter().any(|id| id == &target));
        anyhow::ensure!(!loaded["data"].as_array().unwrap().iter().any(|id| id == &ordinary));
        fixture.assert_no_model_request(Duration::from_secs(11)).await?;
        let queue = api(&reopened.app,"GET",&format!("/v1/threads/{ordinary}/queued-inputs"),None).await?;
        anyhow::ensure!(queue["queuedInputs"].as_array().unwrap().len() == 1 && queue["queuedInputs"][0]["id"] == ordinary_row["queuedInput"]["id"]);
        let runs = reopened.state.store.list_automation_runs(&run.automation_id).await?;
        anyhow::ensure!(runs.len() == 1 && runs[0].id == run.id, "Recovery must not create another admission");
        api(&reopened.app,"POST",&format!("/v1/threads/{target}/interrupt-current"),None).await?;
        reopened.completed_turn(&target,"interrupted").await?;
        Ok::<_,anyhow::Error>(())
    }).await;
    reopened.shutdown().await?;
    result??;
    Ok(())
}

async fn project(fixture: &Fixture, session: &NativeSession) -> anyhow::Result<String> {
    let p=api(&session.app,"POST","/v1/projects",Some(json!({"name":"Native producer proof","roots":[{"path":fixture.workspace}],"idempotencyKey":"native-producer-proof"}))).await?;
    Ok(p["id"].as_str().context("native project ID")?.into())
}
async fn chat(session: &NativeSession, project: &str) -> anyhow::Result<String> {
    let c = api(
        &session.app,
        "POST",
        "/v1/threads",
        Some(json!({"projectId":project})),
    )
    .await?;
    Ok(c["thread"]["id"]
        .as_str()
        .context("native thread ID")?
        .into())
}
async fn automation(session: &NativeSession, target: &str) -> anyhow::Result<String> {
    let a=api(&session.app,"POST","/v1/automations",Some(json!({"name":"Native schedule proof","prompt":"Native producer scheduled input","targetThreadId":target,"schedule":{"startAt":"2099-01-01T00:00:00Z","repeatEvery":{"value":1,"unit":"hours"}}}))).await?;
    Ok(a["automation"]["id"]
        .as_str()
        .context("automation ID")?
        .into())
}
async fn wait_dispatched(session: &NativeSession, id: &str) -> anyhow::Result<()> {
    timeout(Duration::from_secs(15), async {
        loop {
            let run = session.state.store.get_automation_run(id).await?;
            if run.phase == AutomationRunPhase::Dispatched {
                return Ok::<_, anyhow::Error>(());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .context("native dispatch acknowledgement or receipt did not settle automation run")?
}
