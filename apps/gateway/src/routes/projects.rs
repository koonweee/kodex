use std::path::{Path as FsPath, PathBuf};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    api::AppState,
    app_server_api::{self, NativeProject, NativeProjectRoot},
    error::{ApiError, ApiResult},
    store::Project,
};

#[cfg(test)]
mod tests;

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
    pub idempotency_key: Option<String>,
}

#[utoipa::path(get, path = "/v1/projects", responses((status = 200, body = ProjectListResponse)))]
pub async fn list_projects(State(state): State<AppState>) -> ApiResult<Json<ProjectListResponse>> {
    let projects = list_project_records(&state).await?;
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
    let native_project = app_server_api::client(&state.app_server)
        .project_create(
            name,
            vec![NativeProjectRoot {
                path: cwd.to_string_lossy().to_string(),
            }],
            request
                .idempotency_key
                .unwrap_or_else(|| Uuid::new_v4().to_string()),
        )
        .await?;
    let project = project_record(native_project)?;
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
    Ok(Json(read_project_record(&state, &project_id).await?))
}

pub(crate) async fn read_project_record(state: &AppState, project_id: &str) -> ApiResult<Project> {
    let project = app_server_api::client(&state.app_server)
        .project_read(project_id.to_string())
        .await?;
    project_record(project)
}

pub(crate) async fn read_project_with_cwd(
    state: &AppState,
    project_id: &str,
) -> ApiResult<Project> {
    let project = read_project_record(state, project_id).await?;
    if project.cwd.is_empty() {
        return Err(ApiError::BadRequest(format!(
            "project {} has no working directory; this operation requires a project root",
            project.id
        )));
    }
    Ok(project)
}

pub(crate) async fn list_project_records(state: &AppState) -> ApiResult<Vec<Project>> {
    let client = app_server_api::client(&state.app_server);
    let mut projects = Vec::new();
    let mut cursor = None;
    loop {
        let page = client.project_list_page(cursor, Some(100)).await?;
        for project in page.data {
            projects.push(project_record(project)?);
        }
        match page.next_cursor {
            Some(next_cursor) => cursor = Some(next_cursor),
            None => return Ok(projects),
        }
    }
}

fn project_record(project: NativeProject) -> ApiResult<Project> {
    let cwd = project
        .roots
        .first()
        .map(|root| root.path.clone())
        .unwrap_or_default();
    let timestamp = |seconds| {
        chrono::DateTime::from_timestamp(seconds, 0)
            .ok_or_else(|| ApiError::BadGateway("invalid native project timestamp".to_string()))
    };
    Ok(Project {
        id: project.id,
        name: project.name,
        cwd,
        created_at: timestamp(project.created_at)?,
        updated_at: timestamp(project.updated_at)?,
    })
}
