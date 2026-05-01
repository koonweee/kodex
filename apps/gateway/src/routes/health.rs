use axum::{extract::State, routing::get, Json, Router};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::api::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct HealthResponse {
    pub status: String,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReadyResponse {
    pub ready: bool,
}

#[utoipa::path(get, path = "/healthz", responses((status = 200, body = HealthResponse)))]
pub async fn healthz() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
    })
}

#[utoipa::path(get, path = "/readyz", responses((status = 200, body = ReadyResponse)))]
pub async fn readyz(State(state): State<AppState>) -> Json<ReadyResponse> {
    Json(ReadyResponse {
        ready: state.app_server.is_ready(),
    })
}
