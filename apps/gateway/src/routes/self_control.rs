//! Agent-facing self-control endpoints.
//!
//! `/v1/self-control/...` is the product-shaped boundary for Kodex Control tools.
//! MCP tools should call these guarded endpoints instead of raw thread or
//! automation CRUD routes so the gateway can keep policy, provenance, and
//! reconciliation behavior in one place.

use axum::{
    extract::{Path, Query, State},
    routing::{get, patch, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use utoipa::ToSchema;

use crate::{
    api::AppState,
    app_server_api::{
        self, RawAppServerResponse, ThreadCommandResponse, ThreadListResponse,
        ThreadSettingsUpdateRequest, ThreadSubagentListResponse, ThreadViewResponse, UserInput,
    },
    app_surfaces::{
        validate_app_surface_grants, validate_app_surface_title,
        validate_generated_app_surface_html, MCP_APP_MIME_TYPE,
    },
    automations::{broadcast_automation_delete, broadcast_automation_upsert},
    error::{ApiError, ApiResult},
    queue::{self, QueuedInput},
    routes::{
        app_surfaces::{
            broadcast_app_surface_event, broadcast_app_surface_presentation_request,
            session_dto as app_surface_session_dto, AppSurfacePresentationAction,
            AppSurfacePresentationRequestDto, AppSurfacePresentationResponse,
            AppSurfaceSessionReadResponse, AppSurfaceSessionResponse, APP_SURFACE_ARCHIVED_EVENT,
            APP_SURFACE_UPSERTED_EVENT,
        },
        approvals::{ApprovalListQuery, ApprovalListResponse},
        automations::{
            automation_to_dto, repeat_every_seconds, validate_name_and_prompt,
            validate_target_thread, AutomationDeleteResponse, AutomationDto, AutomationListQuery,
            AutomationListResponse, AutomationResponse, AutomationSchedule,
            AutomationUpdateRequest,
        },
        events::{EventListResponse, EventsQuery},
        projects::{Project, ProjectListResponse},
        subagents::ThreadSubagentListQuery,
        thread_settings::ThreadSettingsUpdateResponse,
        threads::{
            apply_thread_command_response_state, broadcast_thread_upserted, create_thread_payload,
            MarkThreadSeenRequest, MarkThreadSeenResponse, RenameThreadRequest,
            RenameThreadResponse, SidebarThreadsResponse, ThreadCreationOptions, ThreadListQuery,
            ThreadTimelinePageQuery, ThreadUpsertScope,
        },
        turns::{ThreadCompactResponse, ThreadInterruptCurrentResponse},
    },
    schema::validate_approval_response,
    store::{
        AppSurfaceCsp, AppSurfaceGrants, AppSurfacePermissions, AppSurfaceProvider,
        AppSurfaceSessionStatus, AppSurfaceSessionUpsert, Approval, AutomationRun,
        AutomationStatus, AutomationUpdate, NewAutomation, NewEvent,
    },
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/self-control/status", get(self_control_status))
        .route("/v1/self-control/projects", get(list_self_control_projects))
        .route(
            "/v1/self-control/projects/{project_id}",
            get(get_self_control_project),
        )
        .route(
            "/v1/self-control/threads",
            get(list_self_control_threads).post(create_self_control_thread),
        )
        .route(
            "/v1/self-control/sidebar/threads",
            get(get_self_control_sidebar_threads),
        )
        .route(
            "/v1/self-control/threads/{thread_id}",
            get(get_self_control_thread),
        )
        .route(
            "/v1/self-control/threads/{thread_id}/timeline/pages",
            get(get_self_control_thread_timeline_page),
        )
        .route(
            "/v1/self-control/threads/{thread_id}/subagents",
            get(list_self_control_subagents),
        )
        .route(
            "/v1/self-control/threads/{thread_id}/queued-inputs",
            get(list_self_control_queued_inputs),
        )
        .route(
            "/v1/self-control/threads/{thread_id}/app-surface",
            get(get_self_control_app_surface)
                .post(upsert_self_control_generated_app_surface)
                .delete(archive_self_control_app_surface),
        )
        .route(
            "/v1/self-control/threads/{thread_id}/app-surface/presentation",
            post(request_self_control_app_surface_presentation),
        )
        .route(
            "/v1/self-control/threads/{thread_id}/attach",
            post(attach_self_control_thread),
        )
        .route(
            "/v1/self-control/threads/{thread_id}/resume",
            post(resume_self_control_thread),
        )
        .route(
            "/v1/self-control/threads/{thread_id}/fork",
            post(fork_self_control_thread),
        )
        .route(
            "/v1/self-control/threads/{thread_id}/name",
            patch(rename_self_control_thread),
        )
        .route(
            "/v1/self-control/threads/{thread_id}/settings",
            patch(update_self_control_thread_settings),
        )
        .route(
            "/v1/self-control/threads/{thread_id}/archive",
            post(archive_self_control_thread),
        )
        .route(
            "/v1/self-control/threads/{thread_id}/seen",
            post(mark_self_control_thread_seen),
        )
        .route(
            "/v1/self-control/threads/{thread_id}/compact",
            post(compact_self_control_thread),
        )
        .route(
            "/v1/self-control/threads/{thread_id}/interrupt-current",
            post(interrupt_current_self_control_thread),
        )
        .route(
            "/v1/self-control/threads/{thread_id}/input",
            post(send_self_control_thread_input),
        )
        .route(
            "/v1/self-control/thread-spawns",
            post(spawn_self_control_thread),
        )
        .route(
            "/v1/self-control/automations",
            get(list_self_control_automations).post(create_self_control_automation),
        )
        .route(
            "/v1/self-control/automations/{automation_id}",
            get(get_self_control_automation)
                .patch(update_self_control_automation)
                .delete(delete_self_control_automation),
        )
        .route(
            "/v1/self-control/automations/{automation_id}/pause",
            post(pause_self_control_automation),
        )
        .route(
            "/v1/self-control/automations/{automation_id}/resume",
            post(resume_self_control_automation),
        )
        .route(
            "/v1/self-control/automations/{automation_id}/run-now",
            post(run_self_control_automation_now),
        )
        .route(
            "/v1/self-control/automations/validate",
            post(validate_self_control_automation),
        )
        .route(
            "/v1/self-control/approvals",
            get(list_self_control_approvals),
        )
        .route(
            "/v1/self-control/approvals/{approval_id}",
            get(get_self_control_approval),
        )
        .route(
            "/v1/self-control/approvals/{approval_id}/decision",
            post(decide_self_control_approval),
        )
        .route("/v1/self-control/events", get(list_self_control_events))
}

/// Provenance supplied by Kodex Control MCP tools when they call guarded self-control endpoints.
///
/// Self-control endpoints are the agent-facing product boundary for Kodex-managed mutations.
/// MCP tools should use these routes instead of raw thread or automation CRUD routes so
/// gateway-owned policy, reconciliation, provenance, and audit behavior stay centralized.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlSource {
    /// Self-control provenance marker. The only accepted value is `kodex_control`.
    #[serde(default = "default_self_control_source_type")]
    pub source_type: SelfControlSourceType,
    /// Originating Kodex thread, when this request came from another thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_thread_id: Option<String>,
    /// Originating Kodex turn, when this request came from a specific turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_turn_id: Option<String>,
    /// Originating MCP tool call id or equivalent agent tool invocation id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_tool_call_id: Option<String>,
    /// Whether the request was directly user-requested or agent-initiated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_by: Option<SelfControlRequestedBy>,
    /// Short reason recorded in audit/provenance payloads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl Default for SelfControlSource {
    fn default() -> Self {
        Self {
            source_type: default_self_control_source_type(),
            source_thread_id: None,
            source_turn_id: None,
            source_tool_call_id: None,
            requested_by: None,
            reason: None,
        }
    }
}

impl SelfControlSource {
    pub(super) fn to_value(&self) -> Value {
        let mut value = serde_json::Map::new();
        value.insert("sourceType".to_string(), json!("kodex_control"));
        if let Some(source_thread_id) = &self.source_thread_id {
            value.insert("sourceThreadId".to_string(), json!(source_thread_id));
        }
        if let Some(source_turn_id) = &self.source_turn_id {
            value.insert("sourceTurnId".to_string(), json!(source_turn_id));
        }
        if let Some(source_tool_call_id) = &self.source_tool_call_id {
            value.insert("sourceToolCallId".to_string(), json!(source_tool_call_id));
        }
        if let Some(requested_by) = &self.requested_by {
            value.insert("requestedBy".to_string(), json!(requested_by));
        }
        if let Some(reason) = &self.reason {
            value.insert("reason".to_string(), json!(reason));
        }
        Value::Object(value)
    }
}

fn default_self_control_source_type() -> SelfControlSourceType {
    SelfControlSourceType::KodexControl
}

/// Allowed provenance source type for self-control requests.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SelfControlSourceType {
    KodexControl,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum SelfControlRequestedBy {
    User,
    Agent,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlStatusResponse {
    pub version: String,
    pub gateway_ready: bool,
    pub app_server_ready: bool,
    pub app_server_error: Option<String>,
    pub capabilities: SelfControlCapabilities,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlCapabilities {
    pub threads: bool,
    pub automations: bool,
    pub mcp_resources: bool,
    pub app_surfaces: bool,
}

#[utoipa::path(
    get,
    path = "/v1/self-control/status",
    summary = "Read Kodex self-control readiness",
    description = "Agent-facing guarded self-control status endpoint. MCP tools use the /v1/self-control namespace instead of raw CRUD routes so gateway-owned policy, provenance, and audit behavior stay centralized.",
    responses((status = 200, body = SelfControlStatusResponse))
)]
pub async fn self_control_status(
    State(state): State<AppState>,
) -> ApiResult<Json<SelfControlStatusResponse>> {
    Ok(Json(SelfControlStatusResponse {
        version: "0.1.0".to_string(),
        gateway_ready: true,
        app_server_ready: state.app_server.is_ready(),
        app_server_error: state.app_server.readiness_error(),
        capabilities: SelfControlCapabilities {
            threads: true,
            automations: true,
            mcp_resources: true,
            app_surfaces: true,
        },
    }))
}

#[utoipa::path(
    get,
    path = "/v1/self-control/projects",
    summary = "List projects through self-control",
    responses((status = 200, body = ProjectListResponse))
)]
pub async fn list_self_control_projects(
    State(state): State<AppState>,
) -> ApiResult<Json<ProjectListResponse>> {
    crate::routes::projects::list_projects(State(state)).await
}

