use std::path::{Path as FsPath, PathBuf};

use axum::{
    extract::{Path, Query, State},
    routing::{get, post},
    Json, Router,
};
use chrono::{Local, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use utoipa::{IntoParams, ToSchema};

use crate::{
    api::AppState,
    app_server_api::{
        self, RawAppServerResponse, ThreadCommandResponse, ThreadDetailResponse,
        ThreadListResponse, ThreadSummary,
    },
    error::ApiResult,
    store::ThreadRead,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/threads", get(list_threads).post(create_thread))
        .route(
            "/v1/chats/threads",
            get(list_chat_threads).post(create_chat_thread),
        )
        .route("/v1/threads/{thread_id}", get(get_thread))
        .route("/v1/threads/{thread_id}/resume", post(resume_thread))
        .route("/v1/threads/{thread_id}/fork", post(fork_thread))
        .route("/v1/threads/{thread_id}/archive", post(archive_thread))
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
    apply_thread_read_state(&state, &mut response.threads).await?;
    Ok(Json(response))
}

#[utoipa::path(post, path = "/v1/threads", request_body = CreateThreadRequest, responses((status = 200, body = ThreadCommandResponse)))]
pub async fn create_thread(
    State(state): State<AppState>,
    Json(request): Json<CreateThreadRequest>,
) -> ApiResult<Json<ThreadCommandResponse>> {
    let project = state.store.get_project(&request.project_id).await?;
    let payload = create_thread_payload(ThreadCreationOptions {
        model: request.model,
        service_tier: request.service_tier,
        approval_policy: request.approval_policy,
        approvals_reviewer: request.approvals_reviewer,
        sandbox: request.sandbox,
        payload: request.payload,
    });
    let mut response = app_server_api::client(&state.app_server)
        .thread_start(project.id, project.cwd, payload)
        .await?;
    apply_thread_read_state(&state, std::slice::from_mut(&mut response.thread)).await?;
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
    response.next_cursor = None;
    apply_thread_read_state(&state, &mut response.threads).await?;
    Ok(Json(response))
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
    let payload = create_thread_payload(ThreadCreationOptions {
        model: request.model,
        service_tier: request.service_tier,
        approval_policy: request.approval_policy,
        approvals_reviewer: request.approvals_reviewer,
        sandbox: request.sandbox,
        payload: request.payload,
    });
    let mut response = app_server_api::client(&state.app_server)
        .thread_start_in_cwd(cwd, payload)
        .await?;
    apply_thread_read_state(&state, std::slice::from_mut(&mut response.thread)).await?;
    Ok(Json(response))
}

struct ThreadCreationOptions {
    model: Option<String>,
    service_tier: Option<String>,
    approval_policy: Option<String>,
    approvals_reviewer: Option<String>,
    sandbox: Option<String>,
    payload: Value,
}

fn create_thread_payload(options: ThreadCreationOptions) -> Value {
    let mut payload = options.payload;
    if let Some(model) = options.model {
        payload["model"] = Value::String(model);
    }
    if let Some(service_tier) = options.service_tier {
        payload["serviceTier"] = Value::String(service_tier);
    }
    if let Some(approval_policy) = options.approval_policy {
        payload["approvalPolicy"] = Value::String(approval_policy);
    }
    if let Some(approvals_reviewer) = options.approvals_reviewer {
        payload["approvalsReviewer"] = Value::String(approvals_reviewer);
    }
    if let Some(sandbox) = options.sandbox {
        payload["sandbox"] = Value::String(sandbox);
    }
    payload
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

#[utoipa::path(get, path = "/v1/threads/{threadId}", responses((status = 200, body = ThreadDetailResponse)))]
pub async fn get_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> ApiResult<Json<ThreadDetailResponse>> {
    let mut response = app_server_api::client(&state.app_server)
        .thread_read(thread_id)
        .await?;
    apply_thread_read_state(&state, std::slice::from_mut(&mut response.thread)).await?;
    Ok(Json(response))
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/resume", responses((status = 200, body = ThreadCommandResponse)))]
pub async fn resume_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(payload): Json<Value>,
) -> ApiResult<Json<ThreadCommandResponse>> {
    let mut response = app_server_api::client(&state.app_server)
        .thread_resume(thread_id, payload)
        .await?;
    apply_thread_read_state(&state, std::slice::from_mut(&mut response.thread)).await?;
    Ok(Json(response))
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/fork", responses((status = 200, body = ThreadCommandResponse)))]
pub async fn fork_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(payload): Json<Value>,
) -> ApiResult<Json<ThreadCommandResponse>> {
    let mut response = app_server_api::client(&state.app_server)
        .thread_fork(thread_id, payload)
        .await?;
    apply_thread_read_state(&state, std::slice::from_mut(&mut response.thread)).await?;
    Ok(Json(response))
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/archive", responses((status = 200, body = RawAppServerResponse)))]
pub async fn archive_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> ApiResult<Json<RawAppServerResponse>> {
    Ok(Json(
        app_server_api::client(&state.app_server)
            .thread_archive(thread_id)
            .await?,
    ))
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
