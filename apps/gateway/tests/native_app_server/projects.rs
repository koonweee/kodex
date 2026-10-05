use anyhow::Context;
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use tokio::time::{timeout, Duration};
use tower::ServiceExt;

use super::{
    fixture::{api, Fixture, ModelResponse, NativeSession},
    function_output, start_turn,
};

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_native_projects_keep_roots_membership_order_and_history_across_restart(
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
    let (project_id, survivor_id, thread_id, cwd) = result??;
    let reopened = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(20), async {
        let project = api(
            &reopened.app,
            "GET",
            &format!("/v1/projects/{project_id}"),
            None,
        )
        .await?;
        anyhow::ensure!(project["roots"] == json!([]));
        anyhow::ensure!(project["name"] == "Renamed project");
        anyhow::ensure!(project["metadata"]["unknown-native-key"] == "preserved");
        let listed = api(&reopened.app, "GET", "/v1/projects", None).await?;
        anyhow::ensure!(listed["projects"][0]["id"] == survivor_id);
        anyhow::ensure!(listed["projects"][1]["id"] == project_id);
        anyhow::ensure!(
            listed["projects"][0]["roots"]
                == json!([{
                    "path":fixture.workspace.join("not-created")
                }])
        );
        anyhow::ensure!(!fixture.workspace.join("not-created").exists());
        verify_unassigned(&reopened.app, &thread_id, &cwd).await
    })
    .await;
    reopened.shutdown().await?;
    result??;
    Ok(())
}

