use std::{
    collections::BTreeMap,
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
use tokio::task::JoinSet;
use utoipa::{IntoParams, ToSchema};

use crate::{
    api::AppState,
    app_server_api::{
        self, GitInfo, RawAppServerResponse, ThreadCommandResponse, ThreadDetailResponse,
        ThreadListResponse, ThreadStatus, ThreadSummary, ThreadViewResponse,
    },
    error::{ApiError, ApiResult},
    routes::projects::Project,
    store::{EventEnvelope, NewEvent, ThreadNotificationSetting, ThreadRead},
    thread_view,
    thread_view_delivery::ThreadViewDeliveryQuery,
};

pub const THREAD_READ_UPDATED_EVENT: &str = "thread.read_updated";
pub const THREAD_NOTIFICATIONS_UPDATED_EVENT: &str = "thread.notifications_updated";
pub const THREAD_UPSERTED_EVENT: &str = "thread.upserted";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/threads", get(list_threads).post(create_thread))
        .route("/v1/threads/unread-badge", get(get_unread_badge))
        .route("/v1/sidebar/threads", get(get_sidebar_threads))
        .route(
            "/v1/chats/threads",
            get(list_chat_threads).post(create_chat_thread),
        )
        .route(
            "/v1/threads/{thread_id}/timeline/pages",
            get(get_thread_timeline_page),
        )
        .route("/v1/threads/{thread_id}", get(get_thread))
        .route("/v1/threads/{thread_id}/name", patch(rename_thread))
        .route(
            "/v1/threads/{thread_id}/notifications",
            patch(update_thread_notifications),
        )
        .route("/v1/threads/{thread_id}/attach", post(attach_thread))
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

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatThreadListQuery {
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}

const DEFAULT_THREAD_LIST_LIMIT: u32 = 100;
const SIDEBAR_INITIAL_THREAD_LIST_LIMIT: u32 = 10;
const SELECTED_THREAD_HISTORY_PAGE_LIMIT: u32 = 50;
const MAX_SELECTED_THREAD_HISTORY_PAGE_LIMIT: u32 = 200;
const SIDEBAR_GROUP_FETCH_CONCURRENCY: usize = 8;

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTimelinePageQuery {
    pub cursor: Option<String>,
    pub limit: Option<u32>,
    pub include_debug_events: Option<bool>,
    pub include_command_outputs: Option<bool>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SidebarThreadsResponse {
    pub projects: Vec<Project>,
    pub project_threads: BTreeMap<String, SidebarThreadListResponse>,
    pub chat_threads: SidebarThreadListResponse,
    pub pinned_threads: SidebarThreadListResponse,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SidebarThreadListResponse {
    pub threads: Vec<SidebarThreadSummary>,
    pub next_cursor: Option<String>,
    pub backwards_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SidebarThreadSummary {
    pub id: String,
    #[schema(required = true)]
    pub parent_thread_id: Option<String>,
    #[schema(required = true)]
    pub can_accept_direct_input: Option<bool>,
    pub name: Option<String>,
    pub project_id: Option<String>,
    pub cwd: String,
    pub status: ThreadStatus,
    pub created_at: i64,
    pub updated_at: i64,
    pub source: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
    pub approval_policy: Option<String>,
    pub approvals_reviewer: Option<String>,
    pub agent_nickname: Option<String>,
    pub agent_role: Option<String>,
    pub sandbox: Option<Value>,
    pub git_info: Option<GitInfo>,
    pub pinned: bool,
    pub preview: Option<Value>,
    #[schema(required = true)]
    pub latest_completed_turn_id: Option<String>,
    #[schema(required = true)]
    pub seen_completed_turn_id: Option<String>,
    pub read_revision: i64,
    pub read_state_known: bool,
    pub unread_completed_agent_turn: bool,
    pub notifications_enabled: bool,
}

impl From<ThreadSummary> for SidebarThreadSummary {
    fn from(thread: ThreadSummary) -> Self {
        Self {
            id: thread.id,
            parent_thread_id: thread.parent_thread_id,
            can_accept_direct_input: thread.can_accept_direct_input,
            name: thread.name,
            project_id: thread.project_id,
            cwd: thread.cwd,
            status: thread.status,
            created_at: thread.created_at,
            updated_at: thread.updated_at,
            source: thread.source,
            model: thread.model,
            reasoning_effort: thread.reasoning_effort,
            service_tier: thread.service_tier,
            approval_policy: thread.approval_policy,
            approvals_reviewer: thread.approvals_reviewer,
            agent_nickname: thread.agent_nickname,
            agent_role: thread.agent_role,
            sandbox: thread.sandbox,
            git_info: thread.git_info,
            pinned: thread.pinned,
            preview: thread.preview,
            latest_completed_turn_id: thread.latest_completed_turn_id,
            seen_completed_turn_id: thread.seen_completed_turn_id,
            read_revision: thread.read_revision,
            read_state_known: thread.read_state_known,
            unread_completed_agent_turn: thread.unread_completed_agent_turn,
            notifications_enabled: thread.notifications_enabled,
        }
    }
}

impl From<ThreadListResponse> for SidebarThreadListResponse {
    fn from(response: ThreadListResponse) -> Self {
        Self {
            threads: response
                .threads
                .into_iter()
                .map(SidebarThreadSummary::from)
                .collect(),
            next_cursor: response.next_cursor,
            backwards_cursor: response.backwards_cursor,
        }
    }
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateThreadRequest {
    pub project_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(
        default,
        deserialize_with = "app_server_api::deserialize_optional_string_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub service_tier: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approvals_reviewer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<String>,
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
    #[serde(
        default,
        deserialize_with = "app_server_api::deserialize_optional_string_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub service_tier: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approvals_reviewer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<String>,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarkThreadSeenRequest {
    pub completed_turn_id: String,
    pub read_revision: i64,
}

pub type MarkThreadSeenResponse = ThreadRead;

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(transparent)]
pub struct ThreadReadStateUpdate(pub ThreadRead);

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

#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadNotificationSettingsUpdateRequest {
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadNotificationSettingsResponse {
    pub thread_id: String,
    pub notifications_enabled: bool,
    pub updated_at: DateTime<Utc>,
}

impl From<ThreadNotificationSetting> for ThreadNotificationSettingsResponse {
    fn from(setting: ThreadNotificationSetting) -> Self {
        Self {
            thread_id: setting.thread_id,
            notifications_enabled: setting.notifications_enabled,
            updated_at: setting.updated_at,
        }
    }
}

pub type ThreadNotificationSettingsUpdate = ThreadNotificationSettingsResponse;

#[utoipa::path(get, path = "/v1/threads", params(ThreadListQuery), responses((status = 200, body = ThreadListResponse)))]
pub async fn list_threads(
    State(state): State<AppState>,
    Query(query): Query<ThreadListQuery>,
) -> ApiResult<Json<ThreadListResponse>> {
    let response = match query.project_id {
        Some(project_id) => {
            list_project_threads(&state, project_id, query.cursor, query.limit).await?
        }
        None => list_all_threads(&state, query.cursor, query.limit).await?,
    };
    Ok(Json(response))
}

#[utoipa::path(get, path = "/v1/sidebar/threads", responses((status = 200, body = SidebarThreadsResponse)))]
pub async fn get_sidebar_threads(
    State(state): State<AppState>,
) -> ApiResult<Json<SidebarThreadsResponse>> {
    let projects = super::projects::list_project_records(&state).await?;
    let (project_threads, pinned_threads, chat_threads) = tokio::try_join!(
        sidebar_project_threads(&state, &projects),
        super::pins::pinned_threads_response(&state, None, Some(SIDEBAR_INITIAL_THREAD_LIST_LIMIT)),
        chat_thread_list_response(&state, None, Some(SIDEBAR_INITIAL_THREAD_LIST_LIMIT)),
    )?;
    Ok(Json(SidebarThreadsResponse {
        projects,
        project_threads,
        pinned_threads: SidebarThreadListResponse::from(pinned_threads),
        chat_threads: SidebarThreadListResponse::from(chat_threads),
    }))
}

async fn sidebar_project_threads(
    state: &AppState,
    projects: &[Project],
) -> ApiResult<BTreeMap<String, SidebarThreadListResponse>> {
    let mut project_threads = BTreeMap::new();
    let mut pending = JoinSet::new();
    let mut iter = projects.iter();
    loop {
        while pending.len() < SIDEBAR_GROUP_FETCH_CONCURRENCY {
            let Some(project) = iter.next() else {
                break;
            };
            let id = project.id.clone();
            let state = state.clone();
            pending.spawn(async move {
                let response = list_project_threads(
                    &state,
                    id.clone(),
                    None,
                    Some(SIDEBAR_INITIAL_THREAD_LIST_LIMIT),
                )
                .await?;
                Ok::<_, ApiError>((id, SidebarThreadListResponse::from(response)))
            });
        }
        let Some(result) = pending.join_next().await else {
            break;
        };
        let (id, response) = result.map_err(|error| {
            ApiError::Other(anyhow::anyhow!("sidebar project task failed: {error}"))
        })??;
        project_threads.insert(id, response);
    }
    Ok(project_threads)
}

async fn list_project_threads(
    state: &AppState,
    project_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
) -> ApiResult<ThreadListResponse> {
    let mut response = app_server_api::client(&state.app_server)
        .thread_list_in_project(Some(project_id), cursor, limit)
        .await?;
    response
        .threads
        .retain(|thread| !thread_is_archived(thread));
    apply_thread_list_response_state(state, &mut response).await?;
    Ok(response)
}

async fn list_all_threads(
    state: &AppState,
    cursor: Option<String>,
    limit: Option<u32>,
) -> ApiResult<ThreadListResponse> {
    let mut response = app_server_api::client(&state.app_server)
        .thread_list(None, cursor, limit)
        .await?;
    response
        .threads
        .retain(|thread| !thread_is_archived(thread));
    apply_thread_list_response_state(&state, &mut response).await?;
    Ok(response)
}

#[utoipa::path(post, path = "/v1/threads", request_body = CreateThreadRequest, responses((status = 200, body = ThreadCommandResponse)))]
pub async fn create_thread(
    State(state): State<AppState>,
    Json(request): Json<CreateThreadRequest>,
) -> ApiResult<Json<ThreadCommandResponse>> {
    let cwd =
        super::projects::project_execution_cwd(&state, &request.project_id, request.cwd).await?;
    let project_id = request.project_id;
    let options = ThreadCreationOptions {
        model: request.model,
        effort: request.effort,
        service_tier: request.service_tier,
        approval_policy: request.approval_policy,
        approvals_reviewer: request.approvals_reviewer,
        permissions: request.permissions,
        sandbox: request.sandbox,
        payload: request.payload,
    };
    options.validate()?;
    let payload = create_thread_payload(&options)?;
    let mut response = app_server_api::client(&state.app_server)
        .thread_start(project_id.clone(), cwd, payload)
        .await?;
    crate::read_state::catalog_changed(&state, "thread/started", &response.thread.id).await?;
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

#[utoipa::path(get, path = "/v1/chats/threads", params(ChatThreadListQuery), responses((status = 200, body = ThreadListResponse)))]
pub async fn list_chat_threads(
    State(state): State<AppState>,
    Query(query): Query<ChatThreadListQuery>,
) -> ApiResult<Json<ThreadListResponse>> {
    Ok(Json(
        chat_thread_list_response(
            &state,
            query.cursor,
            Some(query.limit.unwrap_or(DEFAULT_THREAD_LIST_LIMIT)),
        )
        .await?,
    ))
}

async fn chat_thread_list_response(
    state: &AppState,
    cursor: Option<String>,
    limit: Option<u32>,
) -> ApiResult<ThreadListResponse> {
    let mut response = app_server_api::client(&state.app_server)
        .thread_list_in_project(None, cursor, limit)
        .await?;
    response
        .threads
        .retain(|thread| !thread_is_archived(thread));
    apply_thread_list_response_state(&state, &mut response).await?;
    Ok(response)
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
        permissions: request.permissions,
        sandbox: request.sandbox,
        payload: request.payload,
    };
    options.validate()?;
    let payload = create_thread_payload(&options)?;
    let mut response = app_server_api::client(&state.app_server)
        .thread_start_in_cwd(cwd, payload)
        .await?;
    crate::read_state::catalog_changed(&state, "thread/started", &response.thread.id).await?;
    apply_thread_command_response_state(&state, &mut response).await?;
    broadcast_thread_upserted(&state, ThreadUpsertScope::Chat, None, &response.thread).await?;
    Ok(Json(response))
}

pub(crate) struct ThreadCreationOptions {
    pub(crate) model: Option<String>,
    pub(crate) effort: Option<String>,
    pub(crate) service_tier: Option<Option<String>>,
    pub(crate) approval_policy: Option<String>,
    pub(crate) approvals_reviewer: Option<String>,
    pub(crate) permissions: Option<String>,
    pub(crate) sandbox: Option<String>,
    pub(crate) payload: Value,
}

impl ThreadCreationOptions {
    pub(crate) fn validate(&self) -> ApiResult<()> {
        if self.permissions.is_some() && self.sandbox.is_some() {
            return Err(crate::error::ApiError::BadRequest(
                "permissions and sandbox cannot be combined".to_string(),
            ));
        }
        Ok(())
    }
}

pub(crate) fn create_thread_payload(options: &ThreadCreationOptions) -> ApiResult<Value> {
    let mut payload = options.payload.clone();
    if payload.is_null() {
        payload = json!({});
    }
    let object = payload
        .as_object_mut()
        .ok_or_else(|| ApiError::BadRequest("thread creation payload must be an object".into()))?;
    object.remove("effort");
    object.remove("reasoningEffort");
    if let Some(effort) = options.effort.as_ref() {
        let config = object.entry("config").or_insert_with(|| json!({}));
        if config.is_null() {
            *config = json!({});
        }
        config
            .as_object_mut()
            .ok_or_else(|| ApiError::BadRequest("thread creation config must be an object".into()))?
            .insert("model_reasoning_effort".into(), json!(effort));
    }
    if let Some(model) = options.model.as_ref() {
        payload["model"] = Value::String(model.clone());
    }
    if let Some(service_tier) = options.service_tier.as_ref() {
        payload["serviceTier"] = service_tier
            .as_ref()
            .map(|value| Value::String(value.clone()))
            .unwrap_or(Value::Null);
    }
    if let Some(approval_policy) = options.approval_policy.as_ref() {
        payload["approvalPolicy"] = Value::String(approval_policy.clone());
    }
    if let Some(approvals_reviewer) = options.approvals_reviewer.as_ref() {
        payload["approvalsReviewer"] = Value::String(approvals_reviewer.clone());
    }
    if let Some(permissions) = options.permissions.as_ref() {
        payload["permissions"] = Value::String(permissions.clone());
    }
    if let Some(sandbox) = options.sandbox.as_ref() {
        payload["sandbox"] = Value::String(sandbox.clone());
    }
    Ok(payload)
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

#[utoipa::path(get, path = "/v1/threads/{threadId}", params(ThreadViewDeliveryQuery), responses((status = 200, body = ThreadViewResponse)))]
pub async fn get_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Query(delivery): Query<ThreadViewDeliveryQuery>,
) -> ApiResult<Json<ThreadViewResponse>> {
    let timeline_revision = state.store.latest_event_seq().await?;
    let mut response = app_server_api::client(&state.app_server)
        .thread_read_history_window(thread_id, SELECTED_THREAD_HISTORY_PAGE_LIMIT)
        .await?;
    apply_thread_detail_response_state_with_merge(
        &state,
        &mut response,
        timeline_revision,
        ThreadTimelineMergeMode::ReplaceWindow,
    )
    .await?;
    delivery.project_snapshot(&mut response.timeline);
    Ok(Json(ThreadViewResponse::from_detail(response)))
}

#[utoipa::path(get, path = "/v1/threads/{threadId}/timeline/pages", params(ThreadTimelinePageQuery), responses((status = 200, body = ThreadViewResponse)))]
pub async fn get_thread_timeline_page(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Query(query): Query<ThreadTimelinePageQuery>,
) -> ApiResult<Json<ThreadViewResponse>> {
    let delivery = ThreadViewDeliveryQuery {
        include_debug_events: query.include_debug_events.unwrap_or(false),
        include_command_outputs: query.include_command_outputs.unwrap_or(false),
    };
    let timeline_revision = state.store.latest_event_seq().await?;
    let Some(cursor) = query.cursor else {
        return Err(ApiError::BadRequest(
            "timeline page cursor is required".to_string(),
        ));
    };
    let limit = query
        .limit
        .unwrap_or(SELECTED_THREAD_HISTORY_PAGE_LIMIT)
        .clamp(1, MAX_SELECTED_THREAD_HISTORY_PAGE_LIMIT);
    let existing_history_page = state.thread_views.history_page(&thread_id).await;
    let cursor_matches_loaded_window = existing_history_page
        .as_ref()
        .and_then(|history_page| history_page.older_cursor.as_deref())
        == Some(cursor.as_str());
    let mut response = if cursor_matches_loaded_window {
        app_server_api::client(&state.app_server)
            .thread_read_history_page(thread_id, Some(cursor), limit)
            .await?
    } else {
        let mut response = app_server_api::client(&state.app_server)
            .thread_read_history_window(thread_id, limit)
            .await?;
        if let Some(history_page) = &mut response.history_page {
            history_page.reset_window = true;
        }
        response
    };
    apply_thread_detail_response_state_with_merge(
        &state,
        &mut response,
        timeline_revision,
        if cursor_matches_loaded_window {
            ThreadTimelineMergeMode::PrependPage
        } else {
            ThreadTimelineMergeMode::ReplaceWindow
        },
    )
    .await?;
    delivery.project_snapshot(&mut response.timeline);
    Ok(Json(ThreadViewResponse::from_detail(response)))
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/attach", params(ThreadViewDeliveryQuery), responses((status = 200, body = ThreadViewResponse)))]
pub async fn attach_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Query(delivery): Query<ThreadViewDeliveryQuery>,
) -> ApiResult<Json<ThreadViewResponse>> {
    let timeline_revision = state.store.latest_event_seq().await?;
    let mut response = app_server_api::client(&state.app_server)
        .thread_resume_history_window(thread_id, SELECTED_THREAD_HISTORY_PAGE_LIMIT)
        .await?;
    apply_thread_detail_response_state_with_merge(
        &state,
        &mut response,
        timeline_revision,
        ThreadTimelineMergeMode::ReplaceWindow,
    )
    .await?;
    delivery.project_snapshot(&mut response.timeline);
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

#[utoipa::path(patch, path = "/v1/threads/{threadId}/notifications", request_body = ThreadNotificationSettingsUpdateRequest, responses((status = 200, body = ThreadNotificationSettingsResponse)))]
pub async fn update_thread_notifications(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<ThreadNotificationSettingsUpdateRequest>,
) -> ApiResult<Json<ThreadNotificationSettingsResponse>> {
    let setting = state
        .store
        .set_thread_notifications_enabled(&thread_id, request.enabled)
        .await?;
    let response = ThreadNotificationSettingsResponse::from(setting);
    broadcast_thread_notifications_update(&state, response.clone()).await?;
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
    apply_thread_command_response_state(&state, &mut response).await?;
    Ok(Json(response))
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
    crate::read_state::catalog_changed(&state, "thread/started", &response.thread.id).await?;
    apply_thread_command_response_state(&state, &mut response).await?;
    Ok(Json(response))
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/archive", responses((status = 200, body = RawAppServerResponse)))]
pub async fn archive_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> ApiResult<Json<RawAppServerResponse>> {
    let response = app_server_api::client(&state.app_server)
        .thread_archive(thread_id.clone())
        .await?;
    crate::read_state::catalog_changed(&state, "thread/archived", &thread_id).await?;
    Ok(Json(response))
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/seen", request_body = MarkThreadSeenRequest, responses((status = 200, body = MarkThreadSeenResponse)))]
pub async fn mark_thread_seen(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<MarkThreadSeenRequest>,
) -> ApiResult<Json<MarkThreadSeenResponse>> {
    let current = state.store.get_thread_read(&thread_id).await?;
    if !current.read_state_known
        || current.read_revision != request.read_revision
        || current.latest_completed_turn_id.as_deref() != Some(request.completed_turn_id.as_str())
    {
        return Err(ApiError::Conflict(
            "Chat completion changed; refresh before marking it seen".into(),
        ));
    }
    // Reconcile offline native work before admitting the displayed marker.
    // The store atomically refuses a stale acknowledgment of another head.
    crate::read_state::reconcile(&state, &thread_id).await?;
    let read = state
        .store
        .mark_thread_seen(
            &thread_id,
            &request.completed_turn_id,
            request.read_revision,
        )
        .await?;
    broadcast_thread_read_update(&state, read.clone()).await?;
    Ok(Json(read))
}

#[utoipa::path(get, path = "/v1/threads/unread-badge", responses((status = 200, body = crate::read_state::UnreadBadgeResponse)))]
pub async fn get_unread_badge(
    State(state): State<AppState>,
) -> ApiResult<Json<crate::read_state::UnreadBadgeResponse>> {
    Ok(Json(crate::read_state::unread_badge(&state).await?))
}

pub(crate) async fn apply_thread_list_response_state(
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

#[derive(Debug, Clone, Copy)]
enum ThreadTimelineMergeMode {
    ReplaceWindow,
    PrependPage,
}

async fn apply_thread_detail_response_state_with_merge(
    state: &AppState,
    response: &mut ThreadDetailResponse,
    timeline_revision: i64,
    merge_mode: ThreadTimelineMergeMode,
) -> ApiResult<()> {
    state
        .thread_views
        .ensure_history_current(&response.thread.id, timeline_revision)
        .await?;
    apply_thread_summary_state(state, std::slice::from_mut(&mut response.thread)).await?;
    match merge_mode {
        ThreadTimelineMergeMode::ReplaceWindow => {
            thread_view::build_thread_timeline_window(
                &state.thread_views,
                &response.thread.id,
                &response.turns,
                response.history_page.clone(),
                timeline_revision,
            )
            .await?
        }
        ThreadTimelineMergeMode::PrependPage => {
            thread_view::prepend_thread_timeline_page(
                &state.thread_views,
                &response.thread.id,
                &response.turns,
                response.history_page.clone(),
                timeline_revision,
            )
            .await?
        }
    };
    response.timeline = crate::approvals::hydrate_thread_view(state, &response.thread.id).await?;
    if let Some(history_page) = &mut response.history_page {
        history_page.loaded_turn_count = response.timeline.turns.len() as u32;
    }
    response.live_state = response.timeline.live_state;
    sync_raw_response_thread(&mut response.raw_payload, &response.thread);
    state
        .thread_views
        .ensure_history_current(&response.thread.id, timeline_revision)
        .await?;
    Ok(())
}

pub(crate) async fn apply_thread_summary_state(
    state: &AppState,
    threads: &mut [ThreadSummary],
) -> ApiResult<()> {
    apply_thread_notification_settings(state, threads).await?;
    apply_thread_read_state(state, threads).await?;
    Ok(())
}

// Native ingestion enriches metadata from storage only. It must not await an
// RPC whose response shares the serial notification transport.
pub(crate) async fn apply_stored_thread_summary_state(
    state: &AppState,
    threads: &mut [ThreadSummary],
) -> ApiResult<()> {
    apply_thread_notification_settings(state, threads).await?;
    let ids = threads
        .iter()
        .map(|thread| thread.id.clone())
        .collect::<Vec<_>>();
    let reads = state.store.thread_read_states(&ids).await?;
    for thread in threads {
        let read = reads.get(&thread.id).cloned().unwrap_or_default();
        thread.apply_read_state(&read);
    }
    Ok(())
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
    response.active_permission_profile = response.thread.active_permission_profile.clone();
    response.sandbox = response.thread.sandbox.clone();

    sync_raw_response_thread(&mut response.raw_payload, &response.thread);
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

async fn apply_thread_notification_settings(
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
    let settings = state
        .store
        .thread_notification_settings(&thread_ids)
        .await?;
    for thread in threads {
        let enabled = settings.get(&thread.id).copied().unwrap_or(true);
        thread.notifications_enabled = enabled;
        sync_raw_thread_notifications_enabled(&mut thread.raw_payload, enabled);
    }

    Ok(())
}

fn sync_raw_thread_notifications_enabled(raw_payload: &mut Value, enabled: bool) {
    let Some(raw_payload) = raw_payload.as_object_mut() else {
        return;
    };
    raw_payload.insert("notificationsEnabled".to_string(), json!(enabled));
}

pub(crate) async fn broadcast_thread_read_update(
    state: &AppState,
    read_state: ThreadRead,
) -> ApiResult<EventEnvelope> {
    let event = state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: Some(read_state.thread_id.clone()),
            turn_id: None,
            item_id: None,
            kind: THREAD_READ_UPDATED_EVENT.to_string(),
            codex_method: None,
            payload: serde_json::to_value(ThreadReadStateUpdate(read_state))?,
        })
        .await?;
    let _ = state.events.send(event.clone());
    Ok(event)
}

async fn broadcast_thread_notifications_update(
    state: &AppState,
    update: ThreadNotificationSettingsUpdate,
) -> ApiResult<EventEnvelope> {
    let event = state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: Some(update.thread_id.clone()),
            turn_id: None,
            item_id: None,
            kind: THREAD_NOTIFICATIONS_UPDATED_EVENT.to_string(),
            codex_method: None,
            payload: serde_json::to_value(update)?,
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

fn thread_is_archived(thread: &ThreadSummary) -> bool {
    thread
        .raw_payload
        .get("archived")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

async fn apply_thread_read_state(state: &AppState, threads: &mut [ThreadSummary]) -> ApiResult<()> {
    for thread in threads {
        let read = crate::read_state::reconcile(state, &thread.id).await?;
        thread.apply_read_state(&read);
    }
    Ok(())
}
