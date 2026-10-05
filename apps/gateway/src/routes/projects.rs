use std::{collections::BTreeMap, path::Path as FsPath};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

pub use crate::app_server_api::{Project, ProjectRoot};
use crate::{
    api::AppState,
    app_server_api,
    error::{ApiError, ApiResult},
};

#[cfg(test)]
mod native_contract_tests;
#[cfg(test)]
mod tests;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/projects", get(list_projects).post(create_project))
        .route(
            "/v1/projects/{project_id}",
            get(get_project)
                .patch(update_project)
                .delete(delete_project),
        )
        .route("/v1/projects/{project_id}/move", post(move_project))
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectListResponse {
    pub projects: Vec<Project>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectRequest {
    pub name: String,
    pub roots: Vec<ProjectRoot>,
    pub idempotency_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProjectRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roots: Option<Vec<ProjectRoot>>,
    /// Replaces the complete metadata map when supplied; omission preserves it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MoveProjectRequest {
    pub before_project_id: Option<String>,
}

#[utoipa::path(get, path = "/v1/projects", responses((status = 200, body = ProjectListResponse)))]
pub async fn list_projects(State(state): State<AppState>) -> ApiResult<Json<ProjectListResponse>> {
    Ok(Json(ProjectListResponse {
        projects: list_project_records(&state).await?,
    }))
}

#[utoipa::path(post, path = "/v1/projects", request_body = CreateProjectRequest, responses((status = 201, body = Project)))]
pub async fn create_project(
    State(state): State<AppState>,
    Json(request): Json<CreateProjectRequest>,
) -> ApiResult<(StatusCode, Json<Project>)> {
    let project = app_server_api::client(&state.app_server)
        .project_create(
            request.name,
            request.roots,
            request.idempotency_key,
            request.metadata,
        )
        .await?;
    Ok((StatusCode::CREATED, Json(project)))
}

#[utoipa::path(get, path = "/v1/projects/{projectId}", responses((status = 200, body = Project)))]
pub async fn get_project(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> ApiResult<Json<Project>> {
    Ok(Json(read_project_record(&state, &project_id).await?))
}

#[utoipa::path(patch, path = "/v1/projects/{projectId}", request_body = UpdateProjectRequest, responses((status = 200, body = Project)))]
pub async fn update_project(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(request): Json<UpdateProjectRequest>,
) -> ApiResult<Json<Project>> {
    Ok(Json(
        app_server_api::client(&state.app_server)
            .project_update(project_id, serde_json::to_value(request)?)
            .await?,
    ))
}

#[utoipa::path(post, path = "/v1/projects/{projectId}/move", request_body = MoveProjectRequest, responses((status = 204)))]
pub async fn move_project(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(request): Json<MoveProjectRequest>,
) -> ApiResult<StatusCode> {
    app_server_api::client(&state.app_server)
        .project_move(project_id, request.before_project_id)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(delete, path = "/v1/projects/{projectId}", responses((status = 204)))]
pub async fn delete_project(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> ApiResult<StatusCode> {
    app_server_api::client(&state.app_server)
        .project_delete(project_id)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn read_project_record(state: &AppState, project_id: &str) -> ApiResult<Project> {
    app_server_api::client(&state.app_server)
        .project_read(project_id.to_string())
        .await
}

pub(crate) async fn project_execution_cwd(
    state: &AppState,
    project_id: &str,
    explicit_cwd: Option<String>,
) -> ApiResult<String> {
    let project = read_project_record(state, project_id).await?;
    let [root] = project.roots.as_slice() else {
        return Err(ApiError::BadRequest(
            "choose one project root directory before starting a chat or terminal".into(),
        ));
    };
    let cwd = root.path.clone();
    validate_execution_cwd(&cwd)?;
    if explicit_cwd
        .as_deref()
        .is_some_and(|explicit| explicit != cwd)
    {
        return Err(ApiError::BadRequest(
            "working directory must match the project root".into(),
        ));
    }
    Ok(cwd)
}

pub(crate) async fn settings_cwd(
    state: &AppState,
    project_id: Option<&str>,
    cwd: Option<String>,
) -> ApiResult<Option<String>> {
    match project_id {
        Some(project_id) => Ok(Some(project_execution_cwd(state, project_id, cwd).await?)),
        None => {
            if let Some(cwd) = &cwd {
                validate_execution_cwd(cwd)?;
            }
            Ok(cwd)
        }
    }
}

fn validate_execution_cwd(cwd: &str) -> ApiResult<()> {
    if !FsPath::new(cwd).is_absolute() {
        return Err(ApiError::BadRequest("cwd must be an absolute path".into()));
    }
    Ok(())
}

pub(crate) async fn list_project_records(state: &AppState) -> ApiResult<Vec<Project>> {
    let client = app_server_api::client(&state.app_server);
    let mut projects = Vec::new();
    let mut cursor = None;
    loop {
        let page = client.project_list_page(cursor, Some(100)).await?;
        projects.extend(page.data);
        match page.next_cursor {
            Some(next_cursor) => cursor = Some(next_cursor),
            None => return Ok(projects),
        }
    }
}
