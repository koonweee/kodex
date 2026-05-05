use std::path::{Path as FsPath, PathBuf};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::{
    api::AppState,
    error::{ApiError, ApiResult},
    store::Project,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/projects", get(list_projects).post(create_project))
        .route("/v1/projects/{project_id}", get(get_project))
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectListResponse {
    pub projects: Vec<Project>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectRequest {
    pub create_directory: Option<bool>,
    pub name: Option<String>,
    pub cwd: String,
}

#[utoipa::path(get, path = "/v1/projects", responses((status = 200, body = ProjectListResponse)))]
pub async fn list_projects(State(state): State<AppState>) -> ApiResult<Json<ProjectListResponse>> {
    let projects = state.store.list_projects().await?;
    Ok(Json(ProjectListResponse { projects }))
}

#[utoipa::path(post, path = "/v1/projects", request_body = CreateProjectRequest, responses((status = 201, body = Project)))]
pub async fn create_project(
    State(state): State<AppState>,
    Json(request): Json<CreateProjectRequest>,
) -> ApiResult<(StatusCode, Json<Project>)> {
    let cwd_text = request.cwd.trim();
    if cwd_text.is_empty() {
        return Err(ApiError::BadRequest("cwd is required".to_string()));
    }

    let cwd_candidate = project_cwd_candidate(&state.config.projects.home_dir, cwd_text);
    if !cwd_candidate.exists() {
        if request.create_directory == Some(true) {
            std::fs::create_dir_all(&cwd_candidate)
                .map_err(|_| ApiError::BadRequest("directory could not be created".to_string()))?;
        } else {
            return Err(ApiError::BadRequest("directory does not exist".to_string()));
        }
    }

    let cwd = std::fs::canonicalize(cwd_candidate)
        .map_err(|_| ApiError::BadRequest("directory does not exist".to_string()))?;
    if !cwd.is_absolute() || !cwd.is_dir() {
        return Err(ApiError::BadRequest("cwd must be a directory".to_string()));
    }

    let name = request.name.unwrap_or_else(|| {
        cwd.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Project")
            .to_string()
    });
    let project = state
        .store
        .create_project(name, cwd.to_string_lossy().to_string())
        .await?;
    Ok((StatusCode::CREATED, Json(project)))
}

fn project_cwd_candidate(home_dir: &FsPath, cwd_text: &str) -> PathBuf {
    let cwd = FsPath::new(cwd_text);
    if cwd.is_absolute() {
        return cwd.to_path_buf();
    }

    if cwd_text == "~" {
        return home_dir.to_path_buf();
    }

    if let Some(rest) = cwd_text.strip_prefix("~/") {
        return home_dir.join(rest);
    }

    home_dir.join(cwd)
}

#[utoipa::path(get, path = "/v1/projects/{projectId}", responses((status = 200, body = Project)))]
pub async fn get_project(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> ApiResult<Json<Project>> {
    Ok(Json(state.store.get_project(&project_id).await?))
}
