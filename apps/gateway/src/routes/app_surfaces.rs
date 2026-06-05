use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

use crate::{
    api::AppState,
    app_server_api::{McpServerToolCallRequest, UserInput},
    app_surfaces::{app_surface_csp, MCP_APP_MIME_TYPE},
    error::{ApiError, ApiResult},
    routes::turns::{submit_thread_input, ThreadInputResponse, TurnStartRequest},
    store::{
        AppSurfaceCsp, AppSurfaceGrants, AppSurfaceProvider, AppSurfaceSession,
        AppSurfaceSessionStatus, Approval, EventEnvelope, NewApproval, NewEvent,
    },
};

pub const APP_SURFACE_UPSERTED_EVENT: &str = "app_surface.session_upserted";
pub const APP_SURFACE_SUBMITTED_EVENT: &str = "app_surface.session_submitted";
pub const APP_SURFACE_ARCHIVED_EVENT: &str = "app_surface.session_archived";
pub const APP_SURFACE_ERROR_EVENT: &str = "app_surface.session_error";
pub const APP_SURFACE_BRIDGE_CALL_EVENT: &str = "app_surface.bridge_call";
pub const APP_SURFACE_MODEL_CONTEXT_UPDATED_EVENT: &str = "app_surface.model_context_updated";
pub const APP_SURFACE_BRIDGE_APPROVAL_METHOD: &str = "appSurface/bridge/requestApproval";

const MAX_BRIDGE_MESSAGE_BYTES: usize = 16 * 1024;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/threads/{thread_id}/app-surface",
            get(get_thread_app_surface),
        )
        .route(
            "/v1/app-surfaces/{session_id}/document",
            get(app_surface_document),
        )
        .route(
            "/v1/app-surfaces/{session_id}/bridge",
            post(app_surface_bridge),
        )
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppSurfaceSessionDto {
    pub id: String,
    pub thread_id: String,
    pub bridge_token: String,
    pub provider: AppSurfaceProvider,
    pub title: String,
    pub resource_uri: String,
    pub resource_mime_type: String,
    pub fallback_content: String,
    pub revision: i64,
    pub status: AppSurfaceSessionStatus,
    pub display_modes: Vec<String>,
    pub csp: AppSurfaceCsp,
    pub grants: AppSurfaceGrants,
    pub provenance: Value,
    pub submitted_revision: Option<i64>,
    pub submitted_message: Option<String>,
    pub submitted_metadata: Option<Value>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub submitted_at: Option<DateTime<Utc>>,
    pub archived_at: Option<DateTime<Utc>>,
    pub document_url: String,
    pub submit_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppSurfaceSessionReadResponse {
    pub session: Option<AppSurfaceSessionDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppSurfaceSessionResponse {
    pub session: AppSurfaceSessionDto,
}

#[derive(Debug, Clone, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppSurfaceDocumentQuery {
    pub revision: i64,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppSurfaceBridgeRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bridge_token: Option<String>,
    pub revision: i64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppSurfaceBridgeResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<AppSurfaceBridgeError>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppSurfaceBridgeError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[utoipa::path(
    get,
    path = "/v1/threads/{threadId}/app-surface",
    responses((status = 200, body = AppSurfaceSessionReadResponse))
)]
pub async fn get_thread_app_surface(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> ApiResult<Json<AppSurfaceSessionReadResponse>> {
    let session = state
        .store
        .latest_app_surface_session(&thread_id)
        .await?
        .filter(|session| session.status != AppSurfaceSessionStatus::Archived)
        .map(session_dto);
    Ok(Json(AppSurfaceSessionReadResponse { session }))
}

#[utoipa::path(
    get,
    path = "/v1/app-surfaces/{sessionId}/document",
    params(AppSurfaceDocumentQuery),
    responses((status = 200, content_type = "text/html"))
)]
pub async fn app_surface_document(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Query(query): Query<AppSurfaceDocumentQuery>,
) -> ApiResult<Response> {
    let session = state.store.get_app_surface_session(&session_id).await?;
    if session.revision != query.revision {
        return Err(ApiError::Conflict(format!(
            "app surface revision {} is not current",
            query.revision
        )));
    }
    if session.resource_mime_type != MCP_APP_MIME_TYPE {
        return Err(ApiError::Conflict(format!(
            "app surface resource MIME type {} is not renderable",
            session.resource_mime_type
        )));
    }
    let mut response = Html(session.html).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_str(&app_surface_csp(&session.csp))
            .map_err(|error| ApiError::BadRequest(format!("invalid app surface CSP: {error}")))?,
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, no-cache, must-revalidate"),
    );
    Ok(response)
}

