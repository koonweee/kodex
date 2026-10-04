use axum::{
    extract::{Path, Query, State},
    routing::{get, patch, post},
    Json, Router,
};
use serde::Deserialize;
use utoipa::{IntoParams, ToSchema};

use crate::{
    api::AppState,
    app_server_api::{
        self, ConfiguredMcpServerListResponse, McpConfigMutationResponse, McpOAuthLoginRequest,
        McpOAuthLoginResponse, McpReloadResponse, McpResourceReadResponse, McpServerInstallRequest,
        McpServerListResponse, McpServerRemoveRequest, McpServerStatusDetail,
        McpServerToggleRequest, McpServerUpdateRequest, NativeConfigWriteResult,
    },
    error::{ApiError, ApiResult},
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/mcp/configured-servers",
            get(list_configured_mcp_servers),
        )
        .route("/v1/mcp/servers", get(list_mcp_servers))
        .route("/v1/mcp/servers", post(add_mcp_server))
        .route(
            "/v1/mcp/servers/{server}",
            patch(update_mcp_server).delete(remove_mcp_server),
        )
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
            .mcp_configured_servers(&state.config.codex.home)
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
    request
        .write_target
        .validate_owned_path(&state.config.codex.home)?;
    let name = request.name.clone();
    let configured = app_server_api::client(&state.app_server)
        .mcp_configured_servers(&state.config.codex.home)
        .await?;
    if configured.servers.iter().any(|server| server.name == name) {
        return Err(ApiError::BadRequest(format!(
            "MCP server '{name}' already exists; edit its individual fields"
        )));
    }
    let write = app_server_api::client(&state.app_server)
        .mcp_add_server(request)
        .await?;
    finish_config_write(&state, write).await
}

#[utoipa::path(
    patch,
    path = "/v1/mcp/servers/{server}",
    params(("server" = String, Path, description = "MCP server name")),
    request_body = McpServerUpdateRequest,
    responses((status = 200, body = McpConfigMutationResponse))
)]
pub async fn update_mcp_server(
    State(state): State<AppState>,
    Path(server): Path<String>,
    Json(request): Json<McpServerUpdateRequest>,
) -> ApiResult<Json<McpConfigMutationResponse>> {
    request
        .write_target
        .validate_owned_path(&state.config.codex.home)?;
    let write = app_server_api::client(&state.app_server)
        .mcp_update_server(&server, request)
        .await?;
    finish_config_write(&state, write).await
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
    request
        .write_target
        .validate_owned_path(&state.config.codex.home)?;
    let write = app_server_api::client(&state.app_server)
        .mcp_set_server_enabled(&server, request)
        .await?;
    finish_config_write(&state, write).await
}

#[utoipa::path(
    delete,
    path = "/v1/mcp/servers/{server}",
    params(("server" = String, Path, description = "MCP server name")),
    request_body = McpServerRemoveRequest,
    responses((status = 200, body = McpConfigMutationResponse))
)]
pub async fn remove_mcp_server(
    State(state): State<AppState>,
    Path(server): Path<String>,
    Json(request): Json<McpServerRemoveRequest>,
) -> ApiResult<Json<McpConfigMutationResponse>> {
    request
        .write_target
        .validate_owned_path(&state.config.codex.home)?;
    let write = app_server_api::client(&state.app_server)
        .mcp_remove_server(&server, request)
        .await?;
    finish_config_write(&state, write).await
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
            .mcp_resource_read(app_server_api::McpResourceReadRequest {
                server,
                uri: query.uri,
                thread_id: query.thread_id,
                ..Default::default()
            })
            .await?,
    ))
}

async fn finish_config_write(
    state: &AppState,
    write: NativeConfigWriteResult,
) -> ApiResult<Json<McpConfigMutationResponse>> {
    // The file is already durable. A failed reload cannot turn this into an
    // unsaved result or suppress the global authoritative refill.
    let notification_error = super::config_writes::saved_notification_error(
        super::config_writes::emit_config_changed(state).await,
    );
    let reload = match app_server_api::client(&state.app_server).mcp_reload().await {
        Ok(response) => response,
        Err(_) => McpReloadResponse {
            queued: false,
            error: Some(
                "Configuration saved, but native MCP reload was not confirmed. Retry reload."
                    .into(),
            ),
        },
    };
    Ok(Json(McpConfigMutationResponse {
        saved: true,
        write,
        reload,
        notification_error,
    }))
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
