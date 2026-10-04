use anyhow::Context;
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::time::{timeout, Duration};
use tower::ServiceExt;

use super::{
    fixture::{api, Fixture, ModelResponse, NativeSession},
    start_turn,
};

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_native_settings_apply_sparse_edits_and_resume_native_persistence(
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
    let (thread_id, before_restart) = result??;

    let mut reopened = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(30), async {
        let after_restart = read_settings(&reopened.app, &thread_id).await?;
        anyhow::ensure!(after_restart["model"] == before_restart["model"]);
        anyhow::ensure!(after_restart["effort"] == before_restart["effort"]);
        anyhow::ensure!(
            after_restart["activePermissionProfile"] == before_restart["activePermissionProfile"]
        );
        // In 0.160.0, resume restores model/effort from native metadata, while
        // service tier starts from config (unset in this disposable home).
        // A saved ThreadSettingsApplied tier does not make it a resume default.
        anyhow::ensure!(before_restart["serviceTier"] == "priority");
        anyhow::ensure!(
            after_restart["serviceTier"].is_null(),
            "cold resume service tier differed from the native config default: {after_restart}"
        );
        complete_settings_free_turn(&mut fixture, &mut reopened, &thread_id, &after_restart)
            .await?;
        anyhow::ensure!(read_settings(&reopened.app, &thread_id).await? == after_restart);
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
) -> anyhow::Result<(String, Value)> {
    // Both model choices come from this pinned executable's catalog. All model
    // calls still use the fixture's local provider, without an account or key.
    let (first_model, second_model) = supported_models(&session.app).await?;
    let project = api(
        &session.app,
        "POST",
        "/v1/projects",
        Some(json!({
            "name":"Native settings", "roots":[{"path":fixture.workspace}],
            "idempotencyKey":"native-settings-proof",
        })),
    )
    .await?;
    let created = api(
        &session.app,
        "POST",
        "/v1/threads",
        Some(json!({
            "projectId":project["id"], "model":first_model,
            "effort":"high", "serviceTier":"priority", "permissions":":read-only",
            "payload":{"config":{"model_reasoning_summary":"detailed"}},
        })),
    )
    .await?;
    let thread_id = created["thread"]["id"]
        .as_str()
        .context("native thread start omitted ID")?
        .to_owned();
    // Native 0.160.0 resume requires a rollout even for an already loaded chat.
    // Preserve this fresh-shell limitation explicitly instead of inventing a
    // settings snapshot, forcing unrelated metadata writes, or hiding a retry.
    let response = session
        .app
        .clone()
        .oneshot(Request::get(format!("/v1/threads/{thread_id}/settings")).body(Body::empty())?)
        .await?;
    anyhow::ensure!(response.status() == StatusCode::BAD_GATEWAY);
    let unavailable: Value =
        serde_json::from_slice(&response.into_body().collect().await?.to_bytes())?;
    anyhow::ensure!(unavailable["code"] == "bad_gateway");
    anyhow::ensure!(
        unavailable["message"]
            == format!("app-server error -32600: no rollout found for thread id {thread_id}")
    );
    // Until the first turn, only the actual native start response supplies the
    // effective creation choices. These values are test expectations, not a
    // gateway or browser settings cache.
    let initial = json!({
        "model":created["model"], "effort":created["reasoningEffort"],
        "serviceTier":created["serviceTier"],
        "activePermissionProfile":created["activePermissionProfile"],
    });
    anyhow::ensure!(initial["model"] == first_model);
    anyhow::ensure!(initial["effort"] == "high");
    anyhow::ensure!(initial["serviceTier"] == "priority");
    anyhow::ensure!(initial["activePermissionProfile"]["id"] == ":read-only");
    fixture.enqueue([ModelResponse::Hold]);
    let first_turn = start_turn(&session.app, &thread_id, "Use the native draft choices").await?;
    session
        .notification("turn/started", "threadId", &thread_id)
        .await?;
    // The native lifecycle notification is the UI's refill barrier after the
    // unavailable fresh-shell read. Holding the provider prevents completion
    // from supplying a later, accidental persistence barrier for this check.
    anyhow::ensure!(
        read_settings(&session.app, &thread_id).await? == initial,
        "metadata-only resume after turn/started changed native creation choices"
    );
    let first_request = fixture.next_model_request().await?;
    assert_request_settings(&first_request, &initial)?;
    // The draft effort override must merge into config without replacing other
    // caller choices, and must reach native execution rather than a UI overlay.
    anyhow::ensure!(first_request["reasoning"]["summary"] == "detailed");
    stop_current_turn(session, &thread_id, &first_turn).await?;

    let model_edit = apply_settings(session, &thread_id, json!({"model":second_model})).await?;
    anyhow::ensure!(model_edit["model"] == second_model);
    anyhow::ensure!(model_edit["effort"] == "high");
    anyhow::ensure!(model_edit["serviceTier"] == "priority");
    let effort_edit = apply_settings(session, &thread_id, json!({"effort":"medium"})).await?;
    anyhow::ensure!(effort_edit["model"] == second_model);
    anyhow::ensure!(effort_edit["effort"] == "medium");
    anyhow::ensure!(effort_edit["serviceTier"] == "priority");

    // model/effort are ordinary Option fields in the native update contract:
    // null is ignored. serviceTier is a nested Option and null clears it.
    let cleared = apply_settings(
        session,
        &thread_id,
        json!({"model":null, "effort":null, "serviceTier":null}),
    )
    .await?;
    anyhow::ensure!(cleared["model"] == second_model);
    anyhow::ensure!(cleared["effort"] == "medium");
    // Native StepSettings::apply represents the clear as "default"; the
    // Responses request omits service_tier instead of sending that sentinel.
    anyhow::ensure!(cleared["serviceTier"] == "default");
    complete_settings_free_turn(fixture, session, &thread_id, &cleared).await?;

    // An already dispatched request keeps its settings. The native applied
    // event confirms new thread defaults while that request remains active;
    // this test makes no claim about changing an in-flight provider request.
    fixture.enqueue([ModelResponse::Hold]);
    let running = start_turn(&session.app, &thread_id, "Hold this active request").await?;
    let active_request = fixture.next_model_request().await?;
    assert_request_settings(&active_request, &cleared)?;
    let next = apply_settings(
        session,
        &thread_id,
        json!({"model":first_model, "effort":"low", "serviceTier":"priority"}),
    )
    .await?;
    anyhow::ensure!(next["model"] == first_model);
    anyhow::ensure!(next["effort"] == "low");
    anyhow::ensure!(next["serviceTier"] == "priority");
    stop_current_turn(session, &thread_id, &running).await?;
    complete_settings_free_turn(fixture, session, &thread_id, &next).await?;

    // Persist a standalone edit after the last turn, so the cold assertion
    // cannot pass by restoring only that turn's earlier effort.
    let before_restart = apply_settings(session, &thread_id, json!({"effort":"high"})).await?;
    anyhow::ensure!(before_restart["model"] == first_model);
    anyhow::ensure!(before_restart["effort"] == "high");
    anyhow::ensure!(before_restart["serviceTier"] == "priority");
    Ok((thread_id, before_restart))
}

async fn supported_models(app: &Router) -> anyhow::Result<(String, String)> {
    let catalog = api(app, "GET", "/v1/models", None).await?;
    let models = catalog["models"]
        .as_array()
        .context("model catalog missing models")?;
    let mut matching = models.iter().filter(|model| {
        let tiers = model["rawPayload"]["serviceTiers"].as_array();
        let efforts = model["supportedReasoningEfforts"].as_array();
        tiers.is_some_and(|tiers| tiers.iter().any(|tier| tier["id"] == "priority"))
            && efforts.is_some_and(|efforts| {
                ["low", "medium", "high"].iter().all(|effort| {
                    efforts
                        .iter()
                        .any(|option| option["reasoningEffort"] == *effort)
                })
            })
    });
    let first = matching
        .next()
        .and_then(|model| model["model"].as_str())
        .context("pinned catalog has no model supporting fixture settings")?;
    let second = matching
        .find(|model| model["model"] != first)
        .and_then(|model| model["model"].as_str())
        .context("pinned catalog needs two distinct models supporting fixture settings")?;
    Ok((first.to_owned(), second.to_owned()))
}

async fn read_settings(app: &Router, thread_id: &str) -> anyhow::Result<Value> {
    api(
        app,
        "GET",
        &format!("/v1/threads/{thread_id}/settings"),
        None,
    )
    .await
}

async fn apply_settings(
    session: &mut NativeSession,
    thread_id: &str,
    edit: Value,
) -> anyhow::Result<Value> {
    let response = session
        .app
        .clone()
        .oneshot(
            Request::patch(format!("/v1/threads/{thread_id}/settings"))
                .header("content-type", "application/json")
                .body(Body::from(edit.to_string()))?,
        )
        .await?;
    let status = response.status();
    let body = response.into_body().collect().await?.to_bytes();
    anyhow::ensure!(
        status == StatusCode::ACCEPTED,
        "settings update returned {status}: {}",
        String::from_utf8_lossy(&body)
    );
    anyhow::ensure!(serde_json::from_slice::<Value>(&body)? == json!({}));
    // HTTP acceptance is not the application barrier. Observe the real native
    // notification after the serial relay ingested it, then refetch via resume.
    let applied = session
        .notification("thread/settings/updated", "threadId", thread_id)
        .await?;
    let snapshot = read_settings(&session.app, thread_id).await?;
    let native = &applied["threadSettings"];
    for key in ["model", "effort", "serviceTier"] {
        anyhow::ensure!(
            snapshot[key] == native[key],
            "settings read differs from native applied {key}: read={snapshot}, applied={native}"
        );
    }
    // The gateway omits an absent optional `extends`; native emits null.
    let profile = &snapshot["activePermissionProfile"];
    let native_profile = &native["activePermissionProfile"];
    anyhow::ensure!(profile.is_null() == native_profile.is_null());
    for key in ["id", "extends"] {
        anyhow::ensure!(profile[key] == native_profile[key]);
    }
    Ok(snapshot)
}

async fn complete_settings_free_turn(
    fixture: &mut Fixture,
    session: &mut NativeSession,
    thread_id: &str,
    settings: &Value,
) -> anyhow::Result<Value> {
    fixture.enqueue([ModelResponse::message("settings proof completed")]);
    start_turn(&session.app, thread_id, "Use the native thread choices").await?;
    let request = fixture.next_model_request().await?;
    assert_request_settings(&request, settings)?;
    session.completed_turn(thread_id, "completed").await?;
    Ok(request)
}

async fn stop_current_turn(
    session: &mut NativeSession,
    thread_id: &str,
    running: &Value,
) -> anyhow::Result<()> {
    let turn_id = &running["payload"]["turn"]["id"];
    anyhow::ensure!(turn_id.is_string());
    let stopped = api(
        &session.app,
        "POST",
        &format!("/v1/threads/{thread_id}/interrupt-current"),
        None,
    )
    .await?;
    anyhow::ensure!(stopped["disposition"] == "interrupted");
    anyhow::ensure!(stopped["interruptedTurnId"] == *turn_id);
    let interrupted = session.completed_turn(thread_id, "interrupted").await?;
    anyhow::ensure!(interrupted["id"] == *turn_id);
    Ok(())
}

fn assert_request_settings(request: &Value, settings: &Value) -> anyhow::Result<()> {
    anyhow::ensure!(
        request["model"] == settings["model"],
        "native model request used {}, expected {}",
        request["model"],
        settings["model"]
    );
    anyhow::ensure!(
        request["reasoning"]["effort"] == settings["effort"],
        "native model request effort was {}, expected {}",
        request["reasoning"]["effort"],
        settings["effort"]
    );
    if settings["serviceTier"].is_null() || settings["serviceTier"] == "default" {
        anyhow::ensure!(request.get("service_tier").is_none());
    } else {
        anyhow::ensure!(request["service_tier"] == settings["serviceTier"]);
    }
    Ok(())
}
