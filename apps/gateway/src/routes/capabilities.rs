use axum::{extract::State, routing::get, Json, Router};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::api::AppState;

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
    pub gateway_auth: bool,
    pub trusted_network_only: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppServerCapabilities {
    pub ready: bool,
    pub experimental_api: bool,
}

#[utoipa::path(get, path = "/v1/capabilities", responses((status = 200, body = CapabilitiesResponse)))]
pub async fn capabilities(State(state): State<AppState>) -> Json<CapabilitiesResponse> {
    Json(CapabilitiesResponse {
        gateway: GatewayCapabilities {
            version: env!("CARGO_PKG_VERSION").to_string(),
            sse: true,
            approvals: true,
            gateway_auth: false,
            trusted_network_only: state.config.server.trusted_network_only,
        },
        app_server: AppServerCapabilities {
            ready: state.app_server.is_ready(),
            experimental_api: true,
        },
    })
}