#[utoipa::path(
    post,
    path = "/v1/app-surfaces/{sessionId}/bridge",
    request_body = AppSurfaceBridgeRequest,
    responses((status = 200, body = AppSurfaceBridgeResponse))
)]
pub async fn app_surface_bridge(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(request): Json<AppSurfaceBridgeRequest>,
) -> ApiResult<Json<AppSurfaceBridgeResponse>> {
    let session = state.store.get_app_surface_session(&session_id).await?;
    let method = request.method.clone();
    let params = request.params.clone();
    if session.revision != request.revision {
        let response = bridge_error(
            request.id,
            -32001,
            format!("app surface revision {} is not current", request.revision),
        );
        append_bridge_audit(&state, &session, &method, &params, &response).await?;
        return Ok(Json(response));
    }
    if request.bridge_token.as_deref() != Some(session.bridge_token.as_str()) {
        let response = bridge_error(
            request.id,
            -32004,
            "app surface bridge token is missing or invalid",
        );
        append_bridge_audit(&state, &session, &method, &params, &response).await?;
        return Ok(Json(response));
    }
    if session.status != AppSurfaceSessionStatus::Active {
        let response = bridge_error(request.id, -32002, "app surface session is not active");
        append_bridge_audit(&state, &session, &method, &params, &response).await?;
        return Ok(Json(response));
    }
    let id = request.id.clone();
    let result = match request.method.as_str() {
        "ui/initialize" => bridge_initialize(&session, &request.params),
        "ui/message" => bridge_message(state.clone(), session.clone(), request).await,
        "resources/read" => bridge_resource_read(state.clone(), session.clone(), request).await,
        "tools/call" => bridge_tool_call(state.clone(), session.clone(), request).await,
        "ui/update-model-context" => {
            bridge_update_model_context(state.clone(), session.clone(), request).await
        }
        "ui/open-link" => bridge_open_link(session.clone(), request).await,
        method => {
            let response = bridge_error(
                request.id,
                -32601,
                format!("unsupported app surface bridge method {method}"),
            );
            append_bridge_audit(&state, &session, &method, &params, &response).await?;
            return Ok(Json(response));
        }
    };
    let response = bridge_result(id, result);
    append_bridge_audit(&state, &session, &method, &params, &response).await?;
    Ok(Json(response))
}

fn bridge_result(id: Option<Value>, result: ApiResult<Value>) -> AppSurfaceBridgeResponse {
    match result {
        Ok(result) => AppSurfaceBridgeResponse {
            id,
            result: Some(result),
            error: None,
        },
        Err(error) => bridge_error(id, -32000, error.to_string()),
    }
}

fn bridge_error(
    id: Option<Value>,
    code: i64,
    message: impl Into<String>,
) -> AppSurfaceBridgeResponse {
    bridge_error_with_data(id, code, message, None)
}

fn bridge_error_with_data(
    id: Option<Value>,
    code: i64,
    message: impl Into<String>,
    data: Option<Value>,
) -> AppSurfaceBridgeResponse {
    AppSurfaceBridgeResponse {
        id,
        result: None,
        error: Some(AppSurfaceBridgeError {
            code,
            message: message.into(),
            data,
        }),
    }
}

