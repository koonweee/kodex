use axum::{extract::State, routing::get, Json, Router};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::api::AppState;
use crate::schema::APP_SERVER_SCHEMA_VERSION;

pub fn router() -> Router<AppState> {
    Router::new().route("/v1/capabilities", get(capabilities))
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitiesResponse {
    pub gateway: GatewayCapabilities,
    pub app_server: AppServerCapabilities,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GatewayCapabilities {
    pub version: String,
    pub sse: bool,
    pub approvals: bool,
    pub terminals: TerminalCapabilities,
    pub gateway_auth: bool,
    pub trusted_network_only: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCapabilities {
    pub enabled: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppServerCapabilities {
    pub ready: bool,
    pub experimental_api: bool,
    pub schema_version: String,
    pub detected_version: Option<String>,
    pub detected_version_matches_schema: Option<bool>,
}

#[utoipa::path(get, path = "/v1/capabilities", responses((status = 200, body = CapabilitiesResponse)))]
pub async fn capabilities(State(state): State<AppState>) -> Json<CapabilitiesResponse> {
    let detected_version = state.app_server.detected_version();
    let detected_version_matches_schema = detected_version
        .as_ref()
        .map(|version| version == APP_SERVER_SCHEMA_VERSION);

    Json(CapabilitiesResponse {
        gateway: GatewayCapabilities {
            version: env!("CARGO_PKG_VERSION").to_string(),
            sse: true,
            approvals: true,
            terminals: TerminalCapabilities { enabled: true },
            gateway_auth: false,
            trusted_network_only: state.config.server.trusted_network_only,
        },
        app_server: AppServerCapabilities {
            ready: state.app_server.is_ready(),
            experimental_api: true,
            schema_version: APP_SERVER_SCHEMA_VERSION.to_string(),
            detected_version,
            detected_version_matches_schema,
        },
    })
}
