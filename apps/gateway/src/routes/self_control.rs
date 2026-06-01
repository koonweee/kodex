//! Agent-facing self-control endpoints.
//!
//! `/v1/self-control/...` is the product-shaped boundary for Kodex Control tools.
//! MCP tools should call these guarded endpoints instead of raw preview, thread, or
//! automation CRUD routes so the gateway can keep policy, provenance, and
//! reconciliation behavior in one place.

use std::collections::{HashMap, HashSet};

use axum::{
    extract::{Path, State},
    routing::{get, patch, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use utoipa::ToSchema;

use crate::{
    api::AppState,
    app_server_api::{
        self, RawAppServerResponse, ThreadCommandResponse, ThreadLiveState, TurnStartOptions,
        UserInput,
    },
    automations::broadcast_automation_upsert,
    error::{ApiError, ApiResult},
    previews::PreviewSubsystemStatus,
    queue,
    routes::{
        automations::{
            automation_to_dto, repeat_every_seconds, validate_name_and_prompt,
            validate_target_thread, AutomationDto, AutomationSchedule, AutomationUpdateRequest,
        },
        project_previews::{
            project_preview_response, validate_path, validate_port, validate_protocol,
            validate_public_port, validate_route_path, PreviewListResponse,
        },
        threads::{
            apply_thread_command_response_state, broadcast_thread_upserted, create_thread_payload,
            overlay_thread_creation_options, save_thread_creation_options, ThreadCreationOptions,
            ThreadUpsertScope,
        },
        turns::{start_turn, TurnStartRequest},
    },
    skills,
    store::{
        AutomationStatus, AutomationUpdate, NewAutomation, NewEvent, NewProjectPreview,
        NewProjectPreviewRoute, NewProjectPreviewService, Project, ProjectPreview,
        ProjectPreviewRouteUpdate, ProjectPreviewService, ProjectPreviewServiceUpdate,
        ProjectPreviewUpdate, QueuedInput,
    },
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/self-control/status", get(self_control_status))
        .route(
            "/v1/self-control/project-previews/apply",
            post(apply_project_preview_config),
        )
        .route("/v1/self-control/threads", post(create_self_control_thread))
        .route(
            "/v1/self-control/threads/{thread_id}/input",
            post(send_self_control_thread_input),
        )
        .route(
            "/v1/self-control/automations",
            post(create_self_control_automation),
        )
        .route(
            "/v1/self-control/automations/{automation_id}",
            patch(update_self_control_automation),
        )
        .route(
            "/v1/self-control/automations/{automation_id}/pause",
            post(pause_self_control_automation),
        )
        .route(
            "/v1/self-control/automations/{automation_id}/resume",
            post(resume_self_control_automation),
        )
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

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
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

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfControlThreadInputResponse {
    pub action: SelfControlThreadInputAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<RawAppServerResponse>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued_input: Option<QueuedInput>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum SelfControlThreadInputAction {
    Started,
    Queued,
}

#[utoipa::path(
    post,
    path = "/v1/self-control/threads/{threadId}/input",
    summary = "Send input to a Kodex thread through self-control",
    description = "Agent-facing guarded thread input endpoint. It uses composer-equivalent gateway routing: idle threads start a turn and active threads receive source-labeled queued input.",
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
    let snapshot = app_server_api::client(&state.app_server)
        .thread_read(thread_id.to_string())
        .await?;
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
    if max_depth == Some(0) {
        return Err(ApiError::BadRequest(
            "maxSelfControlDepth must be greater than zero".to_string(),
        ));
    }
    Ok(())
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
