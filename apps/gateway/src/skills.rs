use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
};

use serde_json::json;
use tokio::sync::RwLock;

use crate::{
    api::AppState,
    app_server::DynAppServer,
    app_server_api::{self, SkillMetadata, SkillsCatalogResponse, UserInput},
    error::{ApiError, ApiResult},
    store::NewEvent,
};

pub const SKILLS_CHANGED_EVENT: &str = "skills.changed";

const DEFAULT_CATALOG_KEY: &str = "";

#[derive(Debug, Clone)]
pub struct ResolvedTurnInput {
    pub input: Vec<UserInput>,
    pub skills: Vec<SkillMetadata>,
}

#[derive(Clone, Default)]
pub struct SkillCatalogCache {
    inner: Arc<RwLock<SkillCatalogCacheState>>,
}

#[derive(Default)]
struct SkillCatalogCacheState {
    generation: u64,
    entries: HashMap<String, SkillsCatalogResponse>,
}

impl SkillCatalogCache {
    pub async fn catalog(
        &self,
        app_server: &DynAppServer,
        cwd: Option<String>,
        force_reload: bool,
    ) -> ApiResult<SkillsCatalogResponse> {
        let key = catalog_key(cwd.as_deref());
        loop {
            if !force_reload {
                let state = self.inner.read().await;
                if let Some(entry) = state.entries.get(&key) {
                    if entry.invalidation_generation == state.generation {
                        return Ok(entry.clone());
                    }
                }
            }

            let generation = self.generation().await;
            let app_server_force_reload = force_reload || generation > 0;
            let response = app_server_api::client(app_server)
                .skills_list(cwd.clone().into_iter().collect(), app_server_force_reload)
                .await?;
            let entry = response
                .data
                .into_iter()
                .find(|entry| cwd.as_deref().is_none_or(|cwd| entry.cwd == cwd))
                .map(|entry| {
                    let mut skills = entry.skills;
                    normalize_skill_icon_paths(&mut skills);
                    SkillsCatalogResponse {
                        cwd: Some(entry.cwd),
                        skills,
                        errors: entry.errors,
                        invalidation_generation: generation,
                    }
                })
                .unwrap_or_else(|| SkillsCatalogResponse {
                    cwd: cwd.clone(),
                    skills: Vec::new(),
                    errors: Vec::new(),
                    invalidation_generation: generation,
                });

            let mut state = self.inner.write().await;
            if state.generation != generation {
                continue;
            }
            state.entries.insert(key.clone(), entry.clone());
            return Ok(entry);
        }
    }

    pub async fn invalidate(&self) -> u64 {
        let mut state = self.inner.write().await;
        state.generation = state.generation.saturating_add(1);
        state.entries.clear();
        state.generation
    }

    pub async fn generation(&self) -> u64 {
        self.inner.read().await.generation
    }
}

fn normalize_skill_icon_paths(skills: &mut [SkillMetadata]) {
    for skill in skills {
        let Some(skill_dir) = Path::new(&skill.path).parent() else {
            continue;
        };
        let Some(interface) = skill.interface.as_mut() else {
            continue;
        };
        normalize_skill_icon_path(skill_dir, &mut interface.icon_small);
        normalize_skill_icon_path(skill_dir, &mut interface.icon_large);
    }
}

fn normalize_skill_icon_path(skill_dir: &Path, icon_path: &mut Option<String>) {
    let Some(raw_path) = icon_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    else {
        *icon_path = None;
        return;
    };
    if raw_path.starts_with("http://") || raw_path.starts_with("https://") {
        *icon_path = Some(raw_path.to_string());
        return;
    }
    let path = Path::new(raw_path);
    let absolute = if path.is_absolute() {
        PathBuf::from(path)
    } else {
        skill_dir.join(path)
    };
    *icon_path = Some(clean_path_string(&absolute));
}

fn clean_path_string(path: &Path) -> String {
    path.components()
        .collect::<PathBuf>()
        .to_string_lossy()
        .into_owned()
}