#[utoipa::path(
    get,
    path = "/v1/self-control/projects/{projectId}",
    summary = "Read a project through self-control",
    responses((status = 200, body = Project))
)]
pub async fn get_self_control_project(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> ApiResult<Json<Project>> {
    crate::routes::projects::get_project(State(state), Path(project_id)).await
}

#[utoipa::path(
    get,
    path = "/v1/self-control/threads",
    params(ThreadListQuery),
    summary = "List project threads through self-control",
    responses((status = 200, body = ThreadListResponse))
)]
pub async fn list_self_control_threads(
    State(state): State<AppState>,
    Query(query): Query<ThreadListQuery>,
) -> ApiResult<Json<ThreadListResponse>> {
    crate::routes::threads::list_threads(State(state), Query(query)).await
}

#[utoipa::path(
    get,
    path = "/v1/self-control/sidebar/threads",
    summary = "Read sidebar thread lists through self-control",
    responses((status = 200, body = SidebarThreadsResponse))
)]
pub async fn get_self_control_sidebar_threads(
    State(state): State<AppState>,
) -> ApiResult<Json<SidebarThreadsResponse>> {
    crate::routes::threads::get_sidebar_threads(State(state)).await
}

#[utoipa::path(
    get,
    path = "/v1/self-control/threads/{threadId}",
    summary = "Read a thread detail view through self-control",
    responses((status = 200, body = ThreadViewResponse))
)]
pub async fn get_self_control_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> ApiResult<Json<ThreadViewResponse>> {
    crate::routes::threads::get_thread(State(state), Path(thread_id)).await
}

#[utoipa::path(
    get,
    path = "/v1/self-control/threads/{threadId}/timeline/pages",
    params(ThreadTimelinePageQuery),
    summary = "Read a thread timeline page through self-control",
    responses((status = 200, body = ThreadViewResponse))
)]
pub async fn get_self_control_thread_timeline_page(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Query(query): Query<ThreadTimelinePageQuery>,
) -> ApiResult<Json<ThreadViewResponse>> {
    crate::routes::threads::get_thread_timeline_page(State(state), Path(thread_id), Query(query))
        .await
}

#[utoipa::path(
    get,
    path = "/v1/self-control/threads/{threadId}/subagents",
    summary = "List subagents through self-control",
    params(ThreadSubagentListQuery),
    responses((status = 200, body = ThreadSubagentListResponse))
)]
pub async fn list_self_control_subagents(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Query(query): Query<ThreadSubagentListQuery>,
) -> ApiResult<Json<ThreadSubagentListResponse>> {
    crate::routes::subagents::list_subagents(State(state), Path(thread_id), Query(query)).await
}

