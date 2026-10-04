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
    pub cwd: Option<String>,
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
    let cwd = super::projects::settings_cwd(&state, query.project_id.as_deref(), query.cwd).await?;

    Ok(Json(
        app_server_api::client(&state.app_server)
            .composer_settings(cwd, &state.config.codex.home)
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
    request
        .write_target
        .validate_owned_path(&state.config.codex.home)?;
    let should_invalidate_skills =
        request.model.is_some() || request.effort.is_some() || request.service_tier.is_some();
    let mut response = app_server_api::client(&state.app_server)
        .update_composer_settings(request)
        .await?;
    response.notification_error = super::config_writes::saved_notification_error(
        super::config_writes::emit_config_changed(&state).await,
    );
    if should_invalidate_skills {
        let warning = super::config_writes::saved_notification_error(
            skills::broadcast_skills_changed(&state, "config-write").await,
        );
        response.notification_error = response.notification_error.or(warning);
    }
    Ok(Json(response))
}
