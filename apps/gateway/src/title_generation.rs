use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::{
    io::AsyncWriteExt,
    process::Command,
    sync::{Mutex as AsyncMutex, OwnedMutexGuard},
    time::timeout,
};
use uuid::Uuid;

use crate::{
    api::AppState,
    app_server_api::{self, UserInput},
    error::{ApiError, ApiResult},
};

const TITLE_MODEL: &str = "gpt-5.4-mini";
const TITLE_REASONING_EFFORT: &str = "medium";
const TITLE_WORKDIR: &str = "/private/tmp";
const TITLE_TIMEOUT: Duration = Duration::from_secs(30);
const TITLE_MAX_CHARS: usize = 80;

#[derive(Clone)]
pub struct TitleGenerationService {
    inner: Arc<TitleGenerationInner>,
}

struct TitleGenerationInner {
    generator: Arc<dyn ThreadTitleGenerator>,
    jobs: StdMutex<HashMap<String, TitleJobState>>,
    name_locks: StdMutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TitleJobState {
    Running,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadTitleRequest {
    pub thread_id: String,
    pub user_request: String,
}

#[async_trait]
pub trait ThreadTitleGenerator: Send + Sync {
    async fn generate_title(&self, request: ThreadTitleRequest) -> ApiResult<Option<String>>;
}

impl TitleGenerationService {
    pub fn enabled() -> Self {
        Self::new(Arc::new(CodexExecThreadTitleGenerator::default()), true)
    }

    pub fn disabled() -> Self {
        Self::new(Arc::new(NoopThreadTitleGenerator), false)
    }

    pub fn with_generator(generator: Arc<dyn ThreadTitleGenerator>) -> Self {
        Self::new(generator, true)
    }

    fn new(generator: Arc<dyn ThreadTitleGenerator>, enabled: bool) -> Self {
        Self {
            inner: Arc::new(TitleGenerationInner {
                generator,
                jobs: StdMutex::new(HashMap::new()),
                name_locks: StdMutex::new(HashMap::new()),
                enabled,
            }),
        }
    }

    pub fn spawn_for_turn_start(
        &self,
        state: AppState,
        thread_id: String,
        input: &[UserInput],
    ) -> bool {
        if !self.inner.enabled {
            return false;
        }
        let Some(user_request) = first_user_text(input) else {
            return false;
        };
        if !self.try_start_job(&thread_id) {
            return false;
        }

        let service = self.clone();
        tokio::spawn(async move {
            let outcome = service
                .run_job(state, thread_id.clone(), user_request)
                .await;
            match outcome {
                Ok(TitleJobOutcome::Set | TitleJobOutcome::SkippedNamedThread) => {
                    service.complete_job(&thread_id);
                }
                Ok(
                    TitleJobOutcome::SkippedCancelled
                    | TitleJobOutcome::SkippedNoTitle
                    | TitleJobOutcome::SkippedNotFirstTurn,
                ) => {
                    service.clear_job(&thread_id);
                }
                Err(error) => {
                    tracing::warn!(thread_id, error = %error, "thread title generation failed");
                    service.clear_job(&thread_id);
                }
            }
        });
        true
    }

    async fn run_job(
        &self,
        state: AppState,
        thread_id: String,
        user_request: String,
    ) -> ApiResult<TitleJobOutcome> {
        let snapshot = thread_title_snapshot(&state, &thread_id).await?;
        if snapshot.has_name {
            return Ok(TitleJobOutcome::SkippedNamedThread);
        }
        if snapshot.turn_count > 1 {
            return Ok(TitleJobOutcome::SkippedNotFirstTurn);
        }

        let request = ThreadTitleRequest {
            thread_id: thread_id.clone(),
            user_request,
        };
        let Some(raw_title) = self.inner.generator.generate_title(request).await? else {
            return Ok(TitleJobOutcome::SkippedNoTitle);
        };
        let Some(title) = normalize_title(&raw_title) else {
            return Ok(TitleJobOutcome::SkippedNoTitle);
        };

        let _name_guard = self.name_write_guard(&thread_id).await;
        let snapshot = thread_title_snapshot(&state, &thread_id).await?;
        if snapshot.has_name {
            return Ok(TitleJobOutcome::SkippedNamedThread);
        }
        if snapshot.turn_count > 1 {
            return Ok(TitleJobOutcome::SkippedNotFirstTurn);
        }
        if !self.is_running(&thread_id) {
            return Ok(TitleJobOutcome::SkippedCancelled);
        }

        app_server_api::client(&state.app_server)
            .thread_set_name(thread_id, title)
            .await?;
        Ok(TitleJobOutcome::Set)
    }

    fn try_start_job(&self, thread_id: &str) -> bool {
        let mut jobs = self.inner.jobs.lock().unwrap();
        if matches!(
            jobs.get(thread_id),
            Some(TitleJobState::Running | TitleJobState::Completed)
        ) {
            return false;
        }
        jobs.insert(thread_id.to_string(), TitleJobState::Running);
        true
    }

    fn complete_job(&self, thread_id: &str) {
        self.inner
            .jobs
            .lock()
            .unwrap()
            .insert(thread_id.to_string(), TitleJobState::Completed);
    }

    pub fn mark_thread_named(&self, thread_id: &str) {
        self.complete_job(thread_id);
    }

    pub async fn name_write_guard(&self, thread_id: &str) -> OwnedMutexGuard<()> {
        let lock = {
            let mut name_locks = self.inner.name_locks.lock().unwrap();
            name_locks
                .entry(thread_id.to_string())
                .or_insert_with(|| Arc::new(AsyncMutex::new(())))
                .clone()
        };
        lock.lock_owned().await
    }

    fn clear_job(&self, thread_id: &str) {
        self.inner.jobs.lock().unwrap().remove(thread_id);
    }

    fn is_running(&self, thread_id: &str) -> bool {
        matches!(
            self.inner.jobs.lock().unwrap().get(thread_id),
            Some(TitleJobState::Running)
        )
    }
}

impl Default for TitleGenerationService {
    fn default() -> Self {
        #[cfg(test)]
        {
            Self::disabled()
        }
        #[cfg(not(test))]
        {
            Self::enabled()
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TitleJobOutcome {
    Set,
    SkippedCancelled,
    SkippedNamedThread,
    SkippedNotFirstTurn,
    SkippedNoTitle,
}

#[derive(Debug, Clone, Copy)]
struct ThreadTitleSnapshot {
    has_name: bool,
    turn_count: usize,
}

async fn thread_title_snapshot(
    state: &AppState,
    thread_id: &str,
) -> ApiResult<ThreadTitleSnapshot> {
    let detail = app_server_api::client(&state.app_server)
        .thread_read(thread_id.to_string())
        .await?;
    Ok(ThreadTitleSnapshot {
        has_name: detail
            .thread
            .name
            .as_deref()
            .map(str::trim)
            .is_some_and(|name| !name.is_empty()),
        turn_count: detail.turns.len(),
    })
}

pub fn first_user_text(input: &[UserInput]) -> Option<String> {
    input.iter().find_map(|item| {
        let UserInput::Text { text, .. } = item else {
            return None;
        };
        let text = text.trim();
        if text.is_empty() {
            None
        } else {
            Some(text.to_string())
        }
    })
}

pub fn normalize_title(title: &str) -> Option<String> {
    let title = title.trim();
    let title = title
        .trim_matches('"')
        .trim_matches('\'')
        .trim_matches('`')
        .trim();
    let title = title.lines().find_map(|line| {
        let line = line.trim();
        if line.is_empty() {
            None
        } else {
            Some(
                line.trim_matches('"')
                    .trim_matches('\'')
                    .trim_matches('`')
                    .trim(),
            )
        }
    })?;
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    let title = title
        .trim_end_matches(['.', '"', '\'', '`'])
        .trim()
        .to_string();
    if title.is_empty() || title.chars().count() > TITLE_MAX_CHARS {
        return None;
    }
    let lower = title.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "new chat" | "untitled" | "thread" | "conversation" | "chat"
    ) {
        return None;
    }
    Some(title)
}

#[derive(Debug, Clone)]
struct CodexExecThreadTitleGenerator {
    binary: String,
    timeout: Duration,
}

impl Default for CodexExecThreadTitleGenerator {
    fn default() -> Self {
        Self {
            binary: "codex".to_string(),
            timeout: TITLE_TIMEOUT,
        }
    }
}

#[async_trait]
impl ThreadTitleGenerator for CodexExecThreadTitleGenerator {
    async fn generate_title(&self, request: ThreadTitleRequest) -> ApiResult<Option<String>> {
        let temp_dir = std::env::temp_dir();
        let id = Uuid::new_v4();
        let schema_path = temp_dir.join(format!("kodex-title-schema-{id}.json"));
        let output_path = temp_dir.join(format!("kodex-title-output-{id}.json"));
        let schema = title_output_schema();
        tokio::fs::write(&schema_path, schema.to_string()).await?;

        let result = self
            .run_codex_exec(&schema_path, &output_path, &title_prompt(&request))
            .await;
        cleanup_temp_file(&schema_path).await;
        cleanup_temp_file(&output_path).await;
        result
    }
}

impl CodexExecThreadTitleGenerator {
    async fn run_codex_exec(
        &self,
        schema_path: &Path,
        output_path: &Path,
        prompt: &str,
    ) -> ApiResult<Option<String>> {
        let args = codex_exec_args(schema_path, output_path);
        let mut child = Command::new(&self.binary)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| {
                ApiError::BadGateway(format!("failed to spawn codex title generator: {error}"))
            })?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(prompt.as_bytes()).await?;
        }

        let status = match timeout(self.timeout, child.wait()).await {
            Ok(status) => status?,
            Err(_) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return Err(ApiError::BadGateway(
                    "codex title generation timed out".to_string(),
                ));
            }
        };
        if !status.success() {
            return Err(ApiError::BadGateway(format!(
                "codex title generation exited with status {status}"
            )));
        }

        let output = tokio::fs::read_to_string(output_path).await?;
        Ok(title_from_model_output(&output))
    }
}

fn codex_exec_args(schema_path: &Path, output_path: &Path) -> Vec<String> {
    vec![
        "exec".to_string(),
        "--ephemeral".to_string(),
        "--ignore-rules".to_string(),
        "--ignore-user-config".to_string(),
        "--skip-git-repo-check".to_string(),
        "--cd".to_string(),
        TITLE_WORKDIR.to_string(),
        "--sandbox".to_string(),
        "read-only".to_string(),
        "-m".to_string(),
        TITLE_MODEL.to_string(),
        "-c".to_string(),
        format!("model_reasoning_effort=\"{TITLE_REASONING_EFFORT}\""),
        "--output-schema".to_string(),
        schema_path.display().to_string(),
        "--output-last-message".to_string(),
        output_path.display().to_string(),
        "-".to_string(),
    ]
}

fn title_prompt(request: &ThreadTitleRequest) -> String {
    format!(
        "Create a succinct title for this user request. Use 2 to 6 words. \
Do not include quotation marks, punctuation at the end, or generic labels.\n\nUser request:\n{}",
        request.user_request
    )
}

fn title_output_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["title"],
        "properties": {
            "title": {
                "type": "string",
                "minLength": 1,
                "maxLength": TITLE_MAX_CHARS
            }
        }
    })
}