async fn bridge_message(
    state: AppState,
    session: AppSurfaceSession,
    request: AppSurfaceBridgeRequest,
) -> ApiResult<Value> {
    if !session.grants.can_send_message {
        return Err(ApiError::BadRequest(
            "app surface is not granted ui/message".to_string(),
        ));
    }
    let message = required_string_param(&request.params, "message")?;
    if message.len() > MAX_BRIDGE_MESSAGE_BYTES {
        return Err(ApiError::BadRequest(
            "app surface message is too large".to_string(),
        ));
    }
    let metadata = request.params.get("metadata").cloned();
    let response = match submit_thread_input(
        State(state.clone()),
        Path(session.thread_id.clone()),
        Json(TurnStartRequest {
            input: vec![UserInput::Text {
                text: message.clone(),
                text_elements: Vec::new(),
            }],
            attachments: Vec::new(),
            options: Default::default(),
        }),
    )
    .await
    {
        Ok(response) => response.0,
        Err(error) => {
            if let Ok(errored) = state
                .store
                .mark_app_surface_session_errored(&session.id, session.revision, &error.to_string())
                .await
            {
                broadcast_app_surface_event(&state, APP_SURFACE_ERROR_EVENT, &errored).await?;
            }
            return Err(error);
        }
    };
    let submitted = state
        .store
        .submit_app_surface_session(&session.id, session.revision, &message, metadata)
        .await?;
    broadcast_app_surface_event(&state, APP_SURFACE_SUBMITTED_EVENT, &submitted).await?;
    serde_json::to_value(AppSurfaceBridgeMessageResult { input: response }).map_err(Into::into)
}

fn bridge_initialize(session: &AppSurfaceSession, params: &Value) -> ApiResult<Value> {
    let protocol_version = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or("2025-11-21");
    let available_display_modes = mcp_app_available_display_modes(&session.display_modes);
    let host_capabilities = mcp_app_host_capabilities(&session);
    Ok(json!({
        "protocolVersion": protocol_version,
        "hostInfo": {
            "name": "Kodex",
            "version": env!("CARGO_PKG_VERSION")
        },
        "hostCapabilities": host_capabilities,
        "hostContext": {
            "sessionId": session.id,
            "revision": session.revision,
            "provider": session.provider,
            "resourceUri": session.resource_uri,
            "displayMode": "inline",
            "availableDisplayModes": available_display_modes,
            "platform": "web"
        },
        "sessionId": session.id,
        "revision": session.revision,
        "provider": session.provider,
        "resourceUri": session.resource_uri,
        "displayMode": "pane",
        "displayModes": session.display_modes,
        "capabilities": {
            "bridge": true,
            "methods": bridge_supported_methods(session)
        }
    }))
}

fn mcp_app_host_capabilities(session: &AppSurfaceSession) -> Value {
    let mut capabilities = serde_json::Map::new();
    capabilities.insert("serverTools".to_string(), json!({}));
    capabilities.insert("serverResources".to_string(), json!({}));
    if session.grants.can_open_links {
        capabilities.insert("openLinks".to_string(), json!({}));
    }
    Value::Object(capabilities)
}

fn mcp_app_available_display_modes(display_modes: &[String]) -> Vec<&'static str> {
    let mut valid = display_modes
        .iter()
        .filter_map(|mode| match mode.as_str() {
            "inline" => Some("inline"),
            "fullscreen" => Some("fullscreen"),
            "pip" => Some("pip"),
            _ => None,
        })
        .collect::<Vec<_>>();
    if valid.is_empty() {
        valid.push("inline");
    }
    valid
}

async fn bridge_resource_read(
    state: AppState,
    session: AppSurfaceSession,
    request: AppSurfaceBridgeRequest,
) -> ApiResult<Value> {
    let uri = required_string_param(&request.params, "uri")?;
    if uri == session.resource_uri {
        return Ok(json!({
            "contents": [{
                "uri": session.resource_uri,
                "mimeType": session.resource_mime_type,
                "text": session.html
            }]
        }));
    }
    let server = required_string_param(&request.params, "server")?;
    if !session
        .grants
        .resources
        .iter()
        .any(|grant| grant.server.as_deref() == Some(server.as_str()) && grant.uri == uri)
    {
        return Err(ApiError::BadRequest(
            "app surface resource read is not granted".to_string(),
        ));
    }
    let response = crate::app_server_api::client(&state.app_server)
        .mcp_resource_read(server, uri, Some(session.thread_id))
        .await?;
    serde_json::to_value(response).map_err(Into::into)
}

