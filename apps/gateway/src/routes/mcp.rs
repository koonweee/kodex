use axum::{
    extract::{Path, Query, State},
    routing::{delete, get, patch, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::{
    api::AppState,
    app_server_api::{
        self, ConfiguredMcpServerListResponse, McpConfigMutationResponse, McpOAuthLoginRequest,
        McpOAuthLoginResponse, McpReloadResponse, McpResourceReadResponse, McpServerInstallRequest,
        McpServerListResponse, McpServerStatusDetail, McpServerToggleRequest,
    },
    error::{ApiError, ApiResult},
    events::MCP_CONFIG_CHANGED_EVENT,
    store::NewEvent,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/mcp/configured-servers",
            get(list_configured_mcp_servers),
        )
        .route("/v1/mcp/servers", get(list_mcp_servers))
        .route("/v1/mcp/servers", post(add_mcp_server))
        .route("/v1/mcp/servers/{server}", delete(remove_mcp_server))
        .route("/v1/mcp/servers/{server}/replace", post(replace_mcp_server))
        .route(
            "/v1/mcp/servers/{server}/enabled",
            patch(set_mcp_server_enabled),
        )
        .route(
            "/v1/mcp/servers/{server}/resources/read",
            get(read_mcp_resource),
        )
        .route(
            "/v1/mcp/servers/{server}/oauth-login",
            post(start_mcp_oauth_login),
        )
        .route("/v1/mcp/reload", post(reload_mcp_servers))
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpServersQuery {
    #[serde(default)]
    pub detail: Option<McpServerStatusDetail>,
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceReadQuery {
    pub uri: String,
    pub thread_id: Option<String>,
}

#[utoipa::path(
    get,
    path = "/v1/mcp/configured-servers",
    responses((status = 200, body = ConfiguredMcpServerListResponse))
)]
pub async fn list_configured_mcp_servers(
    State(state): State<AppState>,
) -> ApiResult<Json<ConfiguredMcpServerListResponse>> {
    Ok(Json(
        app_server_api::client(&state.app_server)
            .mcp_configured_servers()
            .await?,
    ))
}

#[utoipa::path(
    get,
    path = "/v1/mcp/servers",
    params(McpServersQuery),
    responses((status = 200, body = McpServerListResponse))
)]
pub async fn list_mcp_servers(
    State(state): State<AppState>,
    Query(query): Query<McpServersQuery>,
) -> ApiResult<Json<McpServerListResponse>> {
    Ok(Json(
        app_server_api::client(&state.app_server)
            .mcp_server_status_list(query.detail.unwrap_or(McpServerStatusDetail::Full))
            .await?,
    ))
}

#[utoipa::path(
    post,
    path = "/v1/mcp/servers",
    request_body = McpServerInstallRequest,
    responses((status = 200, body = McpConfigMutationResponse))
)]
pub async fn add_mcp_server(
    State(state): State<AppState>,
    Json(request): Json<McpServerInstallRequest>,
) -> ApiResult<Json<McpConfigMutationResponse>> {
    let name = request.name.clone();
    let configured = app_server_api::client(&state.app_server)
        .mcp_configured_servers()
        .await?;
    if configured.servers.iter().any(|server| server.name == name) {
        return Err(ApiError::BadRequest(format!(
            "MCP server '{name}' already exists; use replace to overwrite it"
        )));
    }
    write_mcp_server(state, name, request, "add").await
}

#[utoipa::path(
    post,
    path = "/v1/mcp/servers/{server}/replace",
    params(("server" = String, Path, description = "MCP server name")),
    request_body = McpServerInstallRequest,
    responses((status = 200, body = McpConfigMutationResponse))
)]
pub async fn replace_mcp_server(
    State(state): State<AppState>,
    Path(server): Path<String>,
    Json(request): Json<McpServerInstallRequest>,
) -> ApiResult<Json<McpConfigMutationResponse>> {
    let client = app_server_api::client(&state.app_server);
    let configured_server = client.mcp_replace_server(server.clone(), request).await?;
    let reload = client.mcp_reload().await?;
    emit_config_changed(&state, "replace", &server).await?;
    Ok(Json(McpConfigMutationResponse {
        configured_server: Some(configured_server),
        reload,
    }))
}

