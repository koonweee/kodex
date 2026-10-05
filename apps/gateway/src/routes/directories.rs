use std::path::{Path, PathBuf};

use axum::{
    extract::{Query, State},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tokio::fs;
use utoipa::{IntoParams, ToSchema};

use crate::{
    api::AppState,
    error::{ApiError, ApiResult},
};

pub fn router() -> Router<AppState> {
    Router::new().route("/v1/directories", get(list_directories))
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
pub struct DirectoryListQuery {
    /// Absolute directory to browse; omission starts at the gateway user's home.
    pub path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListResponse {
    pub path: String,
    pub home_path: String,
    pub parent_path: Option<String>,
    pub directories: Vec<DirectoryEntry>,
}

#[utoipa::path(
    get,
    path = "/v1/directories",
    summary = "Browse directories inside the gateway user's home",
    params(DirectoryListQuery),
    responses(
        (status = 200, body = DirectoryListResponse),
        (status = 400, description = "Path is outside home, unreadable or not a directory"),
        (status = 404, description = "Directory does not exist")
    )
)]
pub async fn list_directories(
    State(state): State<AppState>,
    Query(query): Query<DirectoryListQuery>,
) -> ApiResult<Json<DirectoryListResponse>> {
    let home = fs::canonicalize(&state.config.projects.home_dir)
        .await
        .map_err(directory_error)?;
    let requested = query
        .path
        .map(PathBuf::from)
        .unwrap_or_else(|| home.clone());
    if !requested.is_absolute() {
        return Err(ApiError::BadRequest(
            "directory path must be absolute".into(),
        ));
    }
    let path = fs::canonicalize(requested).await.map_err(directory_error)?;
    if !path.starts_with(&home) {
        return Err(ApiError::BadRequest(
            "directory must be inside your home".into(),
        ));
    }
    if !fs::metadata(&path).await.map_err(directory_error)?.is_dir() {
        return Err(ApiError::BadRequest("path is not a directory".into()));
    }
    let mut entries = fs::read_dir(&path).await.map_err(directory_error)?;
    let mut directories = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(directory_error)? {
        let Ok(child) = fs::canonicalize(entry.path()).await else {
            continue;
        };
        if !child.starts_with(&home)
            || !fs::metadata(&child)
                .await
                .is_ok_and(|metadata| metadata.is_dir())
        {
            continue;
        }
        let name = entry.file_name();
        let (Some(name), Some(child)) = (name.to_str(), child.to_str()) else {
            continue;
        };
        directories.push(DirectoryEntry {
            name: name.to_owned(),
            path: child.to_owned(),
        });
    }
    directories.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.name.cmp(&right.name))
    });
    let parent_path = path
        .parent()
        .filter(|parent| *parent != path && parent.starts_with(&home))
        .map(path_string)
        .transpose()?;
    Ok(Json(DirectoryListResponse {
        path: path_string(&path)?,
        home_path: path_string(&home)?,
        parent_path,
        directories,
    }))
}

fn path_string(path: &Path) -> ApiResult<String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| ApiError::BadRequest("directory path is not valid Unicode".into()))
}

fn directory_error(error: std::io::Error) -> ApiError {
    if error.kind() == std::io::ErrorKind::NotFound {
        ApiError::NotFound("directory does not exist".into())
    } else {
        ApiError::BadRequest("directory cannot be read".into())
    }
}

#[cfg(test)]
mod tests;