async fn exercise(
    fixture: &mut Fixture,
    session: &mut NativeSession,
) -> anyhow::Result<(String, String, String, String)> {
    let secondary = fixture.workspace.join("secondary");
    std::fs::create_dir(&secondary)?;
    // Native turn execution canonicalizes macOS /var aliases. Use the resolved
    // directory so membership assertions measure identity, not path spelling.
    let secondary = std::fs::canonicalize(secondary)?;
    let create = json!({
        "name":"Two roots", "roots":[{"path":fixture.workspace},{"path":secondary}],
        "metadata":{"unknown-native-key":"preserved"}, "idempotencyKey":"project-two-roots"
    });
    let project = api(&session.app, "POST", "/v1/projects", Some(create.clone())).await?;
    let project_id = id(&project)?;
    session
        .notification("project/changed", "projectId", &project_id)
        .await?;
    let duplicate = api(&session.app, "POST", "/v1/projects", Some(create)).await?;
    anyhow::ensure!(
        duplicate["id"] == project_id,
        "native create retry changed identity"
    );
    anyhow::ensure!(
        project["roots"]
            .as_array()
            .context("missing native roots")?
            .len()
            == 2
    );
    anyhow::ensure!(project["metadata"]["unknown-native-key"] == "preserved");
    anyhow::ensure!(
        project.get("cwd").is_none(),
        "native roots were flattened into cwd"
    );

    let rootless = api(
        &session.app,
        "POST",
        "/v1/projects",
        Some(json!({
            "name":"Organization only", "roots":[], "idempotencyKey":"project-rootless"
        })),
    )
    .await?;
    let rootless_id = id(&rootless)?;
    session
        .notification("project/changed", "projectId", &rootless_id)
        .await?;
    let survivor = api(
        &session.app,
        "POST",
        "/v1/projects",
        Some(json!({
            "name":"Surviving project", "roots":[{"path":fixture.workspace.join("not-created")}],
            "idempotencyKey":"project-survivor"
        })),
    )
    .await?;
    let survivor_id = id(&survivor)?;
    anyhow::ensure!(!fixture.workspace.join("not-created").exists());
    session
        .notification("project/changed", "projectId", &survivor_id)
        .await?;
    for project_id in [&project_id, &rootless_id] {
        reject_execution(&session.app, json!({"projectId":project_id})).await?;
        reject_execution(
            &session.app,
            json!({"projectId":project_id, "cwd":secondary}),
        )
        .await?;
    }
    let project = api(
        &session.app,
        "PATCH",
        &format!("/v1/projects/{project_id}"),
        Some(json!({"roots":[{"path":secondary}]})),
    )
    .await?;
    session
        .notification("project/changed", "projectId", &project_id)
        .await?;
    anyhow::ensure!(project["roots"] == json!([{"path":secondary}]));
    anyhow::ensure!(project["metadata"]["unknown-native-key"] == "preserved");

    let thread = api(
        &session.app,
        "POST",
        "/v1/threads",
        Some(json!({
            "projectId":project_id
        })),
    )
    .await?;
    let thread_id = id(&thread["thread"])?;
    let cwd = secondary.to_string_lossy().to_string();
    anyhow::ensure!(thread["thread"]["cwd"] == cwd);
    anyhow::ensure!(thread["thread"]["projectId"] == project_id);
    fixture.enqueue([
        ModelResponse::command(
            "cwd-proof",
            json!({"cmd":"pwd", "shell":"/bin/sh", "login":false, "yield_time_ms":1000}),
        ),
        ModelResponse::message("project cwd proved"),
    ]);
    start_turn(&session.app, &thread_id, "Check the project root directory").await?;
    session.completed_turn(&thread_id, "completed").await?;
    fixture.next_model_request().await?;
    let continuation = fixture.next_model_request().await?;
    anyhow::ensure!(function_output(&continuation, "cwd-proof")?
        .to_string()
        .contains(&cwd));

    let project_path = format!("/v1/projects/{project_id}");
    let renamed = api(
        &session.app,
        "PATCH",
        &project_path,
        Some(json!({"name":"Renamed project"})),
    )
    .await?;
    session
        .notification("project/changed", "projectId", &project_id)
        .await?;
    anyhow::ensure!(renamed["roots"] == project["roots"]);
    anyhow::ensure!(renamed["metadata"] == project["metadata"]);
    let cleared = api(
        &session.app,
        "PATCH",
        &project_path,
        Some(json!({"roots":[]})),
    )
    .await?;
    session
        .notification("project/changed", "projectId", &project_id)
        .await?;
    anyhow::ensure!(cleared["name"] == "Renamed project");
    anyhow::ensure!(cleared["metadata"] == project["metadata"]);
    api(
        &session.app,
        "POST",
        &format!("/v1/projects/{survivor_id}/move"),
        Some(json!({"beforeProjectId":project_id})),
    )
    .await?;
    session
        .notification("project/changed", "projectId", &survivor_id)
        .await?;
    api(
        &session.app,
        "POST",
        &format!("/v1/projects/{rootless_id}/move"),
        Some(json!({"beforeProjectId":project_id})),
    )
    .await?;
    session
        .notification("project/changed", "projectId", &rootless_id)
        .await?;
    let listed = api(&session.app, "GET", "/v1/projects", None).await?;
    anyhow::ensure!(listed["projects"][0]["id"] == survivor_id);
    anyhow::ensure!(listed["projects"][1]["id"] == rootless_id);
    anyhow::ensure!(listed["projects"][2]["id"] == project_id);

    // Membership changes made by another native client still project through
    // gateway notifications and reads after the browser move action is removed.
    let moved = session
        .state
        .app_server
        .request(
            "thread/metadata/update",
            json!({"threadId":thread_id,"projectId":rootless_id}),
        )
        .await?;
    session
        .notification("thread/project/updated", "threadId", &thread_id)
        .await?;
    anyhow::ensure!(moved["thread"]["projectId"] == rootless_id);
    anyhow::ensure!(
        moved["thread"]["cwd"] == cwd,
        "membership update changed cwd from {cwd} to {}",
        moved["thread"]["cwd"]
    );
    let old_members = api(
        &session.app,
        "GET",
        &format!("/v1/threads?projectId={project_id}"),
        None,
    )
    .await?;
    anyhow::ensure!(!contains_thread(&old_members, &thread_id));
    let new_members = api(
        &session.app,
        "GET",
        &format!("/v1/threads?projectId={rootless_id}"),
        None,
    )
    .await?;
    anyhow::ensure!(contains_thread(&new_members, &thread_id));
    api(
        &session.app,
        "DELETE",
        &format!("/v1/projects/{rootless_id}"),
        None,
    )
    .await?;
    session
        .notification("project/changed", "projectId", &rootless_id)
        .await?;
    verify_unassigned(&session.app, &thread_id, &cwd).await?;
    Ok((project_id, survivor_id, thread_id, cwd))
}

async fn reject_execution(app: &Router, payload: Value) -> anyhow::Result<()> {
    let response = app
        .clone()
        .oneshot(
            Request::post("/v1/threads")
                .header("content-type", "application/json")
                .body(Body::from(payload.to_string()))?,
        )
        .await?;
    anyhow::ensure!(
        response.status() == StatusCode::BAD_REQUEST,
        "execution without a single project root was accepted"
    );
    Ok(())
}

async fn verify_unassigned(app: &Router, thread_id: &str, cwd: &str) -> anyhow::Result<()> {
    let detail = api(app, "GET", &format!("/v1/threads/{thread_id}"), None).await?;
    anyhow::ensure!(detail["thread"]["projectId"].is_null());
    anyhow::ensure!(detail["thread"]["cwd"] == cwd);
    anyhow::ensure!(detail.to_string().contains("project cwd proved"));
    let unassigned = api(app, "GET", "/v1/chats/threads", None).await?;
    anyhow::ensure!(
        contains_thread(&unassigned, thread_id),
        "native unassigned chat missing outside old chat-directory tree"
    );
    Ok(())
}

fn id(value: &Value) -> anyhow::Result<String> {
    Ok(value["id"]
        .as_str()
        .context("missing native ID")?
        .to_string())
}

fn contains_thread(response: &Value, thread_id: &str) -> bool {
    response["threads"]
        .as_array()
        .is_some_and(|threads| threads.iter().any(|thread| thread["id"] == thread_id))
}
