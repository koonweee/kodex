use axum::{
    extract::{Path, Query, State},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use utoipa::{IntoParams, ToSchema};

use crate::{
    api::AppState,
    app_server_api::{
        self, McpOAuthLoginRequest, McpOAuthLoginResponse, McpReloadResponse,
        McpResourceReadResponse, McpServerListResponse, McpServerStatusDetail,
    },
    error::ApiResult,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/mcp/servers", get(list_mcp_servers))
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
