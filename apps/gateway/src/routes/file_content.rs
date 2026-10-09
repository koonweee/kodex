use std::path::Path as FsPath;

use axum::{
    body::Body,
    extract::{Path, State},
    http::{
        header::{
            CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_SECURITY_POLICY, CONTENT_TYPE, LOCATION,
            REFERRER_POLICY, X_CONTENT_TYPE_OPTIONS,
        },
        HeaderValue, Request, Response, StatusCode,
    },
    routing::get,
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use tokio::fs;
use tower::ServiceExt;
use tower_http::services::ServeFile;

use super::file_preview::{
    canonical_thread_preview_path, classify_preview_file, preview_not_found, read_preview_thread,
    ImagePreviewType, PreviewKind, SVG_POLICY,
};
use crate::{
    api::AppState,
    error::{ApiError, ApiResult},
};

fn document_policy(request: &Request<Body>) -> ApiResult<HeaderValue> {
    // Serve proxies retain Host, while TLS may terminate outside the gateway.
    // Allow either scheme for this host and only this preview directory's URL
    // prefix. 'self' alone would also permit arbitrary gateway GET endpoints.
    let host = request
        .headers()
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .or_else(|| {
            request
                .uri()
                .authority()
                .map(|authority| authority.as_str())
        })
        .filter(|host| {
            !host.is_empty()
                && host
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b".-:[]".contains(&byte))
        })
        .ok_or_else(|| ApiError::BadRequest("preview requires a valid Host header".into()))?;
    let origin = reqwest::Url::parse(&format!("http://{host}"))
        .map_err(|_| ApiError::BadRequest("preview requires a valid Host header".into()))?;
    if origin.host_str().is_none() {
        return Err(ApiError::BadRequest(
            "preview requires a valid Host header".into(),
        ));
    }
    // Request paths retain URI encoding. Escape CSP separators as well, since
    // URI path segments may legally contain semicolons and commas.
    let prefix = request
        .uri()
        .path()
        .split('/')
        .take(7)
        .collect::<Vec<_>>()
        .join("/")
        .replace(';', "%3B")
        .replace(',', "%2C")
        .replace('\'', "%27");
    let assets = format!("http://{host}{prefix}/ https://{host}{prefix}/");
    let policy = format!("sandbox allow-scripts allow-downloads; default-src 'none'; script-src {assets} 'unsafe-inline'; style-src {assets} 'unsafe-inline'; img-src {assets} data: blob:; media-src {assets} blob:; font-src {assets} data:; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    HeaderValue::from_str(&policy).map_err(|error| ApiError::Other(error.into()))
}

pub(super) fn router() -> Router<AppState> {
    Router::new().route(
        "/v1/threads/{thread_id}/files/content/{directory}/{*file_path}",
        get(thread_file_content),
    )
}

#[utoipa::path(
    get,
    path = "/v1/threads/{threadId}/files/content/{directory}/{filePath}",
    summary = "Read a local HTML preview or one of its relative assets",
    description = "Directory-aware static file serving for localhost or trusted VPN deployments. The base64url directory is routing context, not an authorization token. HTML uses an opaque-origin CSP sandbox. Relative assets cannot escape the directory through parent paths or symlinks.",
    params(
        ("threadId" = String, Path, description = "Thread id for native metadata validation"),
        ("directory" = String, Path, description = "Base64url encoded absolute preview directory"),
        ("filePath" = String, Path, description = "Relative asset path; may include nested path segments")
    ),
    responses(
        (status = 200, description = "Inline HTML, local asset, or download bytes"),
        (status = 206, description = "Requested file byte range"),
        (status = 400, description = "Invalid or missing request authority for an HTML preview"),
        (status = 404, description = "Thread or file not found"),
        (status = 415, description = "Unsupported or oversized preview"),
        (status = 416, description = "Requested range is not satisfiable")
    )
)]
pub(crate) async fn thread_file_content(
    State(state): State<AppState>,
    Path((thread_id, directory, file_path)): Path<(String, String, String)>,
    request: Request<Body>,
) -> ApiResult<Response<Body>> {
    read_preview_thread(&state, &thread_id).await?;
    let directory = URL_SAFE_NO_PAD
        .decode(directory)
        .map_err(|_| preview_not_found())?;
    let directory = String::from_utf8(directory).map_err(|_| preview_not_found())?;
    if !FsPath::new(&directory).is_absolute() || FsPath::new(&file_path).is_absolute() {
        return Err(preview_not_found());
    }
    let path = canonical_thread_preview_path(&file_path, FsPath::new(&directory)).await?;
    let metadata = fs::metadata(&path).await.map_err(|_| preview_not_found())?;
    if !metadata.is_file() {
        return Err(preview_not_found());
    }
    let mut kind = classify_preview_file(&path, metadata.len()).await?;
    if matches!(kind, PreviewKind::Download) {
        let asset_type = match path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("css") => Some("text/css; charset=utf-8"),
            Some("js" | "mjs") => Some("text/javascript; charset=utf-8"),
            _ => None,
        };
        if let Some(content_type) = asset_type {
            if metadata.len() > 2 * 1024 * 1024 {
                return Err(ApiError::UnsupportedMediaType(
                    "unsupported preview type".into(),
                ));
            }
            kind = PreviewKind::Asset(content_type);
        }
    }
    stream_preview(kind, &path, request).await
}

