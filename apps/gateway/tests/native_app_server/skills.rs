use std::path::{Path, PathBuf};

use anyhow::Context;
use serde_json::{json, Value};
use tokio::time::{timeout, Duration};

use super::fixture::{api, Fixture, ModelResponse, NativeSession};

struct Skill {
    name: String,
    path: PathBuf,
    body_marker: String,
}

struct Skills {
    valid: Skill,
    disabled: Skill,
    ambiguous: [Skill; 2],
    stale: Skill,
}

#[tokio::test]
#[ignore = "requires explicit pinned real Codex executable and loopback access"]
async fn real_native_skill_selection_and_structured_history_use_native_authority(
) -> anyhow::Result<()> {
    let mut fixture = Fixture::new().await?;
    let skills = seed_skills(&fixture)?;
    let mut session = NativeSession::start(&fixture).await?;
    let result = timeout(
        Duration::from_secs(90),
        exercise(&mut fixture, &mut session, &skills),
    )
    .await;
    session.shutdown().await?;
    drop(session);
    let (raw_thread, structured_thread, structured_input, expected_mention) = result??;

    let reopened = NativeSession::start(&fixture).await?;
    let result = timeout(Duration::from_secs(30), async {
        assert_raw_history(&reopened, &raw_thread, &skills.valid).await?;
        assert_structured_history(
            &reopened,
            &structured_thread,
            &structured_input,
            &expected_mention,
        )
        .await?;
        Ok::<_, anyhow::Error>(())
    })
    .await;
    reopened.shutdown().await?;
    result??;
    anyhow::ensure!(!fixture.config.codex.home.join("auth.json").exists());
    Ok(())
}

fn seed_skills(fixture: &Fixture) -> anyhow::Result<Skills> {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let root = fixture.config.codex.home.join("skills");
    let valid = write_skill(&root, "valid", &format!("kodex-valid-{suffix}"))?;
    let disabled = write_skill(&root, "disabled", &format!("kodex-disabled-{suffix}"))?;
    let ambiguous_name = format!("kodex-ambiguous-{suffix}");
    let ambiguous = [
        write_skill(&root, "ambiguous-one", &ambiguous_name)?,
        write_skill(&root, "ambiguous-two", &ambiguous_name)?,
    ];
    let stale = write_skill(&root, "stale", &format!("kodex-stale-{suffix}"))?;
    let config_path = fixture.config.codex.home.join("config.toml");
    let config = std::fs::read_to_string(&config_path)?;
    let disabled_path = serde_json::to_string(&disabled.path)?;
    std::fs::write(
        config_path,
        format!(
            "project_doc_max_bytes = 0\n{config}\n[skills.bundled]\nenabled = false\n[[skills.config]]\npath = {disabled_path}\nenabled = false\n"
        ),
    )?;
    Ok(Skills {
        valid,
        disabled,
        ambiguous,
        stale,
    })
}

fn write_skill(root: &Path, directory: &str, name: &str) -> anyhow::Result<Skill> {
    let directory = root.join(directory);
    std::fs::create_dir_all(&directory)?;
    let path = directory.join("SKILL.md");
    let body_marker = format!("KODEX_NATIVE_SKILL_BODY_{}", uuid::Uuid::new_v4().simple());
    std::fs::write(
        &path,
        format!(
            "---\nname: {name}\ndescription: Disposable native integration fixture.\n---\n\n{body_marker}\n"
        ),
    )?;
    Ok(Skill {
        name: name.into(),
        path: std::fs::canonicalize(path)?,
        body_marker,
    })
}

