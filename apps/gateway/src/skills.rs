use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde_json::json;
use tokio::sync::RwLock;

use crate::{
    api::AppState,
    app_server::DynAppServer,
    app_server_api::{self, SkillMetadata, SkillsCatalogResponse},
    error::ApiResult,
    store::NewEvent,
};

pub const SKILLS_CHANGED_EVENT: &str = "skills.changed";

const DEFAULT_CATALOG_KEY: &str = "";

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

fn catalog_key(cwd: Option<&str>) -> String {
    cwd.unwrap_or(DEFAULT_CATALOG_KEY).to_string()
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

    use crate::{app_server::AppServer, error::ApiError};

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
