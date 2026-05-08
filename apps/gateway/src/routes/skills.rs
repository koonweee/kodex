use axum::{
    body::Body,
    extract::{Query, State},
    http::Response,
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use utoipa::{IntoParams, ToSchema};

use crate::{
    api::AppState, app_server_api::SkillsCatalogResponse, error::ApiResult, routes::file_preview,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/skills", get(list_skills))
        .route("/v1/skills/icon", get(preview_skill_icon))
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillsQuery {
    pub cwd: Option<String>,
    #[serde(default)]
    pub force_reload: bool,
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
pub struct SkillIconQuery {
    pub path: String,
}

#[utoipa::path(
    get,
    path = "/v1/skills",
    params(SkillsQuery),
    responses((status = 200, body = SkillsCatalogResponse))
)]
pub async fn list_skills(
    State(state): State<AppState>,
    Query(query): Query<SkillsQuery>,
) -> ApiResult<Json<SkillsCatalogResponse>> {
    Ok(Json(
        state
            .skills
            .catalog(&state.app_server, query.cwd, query.force_reload)
            .await?,
    ))
}

#[utoipa::path(
    get,
    path = "/v1/skills/icon",
    summary = "Preview a local skill icon image",
    description = "Serves supported readable local skill icon images for localhost or trusted VPN deployments; this endpoint is not a public-safe filesystem authorization model.",
    params(SkillIconQuery),
    responses(
        (status = 200, description = "Local skill icon image bytes"),
        (status = 404, description = "Icon path was not found"),
        (status = 415, description = "Icon path exists but is not a supported image type")
    )
)]
pub async fn preview_skill_icon(Query(query): Query<SkillIconQuery>) -> ApiResult<Response<Body>> {
    file_preview::preview_local_image_file(&query.path).await
}