#[utoipa::path(
    get,
    path = "/v1/self-control/threads/{threadId}/queued-inputs",
    summary = "List queued inputs through self-control",
    responses((status = 200, body = crate::queue::QueuedInputListResponse))
)]
pub async fn list_self_control_queued_inputs(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> ApiResult<Json<crate::queue::QueuedInputListResponse>> {
    crate::queue::list_queued_inputs(
        State(state),
        Path(thread_id),
        Query(crate::queue::QueuedInputListQuery::default()),
    )
    .await
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlGeneratedAppSurfaceUpsertRequest {
    pub title: String,
    pub html: String,
    pub fallback_content: String,
    #[serde(default)]
    pub presentation: Option<AppSurfacePresentationAction>,
    #[serde(default)]
    pub display_modes: Vec<String>,
    #[serde(default)]
    pub csp: AppSurfaceCsp,
    #[serde(default)]
    pub permissions: AppSurfacePermissions,
    #[serde(default)]
    pub grants: AppSurfaceGrants,
    #[serde(default)]
    pub provenance: Value,
    #[serde(default)]
    pub source: SelfControlSource,
    #[serde(default)]
    pub max_self_control_depth: Option<u8>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlAppSurfacePresentationRequest {
    pub action: AppSurfacePresentationAction,
    #[serde(default)]
    pub source: SelfControlSource,
    #[serde(default)]
    pub max_self_control_depth: Option<u8>,
}

#[utoipa::path(
    get,
    path = "/v1/self-control/threads/{threadId}/app-surface",
    summary = "Read the latest app surface for a thread through self-control",
    responses((status = 200, body = AppSurfaceSessionReadResponse))
)]
pub async fn get_self_control_app_surface(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> ApiResult<Json<AppSurfaceSessionReadResponse>> {
    require_control_thread(&state, &thread_id).await?;
    crate::routes::app_surfaces::get_thread_app_surface(State(state), Path(thread_id)).await
}

#[utoipa::path(
    post,
    path = "/v1/self-control/threads/{threadId}/app-surface",
    summary = "Open or replace a generated app surface through self-control",
    description = "Agent-facing generated app-surface endpoint. The HTML is stored as an MCP App-compatible resource and rendered in the shared app-surface iframe runtime. Grants declare which bridge capabilities the generated surface may use.",
    request_body = SelfControlGeneratedAppSurfaceUpsertRequest,
    responses((status = 200, body = AppSurfaceSessionResponse))
)]
pub async fn upsert_self_control_generated_app_surface(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<SelfControlGeneratedAppSurfaceUpsertRequest>,
) -> ApiResult<Json<AppSurfaceSessionResponse>> {
    enforce_self_control_depth(request.max_self_control_depth)?;
    let title = validate_app_surface_title(request.title)?;
    let html = validate_generated_app_surface_html(request.html)?;
    let fallback_content = request.fallback_content.trim().to_string();
    if fallback_content.is_empty() {
        return Err(ApiError::BadRequest(
            "app surface fallback content cannot be empty".to_string(),
        ));
    }
    let grants = validate_app_surface_grants(AppSurfaceProvider::Generated, request.grants)?;
    require_control_thread(&state, &thread_id).await?;
    let display_modes = if request.display_modes.is_empty() {
        vec!["inline".to_string(), "fullscreen".to_string()]
    } else {
        request.display_modes
    };
    let session = state
        .store
        .upsert_app_surface_session(AppSurfaceSessionUpsert {
            thread_id: thread_id.clone(),
            provider: AppSurfaceProvider::Generated,
            title,
            resource_uri: None,
            resource_mime_type: MCP_APP_MIME_TYPE.to_string(),
            html,
            fallback_content,
            display_modes,
            csp: request.csp,
            permissions: request.permissions,
            grants,
            provenance: json!({
                "source": request.source.to_value(),
                "generated": request.provenance
            }),
        })
        .await?;
    broadcast_app_surface_event(&state, APP_SURFACE_UPSERTED_EVENT, &session).await?;
    if let Some(action) = request.presentation {
        broadcast_app_surface_presentation_request(
            &state,
            app_surface_presentation_request(
                action,
                &thread_id,
                Some(&session.id),
                Some(&session.title),
            ),
        )
        .await?;
    }
    audit_self_control(
        &state,
        None,
        Some(&thread_id),
        "self_control.app_surface_upserted",
        json!({
            "source": request.source.to_value(),
            "sessionId": session.id,
            "revision": session.revision,
            "provider": "generated",
            "presentation": request.presentation.map(|action| action.as_str())
        }),
    )
    .await?;
    Ok(Json(AppSurfaceSessionResponse {
        session: app_surface_session_dto(session),
    }))
}

#[utoipa::path(
    post,
    path = "/v1/self-control/threads/{threadId}/app-surface/presentation",
    summary = "Open or focus the latest app surface pane through self-control",
    request_body = SelfControlAppSurfacePresentationRequest,
    responses((status = 200, body = AppSurfacePresentationResponse))
)]
pub async fn request_self_control_app_surface_presentation(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<SelfControlAppSurfacePresentationRequest>,
) -> ApiResult<Json<AppSurfacePresentationResponse>> {
    enforce_self_control_depth(request.max_self_control_depth)?;
    require_control_thread(&state, &thread_id).await?;
    let session = state
        .store
        .latest_app_surface_session(&thread_id)
        .await?
        .filter(|session| session.status != AppSurfaceSessionStatus::Archived)
        .ok_or_else(|| ApiError::NotFound(format!("app surface for thread {thread_id}")))?;
    let presentation = app_surface_presentation_request(
        request.action,
        &thread_id,
        Some(&session.id),
        Some(&session.title),
    );
    broadcast_app_surface_presentation_request(&state, presentation.clone()).await?;
    audit_self_control(
        &state,
        None,
        Some(&thread_id),
        "self_control.app_surface_presentation_requested",
        json!({
            "source": request.source.to_value(),
            "sessionId": session.id,
            "revision": session.revision,
            "provider": session.provider.as_str(),
            "presentation": request.action.as_str()
        }),
    )
    .await?;
    Ok(Json(AppSurfacePresentationResponse {
        request: presentation,
    }))
}

fn app_surface_presentation_request(
    action: AppSurfacePresentationAction,
    thread_id: &str,
    session_id: Option<&str>,
    title: Option<&str>,
) -> AppSurfacePresentationRequestDto {
    AppSurfacePresentationRequestDto {
        thread_id: thread_id.to_string(),
        session_id: session_id.map(str::to_string),
        action,
        title: title.map(str::to_string),
    }
}

