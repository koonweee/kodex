use anyhow::Context;
use serde_json::{json, Value};
use tokio::time::{timeout, Duration};

use super::{
    fixture::{api, Fixture, ModelResponse, NativeSession},
    function_output, start_turn,
};

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_native_descendants_paginate_and_remain_discoverable_when_unloaded(
) -> anyhow::Result<()> {
    let mut fixture = Fixture::new().await?;
    let path = fixture.config.codex.home.join("config.toml");
    let config = std::fs::read_to_string(&path)?;
    std::fs::write(
        path,
        config.replace("plugins = false", "plugins = false\nmulti_agent = true"),
    )?;
    let mut session = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(60), async {
        let project=api(&session.app,"POST","/v1/projects",Some(json!({"name":"Descendant proof","roots":[{"path":fixture.workspace}],"idempotencyKey":"native-descendant-proof"}))).await?;
        let created = api(&session.app, "POST", "/v1/threads", Some(json!({"projectId":project["id"]}))).await?;
        let root = created["thread"]["id"].as_str().context("missing root ID")?.to_owned();
        let spawn = ModelResponse::Items(["first", "second"].into_iter().map(|name| json!({
            "type":"function_call", "call_id":format!("spawn-{name}"),
            "namespace":"multi_agent_v1", "name":"spawn_agent",
            "arguments":json!({"message":format!("Complete {name} descendant fixture")}).to_string(),
        })).collect());
        // Each v1 child watcher injects one completion fragment. If it arrives
        // during parent sampling, native can require another model response.
        // Bound this fixture to spawn + two children + parent + two fragments;
        // response exhaustion still rejects any unexpected further request.
        fixture.enqueue(std::iter::once(spawn).chain((0..5).map(|index| {
            ModelResponse::Items(vec![json!({
                "type":"message", "role":"assistant", "id":format!("descendant-answer-{index}"),
                "content":[{"type":"output_text", "text":"native descendant completed"}],
            })])
        })));
        start_turn(&session.app, &root, "Spawn two native descendants").await?;
        session.completed_turn(&root, "completed").await?;
        let mut child_ids = Vec::new();
        for _ in 0..6 {
            let request = fixture.next_model_request().await?;
            for name in ["first", "second"] {
                if let Ok(output) = function_output(&request, &format!("spawn-{name}")) {
                    let output: Value = serde_json::from_str(output.as_str().context("tool output must be text")?)?;
                    child_ids.push(output["agent_id"].as_str().context("native spawn omitted child ID")?.to_owned());
                }
            }
            child_ids.sort();
            child_ids.dedup();
            if child_ids.len() == 2 {
                break;
            }
        }
        anyhow::ensure!(child_ids.len() == 2, "native spawn did not produce two children");
        timeout(Duration::from_secs(15), async {
            loop {
                let page = api(&session.app,"GET",&format!("/v1/threads/{root}/subagents"),None).await?;
                if page["subagents"].as_array().is_some_and(|rows| rows.len()==2 && rows.iter().all(|row|row["status"]=="idle")) { break; }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Ok::<_,anyhow::Error>(())
        }).await??;
        assert_pages(&session, &root, &child_ids, false).await?;
        Ok::<_,anyhow::Error>((root,child_ids))
    }).await;
    session.shutdown().await?;
    drop(session);
    let (root, children) = result??;
    let reopened = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(30), async {
        // Discovery must not resume the ancestor or load any descendant.
        assert_pages(&reopened, &root, &children, true).await?;
        for id in &children {
            let detail = api(&reopened.app, "GET", &format!("/v1/threads/{id}"), None).await?;
            anyhow::ensure!(detail.to_string().contains("native descendant completed"));
            anyhow::ensure!(detail["thread"]["parentThreadId"] == root);
            // A history read deliberately does not load/resume this child.
            anyhow::ensure!(detail["thread"]["canAcceptDirectInput"].is_null());
            let attached = api(
                &reopened.app,
                "POST",
                &format!("/v1/threads/{id}/attach"),
                None,
            )
            .await?;
            anyhow::ensure!(attached["thread"]["canAcceptDirectInput"] == true);
        }
        Ok::<_, anyhow::Error>(())
    })
    .await;
    reopened.shutdown().await?;
    result??;
    anyhow::ensure!(!fixture.config.codex.home.join("auth.json").exists());
    Ok(())
}

async fn assert_pages(
    session: &NativeSession,
    root: &str,
    expected: &[String],
    cold: bool,
) -> anyhow::Result<()> {
    let first = api(
        &session.app,
        "GET",
        &format!("/v1/threads/{root}/subagents?limit=1"),
        None,
    )
    .await?;
    let cursor = first["nextCursor"]
        .as_str()
        .context("native descendant page omitted next cursor")?;
    let mut next = reqwest::Url::parse(&format!(
        "http://fixture.invalid/v1/threads/{root}/subagents"
    ))?;
    next.query_pairs_mut()
        .append_pair("limit", "1")
        .append_pair("cursor", cursor);
    let next_path = format!("{}?{}", next.path(), next.query().unwrap_or_default());
    let second = api(&session.app, "GET", &next_path, None).await?;
    anyhow::ensure!(second["nextCursor"].is_null());
    let mut ids = Vec::new();
    for page in [&first, &second] {
        let rows = page["subagents"]
            .as_array()
            .context("missing native descendants")?;
        anyhow::ensure!(rows.len() == 1);
        let row = &rows[0];
        ids.push(row["id"].as_str().context("missing child ID")?.to_owned());
        anyhow::ensure!(row["parentThreadId"] == root);
        if cold {
            anyhow::ensure!(
                row["status"] == "notLoaded",
                "cold discovery loaded child: {row}"
            );
            anyhow::ensure!(row["canAcceptDirectInput"].is_null());
        } else {
            anyhow::ensure!(row["status"] == "idle");
            anyhow::ensure!(row["canAcceptDirectInput"] == true);
        }
    }
    ids.sort();
    anyhow::ensure!(ids == expected);
    Ok(())
}
