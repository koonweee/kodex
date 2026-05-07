use axum::{
    extract::{Query, State},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use utoipa::{IntoParams, ToSchema};

use crate::{
    api::AppState,
    app_server_api::{
        self, ComposerSettingsResponse, ComposerSettingsUpdateRequest,
        ComposerSettingsUpdateResponse,
    },
    error::ApiResult,
    skills,
};

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/v1/composer-settings",
        get(read_composer_settings).patch(update_composer_settings),
    )
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ComposerSettingsQuery {
    pub project_id: Option<String>,
}

#[utoipa::path(
    get,
    path = "/v1/composer-settings",
    params(ComposerSettingsQuery),
    responses((status = 200, body = ComposerSettingsResponse))
)]
pub async fn read_composer_settings(
    State(state): State<AppState>,
    Query(query): Query<ComposerSettingsQuery>,
) -> ApiResult<Json<ComposerSettingsResponse>> {
    let cwd = match query.project_id {
        Some(project_id) => Some(state.store.get_project(&project_id).await?.cwd),
        None => None,
    };

    Ok(Json(
        app_server_api::client(&state.app_server)
            .composer_settings(cwd)
            .await?,
    ))
}

#[utoipa::path(
    patch,
    path = "/v1/composer-settings",
    request_body = ComposerSettingsUpdateRequest,
    responses((status = 200, body = ComposerSettingsUpdateResponse))
)]
pub async fn update_composer_settings(
    State(state): State<AppState>,
    Json(request): Json<ComposerSettingsUpdateRequest>,
) -> ApiResult<Json<ComposerSettingsUpdateResponse>> {
    let should_invalidate_skills =
        request.model.is_some() || request.effort.is_some() || request.service_tier.is_some();
    let response = app_server_api::client(&state.app_server)
        .update_composer_settings(request)
        .await?;
    if should_invalidate_skills {
        skills::broadcast_skills_changed(&state, "config-write").await?;
    }
    Ok(Json(response))
}