#[utoipa::path(
    delete,
    path = "/v1/self-control/threads/{threadId}/app-surface",
    summary = "Archive the latest app surface for a thread through self-control",
    request_body = SelfControlMutationRequest,
    responses((status = 200, body = AppSurfaceSessionReadResponse))
)]
pub async fn archive_self_control_app_surface(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    request: Option<Json<SelfControlMutationRequest>>,
) -> ApiResult<Json<AppSurfaceSessionReadResponse>> {
    let source = optional_source(request);
    require_control_thread(&state, &thread_id).await?;
    let session = state
        .store
        .archive_latest_app_surface_session(&thread_id)
        .await?;
    if let Some(session) = &session {
        broadcast_app_surface_event(&state, APP_SURFACE_ARCHIVED_EVENT, session).await?;
    }
    audit_self_control(
        &state,
        None,
        Some(&thread_id),
        "self_control.app_surface_archived",
        json!({ "source": source.to_value() }),
    )
    .await?;
    Ok(Json(AppSurfaceSessionReadResponse {
        session: session.map(app_surface_session_dto),
    }))
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlCreateThreadRequest {
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
    #[serde(default)]
    pub source: SelfControlSource,
    #[serde(default)]
    pub max_self_control_depth: Option<u8>,
}

#[utoipa::path(
    post,
    path = "/v1/self-control/threads",
    summary = "Create a Kodex thread through self-control",
    description = "Agent-facing guarded thread creation endpoint. It delegates native thread creation and shared settings while preserving guarded provenance.",
    request_body = SelfControlCreateThreadRequest,
    responses((status = 200, body = ThreadCommandResponse))
)]
pub async fn create_self_control_thread(
    State(state): State<AppState>,
    Json(request): Json<SelfControlCreateThreadRequest>,
) -> ApiResult<Json<ThreadCommandResponse>> {
    enforce_self_control_depth(request.max_self_control_depth)?;
    let cwd =
        crate::routes::projects::project_execution_cwd(&state, &request.project_id, request.cwd)
            .await?;
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
        .thread_start(request.project_id.clone(), cwd, payload)
        .await?;
    crate::read_state::catalog_changed(&state, "thread/started", &response.thread.id).await?;
    apply_thread_command_response_state(&state, &mut response).await?;
    broadcast_thread_upserted(
        &state,
        ThreadUpsertScope::Project,
        Some(&request.project_id),
        &response.thread,
    )
    .await?;
    audit_self_control(
        &state,
        Some(&request.project_id),
        Some(&response.thread.id),
        "self_control.thread_created",
        json!({ "source": request.source.to_value() }),
    )
    .await?;
    Ok(Json(response))
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelfControlThreadInputRequest {
    pub input: Vec<Value>,
    #[serde(default)]
    pub source: SelfControlSource,
    #[serde(default)]
    pub max_self_control_depth: Option<u8>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlThreadInputResponse {
    pub action: SelfControlThreadInputAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<RawAppServerResponse>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued_input: Option<QueuedInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum SelfControlThreadInputAction {
    Queued,
}

#[utoipa::path(
    post,
    path = "/v1/self-control/threads/{threadId}/input",
    summary = "Send input to a Kodex thread through self-control",
    description = "Activate the target and submit one native queued message. Native ordering and pause behavior apply; this never steers the user’s active turn and never retries an uncertain admission.",
    request_body = SelfControlThreadInputRequest,
    responses((status = 200, body = SelfControlThreadInputResponse))
)]
pub async fn send_self_control_thread_input(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<SelfControlThreadInputRequest>,
) -> ApiResult<Json<SelfControlThreadInputResponse>> {
    enforce_self_control_depth(request.max_self_control_depth)?;
    let _guard = state.thread_input_locks.lock(&thread_id).await;
    let client = app_server_api::client(&state.app_server);
    client.activate_input_target(&thread_id).await?;
    let client_id = uuid::Uuid::new_v4().to_string();
    audit_self_control(
        &state,
        None,
        Some(&thread_id),
        "self_control.thread_input_admitting",
        json!({"source":request.source.to_value(), "clientUserMessageId":client_id}),
    )
    .await?;
    let row =
        crate::queue_transfer::enqueue_locked(&state, &thread_id, request.input, client_id).await?;
    queue::broadcast_changed_best_effort(&state, &thread_id).await;
    let queued_input = queue::project_row(&state, &thread_id, row);
    // An accepted native write must not become a retryable error solely because
    // its audit/refill publication fails.
    if let Err(error) = audit_self_control(&state, None, Some(&thread_id), "self_control.thread_input", json!({"source":request.source.to_value(), "action":"queued", "queuedInputId":queued_input.id})).await {
        tracing::warn!(%error, "failed to audit accepted Control input");
    }
    Ok(Json(SelfControlThreadInputResponse {
        action: SelfControlThreadInputAction::Queued,
        turn: None,
        queued_input: Some(queued_input),
    }))
}

#[derive(Debug, Default, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlMutationRequest {
    #[serde(default)]
    pub source: SelfControlSource,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlThreadPayloadMutationRequest {
    #[serde(default)]
    pub payload: Value,
    #[serde(default)]
    pub source: SelfControlSource,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlRenameThreadRequest {
    pub name: String,
    #[serde(default)]
    pub source: SelfControlSource,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlThreadSettingsUpdateRequest {
    #[serde(flatten)]
    pub update: ThreadSettingsUpdateRequest,
    #[serde(default)]
    pub source: SelfControlSource,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlMarkThreadSeenRequest {
    pub completed_turn_id: String,
    pub read_revision: i64,
    #[serde(default)]
    pub source: SelfControlSource,
}

// External caller metadata and extension rows never establish native ownership.
// A metadata-only read checks this runtime without loading or importing a chat.
async fn require_control_thread(state: &AppState, thread_id: &str) -> ApiResult<()> {
    if thread_id.trim().is_empty() {
        return Err(ApiError::BadRequest("threadId must not be empty".into()));
    }
    let thread = app_server_api::client(&state.app_server)
        .thread_read_summary(thread_id.to_owned())
        .await?;
    if thread.id != thread_id {
        return Err(ApiError::BadGateway(
            "native thread/read returned a different thread identity".into(),
        ));
    }
    Ok(())
}

#[utoipa::path(
    post,
    path = "/v1/self-control/threads/{threadId}/attach",
    summary = "Attach or resume a thread through self-control",
    request_body = SelfControlMutationRequest,
    responses((status = 200, body = ThreadViewResponse))
)]
pub async fn attach_self_control_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    request: Option<Json<SelfControlMutationRequest>>,
) -> ApiResult<Json<ThreadViewResponse>> {
    let source = optional_source(request);
    let response =
        crate::routes::threads::attach_thread(State(state.clone()), Path(thread_id.clone()))
            .await?;
    audit_thread_mutation(&state, &thread_id, "self_control.thread_attached", source).await?;
    Ok(response)
}

#[utoipa::path(
    post,
    path = "/v1/self-control/threads/{threadId}/resume",
    summary = "Resume a thread through self-control",
    request_body = SelfControlThreadPayloadMutationRequest,
    responses((status = 200, body = ThreadCommandResponse))
)]
pub async fn resume_self_control_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    request: Option<Json<SelfControlThreadPayloadMutationRequest>>,
) -> ApiResult<Json<ThreadCommandResponse>> {
    require_control_thread(&state, &thread_id).await?;
    let request = request.map(|Json(request)| request).unwrap_or_else(|| {
        SelfControlThreadPayloadMutationRequest {
            payload: json!({}),
            source: SelfControlSource::default(),
        }
    });
    let response = crate::routes::threads::resume_thread(
        State(state.clone()),
        Path(thread_id.clone()),
        Json(request.payload),
    )
    .await?;
    audit_thread_mutation(
        &state,
        &thread_id,
        "self_control.thread_resumed",
        request.source,
    )
    .await?;
    Ok(response)
}