async fn bridge_tool_call(
    state: AppState,
    session: AppSurfaceSession,
    request: AppSurfaceBridgeRequest,
) -> ApiResult<Value> {
    let server = required_string_param(&request.params, "server")?;
    let tool = required_string_param(&request.params, "tool")?;
    if !session
        .grants
        .tools
        .iter()
        .any(|grant| grant.server == server && grant.tool == tool)
    {
        return Err(ApiError::BadRequest(
            "app surface tool call is not granted".to_string(),
        ));
    }
    if session.provider == AppSurfaceProvider::Generated {
        if let Some(result) =
            require_generated_tool_approval(&state, &session, &request, &server, &tool).await?
        {
            return Ok(result);
        }
    }
    let response = crate::app_server_api::client(&state.app_server)
        .mcp_tool_call(McpServerToolCallRequest {
            server,
            thread_id: session.thread_id,
            tool,
            arguments: request.params.get("arguments").cloned(),
            meta: request.params.get("_meta").cloned(),
        })
        .await?;
    serde_json::to_value(response).map_err(Into::into)
}

async fn require_generated_tool_approval(
    state: &AppState,
    session: &AppSurfaceSession,
    request: &AppSurfaceBridgeRequest,
    server: &str,
    tool: &str,
) -> ApiResult<Option<Value>> {
    if let Some(approval_id) = request.params.get("approvalId").and_then(Value::as_str) {
        let approval = state.store.get_approval(approval_id).await?;
        validate_bridge_tool_approval(&approval, session, server, tool)?;
        return Ok(None);
    }

    let approval = state
        .store
        .insert_approval(NewApproval {
            request_id: format!(
                "app-surface-bridge:{}:{}:{}",
                session.id,
                session.revision,
                Uuid::new_v4()
            ),
            thread_id: Some(session.thread_id.clone()),
            turn_id: None,
            item_id: None,
            method: APP_SURFACE_BRIDGE_APPROVAL_METHOD.to_string(),
            payload: json!({
                "sessionId": session.id,
                "revision": session.revision,
                "provider": session.provider,
                "method": "tools/call",
                "server": server,
                "tool": tool,
                "message": format!("App surface \"{}\" wants to call MCP tool {server}/{tool}.", session.title),
                "reason": "Generated app surfaces require approval before MCP tool execution."
            }),
        })
        .await?;
    let event = state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: Some(session.thread_id.clone()),
            turn_id: None,
            item_id: None,
            kind: "approval.created".to_string(),
            codex_method: Some(APP_SURFACE_BRIDGE_APPROVAL_METHOD.to_string()),
            payload: serde_json::to_value(&approval)?,
        })
        .await?;
    let _ = state.events.send(event);

    Ok(Some(json!({
        "approvalRequired": true,
        "approvalId": approval.id,
        "method": APP_SURFACE_BRIDGE_APPROVAL_METHOD
    })))
}

fn validate_bridge_tool_approval(
    approval: &Approval,
    session: &AppSurfaceSession,
    server: &str,
    tool: &str,
) -> ApiResult<()> {
    if approval.method != APP_SURFACE_BRIDGE_APPROVAL_METHOD {
        return Err(ApiError::BadRequest(
            "approval is not for an app surface bridge call".to_string(),
        ));
    }
    if approval.status != "resolved" {
        return Err(ApiError::BadRequest(
            "app surface bridge approval is not resolved".to_string(),
        ));
    }
    if approval.thread_id.as_deref() != Some(session.thread_id.as_str())
        || approval.payload.get("sessionId").and_then(Value::as_str) != Some(session.id.as_str())
        || approval.payload.get("revision").and_then(Value::as_i64) != Some(session.revision)
        || approval.payload.get("method").and_then(Value::as_str) != Some("tools/call")
        || approval.payload.get("server").and_then(Value::as_str) != Some(server)
        || approval.payload.get("tool").and_then(Value::as_str) != Some(tool)
    {
        return Err(ApiError::BadRequest(
            "approval does not match this app surface bridge call".to_string(),
        ));
    }
    let decision = approval
        .response
        .as_ref()
        .and_then(|response| response.get("decision"))
        .and_then(Value::as_str);
    if decision != Some("accept") {
        return Err(ApiError::BadRequest(
            "app surface bridge approval was not accepted".to_string(),
        ));
    }
    Ok(())
}

