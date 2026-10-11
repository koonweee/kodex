use std::path::PathBuf;

use axum::{
    body::{to_bytes, Body},
    http::{
        header::{CACHE_CONTROL, CONTENT_TYPE},
        Request, Response, StatusCode,
    },
    response::IntoResponse,
    Router,
};
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

const IMMUTABLE: &str = "public, max-age=31536000, immutable";
const REVALIDATE: &str = "no-cache";

pub(crate) fn attach_primary(
    router: Router,
    dist_dir: PathBuf,
    sandbox_public_url: String,
) -> Router {
    let index = dist_dir.join("index.html");
    if !index.exists() {
        return router;
    }
    let frontend = ServeDir::new(dist_dir)
        .append_index_html_on_directories(true)
        .fallback(ServeFile::new(index));
    router.fallback_service(tower::service_fn(move |request: Request<Body>| {
        let path = request.uri().path().to_string();
        let frontend = frontend.clone();
        let sandbox_public_url = sandbox_public_url.clone();
        async move {
            if path == "/v1" || path.starts_with("/v1/") {
                return Ok(StatusCode::NOT_FOUND.into_response());
            }
            if is_sandbox_document_path(&path) {
                return Ok(StatusCode::NOT_FOUND.into_response());
            }
            let response = frontend.oneshot(request).await?.into_response();
            let mut response = inject_runtime_config(response, &sandbox_public_url).await;
            if response.status().is_success() && !response.headers().contains_key(CACHE_CONTROL) {
                let cache = if hashed_asset(&path, &response) {
                    IMMUTABLE
                } else {
                    REVALIDATE
                };
                response
                    .headers_mut()
                    .insert(CACHE_CONTROL, cache.parse().unwrap());
            }
            Ok::<_, std::convert::Infallible>(response)
        }
    }))
}

fn is_sandbox_document_path(path: &str) -> bool {
    let Ok(decoded) = percent_encoding::percent_decode_str(path).decode_utf8() else {
        return true;
    };
    decoded
        .split('/')
        .filter(|component| !component.is_empty() && *component != ".")
        .eq(["app-surface-sandbox.html"])
}

pub(crate) fn sandbox_document(dist_dir: PathBuf) -> ServeFile {
    ServeFile::new(dist_dir.join("app-surface-sandbox.html"))
}

async fn inject_runtime_config(
    response: Response<Body>,
    sandbox_public_url: &str,
) -> Response<Body> {
    if !response.status().is_success()
        || !response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/html"))
    {
        return response;
    }
    let (mut parts, body) = response.into_parts();
    let Ok(bytes) = to_bytes(body, 4 * 1024 * 1024).await else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let Ok(html) = String::from_utf8(bytes.to_vec()) else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let meta = format!(
        r#"<meta name="kodex-app-surface-sandbox-url" content="{}">"#,
        escape_html_attribute(sandbox_public_url)
    );
    let html = if let Some(offset) = html.find("<head>") {
        let offset = offset + "<head>".len();
        format!("{}{}{}", &html[..offset], meta, &html[offset..])
    } else {
        format!("{meta}{html}")
    };
    parts.headers.remove(axum::http::header::CONTENT_LENGTH);
    Response::from_parts(parts, Body::from(html))
}

fn escape_html_attribute(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn hashed_asset<B>(path: &str, response: &Response<B>) -> bool {
    if !path.starts_with("/assets/")
        || response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/html"))
    {
        return false;
    }
    path.rsplit('/')
        .next()
        .and_then(|name| name.rsplit_once('.').map(|(stem, _)| stem))
        .and_then(|stem| stem.rsplit_once('-').map(|(_, hash)| hash))
        .is_some_and(|hash| {
            hash.len() >= 8
                && hash
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        })
}