#[utoipa::path(
    post,
    path = "/v1/self-control/threads/{threadId}/fork",
    summary = "Fork a thread through self-control",
    request_body = SelfControlThreadPayloadMutationRequest,
    responses((status = 200, body = ThreadCommandResponse))
)]
pub async fn fork_self_control_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    request: Option<Json<SelfControlThreadPayloadMutationRequest>>,
) -> ApiResult<Json<ThreadCommandResponse>> {
    require_control_thread(&state, &thread_id).await?;
    let request = request.map(|Json(request)| request).unwrap_or_else(|| {
        SelfControlThreadPayloadMutationRequest {
            payload: json!({}),
            source: SelfControlSource::default(),
        }
    });
    let response = crate::routes::threads::fork_thread(
        State(state.clone()),
        Path(thread_id.clone()),
        Json(request.payload),
    )
    .await?;
    let forked_thread_id = response.thread.id.clone();
    audit_self_control(
        &state,
        None,
        Some(&thread_id),
        "self_control.thread_forked",
        json!({
            "source": request.source.to_value(),
            "forkedThreadId": forked_thread_id
        }),
    )
    .await?;
    Ok(response)
}

#[utoipa::path(
    patch,
    path = "/v1/self-control/threads/{threadId}/name",
    summary = "Rename a thread through self-control",
    request_body = SelfControlRenameThreadRequest,
    responses((status = 200, body = RenameThreadResponse))
)]
pub async fn rename_self_control_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<SelfControlRenameThreadRequest>,
) -> ApiResult<Json<RenameThreadResponse>> {
    let source = request.source;
    let response = crate::routes::threads::rename_thread(
        State(state.clone()),
        Path(thread_id.clone()),
        Json(RenameThreadRequest { name: request.name }),
    )
    .await?;
    audit_thread_mutation(&state, &thread_id, "self_control.thread_renamed", source).await?;
    Ok(response)
}

#[utoipa::path(
    patch,
    path = "/v1/self-control/threads/{threadId}/settings",
    summary = "Update thread settings through self-control",
    request_body = SelfControlThreadSettingsUpdateRequest,
    responses((status = 202, body = ThreadSettingsUpdateResponse))
)]
pub async fn update_self_control_thread_settings(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<SelfControlThreadSettingsUpdateRequest>,
) -> ApiResult<(axum::http::StatusCode, Json<ThreadSettingsUpdateResponse>)> {
    let source = request.source;
    let response = crate::routes::thread_settings::update_thread_settings(
        State(state.clone()),
        Path(thread_id.clone()),
        Json(request.update),
    )
    .await?;
    audit_thread_mutation(
        &state,
        &thread_id,
        "self_control.thread_settings_update_queued",
        source,
    )
    .await?;
    Ok(response)
}

#[utoipa::path(
    post,
    path = "/v1/self-control/threads/{threadId}/archive",
    summary = "Archive a thread through self-control",
    request_body = SelfControlMutationRequest,
    responses((status = 200, body = RawAppServerResponse))
)]
pub async fn archive_self_control_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    request: Option<Json<SelfControlMutationRequest>>,
) -> ApiResult<Json<RawAppServerResponse>> {
    let source = optional_source(request);
    let response =
        crate::routes::threads::archive_thread(State(state.clone()), Path(thread_id.clone()))
            .await?;
    audit_thread_mutation(&state, &thread_id, "self_control.thread_archived", source).await?;
    Ok(response)
}

#[utoipa::path(
    post,
    path = "/v1/self-control/threads/{threadId}/seen",
    summary = "Mark a thread seen through self-control",
    request_body = SelfControlMarkThreadSeenRequest,
    responses((status = 200, body = MarkThreadSeenResponse))
)]
pub async fn mark_self_control_thread_seen(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<SelfControlMarkThreadSeenRequest>,
) -> ApiResult<Json<MarkThreadSeenResponse>> {
    let response = crate::routes::threads::mark_thread_seen(
        State(state.clone()),
        Path(thread_id.clone()),
        Json(MarkThreadSeenRequest {
            completed_turn_id: request.completed_turn_id,
            read_revision: request.read_revision,
        }),
    )
    .await?;
    audit_thread_mutation(
        &state,
        &thread_id,
        "self_control.thread_seen",
        request.source,
    )
    .await?;
    Ok(response)
}

#[utoipa::path(
    post,
    path = "/v1/self-control/threads/{threadId}/compact",
    summary = "Compact a thread through self-control",
    request_body = SelfControlMutationRequest,
    responses((status = 200, body = ThreadCompactResponse))
)]
pub async fn compact_self_control_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    request: Option<Json<SelfControlMutationRequest>>,
) -> ApiResult<Json<ThreadCompactResponse>> {
    let source = optional_source(request);
    let response =
        crate::routes::turns::compact_thread(State(state.clone()), Path(thread_id.clone())).await?;
    audit_thread_mutation(&state, &thread_id, "self_control.thread_compacted", source).await?;
    Ok(response)
}