pub(super) fn redirect_html(thread_id: &str, path: &FsPath) -> ApiResult<Response<Body>> {
    let directory = path
        .parent()
        .and_then(FsPath::to_str)
        .ok_or_else(preview_not_found)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(preview_not_found)?;
    let directory = URL_SAFE_NO_PAD.encode(directory);
    // URL path-segment encoding preserves names containing spaces, #, ?, %, and
    // non-ASCII characters without depending on the gateway's external origin.
    let mut url = reqwest::Url::parse("http://localhost/").expect("fixed URL");
    url.path_segments_mut().expect("hierarchical URL").extend([
        "v1", "threads", thread_id, "files", "content", &directory, file_name,
    ]);
    Response::builder()
        .status(StatusCode::TEMPORARY_REDIRECT)
        .header(LOCATION, url.path())
        .header(CACHE_CONTROL, "no-store")
        .body(Body::empty())
        .map_err(|error| ApiError::Other(error.into()))
}

pub(super) async fn stream_preview(
    kind: PreviewKind,
    path: &FsPath,
    request: Request<Body>,
) -> ApiResult<Response<Body>> {
    // Text documents and existing validated preview types stay bounded. Video
    // is header-validated and streamed rather than buffered into memory.
    if matches!(
        kind,
        PreviewKind::Html | PreviewKind::Markdown | PreviewKind::Pdf | PreviewKind::Image(_)
    ) {
        kind.validate_bytes(&fs::read(path).await.map_err(|_| preview_not_found())?)?;
    }
    let policy = match kind {
        PreviewKind::Html => Some(document_policy(&request)?),
        PreviewKind::Image(ImagePreviewType::Svg) => Some(HeaderValue::from_static(SVG_POLICY)),
        _ => None,
    };
    let mut response = ServeFile::new(path)
        .oneshot(request)
        .await
        .map_err(|error| ApiError::Other(error.into()))?
        .map(Body::new);
    if response.status() == StatusCode::NOT_FOUND {
        return Err(preview_not_found());
    }
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static(kind.content_type()));
    headers.insert(
        CACHE_CONTROL,
        HeaderValue::from_static(if matches!(kind, PreviewKind::Html) {
            "private, no-store"
        } else {
            "private"
        }),
    );
    headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    if let Some(policy) = policy {
        headers.insert(CONTENT_SECURITY_POLICY, policy);
    }
    if let Some(disposition) = kind.content_disposition(path) {
        headers.insert(
            CONTENT_DISPOSITION,
            HeaderValue::from_str(&disposition).map_err(|error| ApiError::Other(error.into()))?,
        );
    }
    Ok(response)
}
