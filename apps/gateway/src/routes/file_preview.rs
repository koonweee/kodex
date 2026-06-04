use std::path::{Component, Path as FsPath, PathBuf};

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{
        header::{CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE},
        HeaderValue, Response,
    },
    routing::get,
    Router,
};
use serde::Deserialize;
use tokio::fs;
use tokio::io::AsyncReadExt;
use utoipa::{IntoParams, ToSchema};

use crate::{
    api::AppState,
    app_server_api,
    error::{ApiError, ApiResult},
};

const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_MARKDOWN_BYTES: u64 = 2 * 1024 * 1024;
const MAX_PDF_BYTES: u64 = 50 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES: u64 = 100 * 1024 * 1024;

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/v1/threads/{thread_id}/files/preview",
        get(preview_thread_file),
    )
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
pub struct FilePreviewQuery {
    pub path: String,
}

#[utoipa::path(
    get,
    path = "/v1/threads/{threadId}/files/preview",
    summary = "Preview or download a local thread file",
    description = "Serves readable local files for localhost or trusted VPN deployments; this endpoint is not a public-safe filesystem authorization model.",
    params(
        ("threadId" = String, Path, description = "Thread id that owns the preview context"),
        FilePreviewQuery
    ),
    responses(
        (status = 200, description = "Local file preview or download bytes"),
        (status = 404, description = "Thread or preview path was not found"),
        (status = 415, description = "Preview path exists but is not a supported preview type")
    )
)]
pub async fn preview_thread_file(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Query(query): Query<FilePreviewQuery>,
) -> ApiResult<Response<Body>> {
    let thread = read_preview_thread(&state, &thread_id).await?;
    let path = canonical_thread_preview_path(&query.path, FsPath::new(&thread.cwd)).await?;
    let metadata = fs::metadata(&path).await.map_err(|_| preview_not_found())?;
    if !metadata.is_file() {
        return Err(preview_not_found());
    }

    let kind = classify_preview_file(&path, metadata.len()).await?;
    let bytes = fs::read(&path).await.map_err(|_| preview_not_found())?;
    kind.validate_bytes(&bytes)?;
    preview_response(kind, path.as_path(), bytes)
}

pub async fn preview_local_image_file(path: &str) -> ApiResult<Response<Body>> {
    let path = canonical_local_preview_path(path).await?;
    let metadata = fs::metadata(&path).await.map_err(|_| preview_not_found())?;
    if !metadata.is_file() {
        return Err(preview_not_found());
    }

    let kind = classify_preview_file(&path, metadata.len()).await?;
    if !matches!(kind, PreviewKind::Image(_)) {
        return Err(ApiError::UnsupportedMediaType(
            "unsupported preview type".to_string(),
        ));
    }
    let bytes = fs::read(&path).await.map_err(|_| preview_not_found())?;
    kind.validate_bytes(&bytes)?;
    preview_response(kind, path.as_path(), bytes)
}

async fn read_preview_thread(
    state: &AppState,
    thread_id: &str,
) -> ApiResult<app_server_api::ThreadSummary> {
    let response = match app_server_api::client(&state.app_server)
        .thread_read(thread_id.to_string())
        .await
    {
        Ok(response) => response,
        Err(ApiError::BadGateway(message)) if message_mentions_missing_thread(&message) => {
            return Err(preview_not_found());
        }
        Err(error) => return Err(error),
    };
    if response.thread.id != thread_id {
        return Err(preview_not_found());
    }
    Ok(response.thread)
}

async fn canonical_thread_preview_path(path: &str, thread_cwd: &FsPath) -> ApiResult<PathBuf> {
    if path.trim().is_empty() {
        return Err(preview_not_found());
    }
    let preview_path = FsPath::new(path);
    if preview_path.is_absolute() {
        return canonical_absolute_preview_path(path).await;
    }
    if !safe_relative_path(preview_path) {
        return Err(preview_not_found());
    }
    let cwd = fs::canonicalize(thread_cwd)
        .await
        .map_err(|_| preview_not_found())?;
    let path = fs::canonicalize(cwd.join(preview_path))
        .await
        .map_err(|_| preview_not_found())?;
    if !path.starts_with(&cwd) {
        return Err(preview_not_found());
    }
    Ok(path)
}

async fn canonical_absolute_preview_path(path: &str) -> ApiResult<PathBuf> {
    if path.trim().is_empty() {
        return Err(preview_not_found());
    }
    let preview_path = FsPath::new(path);
    if !preview_path.is_absolute() {
        return Err(preview_not_found());
    }
    fs::canonicalize(preview_path)
        .await
        .map_err(|_| preview_not_found())
}

async fn canonical_local_preview_path(path: &str) -> ApiResult<PathBuf> {
    if path.trim().is_empty() {
        return Err(preview_not_found());
    }
    fs::canonicalize(path)
        .await
        .map_err(|_| preview_not_found())
}

fn safe_relative_path(path: &FsPath) -> bool {
    path.components()
        .all(|component| matches!(component, Component::Normal(_)))
}