#[utoipa::path(
    post,
    path = "/v1/self-control/threads/{threadId}/interrupt-current",
    summary = "Interrupt the current turn through self-control",
    request_body = SelfControlMutationRequest,
    responses((status = 200, body = ThreadInterruptCurrentResponse))
)]
pub async fn interrupt_current_self_control_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    request: Option<Json<SelfControlMutationRequest>>,
) -> ApiResult<Json<ThreadInterruptCurrentResponse>> {
    let source = optional_source(request);
    let response =
        crate::routes::turns::interrupt_current_turn(State(state.clone()), Path(thread_id.clone()))
            .await?;
    audit_thread_mutation(
        &state,
        &thread_id,
        "self_control.thread_interrupted_current",
        source,
    )
    .await?;
    Ok(response)
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlThreadSpawnRequest {
    pub project_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub input: Vec<UserInput>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nickname: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    #[serde(default)]
    pub payload: Value,
    #[serde(default)]
    pub source: SelfControlSource,
    #[serde(default)]
    pub idempotency_key: Option<String>,
    #[serde(default)]
    pub max_self_control_depth: Option<u8>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlThreadSpawnResponse {
    pub thread_id: String,
    pub idempotency_key: Option<String>,
    pub remaining_self_control_depth: u8,
    pub queued_submission_id: String,
    pub client_user_message_id: String,
    pub idempotent_replay: bool,
}

#[utoipa::path(
    post,
    path = "/v1/self-control/thread-spawns",
    summary = "Create a thread and submit its first input through self-control",
    request_body = SelfControlThreadSpawnRequest,
    responses((status = 200, body = SelfControlThreadSpawnResponse))
)]
pub async fn spawn_self_control_thread(
    State(state): State<AppState>,
    Json(request): Json<SelfControlThreadSpawnRequest>,
) -> ApiResult<Json<SelfControlThreadSpawnResponse>> {
    let remaining_depth = consume_self_control_depth(request.max_self_control_depth)?;
    let idempotency_key = request
        .idempotency_key
        .clone()
        .or_else(|| request.source.source_tool_call_id.clone());
    let _key_guard = if let Some(key) = &idempotency_key {
        Some(state.self_control_spawn_locks.lock(key).await)
    } else {
        None
    };
    if let Some(key) = &idempotency_key {
        if let Some(event) = state
            .store
            .find_control_spawn_event("self_control.thread_spawned", key)
            .await?
        {
            let mut response: SelfControlThreadSpawnResponse =
                serde_json::from_value(event.payload["response"].clone())?;
            response.idempotent_replay = true;
            return Ok(Json(response));
        }
        if state
            .store
            .find_control_spawn_event("self_control.thread_spawn_admitting", key)
            .await?
            .is_some()
        {
            return Err(ApiError::Conflict("Prior spawn admission is uncertain; inspect native threads/history before explicitly starting another attempt with a new key".into()));
        }
    }
    // One durable intent before either native write. Creation/input lost ACKs
    // never authorize repeating the same key; no partial-spawn repair engine.
    audit_self_control(
        &state,
        Some(&request.project_id),
        None,
        "self_control.thread_spawn_admitting",
        json!({"idempotencyKey":idempotency_key,"source":request.source.to_value()}),
    )
    .await?;

    let mut payload = request.payload.clone();
    if let Some(object) = payload.as_object_mut() {
        if let Some(role) = request.role.as_ref() {
            object.insert("agentRole".to_string(), json!(role));
        }
        if let Some(nickname) = request.nickname.as_ref() {
            object.insert("agentNickname".to_string(), json!(nickname));
        }
        if let Some(goal) = request.goal.as_ref() {
            object.insert("goal".to_string(), json!(goal));
        }
    }

    let thread_response = create_self_control_thread(
        State(state.clone()),
        Json(SelfControlCreateThreadRequest {
            project_id: request.project_id.clone(),
            cwd: request.cwd,
            model: request.model,
            effort: request.effort,
            service_tier: request.service_tier,
            approval_policy: request.approval_policy,
            approvals_reviewer: request.approvals_reviewer,
            permissions: request.permissions,
            sandbox: request.sandbox,
            payload,
            source: request.source.clone(),
            max_self_control_depth: None,
        }),
    )
    .await?
    .0;
    let thread_id = thread_response.thread.id.clone();
    let input_response = send_self_control_thread_input(
        State(state.clone()),
        Path(thread_id.clone()),
        Json(SelfControlThreadInputRequest {
            input: request
                .input
                .into_iter()
                .map(serde_json::to_value)
                .collect::<Result<Vec<_>, _>>()?,
            source: request.source.clone(),
            max_self_control_depth: None,
        }),
    )
    .await?
    .0;
    let row = input_response
        .queued_input
        .ok_or_else(|| ApiError::BadGateway("Control input admission was not confirmed".into()))?;
    let response = SelfControlThreadSpawnResponse {
        thread_id: thread_id.clone(),
        idempotency_key,
        remaining_self_control_depth: remaining_depth,
        queued_submission_id: row.id,
        client_user_message_id: row.client_user_message_id,
        idempotent_replay: false,
    };
    if let Err(error) = audit_self_control(&state, Some(&request.project_id), Some(&thread_id), "self_control.thread_spawned", json!({"idempotencyKey":response.idempotency_key,"source":request.source.to_value(),"response":response})).await {
        // Current caller receives the native ACK. A later replay lacking this
        // audit record sees the durable uncertain intent and cannot resubmit.
        tracing::warn!(%error, "failed to cache accepted Control spawn");
    }
    Ok(Json(response))
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlAutomationCreateRequest {
    pub name: String,
    pub prompt: String,
    pub target_thread_id: String,
    pub schedule: AutomationSchedule,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub source: SelfControlSource,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlAutomationUpdateRequest {
    #[serde(flatten)]
    pub update: AutomationUpdateRequest,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub source: Option<SelfControlSource>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlAutomationResponse {
    pub automation: AutomationDto,
    pub paused_by_default: bool,
}

#[utoipa::path(
    post,
    path = "/v1/self-control/automations",
    summary = "Create a Kodex automation through self-control",
    description = "Agent-facing guarded automation creation endpoint. New self-control automations default to paused unless explicitly enabled, and provenance is stored durably.",
    request_body = SelfControlAutomationCreateRequest,
    responses((status = 200, body = SelfControlAutomationResponse))
)]
pub async fn create_self_control_automation(
    State(state): State<AppState>,
    Json(request): Json<SelfControlAutomationCreateRequest>,
) -> ApiResult<Json<SelfControlAutomationResponse>> {
    validate_name_and_prompt(&request.name, &request.prompt)?;
    validate_target_thread(&state, &request.target_thread_id).await?;
    let repeat_every_seconds = repeat_every_seconds(&request.schedule.repeat_every)?;
    let enabled = request.enabled.unwrap_or(false);
    let automation = state
        .store
        .create_automation(NewAutomation {
            name: request.name,
            prompt: request.prompt,
            target_thread_id: request.target_thread_id,
            start_at: request.schedule.start_at,
            repeat_every_seconds,
            next_run_at: request.schedule.start_at,
            status: if enabled {
                AutomationStatus::Active
            } else {
                AutomationStatus::Paused
            },
            paused_reason: (!enabled).then(|| "selfControlRequiresExplicitEnable".to_string()),
            provenance: Some(request.source.to_value()),
        })
        .await?;
    broadcast_automation_upsert(&state, &automation).await?;
    Ok(Json(SelfControlAutomationResponse {
        automation: automation_to_dto(automation),
        paused_by_default: !enabled,
    }))
}

#[utoipa::path(
    patch,
    path = "/v1/self-control/automations/{automationId}",
    summary = "Update a Kodex automation through self-control",
    description = "Agent-facing guarded automation update endpoint. It reuses gateway validation and only replaces stored provenance when a new self-control source is supplied.",
    request_body = SelfControlAutomationUpdateRequest,
    responses((status = 200, body = SelfControlAutomationResponse))
)]
pub async fn update_self_control_automation(
    State(state): State<AppState>,
    Path(automation_id): Path<String>,
    Json(request): Json<SelfControlAutomationUpdateRequest>,
) -> ApiResult<Json<SelfControlAutomationResponse>> {
    if let Some(name) = request.update.name.as_deref() {
        validate_name_and_prompt(name, "placeholder")?;
    }
    if let Some(prompt) = request.update.prompt.as_deref() {
        validate_name_and_prompt("placeholder", prompt)?;
    }
    if let Some(target_thread_id) = request.update.target_thread_id.as_deref() {
        validate_target_thread(&state, target_thread_id).await?;
    }
    let (start_at, repeat_every_seconds, next_run_at) = match request.update.schedule {
        Some(schedule) => {
            let repeat_every_seconds = repeat_every_seconds(&schedule.repeat_every)?;
            (
                Some(schedule.start_at),
                Some(repeat_every_seconds),
                Some(schedule.start_at),
            )
        }
        None => (None, None, None),
    };
    let automation = state
        .store
        .update_automation(
            &automation_id,
            AutomationUpdate {
                name: request.update.name,
                prompt: request.update.prompt,
                target_thread_id: request.update.target_thread_id,
                start_at,
                repeat_every_seconds,
                next_run_at,
                status: request.enabled.map(|enabled| {
                    if enabled {
                        AutomationStatus::Active
                    } else {
                        AutomationStatus::Paused
                    }
                }),
                paused_reason: request.enabled.map(|enabled| {
                    if enabled {
                        None
                    } else {
                        Some("selfControlPaused".to_string())
                    }
                }),
                provenance: request.source.map(|source| source.to_value()),
            },
        )
        .await?;
    broadcast_automation_upsert(&state, &automation).await?;
    Ok(Json(SelfControlAutomationResponse {
        automation: automation_to_dto(automation),
        paused_by_default: false,
    }))
}