pub async fn broadcast_skills_changed(state: &AppState, source: &str) -> ApiResult<()> {
    let generation = state.skills.invalidate().await;
    let event = state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: None,
            turn_id: None,
            item_id: None,
            kind: SKILLS_CHANGED_EVENT.to_string(),
            codex_method: Some("skills/changed".to_string()),
            payload: json!({
                "generation": generation,
                "source": source,
            }),
        })
        .await?;
    let _ = state.events.send(event);
    Ok(())
}

pub async fn resolve_turn_input_for_thread(
    state: &AppState,
    thread_id: &str,
    input: Vec<UserInput>,
) -> ApiResult<Vec<UserInput>> {
    Ok(
        resolve_turn_input_with_skills_for_thread(state, thread_id, input)
            .await?
            .input,
    )
}

pub async fn resolve_turn_input_with_skills_for_thread(
    state: &AppState,
    thread_id: &str,
    input: Vec<UserInput>,
) -> ApiResult<ResolvedTurnInput> {
    if !input_needs_skill_resolution(&input) {
        return Ok(ResolvedTurnInput {
            input,
            skills: Vec::new(),
        });
    }
    let thread = app_server_api::client(&state.app_server)
        .thread_read_summary(thread_id.to_string())
        .await?;
    resolve_turn_input_with_skills_for_cwd(state, Some(thread.cwd), input).await
}

pub async fn resolve_turn_input_for_cwd(
    state: &AppState,
    cwd: Option<String>,
    input: Vec<UserInput>,
) -> ApiResult<Vec<UserInput>> {
    Ok(resolve_turn_input_with_skills_for_cwd(state, cwd, input)
        .await?
        .input)
}

pub async fn resolve_turn_input_with_skills_for_cwd(
    state: &AppState,
    cwd: Option<String>,
    input: Vec<UserInput>,
) -> ApiResult<ResolvedTurnInput> {
    if !input_needs_skill_resolution(&input) {
        return Ok(ResolvedTurnInput {
            input,
            skills: Vec::new(),
        });
    }

    let catalog = state
        .skills
        .catalog(&state.app_server, cwd.clone(), false)
        .await?;
    match build_resolved_input(&input, &catalog.skills) {
        Ok(resolved) => Ok(resolved),
        Err(ResolveSkillError::SelectedSkillMissing { .. }) => {
            let catalog = state.skills.catalog(&state.app_server, cwd, true).await?;
            build_resolved_input(&input, &catalog.skills).map_err(Into::into)
        }
    }
}

fn catalog_key(cwd: Option<&str>) -> String {
    cwd.unwrap_or(DEFAULT_CATALOG_KEY).to_string()
}

fn input_needs_skill_resolution(input: &[UserInput]) -> bool {
    input.iter().any(|item| match item {
        UserInput::Skill { .. } => true,
        UserInput::Text { text, .. } => !extract_skill_token_names(text).is_empty(),
        _ => false,
    })
}

fn build_resolved_input(
    input: &[UserInput],
    skills: &[SkillMetadata],
) -> Result<ResolvedTurnInput, ResolveSkillError> {
    let enabled: Vec<&SkillMetadata> = skills.iter().filter(|skill| skill.enabled).collect();
    let mut resolved = Vec::new();
    let mut resolved_skills = Vec::new();
    let mut seen_paths = HashSet::new();
    let mut seen_names = HashSet::new();

    for item in input {
        if let UserInput::Skill { name, path } = item {
            let Some(skill) = enabled.iter().copied().find(|skill| skill.path == *path) else {
                return Err(ResolveSkillError::SelectedSkillMissing {
                    name: name.clone(),
                    path: path.clone(),
                });
            };
            if seen_paths.insert(skill.path.clone()) {
                seen_names.insert(skill.name.clone());
                resolved_skills.push(skill.clone());
                resolved.push(skill_input(skill));
            }
        }
    }

    for item in input {
        match item {
            UserInput::Skill { .. } => {}
            UserInput::Text { text, .. } => {
                for name in extract_skill_token_names(text) {
                    if seen_names.contains(&name) {
                        continue;
                    }
                    let matches = enabled
                        .iter()
                        .copied()
                        .filter(|skill| skill.name == name)
                        .collect::<Vec<_>>();
                    let [skill] = matches.as_slice() else {
                        continue;
                    };
                    if seen_paths.insert(skill.path.clone()) {
                        seen_names.insert(skill.name.clone());
                        resolved_skills.push((*skill).clone());
                        resolved.push(skill_input(skill));
                    }
                }
            }
            _ => {}
        }
    }

    let mut output: Vec<UserInput> = input
        .iter()
        .filter(|item| !matches!(item, UserInput::Skill { .. }))
        .cloned()
        .collect();
    output.extend(resolved);
    Ok(ResolvedTurnInput {
        input: output,
        skills: resolved_skills,
    })
}