fn title_from_model_output(output: &str) -> Option<String> {
    match serde_json::from_str::<Value>(output) {
        Ok(Value::Object(object)) => object
            .get("title")
            .and_then(Value::as_str)
            .and_then(normalize_title),
        Ok(Value::String(title)) => normalize_title(&title),
        _ => normalize_title(output),
    }
}

async fn cleanup_temp_file(path: &PathBuf) {
    if let Err(error) = tokio::fs::remove_file(path).await {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::debug!(path = %path.display(), error = %error, "failed to remove title generation temp file");
        }
    }
}

struct NoopThreadTitleGenerator;

#[async_trait]
impl ThreadTitleGenerator for NoopThreadTitleGenerator {
    async fn generate_title(&self, _request: ThreadTitleRequest) -> ApiResult<Option<String>> {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::{AtomicUsize, Ordering};

    use serde_json::json;

    use crate::{app_server::tests::RecordingAppServer, config::Config, store::Store};

    #[test]
    fn extracts_first_non_empty_text_input() {
        let input = vec![
            UserInput::Image {
                url: "https://example.test/a.png".to_string(),
            },
            UserInput::Text {
                text: "  ".to_string(),
                text_elements: Vec::new(),
            },
            UserInput::Text {
                text: "  build model naming ".to_string(),
                text_elements: Vec::new(),
            },
        ];

        assert_eq!(
            first_user_text(&input).as_deref(),
            Some("build model naming")
        );
    }

    #[test]
    fn normalizes_and_rejects_generated_titles() {
        assert_eq!(
            normalize_title("  \"Implement Naming.\" \n extra").as_deref(),
            Some("Implement Naming")
        );
        assert_eq!(normalize_title("New chat"), None);
        assert_eq!(normalize_title(&"x".repeat(TITLE_MAX_CHARS + 1)), None);
    }

    #[test]
    fn builds_codex_exec_command_for_mini_medium_title_generation() {
        let args = codex_exec_args(Path::new("/tmp/schema.json"), Path::new("/tmp/output.json"));

        assert!(args.windows(2).any(|pair| pair == ["-m", TITLE_MODEL]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-c", "model_reasoning_effort=\"medium\""]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--output-schema", "/tmp/schema.json"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--output-last-message", "/tmp/output.json"]));
        assert!(args.contains(&"--ephemeral".to_string()));
        assert!(args.contains(&"--ignore-user-config".to_string()));
        assert!(args.contains(&"--ignore-rules".to_string()));
        assert!(args.contains(&"--skip-git-repo-check".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("-"));
    }