async fn exercise(
    fixture: &mut Fixture,
    session: &mut NativeSession,
    skills: &Skills,
) -> anyhow::Result<(String, String, Value, Value)> {
    let project = api(
        &session.app,
        "POST",
        "/v1/projects",
        Some(json!({
            "name":"Native skill proof", "roots":[{"path":fixture.workspace}],
            "idempotencyKey":"native-skill-proof",
        })),
    )
    .await?;
    let project_id = project["id"].as_str().context("project omitted ID")?;
    let catalog = read_catalog(session, fixture).await?;
    let entries = catalog["skills"]
        .as_array()
        .context("missing skill catalog")?;
    for skill in [&skills.valid, &skills.disabled, &skills.stale] {
        let entry = entries
            .iter()
            .find(|entry| entry["path"] == skill.path.to_string_lossy().as_ref())
            .with_context(|| {
                format!("fixture skill missing from native catalog: {}", skill.name)
            })?;
        anyhow::ensure!(entry["enabled"] == (skill.name != skills.disabled.name));
    }
    // Ambient HOME/.agents skills may also be discovered by native Codex.
    // Unique names and body-only markers keep this proof independent of them.
    anyhow::ensure!(
        entries
            .iter()
            .filter(|entry| entry["name"] == skills.ambiguous[0].name)
            .count()
            == 2
    );

    let raw_input = json!([{"type":"text","text":format!("Use ${}", skills.valid.name)}]);
    let (raw_thread, request) = complete_input(fixture, session, project_id, raw_input).await?;
    assert_injected(&request, &skills.valid, true)?;
    assert_raw_history(session, &raw_thread, &skills.valid).await?;

    let prefix = "🧭 café 你好 ";
    let token = format!("${}", skills.valid.name);
    let text = format!("{prefix}{token} explicit binding");
    let structured_input = json!([
        {"type":"text","text":text,"text_elements":[{
            "byteRange":{"start":prefix.len(),"end":prefix.len()+token.len()},
            "placeholder":token,
        }]},
        {"type":"skill","name":skills.valid.name,"path":skills.valid.path},
    ]);
    let expected_mention = json!({
        "start":prefix.encode_utf16().count(),
        "end":prefix.encode_utf16().count()+token.encode_utf16().count(),
        "name":skills.valid.name,"path":skills.valid.path,
    });
    let (structured_thread, request) =
        complete_input(fixture, session, project_id, structured_input.clone()).await?;
    assert_injected(&request, &skills.valid, true)?;
    assert_structured_history(
        session,
        &structured_thread,
        &structured_input,
        &expected_mention,
    )
    .await?;

    // An explicit invalid binding blocks same-name plain-text fallback natively.
    let missing_path = fixture.config.codex.home.join("missing/SKILL.md");
    let (_, request) = complete_input(
        fixture,
        session,
        project_id,
        json!([
            {"type":"text","text":format!("Use ${}",skills.valid.name)},
            {"type":"skill","name":skills.valid.name,"path":missing_path},
        ]),
    )
    .await?;
    assert_injected(&request, &skills.valid, false)?;
    let (_, request) = complete_input(
        fixture,
        session,
        project_id,
        json!([
            {"type":"text","text":format!("Use ${}",skills.disabled.name)},
            {"type":"skill","name":skills.disabled.name,"path":skills.disabled.path},
        ]),
    )
    .await?;
    assert_injected(&request, &skills.disabled, false)?;
    let (_, request) = complete_input(
        fixture,
        session,
        project_id,
        json!([
            {"type":"text","text":format!("Use ${}",skills.ambiguous[0].name)},
        ]),
    )
    .await?;
    for skill in &skills.ambiguous {
        assert_injected(&request, skill, false)?;
    }

    // A previously advertised picker path can disappear before submission. The
    // native selector owns this outcome; the gateway must still submit the turn.
    std::fs::remove_file(&skills.stale.path)?;
    read_catalog(session, fixture).await?;
    let (_, request) = complete_input(
        fixture,
        session,
        project_id,
        json!([
            {"type":"text","text":format!("Use ${}",skills.stale.name)},
            {"type":"skill","name":skills.stale.name,"path":skills.stale.path},
        ]),
    )
    .await?;
    assert_injected(&request, &skills.stale, false)?;
    Ok((
        raw_thread,
        structured_thread,
        structured_input,
        expected_mention,
    ))
}

async fn read_catalog(session: &NativeSession, fixture: &Fixture) -> anyhow::Result<Value> {
    let mut url = reqwest::Url::parse("http://fixture.invalid/v1/skills")?;
    url.query_pairs_mut()
        .append_pair(
            "cwd",
            fixture
                .workspace
                .to_str()
                .context("fixture cwd not UTF-8")?,
        )
        .append_pair("forceReload", "true");
    api(
        &session.app,
        "GET",
        &format!("{}?{}", url.path(), url.query().unwrap()),
        None,
    )
    .await
}

async fn complete_input(
    fixture: &mut Fixture,
    session: &mut NativeSession,
    project_id: &str,
    input: Value,
) -> anyhow::Result<(String, Value)> {
    let created = api(
        &session.app,
        "POST",
        "/v1/threads",
        Some(json!({"projectId":project_id})),
    )
    .await?;
    let thread_id = created["thread"]["id"]
        .as_str()
        .context("thread omitted ID")?
        .to_owned();
    fixture.enqueue([ModelResponse::message("skill fixture completed")]);
    api(
        &session.app,
        "POST",
        &format!("/v1/threads/{thread_id}/turns"),
        Some(json!({"input":input})),
    )
    .await?;
    session.completed_turn(&thread_id, "completed").await?;
    let request = fixture.next_model_request().await?;
    Ok((thread_id, request))
}

fn assert_injected(request: &Value, skill: &Skill, expected: bool) -> anyhow::Result<()> {
    anyhow::ensure!(
        request["input"].to_string().contains(&skill.body_marker) == expected,
        "native body injection for {} did not match expected={expected}",
        skill.name,
    );
    Ok(())
}

async fn user_item(session: &NativeSession, thread_id: &str) -> anyhow::Result<Value> {
    let detail = api(
        &session.app,
        "GET",
        &format!("/v1/threads/{thread_id}"),
        None,
    )
    .await?;
    let items = detail["timeline"]["rows"]
        .as_array()
        .context("missing canonical rows")?
        .iter()
        .filter_map(|row| row.get("item"))
        .filter(|item| item["itemType"] == "userMessage")
        .collect::<Vec<_>>();
    anyhow::ensure!(items.len() == 1, "expected exactly one native user message");
    Ok(items[0].clone())
}

async fn assert_raw_history(
    session: &NativeSession,
    thread_id: &str,
    skill: &Skill,
) -> anyhow::Result<()> {
    let item = user_item(session, thread_id).await?;
    let content = item["payload"]["item"]["content"]
        .as_array()
        .context("missing native user content")?;
    anyhow::ensure!(content.len() == 1 && content[0]["type"] == "text");
    anyhow::ensure!(content[0]["text"] == format!("Use ${}", skill.name));
    anyhow::ensure!(item["payload"]["itemSnapshot"]["skillMentions"].is_null());
    Ok(())
}

async fn assert_structured_history(
    session: &NativeSession,
    thread_id: &str,
    input: &Value,
    mention: &Value,
) -> anyhow::Result<()> {
    let item = user_item(session, thread_id).await?;
    anyhow::ensure!(
        item["payload"]["item"]["content"] == *input,
        "native structured input/spans changed in history"
    );
    anyhow::ensure!(
        item["payload"]["itemSnapshot"]["skillMentions"] == json!([mention]),
        "canonical binding should preserve only supplied name/path/range"
    );
    Ok(())
}