#[utoipa::path(
    post,
    path = "/v1/self-control/automations/{automationId}/pause",
    summary = "Pause a Kodex automation through self-control",
    description = "Agent-facing guarded automation pause endpoint that uses gateway-owned automation lifecycle policy and broadcasts.",
    responses((status = 200, body = SelfControlAutomationResponse))
)]
pub async fn pause_self_control_automation(
    State(state): State<AppState>,
    Path(automation_id): Path<String>,
) -> ApiResult<Json<SelfControlAutomationResponse>> {
    let automation = state
        .store
        .pause_automation(&automation_id, Some("selfControlPaused"))
        .await?;
    broadcast_automation_upsert(&state, &automation).await?;
    Ok(Json(SelfControlAutomationResponse {
        automation: automation_to_dto(automation),
        paused_by_default: false,
    }))
}

#[utoipa::path(
    post,
    path = "/v1/self-control/automations/{automationId}/resume",
    summary = "Resume a Kodex automation through self-control",
    description = "Agent-facing guarded automation resume endpoint that uses gateway-owned automation lifecycle policy and broadcasts.",
    responses((status = 200, body = SelfControlAutomationResponse))
)]
pub async fn resume_self_control_automation(
    State(state): State<AppState>,
    Path(automation_id): Path<String>,
) -> ApiResult<Json<SelfControlAutomationResponse>> {
    let automation = state.store.resume_automation(&automation_id).await?;
    broadcast_automation_upsert(&state, &automation).await?;
    Ok(Json(SelfControlAutomationResponse {
        automation: automation_to_dto(automation),
        paused_by_default: false,
    }))
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlAutomationRunNowRequest {
    #[serde(default)]
    pub source: SelfControlSource,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlAutomationRunNowResponse {
    pub automation: AutomationDto,
    pub run: AutomationRun,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlAutomationValidateRequest {
    pub name: String,
    pub prompt: String,
    pub target_thread_id: String,
    pub schedule: AutomationSchedule,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlAutomationValidateResponse {
    pub valid: bool,
    pub repeat_every_seconds: i64,
}

#[utoipa::path(
    get,
    path = "/v1/self-control/automations",
    params(AutomationListQuery),
    summary = "List automations through self-control",
    responses((status = 200, body = AutomationListResponse))
)]
pub async fn list_self_control_automations(
    State(state): State<AppState>,
    Query(query): Query<AutomationListQuery>,
) -> ApiResult<Json<AutomationListResponse>> {
    crate::routes::automations::list_automations(State(state), Query(query)).await
}

#[utoipa::path(
    get,
    path = "/v1/self-control/automations/{automationId}",
    summary = "Read an automation through self-control",
    responses((status = 200, body = AutomationResponse))
)]
pub async fn get_self_control_automation(
    State(state): State<AppState>,
    Path(automation_id): Path<String>,
) -> ApiResult<Json<AutomationResponse>> {
    crate::routes::automations::get_automation(State(state), Path(automation_id)).await
}

#[utoipa::path(
    delete,
    path = "/v1/self-control/automations/{automationId}",
    summary = "Delete an automation through self-control",
    request_body = SelfControlMutationRequest,
    responses((status = 200, body = AutomationDeleteResponse))
)]
pub async fn delete_self_control_automation(
    State(state): State<AppState>,
    Path(automation_id): Path<String>,
    request: Option<Json<SelfControlMutationRequest>>,
) -> ApiResult<Json<AutomationDeleteResponse>> {
    let source = optional_source(request);
    state.store.delete_automation(&automation_id).await?;
    broadcast_automation_delete(&state, &automation_id).await?;
    audit_self_control(
        &state,
        None,
        None,
        "self_control.automation_deleted",
        json!({
            "automationId": automation_id,
            "source": source.to_value()
        }),
    )
    .await?;
    Ok(Json(AutomationDeleteResponse { id: automation_id }))
}

#[utoipa::path(
    post,
    path = "/v1/self-control/automations/{automationId}/run-now",
    summary = "Queue an automation immediately through self-control",
    request_body = SelfControlAutomationRunNowRequest,
    responses((status = 200, body = SelfControlAutomationRunNowResponse))
)]
pub async fn run_self_control_automation_now(
    State(state): State<AppState>,
    Path(automation_id): Path<String>,
    request: Option<Json<SelfControlAutomationRunNowRequest>>,
) -> ApiResult<Json<SelfControlAutomationRunNowResponse>> {
    let source = request
        .map(|Json(request)| request.source)
        .unwrap_or_default();
    let automation = state.store.get_automation(&automation_id).await?;
    validate_target_thread(&state, &automation.target_thread_id).await?;
    let run = crate::automations::run_now(&state, &automation_id).await?;
    if let Err(error) = audit_self_control(&state, None, Some(&run.target_thread_id), "self_control.automation_run_now", json!({"automationId":automation_id, "runId":run.id, "nativeQueueId":run.native_queue_id, "source":source.to_value()})).await {
        tracing::warn!(%error, "failed to audit Control automation run");
    }
    Ok(Json(SelfControlAutomationRunNowResponse {
        automation: automation_to_dto(automation),
        run,
    }))
}