fn skill_input(skill: &SkillMetadata) -> UserInput {
    UserInput::Skill {
        name: skill.name.clone(),
        path: skill.path.clone(),
    }
}

fn extract_skill_token_names(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut names = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'$' {
            index += 1;
            continue;
        }
        let name_start = index + 1;
        let Some(first) = bytes.get(name_start) else {
            index += 1;
            continue;
        };
        if !is_mention_name_char(*first) {
            index += 1;
            continue;
        }
        let mut name_end = name_start + 1;
        while bytes
            .get(name_end)
            .is_some_and(|next| is_mention_name_char(*next))
        {
            name_end += 1;
        }
        let name = &text[name_start..name_end];
        if !is_common_env_var(name) {
            names.push(name.to_string());
        }
        index = name_end;
    }
    names
}

fn is_mention_name_char(byte: u8) -> bool {
    matches!(byte, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_' | b'-' | b':')
}

fn is_common_env_var(name: &str) -> bool {
    matches!(
        name.to_ascii_uppercase().as_str(),
        "PATH"
            | "HOME"
            | "USER"
            | "SHELL"
            | "PWD"
            | "TMPDIR"
            | "TEMP"
            | "TMP"
            | "LANG"
            | "TERM"
            | "XDG_CONFIG_HOME"
    )
}

#[derive(Debug)]
enum ResolveSkillError {
    SelectedSkillMissing { name: String, path: String },
}

impl From<ResolveSkillError> for ApiError {
    fn from(error: ResolveSkillError) -> Self {
        match error {
            ResolveSkillError::SelectedSkillMissing { name, path } => ApiError::BadRequest(
                format!("Skill \"{name}\" is no longer available for this thread cwd ({path})"),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::VecDeque,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex as StdMutex,
        },
    };

    use async_trait::async_trait;
    use serde_json::{json, Value};
    use tokio::sync::Notify;

    use crate::app_server::AppServer;

    fn skill(name: &str, path: &str, enabled: bool) -> SkillMetadata {
        SkillMetadata {
            name: name.to_string(),
            path: path.to_string(),
            description: format!("{name} description"),
            enabled,
            scope: "user".to_string(),
            short_description: None,
            interface: None,
        }
    }

    struct BlockingSkillsAppServer {
        first_request_started: Notify,
        release_first_request: Notify,
        request_count: AtomicUsize,
        requests: StdMutex<Vec<(String, Value)>>,
        responses: StdMutex<VecDeque<Value>>,
    }

    impl BlockingSkillsAppServer {
        fn new(responses: Vec<Value>) -> Self {
            Self {
                first_request_started: Notify::new(),
                release_first_request: Notify::new(),
                request_count: AtomicUsize::new(0),
                requests: StdMutex::new(Vec::new()),
                responses: StdMutex::new(responses.into()),
            }
        }
    }

    #[async_trait]
    impl AppServer for BlockingSkillsAppServer {
        fn is_ready(&self) -> bool {
            true
        }

        fn readiness_error(&self) -> Option<String> {
            None
        }

        async fn request(&self, method: &str, params: Value) -> ApiResult<Value> {
            self.requests
                .lock()
                .unwrap()
                .push((method.to_string(), params));
            let request_index = self.request_count.fetch_add(1, Ordering::SeqCst);
            if method == "skills/list" && request_index == 0 {
                self.first_request_started.notify_waiters();
                self.release_first_request.notified().await;
            }
            self.responses.lock().unwrap().pop_front().ok_or_else(|| {
                ApiError::BadGateway("test app-server response queue was empty".to_string())
            })
        }

        async fn respond(&self, _request_id: &str, _result: Value) -> ApiResult<()> {
            Ok(())
        }
    }

    fn skills_response(name: &str, path: &str) -> Value {
        json!({
            "data": [{
                "cwd": "/workspace",
                "errors": [],
                "skills": [{
                    "name": name,
                    "path": path,
                    "description": format!("{name} description"),
                    "enabled": true,
                    "scope": "user",
                    "shortDescription": null,
                    "interface": null
                }]
            }]
        })
    }

    #[test]
    fn parses_skill_tokens_and_ignores_common_env_vars() {
        assert_eq!(
            extract_skill_token_names(
                "use $review-fix and $PATH then $_ok and $browser-use:browser"
            ),
            vec![
                "review-fix".to_string(),
                "_ok".to_string(),
                "browser-use:browser".to_string()
            ]
        );
    }

    #[test]
    fn enriches_manual_and_selected_skills_once() {
        let input = vec![
            UserInput::Text {
                text: "Run $review-fix twice $review-fix".to_string(),
                text_elements: Vec::new(),
            },
            UserInput::Skill {
                name: "selected".to_string(),
                path: "/skills/selected/SKILL.md".to_string(),
            },
        ];
        let resolved = build_resolved_input(
            &input,
            &[
                skill("review-fix", "/skills/review-fix/SKILL.md", true),
                skill("selected", "/skills/selected/SKILL.md", true),
            ],
        )
        .unwrap();

        assert_eq!(resolved.input.len(), 3);
        assert!(
            matches!(resolved.input[1], UserInput::Skill { ref name, .. } if name == "selected")
        );
        assert!(
            matches!(resolved.input[2], UserInput::Skill { ref name, .. } if name == "review-fix")
        );
        assert_eq!(
            resolved
                .skills
                .iter()
                .map(|skill| skill.name.as_str())
                .collect::<Vec<_>>(),
            vec!["selected", "review-fix"]
        );
    }

    #[test]
    fn unresolved_manual_skill_stays_plain_text() {
        let input = vec![UserInput::Text {
            text: "Run $missing".to_string(),
            text_elements: Vec::new(),
        }];
        assert_eq!(build_resolved_input(&input, &[]).unwrap().input.len(), 1);
    }

    #[test]
    fn ambiguous_manual_skill_stays_plain_text() {
        let input = vec![UserInput::Text {
            text: "Run $review-fix".to_string(),
            text_elements: Vec::new(),
        }];
        let resolved = build_resolved_input(
            &input,
            &[
                skill("review-fix", "/repo/review-fix/SKILL.md", true),
                skill("review-fix", "/user/review-fix/SKILL.md", true),
            ],
        )
        .unwrap();

        assert_eq!(resolved.input.len(), 1);
    }

    #[test]
    fn stale_selected_skill_is_an_error() {
        let input = vec![UserInput::Skill {
            name: "stale".to_string(),
            path: "/old/SKILL.md".to_string(),
        }];
        assert!(matches!(
            build_resolved_input(&input, &[skill("stale", "/new/SKILL.md", true)]),
            Err(ResolveSkillError::SelectedSkillMissing { .. })
        ));
    }

    #[tokio::test]
    async fn invalidation_during_fetch_discards_stale_catalog_response() {
        let cache = SkillCatalogCache::default();
        let server = Arc::new(BlockingSkillsAppServer::new(vec![
            skills_response("old-skill", "/skills/old/SKILL.md"),
            skills_response("fresh-skill", "/skills/fresh/SKILL.md"),
        ]));
        let app_server: DynAppServer = server.clone();

        let lookup = {
            let cache = cache.clone();
            let app_server = app_server.clone();
            tokio::spawn(async move {
                cache
                    .catalog(&app_server, Some("/workspace".to_string()), false)
                    .await
                    .unwrap()
            })
        };

        server.first_request_started.notified().await;
        cache.invalidate().await;
        server.release_first_request.notify_waiters();

        let catalog = lookup.await.unwrap();
        assert_eq!(catalog.invalidation_generation, 1);
        assert_eq!(catalog.skills[0].name, "fresh-skill");

        let cached = cache
            .catalog(&app_server, Some("/workspace".to_string()), false)
            .await
            .unwrap();
        assert_eq!(cached.skills[0].name, "fresh-skill");
        assert_eq!(server.requests.lock().unwrap().len(), 2);
    }
}
