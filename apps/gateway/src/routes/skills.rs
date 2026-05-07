use axum::{
    extract::{Query, State},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use utoipa::{IntoParams, ToSchema};

use crate::{api::AppState, app_server_api::SkillsCatalogResponse, error::ApiResult};

pub fn router() -> Router<AppState> {
    Router::new().route("/v1/skills", get(list_skills))
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillsQuery {
    pub cwd: Option<String>,
    #[serde(default)]
    pub force_reload: bool,
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