#[utoipa::path(
    patch,
    path = "/v1/mcp/servers/{server}/enabled",
    params(("server" = String, Path, description = "MCP server name")),
    request_body = McpServerToggleRequest,
    responses((status = 200, body = McpConfigMutationResponse))
)]
pub async fn set_mcp_server_enabled(
    State(state): State<AppState>,
    Path(server): Path<String>,
    Json(request): Json<McpServerToggleRequest>,
) -> ApiResult<Json<McpConfigMutationResponse>> {
    let client = app_server_api::client(&state.app_server);
    client
        .mcp_set_server_enabled(server.clone(), request.enabled)
        .await?;
    let reload = client.mcp_reload().await?;
    emit_config_changed(&state, "toggle", &server).await?;
    Ok(Json(McpConfigMutationResponse {
        configured_server: None,
        reload,
    }))
}

#[utoipa::path(
    delete,
    path = "/v1/mcp/servers/{server}",
    params(("server" = String, Path, description = "MCP server name")),
    responses((status = 200, body = McpConfigMutationResponse))
)]
pub async fn remove_mcp_server(
    State(state): State<AppState>,
    Path(server): Path<String>,
) -> ApiResult<Json<McpConfigMutationResponse>> {
    let client = app_server_api::client(&state.app_server);
    client.mcp_remove_server(server.clone()).await?;
    let reload = client.mcp_reload().await?;
    emit_config_changed(&state, "remove", &server).await?;
    Ok(Json(McpConfigMutationResponse {
        configured_server: None,
        reload,
    }))
}

#[utoipa::path(
    get,
    path = "/v1/mcp/servers/{server}/resources/read",
    params(
        ("server" = String, Path, description = "MCP server name"),
        McpResourceReadQuery
    ),
    responses((status = 200, body = McpResourceReadResponse))
)]
pub async fn read_mcp_resource(
    State(state): State<AppState>,
    Path(server): Path<String>,
    Query(query): Query<McpResourceReadQuery>,
) -> ApiResult<Json<McpResourceReadResponse>> {
    Ok(Json(
        app_server_api::client(&state.app_server)
            .mcp_resource_read(server, query.uri, query.thread_id)
            .await?,
    ))
}

async fn write_mcp_server(
    state: AppState,
    name: String,
    request: McpServerInstallRequest,
    operation: &'static str,
) -> ApiResult<Json<McpConfigMutationResponse>> {
    let client = app_server_api::client(&state.app_server);
    let configured_server = client.mcp_write_server(name.clone(), request).await?;
    let reload = client.mcp_reload().await?;
    emit_config_changed(&state, operation, &name).await?;
    Ok(Json(McpConfigMutationResponse {
        configured_server: Some(configured_server),
        reload,
    }))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpConfigChangedPayload<'a> {
    operation: &'a str,
    server: &'a str,
}

async fn emit_config_changed(state: &AppState, operation: &str, server: &str) -> ApiResult<()> {
    let event = state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: None,
            turn_id: None,
            item_id: None,
            kind: MCP_CONFIG_CHANGED_EVENT.to_string(),
            codex_method: None,
            payload: serde_json::to_value(McpConfigChangedPayload { operation, server })?,
        })
        .await?;
    let _ = state.events.send(event);
    Ok(())
}

#[utoipa::path(
    post,
    path = "/v1/mcp/servers/{server}/oauth-login",
    params(("server" = String, Path, description = "MCP server name")),
    request_body = McpOAuthLoginRequest,
    responses((status = 200, body = McpOAuthLoginResponse))
)]
pub async fn start_mcp_oauth_login(
    State(state): State<AppState>,
    Path(server): Path<String>,
    Json(request): Json<McpOAuthLoginRequest>,
) -> ApiResult<Json<McpOAuthLoginResponse>> {
    Ok(Json(
        app_server_api::client(&state.app_server)
            .mcp_oauth_login(server, request.scopes, request.timeout_secs)
            .await?,
    ))
}

#[utoipa::path(
    post,
    path = "/v1/mcp/reload",
    responses((status = 200, body = McpReloadResponse))
)]
pub async fn reload_mcp_servers(
    State(state): State<AppState>,
) -> ApiResult<Json<McpReloadResponse>> {
    Ok(Json(
        app_server_api::client(&state.app_server)
            .mcp_reload()
            .await?,
    ))
}
