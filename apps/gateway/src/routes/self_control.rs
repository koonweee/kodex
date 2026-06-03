//! Agent-facing self-control endpoints.
//!
//! `/v1/self-control/...` is the product-shaped boundary for Kodex Control tools.
//! MCP tools should call these guarded endpoints instead of raw preview, thread, or
//! automation CRUD routes so the gateway can keep policy, provenance, and
//! reconciliation behavior in one place.

use std::collections::{HashMap, HashSet};

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
        self, RawAppServerResponse, ThreadCommandResponse, ThreadListResponse, ThreadLiveState,
        ThreadSettingsUpdateRequest, ThreadViewResponse, TurnStartOptions, UserInput,
    },
    automations::{broadcast_automation_delete, broadcast_automation_upsert},
    error::{ApiError, ApiResult},
    previews::PreviewSubsystemStatus,
    queue,
    routes::{
        approvals::{ApprovalListQuery, ApprovalListResponse},
        automations::{
            automation_to_dto, repeat_every_seconds, validate_name_and_prompt,
            validate_target_thread, AutomationDeleteResponse, AutomationDto, AutomationListQuery,
            AutomationListResponse, AutomationResponse, AutomationSchedule,
            AutomationUpdateRequest,
        },
        events::{EventListResponse, EventsQuery},
        project_previews::{
            project_preview_response, validate_path, validate_port, validate_protocol,
            validate_public_port, validate_route_path, PreviewListResponse,
        },
        projects::ProjectListResponse,
        threads::{
            apply_thread_command_response_state, broadcast_thread_upserted, create_thread_payload,
            overlay_thread_creation_options, save_thread_creation_options, MarkThreadSeenRequest,
            MarkThreadSeenResponse, RenameThreadRequest, RenameThreadResponse,
            SidebarThreadsResponse, ThreadAttachResponse, ThreadCreationOptions, ThreadListQuery,
            ThreadPinResponse, ThreadSettingsUpdateResponse, ThreadSubagentListResponse,
            ThreadTimelinePageQuery, ThreadUpsertScope,
        },
        turns::{
            start_turn, ThreadCompactResponse, ThreadInterruptCurrentResponse, TurnStartRequest,
        },
    },
    schema::validate_approval_response,
    skills,
    store::{
        Approval, AutomationStatus, AutomationUpdate, NewAutomation, NewEvent, NewProjectPreview,
        NewProjectPreviewRoute, NewProjectPreviewService, Project, ProjectPreview,
        ProjectPreviewRouteUpdate, ProjectPreviewService, ProjectPreviewServiceUpdate,
        ProjectPreviewUpdate, QueuedInput,
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
            "/v1/self-control/projects/{project_id}/previews",
            get(list_self_control_project_previews),
        )
        .route(
            "/v1/self-control/project-previews/apply",
            post(apply_project_preview_config),
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
            "/v1/self-control/threads/{thread_id}/pin",
            post(pin_self_control_thread).delete(unpin_self_control_thread),
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
/// MCP tools should use these routes instead of raw preview, thread, or automation CRUD routes so
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
    fn source_id(&self) -> Option<&str> {
        self.source_tool_call_id
            .as_deref()
            .or(self.source_turn_id.as_deref())
            .or(self.source_thread_id.as_deref())
    }

    fn to_value(&self) -> Value {
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
    pub preview_subsystem: PreviewSubsystemStatus,
    pub capabilities: SelfControlCapabilities,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlCapabilities {
    pub project_preview_apply: bool,
    pub threads: bool,
    pub automations: bool,
    pub mcp_resources: bool,
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
        preview_subsystem: state.previews.subsystem_status().await,
        capabilities: SelfControlCapabilities {
            project_preview_apply: true,
            threads: true,
            automations: true,
            mcp_resources: true,
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
    path = "/v1/self-control/projects/{projectId}/previews",
    summary = "List project previews through self-control",
    responses((status = 200, body = PreviewListResponse))
)]
pub async fn list_self_control_project_previews(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> ApiResult<Json<PreviewListResponse>> {
    crate::routes::project_previews::list_project_previews(State(state), Path(project_id)).await
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
    responses((status = 200, body = ThreadSubagentListResponse))
)]
pub async fn list_self_control_subagents(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> ApiResult<Json<ThreadSubagentListResponse>> {
    crate::routes::threads::list_subagents(State(state), Path(thread_id)).await
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
    crate::queue::list_queued_inputs(State(state), Path(thread_id)).await
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlPreviewApplyRequest {
    pub project_id: Option<String>,
    pub project_cwd: Option<String>,
    pub project_name: Option<String>,
    #[serde(default)]
    pub create_project: bool,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub services: Vec<SelfControlDesiredPreviewService>,
    #[serde(default)]
    pub previews: Vec<SelfControlDesiredPreview>,
    #[serde(default)]
    pub source: SelfControlSource,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlDesiredPreviewService {
    pub name: String,
    #[serde(default)]
    pub protocol: Option<String>,
    pub local_port: i64,
    #[serde(default)]
    pub health_path: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlDesiredPreview {
    pub name: String,
    pub public_port: Option<i64>,
    pub root_service_name: String,
    pub enabled: Option<bool>,
    #[serde(default)]
    pub routes: Vec<SelfControlDesiredPreviewRoute>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlDesiredPreviewRoute {
    pub path_pattern: String,
    pub service_name: String,
    pub strip_prefix: Option<bool>,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlPreviewApplyResponse {
    pub dry_run: bool,
    pub project: Project,
    pub diff: Vec<SelfControlApplyChange>,
    pub previews: PreviewListResponse,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlApplyChange {
    pub resource: String,
    pub name: String,
    pub action: SelfControlApplyAction,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SelfControlApplyAction {
    Created,
    Updated,
    Unchanged,
    DeletedSkipped,
}

#[utoipa::path(
    post,
    path = "/v1/self-control/project-previews/apply",
    summary = "Apply desired preview proxy configuration through self-control",
    description = "Agent-facing guarded preview apply endpoint. It reconciles desired preview services, previews, and routes through gateway-owned policy and provenance instead of exposing raw preview CRUD semantics to MCP tools.",
    request_body = SelfControlPreviewApplyRequest,
    responses((status = 200, body = SelfControlPreviewApplyResponse))
)]
pub async fn apply_project_preview_config(
    State(state): State<AppState>,
    Json(request): Json<SelfControlPreviewApplyRequest>,
) -> ApiResult<Json<SelfControlPreviewApplyResponse>> {
    let project_resolution = resolve_preview_project(&state, &request).await?;
    let existing_services = project_resolution.existing_services(&state).await?;
    let existing_previews = project_resolution.existing_previews(&state).await?;
    validate_preview_request(&state, existing_services, existing_previews, &request).await?;
    let dry_run_new_project = request.dry_run && project_resolution.is_create();
    let project = project_resolution
        .materialize(&state, request.dry_run)
        .await?;

    let mut diff = Vec::new();
    let mut services = if dry_run_new_project {
        ExistingServices::default()
    } else {
        existing_services_by_name_and_port(&state, &project.id).await?
    };
    for desired in &request.services {
        let name = desired.name.trim().to_string();
        let protocol = validate_protocol(desired.protocol.as_deref().unwrap_or("http"))?;
        let health_path =
            validate_path(desired.health_path.as_deref().unwrap_or("/"), "health path")?;
        let local_port = validate_port(desired.local_port, "local port")?;
        match services.match_service(&name, local_port) {
            Some(existing) => {
                if existing.name == name
                    && existing.protocol == protocol
                    && existing.local_port == local_port
                    && existing.health_path == health_path
                {
                    push_change(
                        &mut diff,
                        "service",
                        &name,
                        SelfControlApplyAction::Unchanged,
                        None,
                    );
                } else {
                    push_change(
                        &mut diff,
                        "service",
                        &name,
                        SelfControlApplyAction::Updated,
                        None,
                    );
                    if !request.dry_run {
                        if (existing.protocol != protocol || existing.local_port != local_port)
                            && state
                                .store
                                .preview_service_reference_count(&project.id, &existing.id)
                                .await?
                                > 0
                        {
                            let retired_name = retired_service_name(&name, &existing.id);
                            state
                                .store
                                .update_project_preview_service(
                                    &project.id,
                                    &existing.id,
                                    ProjectPreviewServiceUpdate {
                                        name: Some(retired_name),
                                        protocol: None,
                                        local_port: None,
                                        health_path: None,
                                    },
                                )
                                .await?;
                            let replacement = state
                                .store
                                .create_project_preview_service(NewProjectPreviewService {
                                    project_id: project.id.clone(),
                                    name: name.clone(),
                                    protocol: protocol.clone(),
                                    local_port,
                                    health_path: health_path.clone(),
                                })
                                .await?;
                            services.by_name.remove(&existing.name);
                            services.by_port.remove(&existing.local_port);
                            services.by_name.insert(name.clone(), replacement.clone());
                            services.by_port.insert(local_port, replacement);
                            continue;
                        }
                        state
                            .store
                            .update_project_preview_service(
                                &project.id,
                                &existing.id,
                                ProjectPreviewServiceUpdate {
                                    name: (existing.name != name).then_some(name.clone()),
                                    protocol: (existing.protocol != protocol)
                                        .then_some(protocol.clone()),
                                    local_port: (existing.local_port != local_port)
                                        .then_some(local_port),
                                    health_path: (existing.health_path != health_path)
                                        .then_some(health_path.clone()),
                                },
                            )
                            .await?;
                    }
                    services.by_name.remove(&existing.name);
                    services.by_port.remove(&existing.local_port);
                    let updated = ProjectPreviewService {
                        id: existing.id,
                        project_id: existing.project_id,
                        name: name.clone(),
                        protocol,
                        local_port,
                        health_path,
                        created_at: existing.created_at,
                        updated_at: existing.updated_at,
                    };
                    services.by_name.insert(name.clone(), updated.clone());
                    services.by_port.insert(local_port, updated);
                }
            }
            None => {
                push_change(
                    &mut diff,
                    "service",
                    &name,
                    SelfControlApplyAction::Created,
                    None,
                );
                if !request.dry_run {
                    let service = state
                        .store
                        .create_project_preview_service(NewProjectPreviewService {
                            project_id: project.id.clone(),
                            name: name.clone(),
                            protocol,
                            local_port,
                            health_path,
                        })
                        .await?;
                    services
                        .by_name
                        .insert(service.name.clone(), service.clone());
                    services.by_port.insert(service.local_port, service);
                } else {
                    let service = ProjectPreviewService {
                        id: format!("dry-run:{name}"),
                        project_id: project.id.clone(),
                        name: name.clone(),
                        protocol,
                        local_port,
                        health_path,
                        created_at: chrono::Utc::now(),
                        updated_at: chrono::Utc::now(),
                    };
                    services.by_name.insert(name.clone(), service.clone());
                    services.by_port.insert(local_port, service);
                }
            }
        }
    }
    let service_ids = services.service_ids();

    let mut previews = if dry_run_new_project {
        ExistingPreviews::default()
    } else {
        existing_previews_by_name_and_port(&state, &project.id).await?
    };
    for desired in &request.previews {
        let name = desired.name.trim().to_string();
        let root_service_name = desired.root_service_name.trim();
        let root_service_id = service_ids.get(root_service_name).cloned().ok_or_else(|| {
            ApiError::BadRequest(format!(
                "unknown root service {}",
                desired.root_service_name
            ))
        })?;
        match previews.match_preview(&name, desired.public_port) {
            Some(existing) => {
                let public_port_changed = desired
                    .public_port
                    .map(|port| port != existing.public_port)
                    .unwrap_or(false);
                let enabled_changed = desired
                    .enabled
                    .map(|enabled| enabled != existing.enabled)
                    .unwrap_or(false);
                if existing.name != name
                    || public_port_changed
                    || existing.root_service_id != root_service_id
                    || enabled_changed
                {
                    push_change(
                        &mut diff,
                        "preview",
                        &name,
                        SelfControlApplyAction::Updated,
                        None,
                    );
                    if !request.dry_run {
                        state
                            .store
                            .update_project_preview(
                                &project.id,
                                &existing.id,
                                ProjectPreviewUpdate {
                                    name: (existing.name != name).then_some(name.clone()),
                                    public_port: desired.public_port,
                                    root_service_id: Some(root_service_id.clone()),
                                    enabled: desired.enabled,
                                },
                            )
                            .await?;
                    }
                    previews.by_name.remove(&existing.name);
                    previews.by_port.remove(&existing.public_port);
                    let updated = ProjectPreview {
                        id: existing.id.clone(),
                        project_id: existing.project_id,
                        name: name.clone(),
                        public_port: desired.public_port.unwrap_or(existing.public_port),
                        root_service_id: root_service_id.clone(),
                        enabled: desired.enabled.unwrap_or(existing.enabled),
                        created_at: existing.created_at,
                        updated_at: existing.updated_at,
                    };
                    previews.by_name.insert(name.clone(), updated.clone());
                    previews.by_port.insert(updated.public_port, updated);
                } else {
                    push_change(
                        &mut diff,
                        "preview",
                        &name,
                        SelfControlApplyAction::Unchanged,
                        None,
                    );
                }
                reconcile_routes(
                    &state,
                    &project.id,
                    &existing.id,
                    desired,
                    &service_ids,
                    request.dry_run,
                    &mut diff,
                )
                .await?;
            }
            None => {
                push_change(
                    &mut diff,
                    "preview",
                    &name,
                    SelfControlApplyAction::Created,
                    None,
                );
                if !request.dry_run {
                    let public_port = match desired.public_port {
                        Some(port) => port,
                        None => {
                            state
                                .store
                                .allocate_project_preview_public_port(
                                    10000
                                        + state
                                            .store
                                            .get_project_preview_service(
                                                &project.id,
                                                &root_service_id,
                                            )
                                            .await?
                                            .local_port,
                                    state.config.previews.port_range_start as i64,
                                    state.config.previews.port_range_end as i64,
                                )
                                .await?
                        }
                    };
                    let preview = state
                        .store
                        .create_project_preview(NewProjectPreview {
                            project_id: project.id.clone(),
                            name: name.clone(),
                            public_port,
                            root_service_id: root_service_id.clone(),
                            enabled: desired.enabled.unwrap_or(true),
                        })
                        .await?;
                    previews
                        .by_name
                        .insert(preview.name.clone(), preview.clone());
                    previews
                        .by_port
                        .insert(preview.public_port, preview.clone());
                    reconcile_routes(
                        &state,
                        &project.id,
                        &preview.id,
                        desired,
                        &service_ids,
                        false,
                        &mut diff,
                    )
                    .await?;
                } else {
                    for route in &desired.routes {
                        push_change(
                            &mut diff,
                            "route",
                            &route.path_pattern,
                            SelfControlApplyAction::Created,
                            None,
                        );
                    }
                }
            }
        }
    }

    if !request.dry_run {
        state.previews.apply(&state.store).await?;
    }
    if !request.dry_run {
        audit_self_control(
            &state,
            Some(&project.id),
            None,
            "self_control.preview_apply",
            json!({ "source": request.source.to_value(), "dryRun": request.dry_run, "diff": diff.clone() }),
        )
        .await?;
    }
    let previews = if dry_run_new_project {
        PreviewListResponse {
            subsystem: state.previews.subsystem_status().await,
            project_id: project.id.clone(),
            services: Vec::new(),
            previews: Vec::new(),
        }
    } else {
        project_preview_response(&state, &project.id).await?
    };
    Ok(Json(SelfControlPreviewApplyResponse {
        dry_run: request.dry_run,
        previews,
        project,
        diff,
    }))
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlCreateThreadRequest {
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
    description = "Agent-facing guarded thread creation endpoint. It reuses gateway-owned thread creation policy, settings overlays, broadcasts, and provenance instead of raw app-server access.",
    request_body = SelfControlCreateThreadRequest,
    responses((status = 200, body = ThreadCommandResponse))
)]
pub async fn create_self_control_thread(
    State(state): State<AppState>,
    Json(request): Json<SelfControlCreateThreadRequest>,
) -> ApiResult<Json<ThreadCommandResponse>> {
    enforce_self_control_depth(request.max_self_control_depth)?;
    let project = state.store.get_project(&request.project_id).await?;
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
    let payload = create_thread_payload(&options);
    let mut response = app_server_api::client(&state.app_server)
        .thread_start(project.id.clone(), project.cwd, payload)
        .await?;
    save_thread_creation_options(&state, &response.thread.id, &options).await?;
    overlay_thread_creation_options(&mut response.thread, &options);
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
#[serde(rename_all = "camelCase")]
pub struct SelfControlThreadInputRequest {
    pub input: Vec<UserInput>,
    #[serde(flatten)]
    pub options: TurnStartOptions,
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
    Started,
    Queued,
}

#[utoipa::path(
    post,
    path = "/v1/self-control/threads/{threadId}/input",
    summary = "Send input to a Kodex thread through self-control",
    description = "Agent-facing guarded thread input endpoint. Idle threads start a turn; active threads receive source-labeled queued input instead of steering the live user turn.",
    request_body = SelfControlThreadInputRequest,
    responses((status = 200, body = SelfControlThreadInputResponse))
)]
pub async fn send_self_control_thread_input(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<SelfControlThreadInputRequest>,
) -> ApiResult<Json<SelfControlThreadInputResponse>> {
    enforce_self_control_depth(request.max_self_control_depth)?;
    request.options.validate()?;
    if should_queue_self_control_input(&state, &thread_id).await? {
        let input =
            skills::resolve_turn_input_for_thread(&state, &thread_id, request.input).await?;
        let source_id = request.source.source_id().map(str::to_string);
        let queued_input = queue::create_queued_input_with_source(
            &state,
            &thread_id,
            input,
            request.options,
            Some("kodex_control"),
            source_id.as_deref(),
        )
        .await?;
        audit_self_control(
            &state,
            None,
            Some(&thread_id),
            "self_control.thread_input",
            json!({
                "source": request.source.to_value(),
                "action": "queued",
                "queuedInputId": queued_input.id
            }),
        )
        .await?;
        return Ok(Json(SelfControlThreadInputResponse {
            action: SelfControlThreadInputAction::Queued,
            turn: None,
            queued_input: Some(queued_input),
        }));
    }

    let turn = start_turn(
        State(state.clone()),
        Path(thread_id.clone()),
        Json(TurnStartRequest {
            input: request.input,
            options: request.options,
        }),
    )
    .await?
    .0;
    audit_self_control(
        &state,
        None,
        Some(&thread_id),
        "self_control.thread_input",
        json!({
            "source": request.source.to_value(),
            "action": "started"
        }),
    )
    .await?;
    Ok(Json(SelfControlThreadInputResponse {
        action: SelfControlThreadInputAction::Started,
        turn: Some(turn),
        queued_input: None,
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
    #[serde(default)]
    pub seen_completed_agent_turn_seq: Option<i64>,
    #[serde(default)]
    pub source: SelfControlSource,
}

#[utoipa::path(
    post,
    path = "/v1/self-control/threads/{threadId}/attach",
    summary = "Attach or resume a thread through self-control",
    request_body = SelfControlMutationRequest,
    responses((status = 200, body = ThreadAttachResponse))
)]
pub async fn attach_self_control_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    request: Option<Json<SelfControlMutationRequest>>,
) -> ApiResult<Json<ThreadAttachResponse>> {
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
    responses((status = 200, body = ThreadSettingsUpdateResponse))
)]
pub async fn update_self_control_thread_settings(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<SelfControlThreadSettingsUpdateRequest>,
) -> ApiResult<Json<ThreadSettingsUpdateResponse>> {
    let source = request.source;
    let response = crate::routes::threads::update_thread_settings(
        State(state.clone()),
        Path(thread_id.clone()),
        Json(request.update),
    )
    .await?;
    audit_thread_mutation(
        &state,
        &thread_id,
        "self_control.thread_settings_updated",
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
    path = "/v1/self-control/threads/{threadId}/pin",
    summary = "Pin a thread through self-control",
    request_body = SelfControlMutationRequest,
    responses((status = 200, body = ThreadPinResponse))
)]
pub async fn pin_self_control_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    request: Option<Json<SelfControlMutationRequest>>,
) -> ApiResult<Json<ThreadPinResponse>> {
    let source = optional_source(request);
    let response =
        crate::routes::threads::pin_thread(State(state.clone()), Path(thread_id.clone())).await?;
    audit_thread_mutation(&state, &thread_id, "self_control.thread_pinned", source).await?;
    Ok(response)
}

#[utoipa::path(
    delete,
    path = "/v1/self-control/threads/{threadId}/pin",
    summary = "Unpin a thread through self-control",
    request_body = SelfControlMutationRequest,
    responses((status = 200, body = ThreadPinResponse))
)]
pub async fn unpin_self_control_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    request: Option<Json<SelfControlMutationRequest>>,
) -> ApiResult<Json<ThreadPinResponse>> {
    let source = optional_source(request);
    let response =
        crate::routes::threads::unpin_thread(State(state.clone()), Path(thread_id.clone())).await?;
    audit_thread_mutation(&state, &thread_id, "self_control.thread_unpinned", source).await?;
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
    request: Option<Json<SelfControlMarkThreadSeenRequest>>,
) -> ApiResult<Json<MarkThreadSeenResponse>> {
    let request =
        request
            .map(|Json(request)| request)
            .unwrap_or_else(|| SelfControlMarkThreadSeenRequest {
                seen_completed_agent_turn_seq: None,
                source: SelfControlSource::default(),
            });
    let response = crate::routes::threads::mark_thread_seen(
        State(state.clone()),
        Path(thread_id.clone()),
        Some(Json(MarkThreadSeenRequest {
            seen_completed_agent_turn_seq: request.seen_completed_agent_turn_seq,
        })),
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
    pub input: Vec<UserInput>,
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
    pub thread: ThreadCommandResponse,
    pub input: SelfControlThreadInputResponse,
    #[serde(default)]
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
    if let Some(existing) =
        find_idempotent_spawn_response(&state, idempotency_key.as_deref()).await?
    {
        return Ok(Json(SelfControlThreadSpawnResponse {
            idempotent_replay: true,
            ..existing
        }));
    }
    if let Some(created) = find_idempotent_spawn_created(&state, idempotency_key.as_deref()).await?
    {
        let input_response = send_self_control_thread_input(
            State(state.clone()),
            Path(created.thread_id.clone()),
            Json(SelfControlThreadInputRequest {
                input: request.input,
                options: TurnStartOptions::default(),
                source: request.source.clone(),
                max_self_control_depth: None,
            }),
        )
        .await?
        .0;
        let response = complete_self_control_thread_spawn(
            &state,
            &request.project_id,
            &created.thread_id,
            idempotency_key,
            created.remaining_self_control_depth,
            created.thread,
            input_response,
            &request.source,
            true,
        )
        .await?;
        return Ok(Json(response));
    }

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
    record_self_control_thread_spawn_created(
        &state,
        &request.project_id,
        &thread_id,
        idempotency_key.as_deref(),
        remaining_depth,
        &thread_response,
        &request.source,
    )
    .await?;
    let input_response = send_self_control_thread_input(
        State(state.clone()),
        Path(thread_id.clone()),
        Json(SelfControlThreadInputRequest {
            input: request.input,
            options: TurnStartOptions::default(),
            source: request.source.clone(),
            max_self_control_depth: None,
        }),
    )
    .await?
    .0;
    let response = complete_self_control_thread_spawn(
        &state,
        &request.project_id,
        &thread_id,
        idempotency_key,
        remaining_depth,
        thread_response,
        input_response,
        &request.source,
        false,
    )
    .await?;
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
    pub queued_input: QueuedInput,
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
    let input = vec![UserInput::Text {
        text: automation.prompt.clone(),
        text_elements: Vec::new(),
    }];
    let input =
        skills::resolve_turn_input_for_thread(&state, &automation.target_thread_id, input).await?;
    let source_id = source
        .source_id()
        .map(str::to_string)
        .unwrap_or_else(|| automation_id.clone());
    let queued_input = queue::create_queued_input_with_source(
        &state,
        &automation.target_thread_id,
        input,
        TurnStartOptions::default(),
        Some("automation"),
        Some(&source_id),
    )
    .await?;
    audit_self_control(
        &state,
        None,
        Some(&automation.target_thread_id),
        "self_control.automation_run_now",
        json!({
            "automationId": automation_id,
            "queuedInputId": queued_input.id,
            "source": source.to_value()
        }),
    )
    .await?;
    Ok(Json(SelfControlAutomationRunNowResponse {
        automation: automation_to_dto(automation),
        queued_input,
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
    let approval = state.store.get_approval(&approval_id).await?;
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
        "self_control.approval_decision_applied",
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

async fn validate_preview_request(
    state: &AppState,
    existing_services: Vec<ProjectPreviewService>,
    existing_previews: Vec<ProjectPreview>,
    request: &SelfControlPreviewApplyRequest,
) -> ApiResult<()> {
    let mut service_names = existing_services
        .iter()
        .map(|service| service.name.clone())
        .collect::<HashSet<_>>();
    let existing_service_by_name = existing_services
        .iter()
        .map(|service| (service.name.as_str(), service))
        .collect::<HashMap<_, _>>();
    let existing_service_by_port = existing_services
        .iter()
        .map(|service| (service.local_port, service))
        .collect::<HashMap<_, _>>();
    let mut desired_service_names = HashSet::new();
    let mut desired_service_ports = HashMap::new();
    for service in &request.services {
        let name = service.name.trim();
        if name.is_empty() {
            return Err(ApiError::BadRequest("service name is required".to_string()));
        }
        if !desired_service_names.insert(name.to_string()) {
            return Err(ApiError::BadRequest(format!(
                "service name {name} is used multiple times"
            )));
        }
        service_names.insert(name.to_string());
        validate_protocol(service.protocol.as_deref().unwrap_or("http"))?;
        let local_port = validate_port(service.local_port, "local port")?;
        if let Some(existing_name) = desired_service_ports.insert(local_port, name.to_string()) {
            if existing_name != name {
                return Err(ApiError::BadRequest(format!(
                    "local port {local_port} is used by multiple desired services"
                )));
            }
        }
        if let (Some(named), Some(ported)) = (
            existing_service_by_name.get(name),
            existing_service_by_port.get(&local_port),
        ) {
            if named.id != ported.id {
                return Err(ApiError::BadRequest(format!(
                    "service name {name} and local port {local_port} match different existing services"
                )));
            }
        }
        validate_path(service.health_path.as_deref().unwrap_or("/"), "health path")?;
    }
    let existing_by_name = existing_previews
        .iter()
        .map(|preview| (preview.name.as_str(), preview))
        .collect::<HashMap<_, _>>();
    let existing_by_port = existing_previews
        .iter()
        .map(|preview| (preview.public_port, preview))
        .collect::<HashMap<_, _>>();
    let mut desired_preview_names = HashSet::new();
    let mut desired_public_ports = HashMap::new();
    for preview in &request.previews {
        let preview_name = preview.name.trim();
        if preview_name.is_empty() {
            return Err(ApiError::BadRequest("preview name is required".to_string()));
        }
        if !desired_preview_names.insert(preview_name.to_string()) {
            return Err(ApiError::BadRequest(format!(
                "preview name {preview_name} is used multiple times"
            )));
        }
        if let Some(port) = preview.public_port {
            validate_public_port(state, port)?;
            if let Some(existing_name) = desired_public_ports.insert(port, preview_name.to_string())
            {
                if existing_name != preview_name {
                    return Err(ApiError::BadRequest(format!(
                        "public port {port} is used by multiple desired previews"
                    )));
                }
            }
            let except_preview_id = match (
                existing_by_name.get(preview_name),
                existing_by_port.get(&port),
            ) {
                (Some(named), Some(ported)) if named.id != ported.id => {
                    return Err(ApiError::BadRequest(format!(
                        "preview name {preview_name} and public port {port} match different existing previews"
                    )));
                }
                (Some(named), _) => Some(named.id.as_str()),
                (None, Some(ported)) => Some(ported.id.as_str()),
                (None, None) => None,
            };
            if state
                .store
                .project_preview_public_port_exists(port, except_preview_id)
                .await?
            {
                return Err(ApiError::BadRequest(
                    "preview public port is already in use".to_string(),
                ));
            }
        }
        if !service_names.contains(preview.root_service_name.trim()) {
            return Err(ApiError::BadRequest(format!(
                "unknown root service {}",
                preview.root_service_name
            )));
        }
        for route in &preview.routes {
            validate_route_path(&route.path_pattern)?;
            if !service_names.contains(route.service_name.trim()) {
                return Err(ApiError::BadRequest(format!(
                    "unknown route service {}",
                    route.service_name
                )));
            }
        }
    }
    Ok(())
}

enum PreviewProjectResolution {
    Existing(Project),
    Create { name: String, cwd: String },
}

const DRY_RUN_PROJECT_ID: &str = "dry-run:project";

impl PreviewProjectResolution {
    fn is_create(&self) -> bool {
        matches!(self, Self::Create { .. })
    }

    async fn existing_services(&self, state: &AppState) -> ApiResult<Vec<ProjectPreviewService>> {
        match self {
            Self::Existing(project) => state.store.list_project_preview_services(&project.id).await,
            Self::Create { .. } => Ok(Vec::new()),
        }
    }

    async fn existing_previews(&self, state: &AppState) -> ApiResult<Vec<ProjectPreview>> {
        match self {
            Self::Existing(project) => state.store.list_project_previews(&project.id).await,
            Self::Create { .. } => Ok(Vec::new()),
        }
    }

    async fn materialize(self, state: &AppState, dry_run: bool) -> ApiResult<Project> {
        match self {
            Self::Existing(project) => Ok(project),
            Self::Create { name, cwd } if dry_run => {
                let now = chrono::Utc::now();
                Ok(Project {
                    id: DRY_RUN_PROJECT_ID.to_string(),
                    name,
                    cwd,
                    created_at: now,
                    updated_at: now,
                })
            }
            Self::Create { name, cwd } => state.store.create_project(name, cwd).await,
        }
    }
}

async fn resolve_preview_project(
    state: &AppState,
    request: &SelfControlPreviewApplyRequest,
) -> ApiResult<PreviewProjectResolution> {
    if let Some(project_id) = &request.project_id {
        return state
            .store
            .get_project(project_id)
            .await
            .map(PreviewProjectResolution::Existing);
    }
    let Some(project_cwd) = request.project_cwd.as_deref() else {
        return Err(ApiError::BadRequest(
            "projectId or projectCwd is required".to_string(),
        ));
    };
    let cwd = std::fs::canonicalize(project_cwd).map_err(|_| {
        ApiError::BadRequest("projectCwd must be an existing directory".to_string())
    })?;
    let cwd_text = cwd.to_string_lossy().to_string();
    if let Some(project) = state
        .store
        .list_projects()
        .await?
        .into_iter()
        .find(|project| project.cwd == cwd_text)
    {
        return Ok(PreviewProjectResolution::Existing(project));
    }
    if !request.create_project {
        return Err(ApiError::BadRequest(
            "projectCwd is not registered; set createProject to true".to_string(),
        ));
    }
    let name = request.project_name.clone().unwrap_or_else(|| {
        cwd.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Project")
            .to_string()
    });
    Ok(PreviewProjectResolution::Create {
        name,
        cwd: cwd_text,
    })
}

fn retired_service_name(name: &str, service_id: &str) -> String {
    let suffix: String = service_id.chars().take(8).collect();
    format!("{name} (replaced {suffix})")
}

async fn should_queue_self_control_input(state: &AppState, thread_id: &str) -> ApiResult<bool> {
    match state.thread_views.live_state(thread_id).await {
        Some(ThreadLiveState::Streaming | ThreadLiveState::Syncing) => return Ok(true),
        Some(ThreadLiveState::Idle) => return Ok(false),
        Some(ThreadLiveState::NotLoaded) | None => {}
    }
    let snapshot = match app_server_api::client(&state.app_server)
        .thread_read(thread_id.to_string())
        .await
    {
        Ok(snapshot) => snapshot,
        Err(error)
            if app_server_api::is_thread_not_materialized_before_first_user_message(&error) =>
        {
            return Ok(false);
        }
        Err(error) => return Err(error),
    };
    let revision = state.store.latest_event_seq().await?;
    let timeline = state
        .thread_views
        .refresh_from_turns(thread_id, &snapshot.turns, revision)
        .await;
    Ok(timeline.active_turn_id.is_some() || timeline.live_state != ThreadLiveState::Idle)
}

#[derive(Default)]
struct ExistingServices {
    by_name: HashMap<String, ProjectPreviewService>,
    by_port: HashMap<i64, ProjectPreviewService>,
}

impl ExistingServices {
    fn match_service(&self, name: &str, local_port: i64) -> Option<ProjectPreviewService> {
        let by_name = self.by_name.get(name).cloned();
        let by_port = self.by_port.get(&local_port).cloned();
        match (by_name, by_port) {
            (Some(named), _) => Some(named),
            (None, Some(ported)) => Some(ported),
            (None, None) => None,
        }
    }

    fn service_ids(&self) -> HashMap<String, String> {
        self.by_name
            .iter()
            .map(|(name, service)| (name.clone(), service.id.clone()))
            .collect()
    }
}

async fn existing_services_by_name_and_port(
    state: &AppState,
    project_id: &str,
) -> ApiResult<ExistingServices> {
    let mut by_name = HashMap::new();
    let mut by_port = HashMap::new();
    for service in state
        .store
        .list_project_preview_services(project_id)
        .await?
    {
        by_name.insert(service.name.clone(), service.clone());
        by_port.insert(service.local_port, service);
    }
    Ok(ExistingServices { by_name, by_port })
}

#[derive(Default)]
struct ExistingPreviews {
    by_name: HashMap<String, ProjectPreview>,
    by_port: HashMap<i64, ProjectPreview>,
}

impl ExistingPreviews {
    fn match_preview(&self, name: &str, public_port: Option<i64>) -> Option<ProjectPreview> {
        let by_name = self.by_name.get(name).cloned();
        let by_port = public_port.and_then(|port| self.by_port.get(&port).cloned());
        match (by_name, by_port) {
            (Some(named), _) => Some(named),
            (None, Some(ported)) => Some(ported),
            (None, None) => None,
        }
    }
}

async fn existing_previews_by_name_and_port(
    state: &AppState,
    project_id: &str,
) -> ApiResult<ExistingPreviews> {
    let mut by_name = HashMap::new();
    let mut by_port = HashMap::new();
    for preview in state.store.list_project_previews(project_id).await? {
        by_name.insert(preview.name.clone(), preview.clone());
        by_port.insert(preview.public_port, preview);
    }
    Ok(ExistingPreviews { by_name, by_port })
}

async fn reconcile_routes(
    state: &AppState,
    project_id: &str,
    preview_id: &str,
    desired_preview: &SelfControlDesiredPreview,
    service_ids: &HashMap<String, String>,
    dry_run: bool,
    diff: &mut Vec<SelfControlApplyChange>,
) -> ApiResult<()> {
    let existing_routes = state.store.list_project_preview_routes(preview_id).await?;
    let mut by_path = existing_routes
        .iter()
        .map(|route| (route.path_pattern.clone(), route.clone()))
        .collect::<HashMap<_, _>>();
    for desired in &desired_preview.routes {
        let path_pattern = validate_route_path(&desired.path_pattern)?;
        let service_name = desired.service_name.trim();
        let service_id = service_ids.get(service_name).cloned().ok_or_else(|| {
            ApiError::BadRequest(format!("unknown route service {}", desired.service_name))
        })?;
        let strip_prefix = desired.strip_prefix.unwrap_or(true);
        let sort_order = desired.sort_order.unwrap_or(0);
        match by_path.remove(&path_pattern) {
            Some(existing)
                if existing.service_id == service_id
                    && existing.strip_prefix == strip_prefix
                    && existing.sort_order == sort_order =>
            {
                push_change(
                    diff,
                    "route",
                    &path_pattern,
                    SelfControlApplyAction::Unchanged,
                    None,
                );
            }
            Some(existing) => {
                push_change(
                    diff,
                    "route",
                    &path_pattern,
                    SelfControlApplyAction::Updated,
                    None,
                );
                if !dry_run {
                    state
                        .store
                        .update_project_preview_route(
                            project_id,
                            preview_id,
                            &existing.id,
                            ProjectPreviewRouteUpdate {
                                path_pattern: None,
                                service_id: Some(service_id),
                                strip_prefix: Some(strip_prefix),
                                sort_order: Some(sort_order),
                            },
                        )
                        .await?;
                }
            }
            None => {
                push_change(
                    diff,
                    "route",
                    &path_pattern,
                    SelfControlApplyAction::Created,
                    None,
                );
                if !dry_run {
                    state
                        .store
                        .create_project_preview_route(
                            project_id,
                            NewProjectPreviewRoute {
                                preview_id: preview_id.to_string(),
                                path_pattern,
                                service_id,
                                strip_prefix,
                                sort_order,
                            },
                        )
                        .await?;
                }
            }
        }
    }
    for route in by_path.into_values() {
        push_change(
            diff,
            "route",
            &route.path_pattern,
            SelfControlApplyAction::DeletedSkipped,
            Some("self-control apply does not delete existing routes".to_string()),
        );
    }
    Ok(())
}

fn push_change(
    diff: &mut Vec<SelfControlApplyChange>,
    resource: &str,
    name: &str,
    action: SelfControlApplyAction,
    detail: Option<String>,
) {
    diff.push(SelfControlApplyChange {
        resource: resource.to_string(),
        name: name.to_string(),
        action,
        detail,
    });
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

struct IdempotentSpawnCreated {
    thread_id: String,
    remaining_self_control_depth: u8,
    thread: ThreadCommandResponse,
}

async fn record_self_control_thread_spawn_created(
    state: &AppState,
    project_id: &str,
    thread_id: &str,
    idempotency_key: Option<&str>,
    remaining_self_control_depth: u8,
    thread: &ThreadCommandResponse,
    source: &SelfControlSource,
) -> ApiResult<()> {
    audit_self_control(
        state,
        Some(project_id),
        Some(thread_id),
        "self_control.thread_spawn_created",
        json!({
            "source": source.to_value(),
            "idempotencyKey": idempotency_key,
            "remainingSelfControlDepth": remaining_self_control_depth,
            "threadId": thread_id,
            "thread": thread
        }),
    )
    .await
}

async fn complete_self_control_thread_spawn(
    state: &AppState,
    project_id: &str,
    thread_id: &str,
    idempotency_key: Option<String>,
    remaining_self_control_depth: u8,
    thread: ThreadCommandResponse,
    input: SelfControlThreadInputResponse,
    source: &SelfControlSource,
    idempotent_replay: bool,
) -> ApiResult<SelfControlThreadSpawnResponse> {
    let response = SelfControlThreadSpawnResponse {
        thread_id: thread_id.to_string(),
        idempotency_key,
        remaining_self_control_depth,
        thread,
        input,
        idempotent_replay,
    };
    audit_self_control(
        state,
        Some(project_id),
        Some(thread_id),
        "self_control.thread_spawned",
        json!({
            "source": source.to_value(),
            "idempotencyKey": response.idempotency_key.as_deref(),
            "remainingSelfControlDepth": remaining_self_control_depth,
            "response": &response
        }),
    )
    .await?;
    Ok(response)
}

async fn find_idempotent_spawn_response(
    state: &AppState,
    idempotency_key: Option<&str>,
) -> ApiResult<Option<SelfControlThreadSpawnResponse>> {
    let Some(idempotency_key) = idempotency_key else {
        return Ok(None);
    };
    let events = state.store.replay_events(None, None, None).await?;
    for event in events.into_iter().rev() {
        if event.kind != "self_control.thread_spawned" {
            continue;
        }
        let Some(event_key) = event.payload.get("idempotencyKey").and_then(Value::as_str) else {
            continue;
        };
        if event_key != idempotency_key {
            continue;
        }
        let Some(response) = event.payload.get("response").cloned() else {
            continue;
        };
        return serde_json::from_value(response)
            .map(Some)
            .map_err(|error| ApiError::Other(anyhow::anyhow!(error)));
    }
    Ok(None)
}

async fn find_idempotent_spawn_created(
    state: &AppState,
    idempotency_key: Option<&str>,
) -> ApiResult<Option<IdempotentSpawnCreated>> {
    let Some(idempotency_key) = idempotency_key else {
        return Ok(None);
    };
    let events = state.store.replay_events(None, None, None).await?;
    for event in events.into_iter().rev() {
        if event.kind != "self_control.thread_spawn_created" {
            continue;
        }
        let Some(event_key) = event.payload.get("idempotencyKey").and_then(Value::as_str) else {
            continue;
        };
        if event_key != idempotency_key {
            continue;
        }
        let Some(thread_value) = event.payload.get("thread").cloned() else {
            continue;
        };
        let thread = serde_json::from_value::<ThreadCommandResponse>(thread_value)
            .map_err(|error| ApiError::Other(anyhow::anyhow!(error)))?;
        let thread_id = event
            .payload
            .get("threadId")
            .and_then(Value::as_str)
            .unwrap_or(&thread.thread.id)
            .to_string();
        let remaining_self_control_depth = event
            .payload
            .get("remainingSelfControlDepth")
            .and_then(Value::as_u64)
            .and_then(|value| u8::try_from(value).ok())
            .unwrap_or_default();
        return Ok(Some(IdempotentSpawnCreated {
            thread_id,
            remaining_self_control_depth,
            thread,
        }));
    }
    Ok(None)
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

async fn audit_self_control(
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