async fn classify_preview_file(path: &FsPath, size_bytes: u64) -> ApiResult<PreviewKind> {
    let header = read_header(path).await?;
    if let Some(image) = sniff_image_type(&header) {
        if size_bytes > MAX_IMAGE_BYTES {
            return Err(ApiError::UnsupportedMediaType(
                "unsupported preview type".to_string(),
            ));
        }
        return Ok(PreviewKind::Image(image));
    }

    if markdown_extension(path) {
        if size_bytes > MAX_MARKDOWN_BYTES {
            return Err(ApiError::UnsupportedMediaType(
                "unsupported preview type".to_string(),
            ));
        }
        return Ok(PreviewKind::Markdown);
    }

    if pdf_extension(path) {
        if size_bytes > MAX_PDF_BYTES {
            return Err(ApiError::UnsupportedMediaType(
                "unsupported preview type".to_string(),
            ));
        }
        return Ok(PreviewKind::Pdf);
    }

    if size_bytes > MAX_DOWNLOAD_BYTES {
        return Err(ApiError::UnsupportedMediaType(
            "unsupported preview type".to_string(),
        ));
    }
    Ok(PreviewKind::Download)
}

async fn read_header(path: &FsPath) -> ApiResult<Vec<u8>> {
    let mut file = fs::File::open(path)
        .await
        .map_err(|_| preview_not_found())?;
    let mut buffer = vec![0; 16];
    let bytes_read = file
        .read(&mut buffer)
        .await
        .map_err(|_| preview_not_found())?;
    buffer.truncate(bytes_read);
    Ok(buffer)
}

fn sniff_image_type(bytes: &[u8]) -> Option<ImagePreviewType> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(ImagePreviewType::Png);
    }
    if bytes.len() >= 3 && bytes[0..3] == [0xff, 0xd8, 0xff] {
        return Some(ImagePreviewType::Jpeg);
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(ImagePreviewType::Gif);
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some(ImagePreviewType::Webp);
    }
    if svg_extension_header(bytes) {
        return Some(ImagePreviewType::Svg);
    }
    None
}

fn svg_extension_header(bytes: &[u8]) -> bool {
    let Ok(header) = std::str::from_utf8(bytes) else {
        return false;
    };
    let trimmed = header.trim_start_matches(|character: char| character.is_whitespace());
    trimmed.starts_with("<svg") || trimmed.starts_with("<?xml")
}

fn markdown_extension(path: &FsPath) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
        })
}

fn pdf_extension(path: &FsPath) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
}

fn preview_response(kind: PreviewKind, path: &FsPath, bytes: Vec<u8>) -> ApiResult<Response<Body>> {
    let content_length = HeaderValue::from_str(&bytes.len().to_string())
        .map_err(|error| ApiError::Other(anyhow::Error::new(error)))?;
    let mut builder = Response::builder()
        .header(CONTENT_TYPE, kind.content_type())
        .header(CACHE_CONTROL, "private")
        .header(CONTENT_LENGTH, content_length);
    if let Some(content_disposition) = kind.content_disposition(path) {
        builder = builder.header(CONTENT_DISPOSITION, content_disposition);
    }
    builder
        .body(Body::from(bytes))
        .map_err(|error| ApiError::Other(anyhow::Error::new(error)))
}

fn content_disposition(disposition: &str, path: &FsPath, fallback_file_name: &str) -> String {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(fallback_file_name);
    format!(
        "{disposition}; filename=\"{}\"",
        file_name.replace(['\\', '"'], "_")
    )
}

fn preview_not_found() -> ApiError {
    ApiError::NotFound("file preview".to_string())
}

fn message_mentions_missing_thread(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    (message.contains("thread")
        && (message.contains("not found")
            || message.contains("no such")
            || message.contains("does not exist")
            || message.contains("unknown")))
        || message.contains("no rollout found for thread id")
}

#[derive(Debug, Clone, Copy)]
enum PreviewKind {
    Image(ImagePreviewType),
    Markdown,
    Pdf,
    Download,
}

impl PreviewKind {
    fn content_type(self) -> &'static str {
        match self {
            Self::Image(image) => image.content_type(),
            Self::Markdown => "text/markdown; charset=utf-8",
            Self::Pdf => "application/pdf",
            Self::Download => "application/octet-stream",
        }
    }

    fn content_disposition(self, path: &FsPath) -> Option<String> {
        match self {
            Self::Image(_) => None,
            Self::Markdown => Some(content_disposition("attachment", path, "preview.md")),
            Self::Pdf => Some(content_disposition("inline", path, "preview.pdf")),
            Self::Download => Some(content_disposition("attachment", path, "download")),
        }
    }

    fn validate_bytes(self, bytes: &[u8]) -> ApiResult<()> {
        match self {
            Self::Image(image) => {
                if sniff_image_type(bytes) == Some(image) {
                    Ok(())
                } else {
                    Err(ApiError::UnsupportedMediaType(
                        "unsupported preview type".to_string(),
                    ))
                }
            }
            Self::Markdown => std::str::from_utf8(bytes).map(|_| ()).map_err(|_| {
                ApiError::UnsupportedMediaType("unsupported preview type".to_string())
            }),
            Self::Pdf => {
                if bytes.starts_with(b"%PDF-") {
                    Ok(())
                } else {
                    Err(ApiError::UnsupportedMediaType(
                        "unsupported preview type".to_string(),
                    ))
                }
            }
            Self::Download => Ok(()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImagePreviewType {
    Png,
    Jpeg,
    Gif,
    Webp,
    Svg,
}

impl ImagePreviewType {
    fn content_type(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
            Self::Svg => "image/svg+xml",
        }
    }
}