#[utoipa::path(
    post,
    path = "/v1/self-control/automations/validate",
    summary = "Validate automation input through self-control",
    request_body = SelfControlAutomationValidateRequest,
    responses((status = 200, body = SelfControlAutomationValidateResponse))
)]
pub async fn validate_self_control_automation(
    State(state): State<AppState>,
    Json(request): Json<SelfControlAutomationValidateRequest>,
) -> ApiResult<Json<SelfControlAutomationValidateResponse>> {
    validate_name_and_prompt(&request.name, &request.prompt)?;
    validate_target_thread(&state, &request.target_thread_id).await?;
    let repeat_every_seconds = repeat_every_seconds(&request.schedule.repeat_every)?;
    Ok(Json(SelfControlAutomationValidateResponse {
        valid: true,
        repeat_every_seconds,
    }))
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlApprovalDecisionRequest {
    pub decision: Value,
    #[serde(default)]
    pub source: SelfControlSource,
    #[serde(default)]
    pub requested_by: Option<SelfControlRequestedBy>,
    #[serde(default)]
    pub policy_token: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlApprovalDecisionResponse {
    pub approval: Approval,
    pub policy: SelfControlApprovalPolicyResult,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlApprovalPolicyResult {
    pub allowed: bool,
    pub reason: String,
}

#[utoipa::path(
    get,
    path = "/v1/self-control/approvals",
    params(ApprovalListQuery),
    summary = "List approvals through self-control",
    responses((status = 200, body = ApprovalListResponse))
)]
pub async fn list_self_control_approvals(
    State(state): State<AppState>,
    Query(query): Query<ApprovalListQuery>,
) -> ApiResult<Json<ApprovalListResponse>> {
    crate::routes::approvals::list_approvals(State(state), Query(query)).await
}

#[utoipa::path(
    get,
    path = "/v1/self-control/approvals/{approvalId}",
    summary = "Read an approval through self-control",
    responses((status = 200, body = Approval))
)]
pub async fn get_self_control_approval(
    State(state): State<AppState>,
    Path(approval_id): Path<String>,
) -> ApiResult<Json<Approval>> {
    crate::routes::approvals::get_approval(State(state), Path(approval_id)).await
}

#[utoipa::path(
    post,
    path = "/v1/self-control/approvals/{approvalId}/decision",
    summary = "Apply a policy-checked approval decision through self-control",
    request_body = SelfControlApprovalDecisionRequest,
    responses((status = 200, body = SelfControlApprovalDecisionResponse))
)]
pub async fn decide_self_control_approval(
    State(state): State<AppState>,
    Path(approval_id): Path<String>,
    Json(request): Json<SelfControlApprovalDecisionRequest>,
) -> ApiResult<Json<SelfControlApprovalDecisionResponse>> {
    let approval = crate::approvals::get_approval(&state, &approval_id).await?;
    validate_approval_response(&approval.method, &request.decision)?;
    let policy = approval_policy_result(&request)?;
    audit_self_control(
        &state,
        None,
        approval.thread_id.as_deref(),
        "self_control.approval_decision_requested",
        json!({
            "approvalId": approval_id,
            "decision": request.decision.clone(),
            "policy": policy.clone(),
            "source": request.source.to_value()
        }),
    )
    .await?;
    if !policy.allowed {
        return Err(ApiError::BadRequest(policy.reason));
    }
    let resolved =
        crate::approvals::decide_approval(&state, &approval_id, request.decision).await?;
    audit_self_control(
        &state,
        None,
        resolved.thread_id.as_deref(),
        "self_control.approval_decision_submitted",
        json!({
            "approvalId": approval_id,
            "policy": policy.clone(),
            "source": request.source.to_value()
        }),
    )
    .await?;
    Ok(Json(SelfControlApprovalDecisionResponse {
        approval: resolved,
        policy,
    }))
}

#[utoipa::path(
    get,
    path = "/v1/self-control/events",
    params(EventsQuery),
    summary = "Replay gateway events through self-control",
    responses((status = 200, body = EventListResponse))
)]
pub async fn list_self_control_events(
    State(state): State<AppState>,
    Query(query): Query<EventsQuery>,
) -> ApiResult<Json<EventListResponse>> {
    if query.thread_id.is_some() && query.exclude_thread_id.is_some() {
        return Err(ApiError::BadRequest(
            "threadId and excludeThreadId cannot be combined".to_string(),
        ));
    }
    let events = state
        .store
        .replay_events(
            query.cursor,
            query.project_id.clone(),
            query.thread_id.clone(),
        )
        .await?
        .into_iter()
        .filter(|event| {
            query
                .exclude_thread_id
                .as_ref()
                .is_none_or(|excluded| event.thread_id.as_ref() != Some(excluded))
        })
        .collect();
    Ok(Json(EventListResponse { events }))
}

fn enforce_self_control_depth(max_depth: Option<u8>) -> ApiResult<()> {
    consume_self_control_depth(max_depth).map(|_| ())
}

fn consume_self_control_depth(max_depth: Option<u8>) -> ApiResult<u8> {
    let max_depth = max_depth.unwrap_or(1);
    if max_depth == 0 {
        return Err(ApiError::BadRequest(
            "maxSelfControlDepth is exhausted".to_string(),
        ));
    }
    Ok(max_depth - 1)
}

fn optional_source(request: Option<Json<SelfControlMutationRequest>>) -> SelfControlSource {
    request
        .map(|Json(request)| request.source)
        .unwrap_or_default()
}

async fn audit_thread_mutation(
    state: &AppState,
    thread_id: &str,
    kind: &str,
    source: SelfControlSource,
) -> ApiResult<()> {
    audit_self_control(
        state,
        None,
        Some(thread_id),
        kind,
        json!({ "source": source.to_value() }),
    )
    .await
}

fn approval_policy_result(
    request: &SelfControlApprovalDecisionRequest,
) -> ApiResult<SelfControlApprovalPolicyResult> {
    if is_denial_decision(&request.decision) {
        return Ok(SelfControlApprovalPolicyResult {
            allowed: true,
            reason: "deny decisions are allowed by default".to_string(),
        });
    }
    if matches!(request.requested_by, Some(SelfControlRequestedBy::User))
        || matches!(
            request.source.requested_by,
            Some(SelfControlRequestedBy::User)
        )
    {
        return Ok(SelfControlApprovalPolicyResult {
            allowed: true,
            reason: "requestedBy is user".to_string(),
        });
    }
    if request
        .policy_token
        .as_deref()
        .is_some_and(|token| !token.trim().is_empty())
    {
        return Ok(SelfControlApprovalPolicyResult {
            allowed: true,
            reason: "explicit policy token supplied".to_string(),
        });
    }
    Ok(SelfControlApprovalPolicyResult {
        allowed: false,
        reason: "self-control approvals require requestedBy=user or policyToken; deny decisions are allowed without a token".to_string(),
    })
}

fn is_denial_decision(decision: &Value) -> bool {
    match decision.get("decision") {
        Some(Value::String(value)) if matches!(value.as_str(), "decline" | "cancel") => true,
        Some(Value::Object(object)) => {
            object
                .get("applyNetworkPolicyAmendment")
                .and_then(|value| value.get("network_policy_amendment"))
                .and_then(|value| value.get("action"))
                .and_then(Value::as_str)
                == Some("deny")
        }
        _ => decision
            .get("action")
            .and_then(Value::as_str)
            .is_some_and(|action| matches!(action, "decline" | "cancel")),
    }
}

pub(super) async fn audit_self_control(
    state: &AppState,
    project_id: Option<&str>,
    thread_id: Option<&str>,
    kind: &str,
    payload: Value,
) -> ApiResult<()> {
    let event = state
        .store
        .append_event(NewEvent {
            project_id: project_id.map(str::to_string),
            thread_id: thread_id.map(str::to_string),
            turn_id: None,
            item_id: None,
            kind: kind.to_string(),
            codex_method: None,
            payload,
        })
        .await?;
    let _ = state.events.send(event);
    Ok(())
}