async fn bridge_update_model_context(
    state: AppState,
    session: AppSurfaceSession,
    request: AppSurfaceBridgeRequest,
) -> ApiResult<Value> {
    if !session.grants.can_update_model_context {
        return Err(ApiError::BadRequest(
            "app surface is not granted ui/update-model-context".to_string(),
        ));
    }
    let event = state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: Some(session.thread_id.clone()),
            turn_id: None,
            item_id: None,
            kind: APP_SURFACE_MODEL_CONTEXT_UPDATED_EVENT.to_string(),
            codex_method: None,
            payload: json!({
                "sessionId": session.id,
                "revision": session.revision,
                "provider": session.provider,
                "context": request.params
            }),
        })
        .await?;
    let event_seq = event.seq;
    let _ = state.events.send(event);
    Ok(json!({
        "updated": true,
        "eventSeq": event_seq
    }))
}

async fn bridge_open_link(
    session: AppSurfaceSession,
    request: AppSurfaceBridgeRequest,
) -> ApiResult<Value> {
    if !session.grants.can_open_links {
        return Err(ApiError::BadRequest(
            "app surface is not granted ui/open-link".to_string(),
        ));
    }
    let url = required_string_param(&request.params, "url")?;
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(ApiError::BadRequest(
            "app surface open-link URL must be http or https".to_string(),
        ));
    }
    Ok(json!({
        "opened": false,
        "url": url,
        "reason": "host_link_opening_not_enabled"
    }))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppSurfaceBridgeMessageResult {
    input: ThreadInputResponse,
}

pub(crate) fn session_dto(session: AppSurfaceSession) -> AppSurfaceSessionDto {
    let document_url = format!(
        "/v1/app-surfaces/{}/document?revision={}",
        url_path_segment(&session.id),
        session.revision
    );
    AppSurfaceSessionDto {
        submit_available: session.status == AppSurfaceSessionStatus::Active
            && session.submitted_revision != Some(session.revision)
            && session.archived_at.is_none(),
        id: session.id,
        thread_id: session.thread_id,
        provider: session.provider,
        title: session.title,
        bridge_token: session.bridge_token,
        resource_uri: session.resource_uri,
        resource_mime_type: session.resource_mime_type,
        fallback_content: session.fallback_content,
        revision: session.revision,
        status: session.status,
        display_modes: session.display_modes,
        csp: session.csp,
        grants: session.grants,
        provenance: session.provenance,
        submitted_revision: session.submitted_revision,
        submitted_message: session.submitted_message,
        submitted_metadata: session.submitted_metadata,
        created_at: session.created_at,
        updated_at: session.updated_at,
        submitted_at: session.submitted_at,
        archived_at: session.archived_at,
        document_url,
    }
}

pub(crate) async fn broadcast_app_surface_event(
    state: &AppState,
    kind: &str,
    session: &AppSurfaceSession,
) -> ApiResult<()> {
    let event = app_surface_payload_event(state, kind, session).await?;
    let _ = state.events.send(event);
    Ok(())
}

pub(crate) async fn app_surface_payload_event(
    state: &AppState,
    kind: &str,
    session: &AppSurfaceSession,
) -> ApiResult<EventEnvelope> {
    state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: Some(session.thread_id.clone()),
            turn_id: None,
            item_id: None,
            kind: kind.to_string(),
            codex_method: None,
            payload: serde_json::to_value(session_dto(session.clone()))?,
        })
        .await
}

async fn append_bridge_audit(
    state: &AppState,
    session: &AppSurfaceSession,
    method: &str,
    params: &Value,
    response: &AppSurfaceBridgeResponse,
) -> ApiResult<()> {
    let status = if response.error.is_some() {
        "error"
    } else if response
        .result
        .as_ref()
        .and_then(|result| result.get("approvalRequired"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        "approval_required"
    } else {
        "ok"
    };
    let error = response.error.as_ref().map(|error| {
        json!({
            "code": error.code,
            "message": error.message
        })
    });
    let target = bridge_audit_target(method, params);
    let grant = bridge_audit_grant(session, method, params);
    let approval_id = bridge_audit_approval_id(params, response);
    let result = response
        .result
        .as_ref()
        .map(|result| bridge_audit_result(method, result));
    let event = state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: Some(session.thread_id.clone()),
            turn_id: None,
            item_id: None,
            kind: APP_SURFACE_BRIDGE_CALL_EVENT.to_string(),
            codex_method: None,
            payload: json!({
                "sessionId": session.id,
                "revision": session.revision,
                "provider": session.provider,
                "method": method,
                "target": target,
                "grant": grant,
                "approvalId": approval_id,
                "status": status,
                "result": result,
                "error": error
            }),
        })
        .await?;
    let _ = state.events.send(event);
    Ok(())
}

