use std::path::PathBuf;

use axum::{
    extract::{DefaultBodyLimit, Multipart, State},
    routing::post,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tokio::fs;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    api::AppState,
    error::{ApiError, ApiResult},
};

const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/uploads/images", post(upload_images))
        .layer(DefaultBodyLimit::max(MAX_IMAGE_BYTES * 8))
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImageUploadResponse {
    pub images: Vec<ImageUpload>,
}

#[derive(Debug, ToSchema)]
pub struct ImageUploadRequest {
    #[schema(value_type = Vec<String>, format = Binary)]
    pub images: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImageUpload {
    pub id: String,
    pub file_name: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub path: String,
}

#[utoipa::path(
    post,
    path = "/v1/uploads/images",
    request_body(content = ImageUploadRequest, content_type = "multipart/form-data"),
    responses((status = 200, body = ImageUploadResponse))
)]
pub async fn upload_images(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> ApiResult<Json<ImageUploadResponse>> {
    let image_dir = absolute_upload_dir(state.config.uploads.dir.clone())?.join("images");
    fs::create_dir_all(&image_dir).await?;

    let mut images = Vec::new();
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|error| ApiError::BadRequest(format!("invalid multipart upload: {error}")))?
    {
        if field.name() != Some("images") {
            continue;
        }

        let file_name = field.file_name().unwrap_or("image").to_string();
        let mime_type = field.content_type().unwrap_or("").to_string();
        let extension = image_extension(&mime_type)
            .ok_or_else(|| ApiError::BadRequest("only image uploads are supported".to_string()))?;
        let bytes = field
            .bytes()
            .await
            .map_err(|error| ApiError::BadRequest(format!("invalid multipart field: {error}")))?;

        if bytes.is_empty() {
            return Err(ApiError::BadRequest("image upload was empty".to_string()));
        }
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err(ApiError::BadRequest(format!(
                "image upload exceeds {} bytes",
                MAX_IMAGE_BYTES
            )));
        }

        let id = Uuid::new_v4().to_string();
        let path = image_dir.join(format!("{id}.{extension}"));
        fs::write(&path, &bytes).await?;
        images.push(ImageUpload {
            id,
            file_name,
            mime_type,
            size_bytes: bytes.len() as u64,
            path: path.display().to_string(),
        });
    }

    if images.is_empty() {
        return Err(ApiError::BadRequest(
            "multipart upload did not include image files".to_string(),
        ));
    }

    Ok(Json(ImageUploadResponse { images }))
}

fn image_extension(mime_type: &str) -> Option<&'static str> {
    match mime_type {
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/heic" => Some("heic"),
        "image/heif" => Some("heif"),
        value if value.starts_with("image/") => Some("img"),
        _ => None,
    }
}

fn absolute_upload_dir(path: PathBuf) -> ApiResult<PathBuf> {
    if path.is_absolute() {
        return Ok(path);
    }
    Ok(std::env::current_dir()?.join(path))
}
