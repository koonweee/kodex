use axum::{
    extract::{Query, State},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use utoipa::{IntoParams, ToSchema};

use crate::{
    api::AppState,
    app_server_api::{self, ModelListResponse},
    error::ApiResult,
};

pub fn router() -> Router<AppState> {
    Router::new().route("/v1/models", get(list_models))
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelsQuery {
    #[serde(default)]
    pub include_hidden: bool,
}

#[utoipa::path(get, path = "/v1/models", params(ModelsQuery), responses((status = 200, body = ModelListResponse)))]
pub async fn list_models(
    State(state): State<AppState>,
    Query(query): Query<ModelsQuery>,
) -> ApiResult<Json<ModelListResponse>> {
    Ok(Json(
        app_server_api::client(&state.app_server)
            .model_list(query.include_hidden)
            .await?,
    ))
}