fn bridge_audit_approval_id(params: &Value, response: &AppSurfaceBridgeResponse) -> Value {
    response
        .result
        .as_ref()
        .and_then(|result| result.get("approvalId"))
        .or_else(|| params.get("approvalId"))
        .cloned()
        .unwrap_or(Value::Null)
}

fn bridge_audit_target(method: &str, params: &Value) -> Value {
    match method {
        "tools/call" => json!({
            "server": params.get("server").and_then(Value::as_str),
            "tool": params.get("tool").and_then(Value::as_str)
        }),
        "resources/read" => json!({
            "server": params.get("server").and_then(Value::as_str),
            "uri": params.get("uri").and_then(Value::as_str)
        }),
        "ui/open-link" => json!({
            "url": params.get("url").and_then(Value::as_str)
        }),
        _ => Value::Null,
    }
}

fn bridge_supported_methods(session: &AppSurfaceSession) -> Vec<&'static str> {
    let mut methods = vec!["ui/initialize", "tools/call", "resources/read"];
    if session.grants.can_send_message {
        methods.push("ui/message");
    }
    if session.grants.can_update_model_context {
        methods.push("ui/update-model-context");
    }
    if session.grants.can_open_links {
        methods.push("ui/open-link");
    }
    methods
}

fn bridge_audit_grant(session: &AppSurfaceSession, method: &str, params: &Value) -> Value {
    match method {
        "ui/initialize" => json!({
            "allowed": true,
            "capability": "bridge"
        }),
        "ui/message" => json!({
            "allowed": session.grants.can_send_message,
            "capability": "canSendMessage"
        }),
        "ui/update-model-context" => json!({
            "allowed": session.grants.can_update_model_context,
            "capability": "canUpdateModelContext"
        }),
        "ui/open-link" => json!({
            "allowed": session.grants.can_open_links,
            "capability": "canOpenLinks"
        }),
        "tools/call" => {
            let server = params
                .get("server")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let tool = params
                .get("tool")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let allowed = session
                .grants
                .tools
                .iter()
                .any(|grant| grant.server == server && grant.tool == tool);
            json!({
                "allowed": allowed,
                "server": server,
                "tool": tool
            })
        }
        "resources/read" => {
            let server = params
                .get("server")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let uri = params
                .get("uri")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let allowed = uri == session.resource_uri
                || session
                    .grants
                    .resources
                    .iter()
                    .any(|grant| grant.server.as_deref() == Some(server) && grant.uri == uri);
            json!({
                "allowed": allowed,
                "server": server,
                "uri": uri
            })
        }
        _ => Value::Null,
    }
}

fn bridge_audit_result(method: &str, result: &Value) -> Value {
    match method {
        "ui/initialize" => json!({
            "methodCount": result
                .get("capabilities")
                .and_then(|capabilities| capabilities.get("methods"))
                .and_then(Value::as_array)
                .map(Vec::len)
        }),
        "tools/call" => json!({
            "approvalRequired": result.get("approvalRequired").and_then(Value::as_bool),
            "isError": result.get("isError").and_then(Value::as_bool),
            "hasContent": result.get("content").is_some(),
            "hasStructuredContent": result.get("structuredContent").is_some(),
            "hasMeta": result.get("_meta").is_some()
        }),
        "resources/read" => json!({
            "contentCount": result
                .get("contents")
                .and_then(Value::as_array)
                .map(Vec::len)
        }),
        _ => Value::Null,
    }
}

fn required_string_param(params: &Value, field: &str) -> ApiResult<String> {
    params
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| ApiError::BadRequest(format!("missing app surface bridge field {field}")))
}

fn url_path_segment(value: &str) -> String {
    value.replace('%', "%25").replace('/', "%2F")
}

impl IntoResponse for AppSurfaceBridgeResponse {
    fn into_response(self) -> Response {
        (StatusCode::OK, Json(self)).into_response()
    }
}