    #[test]
    fn parses_schema_or_plain_title_output() {
        assert_eq!(
            title_from_model_output(r#"{"title":"Build Review Loop."}"#).as_deref(),
            Some("Build Review Loop")
        );
        assert_eq!(
            title_from_model_output("Implement first turn names").as_deref(),
            Some("Implement first turn names")
        );
    }

    #[tokio::test]
    async fn user_rename_wins_before_generator_runs() {
        let generator = Arc::new(CountingTitleGenerator::new(Some("Generated Name")));
        let service = TitleGenerationService::with_generator(generator.clone());
        let (state, app_server) = test_state_with_service(service.clone()).await;
        app_server.queued_responses.lock().unwrap().push(json!({
            "thread": {
                "id": "thread-1",
                "name": "User Name",
                "cliVersion": "0.130.0",
                "cwd": "/workspace",
                "ephemeral": false,
                "modelProvider": "openai",
                "source": "cli",
                "status": {"type": "idle"},
                "turns": [],
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_600_i64
            }
        }));

        let outcome = service
            .run_job(
                state,
                "thread-1".to_string(),
                "please implement naming".to_string(),
            )
            .await
            .unwrap();

        assert_eq!(outcome, TitleJobOutcome::SkippedNamedThread);
        assert_eq!(generator.calls.load(Ordering::SeqCst), 0);
        let requests = app_server.requests.lock().unwrap();
        assert!(requests
            .iter()
            .all(|(method, _)| method != "thread/name/set"));
    }

    #[tokio::test]
    async fn duplicate_running_jobs_are_suppressed_until_failure_clears_them() {
        let service = TitleGenerationService::with_generator(Arc::new(FailingTitleGenerator));

        assert!(service.try_start_job("thread-1"));
        assert!(!service.try_start_job("thread-1"));
        service.clear_job("thread-1");
        assert!(service.try_start_job("thread-1"));
        service.complete_job("thread-1");
        assert!(!service.try_start_job("thread-1"));
    }

    #[tokio::test]
    async fn failed_spawned_generation_clears_job_for_retry() {
        let generator = Arc::new(CountingFailingTitleGenerator::default());
        let service = TitleGenerationService::with_generator(generator.clone());
        let (state, app_server) = test_state_with_service(service.clone()).await;
        let input = vec![UserInput::Text {
            text: "please title this".to_string(),
            text_elements: Vec::new(),
        }];
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .push(thread_read_response(None, 1));

        assert!(service.spawn_for_turn_start(state.clone(), "thread-1".to_string(), &input));
        wait_for_generator_calls_and_no_job(&service, &generator, 1).await;

        app_server
            .queued_responses
            .lock()
            .unwrap()
            .push(thread_read_response(None, 1));
        assert!(service.spawn_for_turn_start(state, "thread-1".to_string(), &input));
        wait_for_generator_calls_and_no_job(&service, &generator, 2).await;
    }

    #[tokio::test]
    async fn manual_name_claim_under_lock_cancels_generated_name_set() {
        let generator = Arc::new(CountingTitleGenerator::new(Some("Generated Name")));
        let service = TitleGenerationService::with_generator(generator.clone());
        let (state, app_server) = test_state_with_service(service.clone()).await;
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .extend([thread_read_response(None, 1), thread_read_response(None, 1)]);
        assert!(service.try_start_job("thread-1"));
        let manual_guard = service.name_write_guard("thread-1").await;

        let job = tokio::spawn({
            let service = service.clone();
            async move {
                service
                    .run_job(
                        state,
                        "thread-1".to_string(),
                        "please title this".to_string(),
                    )
                    .await
            }
        });
        wait_for_generator_calls(&generator, 1).await;
        service.mark_thread_named("thread-1");
        drop(manual_guard);

        let outcome = job.await.unwrap().unwrap();
        assert_eq!(outcome, TitleJobOutcome::SkippedCancelled);
        let requests = app_server.requests.lock().unwrap();
        assert!(requests
            .iter()
            .all(|(method, _)| method != "thread/name/set"));
    }

    async fn wait_for_generator_calls(generator: &CountingTitleGenerator, expected_calls: usize) {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if generator.calls.load(Ordering::SeqCst) >= expected_calls {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }

    async fn wait_for_generator_calls_and_no_job(
        service: &TitleGenerationService,
        generator: &CountingFailingTitleGenerator,
        expected_calls: usize,
    ) {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let calls = generator.calls.load(Ordering::SeqCst);
                let has_job = service.inner.jobs.lock().unwrap().contains_key("thread-1");
                if calls >= expected_calls && !has_job {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }

    async fn test_state_with_service(
        service: TitleGenerationService,
    ) -> (AppState, Arc<RecordingAppServer>) {
        let store = Store::in_memory().await.unwrap();
        let app_server = Arc::new(RecordingAppServer::default());
        app_server.ready.store(true, Ordering::SeqCst);
        (
            AppState::new(Config::default(), store, app_server.clone())
                .with_title_generation_service(service),
            app_server,
        )
    }

    fn thread_read_response(name: Option<&str>, completed_turns: usize) -> Value {
        let turns = (0..completed_turns)
            .map(|index| {
                json!({
                    "id": format!("turn-{index}"),
                    "status": {"type": "completed"},
                    "items": []
                })
            })
            .collect::<Vec<_>>();
        json!({
            "thread": {
                "id": "thread-1",
                "name": name,
                "cliVersion": "0.130.0",
                "cwd": "/workspace",
                "ephemeral": false,
                "modelProvider": "openai",
                "source": "cli",
                "status": {"type": "idle"},
                "turns": turns,
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_600_i64
            }
        })
    }

    struct CountingTitleGenerator {
        title: Option<String>,
        calls: AtomicUsize,
    }

    impl CountingTitleGenerator {
        fn new(title: Option<&str>) -> Self {
            Self {
                title: title.map(str::to_string),
                calls: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait]
    impl ThreadTitleGenerator for CountingTitleGenerator {
        async fn generate_title(&self, _request: ThreadTitleRequest) -> ApiResult<Option<String>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.title.clone())
        }
    }

    struct FailingTitleGenerator;

    #[async_trait]
    impl ThreadTitleGenerator for FailingTitleGenerator {
        async fn generate_title(&self, _request: ThreadTitleRequest) -> ApiResult<Option<String>> {
            Err(ApiError::BadGateway("title failed".to_string()))
        }
    }

    #[derive(Default)]
    struct CountingFailingTitleGenerator {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl ThreadTitleGenerator for CountingFailingTitleGenerator {
        async fn generate_title(&self, _request: ThreadTitleRequest) -> ApiResult<Option<String>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Err(ApiError::BadGateway("title failed".to_string()))
        }
    }
}
