use std::path::{Component, Path as FsPath, PathBuf};

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{
        header::{
            CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_SECURITY_POLICY,
            CONTENT_TYPE, X_CONTENT_TYPE_OPTIONS,
        },
        HeaderValue, Request, Response,
    },
    routing::get,
    Router,
};
use serde::Deserialize;
use tokio::fs;
use tokio::io::AsyncReadExt;
use utoipa::{IntoParams, ToSchema};

use super::file_content;

use crate::{
    api::AppState,
    app_server_api,
    error::{ApiError, ApiResult},
};

pub(super) const SVG_POLICY: &str = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const MAX_HTML_BYTES: u64 = 2 * 1024 * 1024;

const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_MARKDOWN_BYTES: u64 = 2 * 1024 * 1024;
const MAX_PDF_BYTES: u64 = 50 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES: u64 = 100 * 1024 * 1024;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/threads/{thread_id}/files/preview",
            get(preview_thread_file),
        )
        .merge(file_content::router())
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
        (status = 206, description = "Requested video byte range"),
        (status = 307, description = "HTML redirect to its relative asset context"),
        (status = 416, description = "Requested video range is not satisfiable"),
        (status = 404, description = "Thread or preview path was not found"),
        (status = 415, description = "Preview path exists but is not a supported preview type")
    )
)]
pub async fn preview_thread_file(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Query(query): Query<FilePreviewQuery>,
    request: Request<Body>,
) -> ApiResult<Response<Body>> {
    let thread = read_preview_thread(&state, &thread_id).await?;
    let path = canonical_thread_preview_path(&query.path, FsPath::new(&thread.cwd)).await?;
    let metadata = fs::metadata(&path).await.map_err(|_| preview_not_found())?;
    if !metadata.is_file() {
        return Err(preview_not_found());
    }

    let kind = classify_preview_file(&path, metadata.len()).await?;
    if matches!(kind, PreviewKind::Html) {
        return file_content::redirect_html(&thread_id, &path);
    }
    if matches!(kind, PreviewKind::Video(_)) {
        return file_content::stream_preview(kind, &path, request).await;
    }
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

pub(super) async fn read_preview_thread(
    state: &AppState,
    thread_id: &str,
) -> ApiResult<app_server_api::ThreadSummary> {
    let response = match app_server_api::client(&state.app_server)
        .thread_read_summary(thread_id.to_string())
        .await
    {
        Ok(response) => response,
        Err(error) if app_server_api::is_thread_read_missing_error(&error, thread_id) => {
            return Err(preview_not_found());
        }
        Err(error) => return Err(error),
    };
    if response.id != thread_id {
        return Err(preview_not_found());
    }
    Ok(response)
}

pub(super) async fn canonical_thread_preview_path(
    path: &str,
    thread_cwd: &FsPath,
) -> ApiResult<PathBuf> {
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

pub(super) async fn classify_preview_file(
    path: &FsPath,
    size_bytes: u64,
) -> ApiResult<PreviewKind> {
    let header = read_header(path).await?;
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase);
    if matches!(extension.as_deref(), Some("html" | "htm")) {
        if size_bytes > MAX_HTML_BYTES {
            return Err(ApiError::UnsupportedMediaType(
                "unsupported preview type".into(),
            ));
        }
        return Ok(PreviewKind::Html);
    }
    if matches!(extension.as_deref(), Some("webm" | "mp4")) {
        let valid = match extension.as_deref() {
            Some("webm") => header.starts_with(b"\x1a\x45\xdf\xa3"),
            Some("mp4") => header.get(4..8) == Some(b"ftyp".as_slice()),
            _ => false,
        };
        if size_bytes > MAX_DOWNLOAD_BYTES || !valid {
            return Err(ApiError::UnsupportedMediaType(
                "unsupported preview type".into(),
            ));
        }
        return Ok(PreviewKind::Video(
            if extension.as_deref() == Some("webm") {
                "video/webm"
            } else {
                "video/mp4"
            },
        ));
    }
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
        .header(X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(CONTENT_LENGTH, content_length);
    if matches!(kind, PreviewKind::Image(ImagePreviewType::Svg)) {
        builder = builder.header(CONTENT_SECURITY_POLICY, SVG_POLICY);
    }
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

pub(super) fn preview_not_found() -> ApiError {
    ApiError::NotFound("file preview".to_string())
}

#[derive(Debug, Clone, Copy)]
pub(super) enum PreviewKind {
    Image(ImagePreviewType),
    Markdown,
    Pdf,
    Html,
    Video(&'static str),
    Asset(&'static str),
    Download,
}

impl PreviewKind {
    pub(super) fn content_type(self) -> &'static str {
        match self {
            Self::Image(image) => image.content_type(),
            Self::Markdown => "text/markdown; charset=utf-8",
            Self::Pdf => "application/pdf",
            Self::Html => "text/html; charset=utf-8",
            Self::Video(content_type) | Self::Asset(content_type) => content_type,
            Self::Download => "application/octet-stream",
        }
    }

    pub(super) fn content_disposition(self, path: &FsPath) -> Option<String> {
        match self {
            Self::Image(_) | Self::Html | Self::Video(_) | Self::Asset(_) => None,
            Self::Markdown => Some(content_disposition("attachment", path, "preview.md")),
            Self::Pdf => Some(content_disposition("inline", path, "preview.pdf")),
            Self::Download => Some(content_disposition("attachment", path, "download")),
        }
    }

    pub(super) fn validate_bytes(self, bytes: &[u8]) -> ApiResult<()> {
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
            Self::Markdown | Self::Html => std::str::from_utf8(bytes).map(|_| ()).map_err(|_| {
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
            Self::Download | Self::Video(_) | Self::Asset(_) => Ok(()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ImagePreviewType {
    Png,
    Jpeg,
    Gif,
    Webp,
    Svg,
}

impl ImagePreviewType {
    pub(super) fn content_type(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
            Self::Svg => "image/svg+xml",
        }
    }
}
