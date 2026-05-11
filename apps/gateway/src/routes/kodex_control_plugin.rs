use std::path::{Path, PathBuf};

use axum::{extract::State, routing::get, Json, Router};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::{
    api::AppState,
    app_server_api::{
        self, AppSummary, MarketplaceAddResponse, PluginDetail, PluginInstallResponse,
        PluginSummary,
    },
    error::{ApiError, ApiResult},
    skills,
};

const KODEX_CONTROL_PLUGIN_NAME: &str = "kodex-control";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/kodex-control-plugin", get(kodex_control_plugin_status))
        .route(
            "/v1/kodex-control-plugin/install",
            axum::routing::post(install_kodex_control_plugin),
        )
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum KodexControlPluginStatusKind {
    NotInstalled,
    Installed,
    AppServerUnavailable,
    SetupError,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct KodexControlPluginStatusResponse {
    pub status: KodexControlPluginStatusKind,
    pub plugin_name: String,
    pub marketplace_path: Option<String>,
    pub marketplace_added: bool,
    pub app_server_ready: bool,
    pub setup_error: Option<String>,
    pub plugin: Option<PluginSummary>,
    pub skills: Vec<String>,
    pub mcp_servers: Vec<String>,
    pub apps_needing_auth: Vec<AppSummary>,
    pub auth_policy: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct KodexControlPluginInstallResponse {
    pub status: KodexControlPluginStatusResponse,
    pub marketplace: Option<MarketplaceAddResponse>,
    pub install: Option<PluginInstallResponse>,
}

#[utoipa::path(get, path = "/v1/kodex-control-plugin", responses((status = 200, body = KodexControlPluginStatusResponse)))]
pub async fn kodex_control_plugin_status(
    State(state): State<AppState>,
) -> ApiResult<Json<KodexControlPluginStatusResponse>> {
    Ok(Json(read_status(&state, false, None, None).await?))
}

#[utoipa::path(post, path = "/v1/kodex-control-plugin/install", responses((status = 200, body = KodexControlPluginInstallResponse)))]
pub async fn install_kodex_control_plugin(
    State(state): State<AppState>,
) -> ApiResult<Json<KodexControlPluginInstallResponse>> {
    if !state.app_server.is_ready() {
        return Ok(Json(KodexControlPluginInstallResponse {
            status: unavailable_status(&state),
            marketplace: None,
            install: None,
        }));
    }
    let marketplace_path = resolve_marketplace_path(&state)?;
    let marketplace_path_text = marketplace_path.to_string_lossy().to_string();
    let marketplace_root = marketplace_root_dir(&marketplace_path)?;
    let marketplace_root_text = marketplace_root.to_string_lossy().to_string();
    let client = app_server_api::client(&state.app_server);
    let marketplace = client
        .marketplace_add(marketplace_root_text, None, None)
        .await?;
    let install = client
        .plugin_install(
            KODEX_CONTROL_PLUGIN_NAME.to_string(),
            Some(marketplace_path_text.clone()),
            None,
        )
        .await?;
    skills::broadcast_skills_changed(&state, "kodex-control-plugin-install").await?;
    let status = read_status(
        &state,
        true,
        Some(install.apps_needing_auth.clone()),
        Some(install.auth_policy.clone()),
    )
    .await?;
    Ok(Json(KodexControlPluginInstallResponse {
        status,
        marketplace: Some(marketplace),
        install: Some(install),
    }))
}

async fn read_status(
    state: &AppState,
    marketplace_added: bool,
    apps_needing_auth: Option<Vec<AppSummary>>,
    auth_policy: Option<String>,
) -> ApiResult<KodexControlPluginStatusResponse> {
    if !state.app_server.is_ready() {
        return Ok(unavailable_status(state));
    }
    let marketplace_path = match resolve_marketplace_path(state) {
        Ok(path) => path,
        Err(error) => {
            return Ok(KodexControlPluginStatusResponse {
                status: KodexControlPluginStatusKind::SetupError,
                plugin_name: KODEX_CONTROL_PLUGIN_NAME.to_string(),
                marketplace_path: None,
                marketplace_added,
                app_server_ready: true,
                setup_error: Some(error.to_string()),
                plugin: None,
                skills: Vec::new(),
                mcp_servers: Vec::new(),
                apps_needing_auth: apps_needing_auth.unwrap_or_default(),
                auth_policy,
            });
        }
    };
    let marketplace_path_text = marketplace_path.to_string_lossy().to_string();
    read_status_from_marketplace_path(
        &state,
        marketplace_added,
        marketplace_path_text,
        apps_needing_auth,
        auth_policy,
    )
    .await
}

async fn read_status_from_marketplace_path(
    state: &AppState,
    marketplace_added: bool,
    marketplace_path_text: String,
    apps_needing_auth: Option<Vec<AppSummary>>,
    auth_policy: Option<String>,
) -> ApiResult<KodexControlPluginStatusResponse> {
    match app_server_api::client(&state.app_server)
        .plugin_read(
            KODEX_CONTROL_PLUGIN_NAME.to_string(),
            Some(marketplace_path_text.clone()),
            None,
        )
        .await
    {
        Ok(response) => Ok(status_from_plugin_detail(
            marketplace_path_text,
            marketplace_added,
            response.plugin,
            apps_needing_auth.unwrap_or_default(),
            auth_policy,
        )),
        Err(error) => Ok(KodexControlPluginStatusResponse {
            status: KodexControlPluginStatusKind::SetupError,
            plugin_name: KODEX_CONTROL_PLUGIN_NAME.to_string(),
            marketplace_path: Some(marketplace_path_text),
            marketplace_added,
            app_server_ready: true,
            setup_error: Some(error.to_string()),
            plugin: None,
            skills: Vec::new(),
            mcp_servers: Vec::new(),
            apps_needing_auth: apps_needing_auth.unwrap_or_default(),
            auth_policy,
        }),
    }
}

fn status_from_plugin_detail(
    marketplace_path: String,
    marketplace_added: bool,
    detail: PluginDetail,
    apps_needing_auth: Vec<AppSummary>,
    auth_policy: Option<String>,
) -> KodexControlPluginStatusResponse {
    let status = if detail.summary.installed {
        KodexControlPluginStatusKind::Installed
    } else {
        KodexControlPluginStatusKind::NotInstalled
    };
    KodexControlPluginStatusResponse {
        status,
        plugin_name: KODEX_CONTROL_PLUGIN_NAME.to_string(),
        marketplace_path: Some(marketplace_path),
        marketplace_added,
        app_server_ready: true,
        setup_error: None,
        skills: detail.skills.into_iter().map(|skill| skill.name).collect(),
        mcp_servers: detail.mcp_servers,
        plugin: Some(detail.summary),
        apps_needing_auth,
        auth_policy,
    }
}

fn unavailable_status(state: &AppState) -> KodexControlPluginStatusResponse {
    KodexControlPluginStatusResponse {
        status: KodexControlPluginStatusKind::AppServerUnavailable,
        plugin_name: KODEX_CONTROL_PLUGIN_NAME.to_string(),
        marketplace_path: state
            .config
            .plugins
            .kodex_control_marketplace_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        marketplace_added: false,
        app_server_ready: false,
        setup_error: state.app_server.readiness_error(),
        plugin: None,
        skills: Vec::new(),
        mcp_servers: Vec::new(),
        apps_needing_auth: Vec::new(),
        auth_policy: None,
    }
}

fn resolve_marketplace_path(state: &AppState) -> ApiResult<PathBuf> {
    let path = state
        .config
        .plugins
        .kodex_control_marketplace_path
        .clone()
        .unwrap_or_else(default_marketplace_path);
    if !path.exists() {
        return Err(ApiError::BadRequest(format!(
            "Kodex Control marketplace was not found at {}",
            path.display()
        )));
    }
    Ok(path)
}

fn marketplace_root_dir(marketplace_path: &Path) -> ApiResult<PathBuf> {
    let Some(plugins_dir) = marketplace_path.parent() else {
        return Err(ApiError::BadRequest(format!(
            "Kodex Control marketplace path has no parent directory: {}",
            marketplace_path.display()
        )));
    };
    let Some(dot_agents_dir) = plugins_dir.parent() else {
        return Err(ApiError::BadRequest(format!(
            "Kodex Control marketplace path must live under .agents/plugins: {}",
            marketplace_path.display()
        )));
    };
    let Some(marketplace_root) = dot_agents_dir.parent() else {
        return Err(ApiError::BadRequest(format!(
            "Kodex Control marketplace path must live under .agents/plugins: {}",
            marketplace_path.display()
        )));
    };
    if plugins_dir.file_name().and_then(|name| name.to_str()) != Some("plugins")
        || dot_agents_dir.file_name().and_then(|name| name.to_str()) != Some(".agents")
    {
        return Err(ApiError::BadRequest(format!(
            "Kodex Control marketplace path must live under .agents/plugins: {}",
            marketplace_path.display()
        )));
    }
    if !marketplace_root.is_dir() {
        return Err(ApiError::BadRequest(format!(
            "Kodex Control marketplace root directory was not found at {}",
            marketplace_root.display()
        )));
    }
    Ok(marketplace_root.to_path_buf())
}

fn default_marketplace_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .unwrap_or_else(|| Path::new("."))
        .join(".agents/plugins/marketplace.json")
}
