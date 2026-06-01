use axum::{
    extract::{Query, State},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use utoipa::{IntoParams, ToSchema};

use crate::{
    api::AppState,
    app_server_api::{self, PermissionProfileListResponse},
    error::ApiResult,
};

pub fn router() -> Router<AppState> {
    Router::new().route("/v1/permission-profiles", get(list_permission_profiles))
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PermissionProfilesQuery {
    pub project_id: Option<String>,
    pub cwd: Option<String>,
    pub limit: Option<u32>,
}

#[utoipa::path(
    get,
    path = "/v1/permission-profiles",
    params(PermissionProfilesQuery),
    responses((status = 200, body = PermissionProfileListResponse))
)]
pub async fn list_permission_profiles(
    State(state): State<AppState>,
    Query(query): Query<PermissionProfilesQuery>,
) -> ApiResult<Json<PermissionProfileListResponse>> {
    let cwd = match (query.project_id, query.cwd) {
        (Some(project_id), _) => Some(state.store.get_project(&project_id).await?.cwd),
        (None, cwd) => cwd,
    };
    let client = app_server_api::client(&state.app_server);
    let mut cursor = None;
    let mut profiles = Vec::new();
    loop {
        let page = client
            .permission_profile_list(cwd.clone(), cursor, query.limit)
            .await?;
        profiles.extend(page.data);
        let Some(next_cursor) = page.next_cursor else {
            break;
        };
        cursor = Some(next_cursor);
    }
    Ok(Json(PermissionProfileListResponse { profiles }))
}
