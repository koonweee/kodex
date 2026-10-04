use std::{
    collections::{BTreeMap, HashMap},
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
        self, enrich_timeline_skill_mentions, timeline_skill_mentions_from_text,
        visible_text_from_thread_item, GitInfo, RawAppServerResponse, ThreadCommandResponse,
        ThreadDetailResponse, ThreadItemSnapshot, ThreadListResponse, ThreadLiveState,
        ThreadStatus, ThreadSummary, ThreadViewResponse, TimelineSkillMention,
    },
    app_surfaces,
    error::{ApiError, ApiResult},
    routes::{
        app_surfaces::{broadcast_app_surface_event, APP_SURFACE_UPSERTED_EVENT},
        projects::Project,
    },
    store::{EventEnvelope, NewEvent, ThreadNotificationSetting, ThreadRead},
    thread_view,
};

pub const THREAD_PIN_UPDATED_EVENT: &str = "thread.pin_updated";
pub const THREAD_READ_UPDATED_EVENT: &str = "thread.read_updated";
pub const THREAD_NOTIFICATIONS_UPDATED_EVENT: &str = "thread.notifications_updated";
pub const THREAD_UPSERTED_EVENT: &str = "thread.upserted";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/threads", get(list_threads).post(create_thread))
        .route("/v1/sidebar/threads", get(get_sidebar_threads))
        .route(
            "/v1/chats/threads",
            get(list_chat_threads).post(create_chat_thread),
        )
        .route("/v1/threads/pinned", get(list_pinned_threads))
        .route("/v1/threads/{thread_id}/subagents", get(list_subagents))
        .route(
            "/v1/threads/{thread_id}/timeline/pages",
            get(get_thread_timeline_page),
        )
        .route("/v1/threads/{thread_id}", get(get_thread))
        .route("/v1/threads/{thread_id}/name", patch(rename_thread))
        .route(
            "/v1/threads/{thread_id}/project",
            patch(update_thread_project),
        )
        .route(
            "/v1/threads/{thread_id}/notifications",
            patch(update_thread_notifications),
        )
        .route("/v1/threads/{thread_id}/attach", post(attach_thread))
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
const SIDEBAR_PROJECT_FETCH_CONCURRENCY: usize = 8;

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTimelinePageQuery {
    pub cursor: Option<String>,
    pub limit: Option<u32>,
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
    pub pinned_at: Option<DateTime<Utc>>,
    pub preview: Option<Value>,
    pub last_completed_agent_turn_seq: Option<i64>,
    pub seen_completed_agent_turn_seq: i64,
    pub unread_completed_agent_turn: bool,
    pub notifications_enabled: bool,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadAttachResponse {
    pub disposition: ThreadAttachDisposition,
    pub thread: Option<ThreadSummary>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ThreadAttachDisposition {
    AlreadyAttached,
    AlreadyLoaded,
    NotNeeded,
    Resumed,
}

impl From<ThreadSummary> for SidebarThreadSummary {
    fn from(thread: ThreadSummary) -> Self {
        Self {
            id: thread.id,
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
            pinned_at: thread.pinned_at,
            preview: thread.preview,
            last_completed_agent_turn_seq: thread.last_completed_agent_turn_seq,
            seen_completed_agent_turn_seq: thread.seen_completed_agent_turn_seq,
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

#[derive(Debug, Default, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarkThreadSeenRequest {
    #[serde(default)]
    pub seen_completed_agent_turn_seq: Option<i64>,
}

pub type MarkThreadSeenResponse = ThreadRead;

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadReadStateUpdate {
    pub thread_id: String,
    pub seen_completed_agent_turn_seq: i64,
    pub last_completed_agent_turn_seq: Option<i64>,
    pub unread_completed_agent_turn: bool,
}

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
    let (project_threads, chat_threads, pinned_threads) = tokio::try_join!(
        sidebar_project_threads(&state, &projects),
        chat_thread_list_response(&state, None, Some(SIDEBAR_INITIAL_THREAD_LIST_LIMIT)),
        pinned_thread_list_response(&state),
    )?;

    Ok(Json(SidebarThreadsResponse {
        projects,
        project_threads,
        chat_threads: SidebarThreadListResponse::from(chat_threads),
        pinned_threads: SidebarThreadListResponse::from(pinned_threads),
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
        while pending.len() < SIDEBAR_PROJECT_FETCH_CONCURRENCY {
            let Some(project) = iter.next() else {
                break;
            };
            let state = state.clone();
            let project_id = project.id.clone();
            pending.spawn(async move {
                let response = list_project_threads(
                    &state,
                    project_id.clone(),
                    None,
                    Some(SIDEBAR_INITIAL_THREAD_LIST_LIMIT),
                )
                .await?;
                Ok::<_, ApiError>((project_id, SidebarThreadListResponse::from(response)))
            });
        }

        let Some(result) = pending.join_next().await else {
            break;
        };
        let (project_id, response) = result.map_err(|error| {
            ApiError::Other(anyhow::anyhow!("sidebar project task failed: {error}"))
        })??;
        project_threads.insert(project_id, response);
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

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadProjectUpdateRequest {
    #[serde(deserialize_with = "required_nullable_project_id")]
    #[schema(required = true)]
    pub project_id: Option<String>,
}

fn required_nullable_project_id<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}

#[utoipa::path(patch, path = "/v1/threads/{threadId}/project", request_body = ThreadProjectUpdateRequest, responses((status = 200, body = ThreadCommandResponse)))]
pub async fn update_thread_project(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<ThreadProjectUpdateRequest>,
) -> ApiResult<Json<ThreadCommandResponse>> {
    let mut response = app_server_api::client(&state.app_server)
        .thread_assign_project(thread_id, request.project_id)
        .await?;
    apply_thread_command_response_state(&state, &mut response).await?;
    Ok(Json(response))
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

#[utoipa::path(get, path = "/v1/threads/pinned", responses((status = 200, body = ThreadListResponse)))]
pub async fn list_pinned_threads(
    State(state): State<AppState>,
) -> ApiResult<Json<ThreadListResponse>> {
    Ok(Json(pinned_thread_list_response(&state).await?))
}

async fn pinned_thread_list_response(state: &AppState) -> ApiResult<ThreadListResponse> {
    let client = app_server_api::client(&state.app_server);
    let mut threads = Vec::new();
    for pin in state.store.list_thread_pins().await? {
        let thread = match client.thread_read_summary(pin.thread_id.clone()).await {
            Ok(thread) => thread,
            Err(ApiError::NotFound(_)) => continue,
            Err(error) if app_server_error_mentions_missing_thread(&error) => {
                state.store.unpin_thread(&pin.thread_id).await?;
                broadcast_thread_pin_update(&state, &pin.thread_id, None).await?;
                continue;
            }
            Err(error) => return Err(error),
        };
        if thread_is_archived(&thread) {
            continue;
        }
        threads.push(thread);
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
    Ok(response)
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
        permissions: request.permissions,
        sandbox: request.sandbox,
        payload: request.payload,
    };
    options.validate()?;
    let payload = create_thread_payload(&options)?;
    let mut response = app_server_api::client(&state.app_server)
        .thread_start_in_cwd(cwd, payload)
        .await?;
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

#[utoipa::path(get, path = "/v1/threads/{threadId}", responses((status = 200, body = ThreadViewResponse)))]
pub async fn get_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
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
    Ok(Json(ThreadViewResponse::from_detail(response)))
}

#[utoipa::path(get, path = "/v1/threads/{threadId}/timeline/pages", params(ThreadTimelinePageQuery), responses((status = 200, body = ThreadViewResponse)))]
pub async fn get_thread_timeline_page(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Query(query): Query<ThreadTimelinePageQuery>,
) -> ApiResult<Json<ThreadViewResponse>> {
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
    Ok(Json(ThreadViewResponse::from_detail(response)))
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/attach", responses((status = 200, body = ThreadAttachResponse)))]
pub async fn attach_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> ApiResult<Json<ThreadAttachResponse>> {
    let client = app_server_api::client(&state.app_server);
    let loaded = client.thread_loaded_list().await?;
    if loaded
        .thread_ids
        .iter()
        .any(|loaded_id| loaded_id == &thread_id)
    {
        return Ok(Json(ThreadAttachResponse {
            disposition: ThreadAttachDisposition::AlreadyLoaded,
            thread: None,
        }));
    }

    let mut response = client.thread_resume(thread_id, json!({})).await?;
    apply_thread_command_response_state(&state, &mut response).await?;
    Ok(Json(ThreadAttachResponse {
        disposition: ThreadAttachDisposition::Resumed,
        thread: Some(response.thread),
    }))
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

#[utoipa::path(get, path = "/v1/threads/{threadId}/subagents", responses((status = 200, body = ThreadSubagentListResponse)))]
pub async fn list_subagents(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> ApiResult<Json<ThreadSubagentListResponse>> {
    if state.subagents.needs_repair(&thread_id).await {
        repair_subagent_projection(&state, &thread_id).await?;
    }

    Ok(Json(ThreadSubagentListResponse {
        subagents: state.subagents.list_descendants(&thread_id).await,
    }))
}

async fn repair_subagent_projection(state: &AppState, thread_id: &str) -> ApiResult<()> {
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
                    "failed to read loaded thread during subagent repair"
                );
            }
        }
    }
    if attempted_thread_reads > 0 && read_failures == attempted_thread_reads {
        return Err(ApiError::BadGateway(
            "failed to read any loaded thread during subagent discovery".to_string(),
        ));
    }
    state
        .subagents
        .replace_repaired_descendants(thread_id, threads)
        .await;
    Ok(())
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
    let (seen_seq, last_completed_agent_turn_seq) = match request.seen_completed_agent_turn_seq {
        Some(seq) => {
            let seq = seq.max(0);
            (seq, Some(seq))
        }
        None => {
            let count = app_server_api::client(&state.app_server)
                .thread_completed_turn_count_light(thread_id.clone())
                .await?
                .unwrap_or(0);
            (count, Some(count))
        }
    };
    let read = state
        .store
        .mark_thread_seen_completed_agent_turns(&thread_id, seen_seq)
        .await?;
    broadcast_thread_read_update(
        &state,
        ThreadReadStateUpdate {
            thread_id,
            seen_completed_agent_turn_seq: read.seen_completed_agent_turn_seq,
            last_completed_agent_turn_seq,
            unread_completed_agent_turn: last_completed_agent_turn_seq
                .is_some_and(|last_completed| last_completed > read.seen_completed_agent_turn_seq),
        },
    )
    .await?;
    Ok(Json(read))
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
    apply_thread_summary_state(state, std::slice::from_mut(&mut response.thread)).await?;
    apply_thread_detail_skill_mentions(state, response).await?;
    let app_surface_sessions =
        app_surfaces::sync_mcp_app_surfaces_for_turns(state, &response.thread.id, &response.turns)
            .await?;
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
    for session in app_surface_sessions {
        broadcast_app_surface_event(state, APP_SURFACE_UPSERTED_EVENT, &session).await?;
    }
    response.live_state = response.timeline.live_state;
    sync_raw_response_thread(&mut response.raw_payload, &response.thread);
    Ok(())
}

async fn apply_thread_detail_skill_mentions(
    state: &AppState,
    response: &mut ThreadDetailResponse,
) -> ApiResult<()> {
    let thread_id = response.thread.id.clone();
    let item_refs = response
        .turns
        .iter()
        .flat_map(|turn| {
            turn.items
                .iter()
                .map(|item| (turn.id.clone(), item.id.clone()))
        })
        .collect::<Vec<_>>();
    let mut stored = state
        .store
        .timeline_skill_mentions_for_items(&thread_id, &item_refs)
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
                &turn.id,
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
    turn_id: &str,
    item: &mut ThreadItemSnapshot,
    stored: &mut HashMap<(String, String), Vec<TimelineSkillMention>>,
    catalog: Option<&[app_server_api::SkillMetadata]>,
) -> ApiResult<()> {
    if !item.skill_mentions.is_empty() {
        item.skill_mentions = enrich_timeline_skill_mentions(
            std::mem::take(&mut item.skill_mentions),
            catalog.unwrap_or(&[]),
        );
        state
            .store
            .upsert_timeline_skill_mentions(thread_id, turn_id, &item.id, &item.skill_mentions)
            .await?;
        return Ok(());
    }
    if let Some(mentions) = stored.remove(&(turn_id.to_string(), item.id.clone())) {
        item.skill_mentions = enrich_timeline_skill_mentions(mentions, catalog.unwrap_or(&[]));
        state
            .store
            .upsert_timeline_skill_mentions(thread_id, turn_id, &item.id, &item.skill_mentions)
            .await?;
        return Ok(());
    }
    let Some(text) = visible_text_from_thread_item(&item.raw_payload) else {
        return Ok(());
    };
    if let Some(mentions) = state
        .store
        .commit_pending_timeline_skill_mentions(thread_id, turn_id, &item.id, &text)
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
                .upsert_timeline_skill_mentions(thread_id, turn_id, &item.id, &item.skill_mentions)
                .await?;
        }
    }
    Ok(())
}

pub(crate) async fn apply_thread_summary_state(
    state: &AppState,
    threads: &mut [ThreadSummary],
) -> ApiResult<()> {
    apply_thread_pin_state(state, threads).await?;
    apply_thread_notification_settings(state, threads).await?;
    apply_thread_read_state(state, threads).await?;
    for thread in threads {
        let _ = state.subagents.upsert_from_thread_summary(thread).await;
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

async fn broadcast_thread_read_update(
    state: &AppState,
    read_state: ThreadReadStateUpdate,
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
            payload: serde_json::to_value(read_state)?,
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
