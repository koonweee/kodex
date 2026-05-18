use std::{
    collections::{HashMap, HashSet},
    path::{Path as FsPath, PathBuf},
};

use axum::{
    extract::{Path, Query, State},
    routing::{get, patch, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use chrono::{Local, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use utoipa::{IntoParams, ToSchema};

use crate::{
    api::AppState,
    app_server_api::{
        self, enrich_timeline_skill_mentions, timeline_skill_mentions_from_text,
        visible_text_from_thread_item, RawAppServerResponse, ThreadCommandResponse,
        ThreadDetailResponse, ThreadItemSnapshot, ThreadListResponse, ThreadLiveState,
        ThreadStatus, ThreadSummary, ThreadViewResponse, TimelineSkillMention,
    },
    error::{ApiError, ApiResult},
    store::{EventEnvelope, NewEvent, ThreadComposerSettings, ThreadRead},
    thread_view,
};

pub const THREAD_PIN_UPDATED_EVENT: &str = "thread.pin_updated";
pub const THREAD_UPSERTED_EVENT: &str = "thread.upserted";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/threads", get(list_threads).post(create_thread))
        .route(
            "/v1/chats/threads",
            get(list_chat_threads).post(create_chat_thread),
        )
        .route("/v1/threads/pinned", get(list_pinned_threads))
        .route("/v1/threads/{thread_id}/subagents", get(list_subagents))
        .route("/v1/threads/{thread_id}", get(get_thread))
        .route("/v1/threads/{thread_id}/name", patch(rename_thread))
        .route("/v1/threads/{thread_id}/resume", post(resume_thread))
        .route("/v1/threads/{thread_id}/fork", post(fork_thread))
        .route("/v1/threads/{thread_id}/archive", post(archive_thread))
        .route(
            "/v1/threads/{thread_id}/pin",
            post(pin_thread).delete(unpin_thread),
        )
        .route("/v1/threads/{thread_id}/seen", post(mark_thread_seen))
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListQuery {
    pub project_id: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateThreadRequest {
    pub project_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approvals_reviewer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<String>,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateChatThreadRequest {
    pub first_message_text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approvals_reviewer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<String>,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Default, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarkThreadSeenRequest {
    #[serde(default)]
    pub seen_completed_agent_turn_seq: Option<i64>,
}

pub type MarkThreadSeenResponse = ThreadRead;

#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RenameThreadRequest {
    pub name: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RenameThreadResponse {
    pub thread: ThreadSummary,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadPinResponse {
    pub thread_id: String,
    pub pinned_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSubagentSummary {
    pub id: String,
    pub parent_thread_id: String,
    pub agent_nickname: Option<String>,
    pub agent_role: Option<String>,
    pub status: ThreadStatus,
    pub live_state: ThreadLiveState,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSubagentListResponse {
    pub subagents: Vec<ThreadSubagentSummary>,
}

#[utoipa::path(get, path = "/v1/threads", params(ThreadListQuery), responses((status = 200, body = ThreadListResponse)))]
pub async fn list_threads(
    State(state): State<AppState>,
    Query(query): Query<ThreadListQuery>,
) -> ApiResult<Json<ThreadListResponse>> {
    let cwd = match query.project_id {
        Some(project_id) => Some(state.store.get_project(&project_id).await?.cwd),
        None => None,
    };

    let mut response = app_server_api::client(&state.app_server)
        .thread_list(cwd, query.cursor, query.limit)
        .await?;
    response
        .threads
        .retain(|thread| !thread_is_archived(thread));
    apply_thread_list_response_state(&state, &mut response).await?;
    Ok(Json(response))
}

#[utoipa::path(post, path = "/v1/threads", request_body = CreateThreadRequest, responses((status = 200, body = ThreadCommandResponse)))]
pub async fn create_thread(
    State(state): State<AppState>,
    Json(request): Json<CreateThreadRequest>,
) -> ApiResult<Json<ThreadCommandResponse>> {
    let project = state.store.get_project(&request.project_id).await?;
    let project_id = project.id.clone();
    let options = ThreadCreationOptions {
        model: request.model,
        effort: request.effort,
        service_tier: request.service_tier,
        approval_policy: request.approval_policy,
        approvals_reviewer: request.approvals_reviewer,
        sandbox: request.sandbox,
        payload: request.payload,
    };
    let payload = create_thread_payload(&options);
    let mut response = app_server_api::client(&state.app_server)
        .thread_start(project.id, project.cwd, payload)
        .await?;
    save_thread_creation_options(&state, &response.thread.id, &options).await?;
    overlay_thread_creation_options(&mut response.thread, &options);
    apply_thread_command_response_state(&state, &mut response).await?;
    broadcast_thread_upserted(
        &state,
        ThreadUpsertScope::Project,
        Some(&project_id),
        &response.thread,
    )
    .await?;
    Ok(Json(response))
}

#[utoipa::path(get, path = "/v1/chats/threads", responses((status = 200, body = ThreadListResponse)))]
pub async fn list_chat_threads(
    State(state): State<AppState>,
) -> ApiResult<Json<ThreadListResponse>> {
    let Some(chat_root) = canonical_chat_root(&state.config.projects.home_dir)? else {
        return Ok(Json(empty_thread_list_response()));
    };
    let chat_cwds = chat_thread_cwd_candidates(&chat_root)?;
    if chat_cwds.is_empty() {
        return Ok(Json(empty_thread_list_response()));
    }
    let mut response = list_all_chat_threads(&state, chat_cwds).await?;
    response
        .threads
        .retain(|thread| thread_is_under_canonical_root(thread, &chat_root));
    response
        .threads
        .retain(|thread| !thread_is_archived(thread));
    response.next_cursor = None;
    apply_thread_list_response_state(&state, &mut response).await?;
    Ok(Json(response))
}

#[utoipa::path(get, path = "/v1/threads/pinned", responses((status = 200, body = ThreadListResponse)))]
pub async fn list_pinned_threads(
    State(state): State<AppState>,
) -> ApiResult<Json<ThreadListResponse>> {
    let client = app_server_api::client(&state.app_server);
    let mut threads = Vec::new();
    for pin in state.store.list_thread_pins().await? {
        let detail = match client.thread_read(pin.thread_id.clone()).await {
            Ok(detail) => detail,
            Err(ApiError::NotFound(_)) => continue,
            Err(error) if app_server_error_mentions_missing_thread(&error) => {
                state.store.unpin_thread(&pin.thread_id).await?;
                broadcast_thread_pin_update(&state, &pin.thread_id, None).await?;
                continue;
            }
            Err(error) => return Err(error),
        };
        if thread_is_archived(&detail.thread) {
            continue;
        }
        threads.push(detail.thread);
    }
    let mut response = ThreadListResponse {
        raw_payload: json!({
            "data": threads.iter().map(|thread| thread.raw_payload.clone()).collect::<Vec<_>>(),
            "nextCursor": null,
            "backwardsCursor": null,
        }),
        threads,
        next_cursor: None,
        backwards_cursor: None,
    };
    apply_thread_list_response_state(&state, &mut response).await?;
    Ok(Json(response))
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/pin", responses((status = 200, body = ThreadPinResponse)))]
pub async fn pin_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> ApiResult<Json<ThreadPinResponse>> {
    let pin = state.store.pin_thread(&thread_id).await?;
    broadcast_thread_pin_update(&state, &thread_id, Some(pin.pinned_at)).await?;
    Ok(Json(ThreadPinResponse {
        thread_id,
        pinned_at: Some(pin.pinned_at),
    }))
}

#[utoipa::path(delete, path = "/v1/threads/{threadId}/pin", responses((status = 200, body = ThreadPinResponse)))]
pub async fn unpin_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> ApiResult<Json<ThreadPinResponse>> {
    state.store.unpin_thread(&thread_id).await?;
    broadcast_thread_pin_update(&state, &thread_id, None).await?;
    Ok(Json(ThreadPinResponse {
        thread_id,
        pinned_at: None,
    }))
}

#[utoipa::path(post, path = "/v1/chats/threads", request_body = CreateChatThreadRequest, responses((status = 200, body = ThreadCommandResponse)))]
pub async fn create_chat_thread(
    State(state): State<AppState>,
    Json(request): Json<CreateChatThreadRequest>,
) -> ApiResult<Json<ThreadCommandResponse>> {
    let cwd = dated_chat_cwd(
        &state.config.projects.home_dir,
        &request.first_message_text,
        Local::now().date_naive(),
    )?;
    let options = ThreadCreationOptions {
        model: request.model,
        effort: request.effort,
        service_tier: request.service_tier,
        approval_policy: request.approval_policy,
        approvals_reviewer: request.approvals_reviewer,
        sandbox: request.sandbox,
        payload: request.payload,
    };
    let payload = create_thread_payload(&options);
    let mut response = app_server_api::client(&state.app_server)
        .thread_start_in_cwd(cwd, payload)
        .await?;
    save_thread_creation_options(&state, &response.thread.id, &options).await?;
    overlay_thread_creation_options(&mut response.thread, &options);
    apply_thread_command_response_state(&state, &mut response).await?;
    broadcast_thread_upserted(&state, ThreadUpsertScope::Chat, None, &response.thread).await?;
    Ok(Json(response))
}

pub(crate) struct ThreadCreationOptions {
    pub(crate) model: Option<String>,
    pub(crate) effort: Option<String>,
    pub(crate) service_tier: Option<String>,
    pub(crate) approval_policy: Option<String>,
    pub(crate) approvals_reviewer: Option<String>,
    pub(crate) sandbox: Option<String>,
    pub(crate) payload: Value,
}

pub(crate) fn create_thread_payload(options: &ThreadCreationOptions) -> Value {
    let mut payload = options.payload.clone();
    if let Some(object) = payload.as_object_mut() {
        object.remove("effort");
        object.remove("reasoningEffort");
    }
    if let Some(model) = options.model.as_ref() {
        payload["model"] = Value::String(model.clone());
    }
    if let Some(service_tier) = options.service_tier.as_ref() {
        payload["serviceTier"] = Value::String(service_tier.clone());
    }
    if let Some(approval_policy) = options.approval_policy.as_ref() {
        payload["approvalPolicy"] = Value::String(approval_policy.clone());
    }
    if let Some(approvals_reviewer) = options.approvals_reviewer.as_ref() {
        payload["approvalsReviewer"] = Value::String(approvals_reviewer.clone());
    }
    if let Some(sandbox) = options.sandbox.as_ref() {
        payload["sandbox"] = Value::String(sandbox.clone());
    }
    payload
}

pub(crate) fn overlay_thread_creation_options(
    thread: &mut ThreadSummary,
    options: &ThreadCreationOptions,
) {
    if thread.model.is_none() {
        thread.model = options.model.clone();
    }
    if thread.reasoning_effort.is_none() {
        thread.reasoning_effort = options.effort.clone();
    }
    if thread.service_tier.is_none() {
        thread.service_tier = options.service_tier.clone();
    }
    if thread.approval_policy.is_none() {
        thread.approval_policy = options.approval_policy.clone();
    }
    if thread.approvals_reviewer.is_none() {
        thread.approvals_reviewer = options.approvals_reviewer.clone();
    }
    if thread.sandbox.is_none() {
        thread.sandbox = options
            .sandbox
            .as_ref()
            .map(|sandbox| Value::String(sandbox.clone()));
    }
}

pub(crate) async fn save_thread_creation_options(
    state: &AppState,
    thread_id: &str,
    options: &ThreadCreationOptions,
) -> ApiResult<()> {
    let settings = ThreadComposerSettings {
        model: options.model.clone(),
        reasoning_effort: options.effort.clone(),
        service_tier: options.service_tier.clone(),
        approval_policy: options.approval_policy.clone(),
        approvals_reviewer: options.approvals_reviewer.clone(),
        sandbox: options
            .sandbox
            .as_ref()
            .map(|sandbox| Value::String(sandbox.clone())),
    };
    if !settings.has_any_setting() {
        return Ok(());
    }

    state
        .store
        .save_thread_composer_settings(thread_id, &settings)
        .await
}

fn dated_chat_cwd(
    home_dir: &FsPath,
    first_message_text: &str,
    date: NaiveDate,
) -> ApiResult<String> {
    let date_dir = chat_root(home_dir).join(date.format("%Y-%m-%d").to_string());
    std::fs::create_dir_all(&date_dir).map_err(|_| {
        crate::error::ApiError::BadRequest("chat directory could not be created".to_string())
    })?;
    create_unique_chat_cwd(&date_dir, first_message_text)
}

fn chat_root(home_dir: &FsPath) -> PathBuf {
    home_dir.join("Documents").join("Codex")
}

fn canonical_chat_root(home_dir: &FsPath) -> ApiResult<Option<PathBuf>> {
    match std::fs::canonicalize(chat_root(home_dir)) {
        Ok(path) => Ok(Some(path)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(crate::error::ApiError::BadRequest(
            "chat directory could not be read".to_string(),
        )),
    }
}

fn chat_thread_cwd_candidates(chat_root: &FsPath) -> ApiResult<Vec<String>> {
    let mut candidates = Vec::new();
    for entry in std::fs::read_dir(chat_root).map_err(|_| {
        crate::error::ApiError::BadRequest("chat directory could not be read".to_string())
    })? {
        let entry = entry.map_err(|_| {
            crate::error::ApiError::BadRequest("chat directory could not be read".to_string())
        })?;
        if !entry
            .file_type()
            .map(|file_type| file_type.is_dir())
            .unwrap_or(false)
        {
            continue;
        }

        let date_dir = entry.path();
        push_canonical_chat_cwd(&mut candidates, &date_dir)?;
        for child in std::fs::read_dir(&date_dir).map_err(|_| {
            crate::error::ApiError::BadRequest("chat directory could not be read".to_string())
        })? {
            let child = child.map_err(|_| {
                crate::error::ApiError::BadRequest("chat directory could not be read".to_string())
            })?;
            if child
                .file_type()
                .map(|file_type| file_type.is_dir())
                .unwrap_or(false)
            {
                push_canonical_chat_cwd(&mut candidates, &child.path())?;
            }
        }
    }
    candidates.sort();
    candidates.dedup();
    Ok(candidates)
}

fn push_canonical_chat_cwd(candidates: &mut Vec<String>, path: &FsPath) -> ApiResult<()> {
    let path = std::fs::canonicalize(path).map_err(|_| {
        crate::error::ApiError::BadRequest("chat directory could not be read".to_string())
    })?;
    candidates.push(path.to_string_lossy().to_string());
    Ok(())
}

async fn list_all_chat_threads(
    state: &AppState,
    chat_cwds: Vec<String>,
) -> ApiResult<ThreadListResponse> {
    let client = app_server_api::client(&state.app_server);
    let mut response = client
        .thread_list_cwds_updated(chat_cwds.clone(), None, Some(100))
        .await?;
    let mut cursor = response.next_cursor.clone();
    while let Some(next_cursor) = cursor {
        let mut next_page = client
            .thread_list_cwds_updated(chat_cwds.clone(), Some(next_cursor), Some(100))
            .await?;
        response.threads.append(&mut next_page.threads);
        cursor = next_page.next_cursor;
    }
    response.next_cursor = None;
    Ok(response)
}

fn empty_thread_list_response() -> ThreadListResponse {
    ThreadListResponse {
        threads: Vec::new(),
        next_cursor: None,
        backwards_cursor: None,
        raw_payload: json!({"data": [], "nextCursor": null, "backwardsCursor": null}),
    }
}

fn thread_is_under_canonical_root(thread: &ThreadSummary, chat_root: &FsPath) -> bool {
    let cwd = FsPath::new(&thread.cwd);
    let cwd = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    cwd.starts_with(chat_root)
}

fn create_unique_chat_cwd(date_dir: &FsPath, first_message_text: &str) -> ApiResult<String> {
    const MAX_SLUG_LEN: usize = 80;

    let base_slug = chat_slug(first_message_text, MAX_SLUG_LEN);
    for index in 1.. {
        let candidate = chat_cwd_candidate(date_dir, &base_slug, index, MAX_SLUG_LEN);
        match std::fs::create_dir(&candidate) {
            Ok(()) => {
                return std::fs::canonicalize(candidate)
                    .map(|path| path.to_string_lossy().to_string())
                    .map_err(|_| {
                        crate::error::ApiError::BadRequest(
                            "chat directory could not be created".to_string(),
                        )
                    });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => {
                return Err(crate::error::ApiError::BadRequest(
                    "chat directory could not be created".to_string(),
                ));
            }
        }
    }
    unreachable!("unbounded duplicate suffix search always returns a candidate")
}

#[cfg(test)]
fn unique_chat_cwd(date_dir: &FsPath, first_message_text: &str) -> PathBuf {
    const MAX_SLUG_LEN: usize = 80;

    let base_slug = chat_slug(first_message_text, MAX_SLUG_LEN);
    for index in 1.. {
        let candidate = chat_cwd_candidate(date_dir, &base_slug, index, MAX_SLUG_LEN);
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!("unbounded duplicate suffix search always returns a candidate")
}

fn chat_cwd_candidate(
    date_dir: &FsPath,
    base_slug: &str,
    index: usize,
    max_slug_len: usize,
) -> PathBuf {
    let suffix = if index == 1 {
        String::new()
    } else {
        format!("-{index}")
    };
    let candidate_base_len = max_slug_len.saturating_sub(suffix.len());
    let candidate_slug = format!("{}{}", truncate_slug(base_slug, candidate_base_len), suffix);
    date_dir.join(candidate_slug)
}

fn chat_slug(first_message_text: &str, max_len: usize) -> String {
    let mut slug = String::new();
    let mut last_was_separator = true;
    for character in first_message_text.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
            last_was_separator = false;
        } else if !last_was_separator {
            slug.push('-');
            last_was_separator = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        return "untitled-chat".to_string();
    }
    truncate_slug(&slug, max_len)
}

fn truncate_slug(slug: &str, max_len: usize) -> String {
    let mut truncated = slug.chars().take(max_len).collect::<String>();
    while truncated.ends_with('-') {
        truncated.pop();
    }
    if truncated.is_empty() {
        "untitled-chat".to_string()
    } else {
        truncated
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::BTreeSet,
        sync::{Arc, Barrier},
        thread,
    };

    #[test]
    fn chat_slug_normalizes_text_for_folder_names() {
        assert_eq!(
            chat_slug(" Build the Chat Sidebar! ", 80),
            "build-the-chat-sidebar"
        );
        assert_eq!(chat_slug("!!!", 80), "untitled-chat");
        assert_eq!(chat_slug("a---b   c", 80), "a-b-c");
    }

    #[test]
    fn unique_chat_cwd_caps_slug_and_adds_duplicate_suffixes() {
        let date_dir = tempfile::tempdir().unwrap();
        let long_text = format!("{} duplicate", "a".repeat(120));
        let first = unique_chat_cwd(date_dir.path(), &long_text);
        assert_eq!(first.file_name().unwrap().to_string_lossy().len(), 80);
        std::fs::create_dir(&first).unwrap();

        let second = unique_chat_cwd(date_dir.path(), &long_text);
        let second_name = second.file_name().unwrap().to_string_lossy();
        assert_eq!(second_name.len(), 80);
        assert!(second_name.ends_with("-2"));
    }

    #[test]
    fn create_unique_chat_cwd_retries_duplicate_suffixes_concurrently() {
        let temp_dir = tempfile::tempdir().unwrap();
        let date_dir = Arc::new(temp_dir.path().to_path_buf());
        let barrier = Arc::new(Barrier::new(8));
        let handles = (0..8)
            .map(|_| {
                let date_dir = Arc::clone(&date_dir);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    create_unique_chat_cwd(&date_dir, "Build the Chat Sidebar").unwrap()
                })
            })
            .collect::<Vec<_>>();

        let names = handles
            .into_iter()
            .map(|handle| {
                let cwd = PathBuf::from(handle.join().unwrap());
                assert!(cwd.is_dir());
                cwd.file_name().unwrap().to_string_lossy().to_string()
            })
            .collect::<BTreeSet<_>>();

        assert_eq!(names.len(), 8);
        for index in 1..=8 {
            let suffix = if index == 1 {
                String::new()
            } else {
                format!("-{index}")
            };
            assert!(names.contains(&format!("build-the-chat-sidebar{suffix}")));
        }
    }
}

#[utoipa::path(get, path = "/v1/threads/{threadId}", responses((status = 200, body = ThreadViewResponse)))]
pub async fn get_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> ApiResult<Json<ThreadViewResponse>> {
    let timeline_revision = state.store.latest_event_seq().await?;
    let mut response = app_server_api::client(&state.app_server)
        .thread_read_full_history(thread_id)
        .await?;
    apply_thread_detail_response_state(&state, &mut response, timeline_revision).await?;
    Ok(Json(ThreadViewResponse::from_detail(response)))
}

#[utoipa::path(patch, path = "/v1/threads/{threadId}/name", request_body = RenameThreadRequest, responses((status = 200, body = RenameThreadResponse)))]
pub async fn rename_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<RenameThreadRequest>,
) -> ApiResult<Json<RenameThreadResponse>> {
    let name = normalize_thread_name(&request.name)
        .ok_or_else(|| ApiError::BadRequest("thread name cannot be empty".to_string()))?;
    let client = app_server_api::client(&state.app_server);
    client.thread_set_name(thread_id.clone(), name).await?;
    let mut thread = client.thread_read_summary(thread_id).await?;
    apply_thread_summary_state(&state, std::slice::from_mut(&mut thread)).await?;
    Ok(Json(RenameThreadResponse { thread }))
}

#[utoipa::path(get, path = "/v1/threads/{threadId}/subagents", responses((status = 200, body = ThreadSubagentListResponse)))]
pub async fn list_subagents(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> ApiResult<Json<ThreadSubagentListResponse>> {
    let client = app_server_api::client(&state.app_server);
    let loaded = client.thread_loaded_list().await?;
    let mut threads = Vec::new();
    let mut attempted_thread_reads = 0;
    let mut read_failures = 0;
    for loaded_thread_id in loaded.thread_ids {
        if loaded_thread_id == thread_id {
            continue;
        }
        attempted_thread_reads += 1;
        match client.thread_read_summary(loaded_thread_id.clone()).await {
            Ok(thread) => threads.push(thread),
            Err(error) => {
                read_failures += 1;
                tracing::warn!(
                    thread_id = loaded_thread_id,
                    %error,
                    "failed to read loaded thread during subagent discovery"
                );
            }
        }
    }
    if attempted_thread_reads > 0 && read_failures == attempted_thread_reads {
        return Err(ApiError::BadGateway(
            "failed to read any loaded thread during subagent discovery".to_string(),
        ));
    }

    Ok(Json(ThreadSubagentListResponse {
        subagents: loaded_descendant_subagents(&thread_id, threads),
    }))
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/resume", responses((status = 200, body = ThreadViewResponse)))]
pub async fn resume_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(payload): Json<Value>,
) -> ApiResult<Json<ThreadViewResponse>> {
    let mut response = app_server_api::client(&state.app_server)
        .thread_resume(thread_id.clone(), payload)
        .await?;
    apply_thread_command_response_state(&state, &mut response).await?;
    let detail = thread_view_response(&state, &thread_id).await?;
    Ok(Json(detail))
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/fork", responses((status = 200, body = ThreadCommandResponse)))]
pub async fn fork_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(payload): Json<Value>,
) -> ApiResult<Json<ThreadCommandResponse>> {
    let mut response = app_server_api::client(&state.app_server)
        .thread_fork(thread_id.clone(), payload)
        .await?;
    save_forked_thread_composer_settings(&state, &thread_id, &response.thread.id).await?;
    apply_thread_command_response_state(&state, &mut response).await?;
    Ok(Json(response))
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/archive", responses((status = 200, body = RawAppServerResponse)))]
pub async fn archive_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> ApiResult<Json<RawAppServerResponse>> {
    match app_server_api::client(&state.app_server)
        .thread_archive(thread_id.clone())
        .await
    {
        Ok(response) => Ok(Json(response)),
        Err(error) if app_server_error_mentions_missing_thread(&error) => {
            state.store.unpin_thread(&thread_id).await?;
            broadcast_thread_pin_update(&state, &thread_id, None).await?;
            Ok(Json(RawAppServerResponse {
                payload: json!({
                    "threadId": thread_id,
                    "archived": true,
                    "stale": true,
                }),
            }))
        }
        Err(error) => Err(error),
    }
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/seen", request_body = MarkThreadSeenRequest, responses((status = 200, body = MarkThreadSeenResponse)))]
pub async fn mark_thread_seen(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    request: Option<Json<MarkThreadSeenRequest>>,
) -> ApiResult<Json<MarkThreadSeenResponse>> {
    let request = request.map(|Json(request)| request).unwrap_or_default();
    let snapshot = app_server_api::client(&state.app_server)
        .thread_read(thread_id.clone())
        .await?;
    let last_completed_agent_turn_seq = snapshot.thread.last_completed_agent_turn_seq.unwrap_or(0);
    let requested_seen_seq = request
        .seen_completed_agent_turn_seq
        .unwrap_or(last_completed_agent_turn_seq)
        .max(0);
    let seen_seq = requested_seen_seq.min(last_completed_agent_turn_seq);
    Ok(Json(
        state
            .store
            .mark_thread_seen_completed_agent_turns(&thread_id, seen_seq)
            .await?,
    ))
}

fn loaded_descendant_subagents(
    parent_thread_id: &str,
    threads: Vec<ThreadSummary>,
) -> Vec<ThreadSubagentSummary> {
    let mut included_thread_ids = HashSet::new();
    let mut parent_ids = HashSet::from([parent_thread_id.to_string()]);
    let mut subagents = Vec::new();

    loop {
        let mut changed = false;
        for thread in &threads {
            if included_thread_ids.contains(&thread.id) {
                continue;
            }
            let Some(source_parent_thread_id) = subagent_parent_thread_id(&thread.raw_payload)
            else {
                continue;
            };
            if !parent_ids.contains(&source_parent_thread_id) {
                continue;
            }
            included_thread_ids.insert(thread.id.clone());
            parent_ids.insert(thread.id.clone());
            subagents.push((
                thread.created_at,
                thread.id.clone(),
                source_parent_thread_id,
            ));
            changed = true;
        }
        if !changed {
            break;
        }
    }

    subagents.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    subagents
        .into_iter()
        .filter_map(|(_, thread_id, source_parent_thread_id)| {
            let thread = threads.iter().find(|thread| thread.id == thread_id)?;
            Some(ThreadSubagentSummary {
                id: thread.id.clone(),
                parent_thread_id: source_parent_thread_id,
                agent_nickname: thread.agent_nickname.clone(),
                agent_role: thread.agent_role.clone(),
                status: thread.status,
                live_state: live_state_for_thread_status(thread.status),
                updated_at: thread.updated_at,
            })
        })
        .collect()
}

fn subagent_parent_thread_id(payload: &Value) -> Option<String> {
    payload
        .get("source")?
        .get("subAgent")?
        .get("thread_spawn")
        .or_else(|| payload.get("source")?.get("subAgent")?.get("threadSpawn"))?
        .get("parent_thread_id")
        .or_else(|| {
            payload
                .get("source")?
                .get("subAgent")?
                .get("thread_spawn")
                .or_else(|| payload.get("source")?.get("subAgent")?.get("threadSpawn"))?
                .get("parentThreadId")
        })?
        .as_str()
        .map(str::to_string)
}

fn live_state_for_thread_status(status: ThreadStatus) -> ThreadLiveState {
    match status {
        ThreadStatus::Active => ThreadLiveState::Streaming,
        ThreadStatus::Idle | ThreadStatus::SystemError => ThreadLiveState::Idle,
        ThreadStatus::NotLoaded => ThreadLiveState::NotLoaded,
    }
}

async fn apply_thread_list_response_state(
    state: &AppState,
    response: &mut ThreadListResponse,
) -> ApiResult<()> {
    apply_thread_summary_state(state, &mut response.threads).await?;
    sync_thread_list_raw_payload(response);
    Ok(())
}

pub(crate) async fn apply_thread_command_response_state(
    state: &AppState,
    response: &mut ThreadCommandResponse,
) -> ApiResult<()> {
    apply_thread_summary_state(state, std::slice::from_mut(&mut response.thread)).await?;
    sync_thread_command_response(response);
    Ok(())
}

async fn thread_view_response(state: &AppState, thread_id: &str) -> ApiResult<ThreadViewResponse> {
    let timeline_revision = state.store.latest_event_seq().await?;
    let mut detail = app_server_api::client(&state.app_server)
        .thread_read_full_history(thread_id.to_string())
        .await?;
    apply_thread_detail_response_state(state, &mut detail, timeline_revision).await?;
    Ok(ThreadViewResponse::from_detail(detail))
}

async fn apply_thread_detail_response_state(
    state: &AppState,
    response: &mut ThreadDetailResponse,
    timeline_revision: i64,
) -> ApiResult<()> {
    apply_thread_summary_state(state, std::slice::from_mut(&mut response.thread)).await?;
    apply_thread_detail_skill_mentions(state, response).await?;
    let timeline = thread_view::build_thread_timeline(
        &state.thread_views,
        &response.thread.id,
        &response.turns,
        timeline_revision,
    )
    .await?;
    let pending_approvals = state
        .store
        .list_approvals(
            Some("pending".to_string()),
            Some(response.thread.id.clone()),
        )
        .await?;
    response.timeline = thread_view::record_pending_requests(
        &state.thread_views,
        &response.thread.id,
        &pending_approvals,
        timeline.view_revision,
    )
    .await?;
    response.live_state = response.timeline.live_state;
    sync_raw_response_thread(&mut response.raw_payload, &response.thread);
    Ok(())
}

async fn apply_thread_detail_skill_mentions(
    state: &AppState,
    response: &mut ThreadDetailResponse,
) -> ApiResult<()> {
    let thread_id = response.thread.id.clone();
    let item_ids = response
        .turns
        .iter()
        .flat_map(|turn| turn.items.iter())
        .map(|item| item.id.clone())
        .collect::<Vec<_>>();
    let mut stored = state
        .store
        .timeline_skill_mentions_for_items(&thread_id, &item_ids)
        .await?;
    let has_snapshot_skill_mentions = response
        .turns
        .iter()
        .flat_map(|turn| turn.items.iter())
        .any(|item| !item.skill_mentions.is_empty());
    let has_stored_skill_mentions = stored.values().any(|mentions| !mentions.is_empty());
    let has_skill_text = response
        .turns
        .iter()
        .flat_map(|turn| turn.items.iter())
        .any(|item| {
            visible_text_from_thread_item(&item.raw_payload).is_some_and(|text| text.contains('$'))
        });
    let catalog = if has_snapshot_skill_mentions || has_stored_skill_mentions || has_skill_text {
        state
            .skills
            .catalog(&state.app_server, Some(response.thread.cwd.clone()), false)
            .await
            .ok()
    } else {
        None
    };
    for turn in &mut response.turns {
        for item in &mut turn.items {
            apply_thread_item_skill_mentions(
                state,
                &thread_id,
                item,
                &mut stored,
                catalog.as_ref().map(|catalog| catalog.skills.as_slice()),
            )
            .await?;
        }
    }
    Ok(())
}

async fn apply_thread_item_skill_mentions(
    state: &AppState,
    thread_id: &str,
    item: &mut ThreadItemSnapshot,
    stored: &mut HashMap<String, Vec<TimelineSkillMention>>,
    catalog: Option<&[app_server_api::SkillMetadata]>,
) -> ApiResult<()> {
    if !item.skill_mentions.is_empty() {
        item.skill_mentions = enrich_timeline_skill_mentions(
            std::mem::take(&mut item.skill_mentions),
            catalog.unwrap_or(&[]),
        );
        state
            .store
            .upsert_timeline_skill_mentions(thread_id, &item.id, &item.skill_mentions)
            .await?;
        return Ok(());
    }
    if let Some(mentions) = stored.remove(&item.id) {
        item.skill_mentions = enrich_timeline_skill_mentions(mentions, catalog.unwrap_or(&[]));
        state
            .store
            .upsert_timeline_skill_mentions(thread_id, &item.id, &item.skill_mentions)
            .await?;
        return Ok(());
    }
    let Some(text) = visible_text_from_thread_item(&item.raw_payload) else {
        return Ok(());
    };
    if let Some(mentions) = state
        .store
        .commit_pending_timeline_skill_mentions(thread_id, &item.id, &text)
        .await?
    {
        item.skill_mentions = mentions;
        return Ok(());
    }
    if let Some(catalog) = catalog {
        item.skill_mentions = timeline_skill_mentions_from_text(&text, catalog);
        if !item.skill_mentions.is_empty() {
            state
                .store
                .upsert_timeline_skill_mentions(thread_id, &item.id, &item.skill_mentions)
                .await?;
        }
    }
    Ok(())
}

async fn apply_thread_summary_state(
    state: &AppState,
    threads: &mut [ThreadSummary],
) -> ApiResult<()> {
    apply_thread_pin_state(state, threads).await?;
    apply_thread_composer_settings(state, threads).await?;
    apply_thread_read_state(state, threads).await
}

fn sync_thread_list_raw_payload(response: &mut ThreadListResponse) {
    let Some(data) = response
        .raw_payload
        .get_mut("data")
        .and_then(Value::as_array_mut)
    else {
        return;
    };

    for thread in &response.threads {
        let Some(raw_thread) = data.iter_mut().find(|raw_thread| {
            raw_thread
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| id == thread.id)
        }) else {
            continue;
        };
        *raw_thread = thread.raw_payload.clone();
    }
}

fn sync_thread_command_response(response: &mut ThreadCommandResponse) {
    response.model = response.thread.model.clone();
    response.reasoning_effort = response.thread.reasoning_effort.clone();
    response.service_tier = response.thread.service_tier.clone();
    response.approval_policy = response.thread.approval_policy.clone();
    response.approvals_reviewer = response.thread.approvals_reviewer.clone();
    response.sandbox = response.thread.sandbox.clone();

    sync_raw_response_thread(&mut response.raw_payload, &response.thread);
    let settings = ThreadComposerSettings {
        model: response.thread.model.clone(),
        reasoning_effort: response.thread.reasoning_effort.clone(),
        service_tier: response.thread.service_tier.clone(),
        approval_policy: response.thread.approval_policy.clone(),
        approvals_reviewer: response.thread.approvals_reviewer.clone(),
        sandbox: response.thread.sandbox.clone(),
    };
    sync_raw_thread_composer_settings(&mut response.raw_payload, &settings);
}

fn normalize_thread_name(name: &str) -> Option<String> {
    let name = name.trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

fn sync_raw_response_thread(raw_payload: &mut Value, thread: &ThreadSummary) {
    let Some(raw_payload) = raw_payload.as_object_mut() else {
        return;
    };
    raw_payload.insert("thread".to_string(), thread.raw_payload.clone());
}

async fn apply_thread_pin_state(state: &AppState, threads: &mut [ThreadSummary]) -> ApiResult<()> {
    if threads.is_empty() {
        return Ok(());
    }

    let thread_ids = threads
        .iter()
        .map(|thread| thread.id.clone())
        .collect::<Vec<_>>();
    let pins = state.store.pinned_at_for_thread_ids(&thread_ids).await?;
    for thread in threads {
        thread.pinned_at = pins.get(&thread.id).copied();
        sync_raw_thread_pin_state(&mut thread.raw_payload, thread.pinned_at);
    }

    Ok(())
}

fn sync_raw_thread_pin_state(raw_payload: &mut Value, pinned_at: Option<DateTime<Utc>>) {
    let Some(raw_payload) = raw_payload.as_object_mut() else {
        return;
    };
    match pinned_at {
        Some(pinned_at) => {
            raw_payload.insert("pinnedAt".to_string(), json!(pinned_at));
        }
        None => {
            raw_payload.insert("pinnedAt".to_string(), Value::Null);
        }
    }
}

async fn apply_thread_composer_settings(
    state: &AppState,
    threads: &mut [ThreadSummary],
) -> ApiResult<()> {
    if threads.is_empty() {
        return Ok(());
    }

    let thread_ids = threads
        .iter()
        .map(|thread| thread.id.clone())
        .collect::<Vec<_>>();
    let settings = state.store.thread_composer_settings(&thread_ids).await?;
    for thread in threads {
        let Some(settings) = settings.get(&thread.id) else {
            continue;
        };
        overlay_stored_thread_composer_settings(thread, settings);
    }

    Ok(())
}

async fn broadcast_thread_pin_update(
    state: &AppState,
    thread_id: &str,
    pinned_at: Option<DateTime<Utc>>,
) -> ApiResult<EventEnvelope> {
    let event = state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: Some(thread_id.to_string()),
            turn_id: None,
            item_id: None,
            kind: THREAD_PIN_UPDATED_EVENT.to_string(),
            codex_method: None,
            payload: json!({
                "threadId": thread_id,
                "pinnedAt": pinned_at,
            }),
        })
        .await?;
    let _ = state.events.send(event.clone());
    Ok(event)
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum ThreadUpsertScope {
    Project,
    Chat,
}

impl ThreadUpsertScope {
    fn as_str(self) -> &'static str {
        match self {
            ThreadUpsertScope::Project => "project",
            ThreadUpsertScope::Chat => "chat",
        }
    }
}

pub(crate) async fn broadcast_thread_upserted(
    state: &AppState,
    scope: ThreadUpsertScope,
    project_id: Option<&str>,
    thread: &ThreadSummary,
) -> ApiResult<EventEnvelope> {
    let event = state
        .store
        .append_event(NewEvent {
            project_id: project_id.map(str::to_string),
            thread_id: Some(thread.id.clone()),
            turn_id: None,
            item_id: None,
            kind: THREAD_UPSERTED_EVENT.to_string(),
            codex_method: None,
            payload: json!({
                "thread": thread,
                "scope": scope.as_str(),
                "projectId": project_id,
            }),
        })
        .await?;
    let _ = state.events.send(event.clone());
    Ok(event)
}

fn overlay_stored_thread_composer_settings(
    thread: &mut ThreadSummary,
    settings: &ThreadComposerSettings,
) {
    let mut overlay = ThreadComposerSettings::default();
    if thread.model.is_none() {
        thread.model = settings.model.clone();
        overlay.model = settings.model.clone();
    }
    if thread.reasoning_effort.is_none() {
        thread.reasoning_effort = settings.reasoning_effort.clone();
        overlay.reasoning_effort = settings.reasoning_effort.clone();
    }
    if thread.service_tier.is_none() {
        thread.service_tier = settings.service_tier.clone();
        overlay.service_tier = settings.service_tier.clone();
    }
    if thread.approval_policy.is_none() {
        thread.approval_policy = settings.approval_policy.clone();
        overlay.approval_policy = settings.approval_policy.clone();
    }
    if thread.approvals_reviewer.is_none() {
        thread.approvals_reviewer = settings.approvals_reviewer.clone();
        overlay.approvals_reviewer = settings.approvals_reviewer.clone();
    }
    if thread.sandbox.is_none() {
        thread.sandbox = settings.sandbox.clone();
        overlay.sandbox = settings.sandbox.clone();
    }
    sync_raw_thread_composer_settings_present(&mut thread.raw_payload, &overlay);
}

fn sync_raw_thread_composer_settings_present(
    raw_payload: &mut Value,
    settings: &ThreadComposerSettings,
) {
    let Some(raw_payload) = raw_payload.as_object_mut() else {
        return;
    };

    sync_raw_optional_string_present(raw_payload, "model", &settings.model);
    sync_raw_optional_string_present(raw_payload, "reasoningEffort", &settings.reasoning_effort);
    sync_raw_optional_string_present(raw_payload, "serviceTier", &settings.service_tier);
    sync_raw_optional_string_present(raw_payload, "approvalPolicy", &settings.approval_policy);
    sync_raw_optional_string_present(
        raw_payload,
        "approvalsReviewer",
        &settings.approvals_reviewer,
    );
    if let Some(sandbox) = settings.sandbox.as_ref() {
        raw_payload.insert("sandbox".to_string(), sandbox.clone());
    }
}

fn sync_raw_thread_composer_settings(raw_payload: &mut Value, settings: &ThreadComposerSettings) {
    let Some(raw_payload) = raw_payload.as_object_mut() else {
        return;
    };

    sync_raw_optional_string(raw_payload, "model", &settings.model);
    sync_raw_optional_string(raw_payload, "reasoningEffort", &settings.reasoning_effort);
    sync_raw_optional_string(raw_payload, "serviceTier", &settings.service_tier);
    sync_raw_optional_string(raw_payload, "approvalPolicy", &settings.approval_policy);
    sync_raw_optional_string(
        raw_payload,
        "approvalsReviewer",
        &settings.approvals_reviewer,
    );
    if let Some(sandbox) = settings.sandbox.as_ref() {
        raw_payload.insert("sandbox".to_string(), sandbox.clone());
    } else {
        raw_payload.remove("sandbox");
    }
}

fn sync_raw_optional_string_present(
    raw_payload: &mut serde_json::Map<String, Value>,
    key: &str,
    value: &Option<String>,
) {
    if let Some(value) = value.as_ref() {
        raw_payload.insert(key.to_string(), Value::String(value.clone()));
    }
}

fn sync_raw_optional_string(
    raw_payload: &mut serde_json::Map<String, Value>,
    key: &str,
    value: &Option<String>,
) {
    if let Some(value) = value.as_ref() {
        raw_payload.insert(key.to_string(), Value::String(value.clone()));
    } else {
        raw_payload.remove(key);
    }
}

fn thread_is_archived(thread: &ThreadSummary) -> bool {
    thread
        .raw_payload
        .get("archived")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn app_server_error_mentions_missing_thread(error: &ApiError) -> bool {
    match error {
        ApiError::BadGateway(message) => message_mentions_missing_thread(message),
        _ => false,
    }
}

fn message_mentions_missing_thread(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    (message.contains("thread")
        && (message.contains("not found")
            || message.contains("no such")
            || message.contains("does not exist")
            || message.contains("unknown")))
        || message.contains("no rollout found for thread id")
}

async fn save_forked_thread_composer_settings(
    state: &AppState,
    source_thread_id: &str,
    forked_thread_id: &str,
) -> ApiResult<()> {
    if source_thread_id == forked_thread_id {
        return Ok(());
    }

    let source_ids = vec![source_thread_id.to_string()];
    if let Some(settings) = state
        .store
        .thread_composer_settings(&source_ids)
        .await?
        .remove(source_thread_id)
    {
        state
            .store
            .save_thread_composer_settings(forked_thread_id, &settings)
            .await?;
    }

    Ok(())
}

async fn apply_thread_read_state(state: &AppState, threads: &mut [ThreadSummary]) -> ApiResult<()> {
    let thread_ids = threads
        .iter()
        .map(|thread| thread.id.clone())
        .collect::<Vec<_>>();
    let read_states = state.store.thread_read_states(&thread_ids).await?;

    for thread in threads {
        let read_state = read_states.get(&thread.id);
        thread.apply_completed_agent_turn_read_state(
            thread.last_completed_agent_turn_seq,
            read_state
                .map(|state| state.seen_completed_agent_turn_seq)
                .unwrap_or(0),
        );
    }

    Ok(())
}
