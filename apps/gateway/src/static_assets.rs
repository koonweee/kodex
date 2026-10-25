use std::path::PathBuf;

use axum::{
    body::Body,
    http::{
        header::{CACHE_CONTROL, CONTENT_TYPE},
        Request, Response, StatusCode,
    },
    response::IntoResponse,
    Router,
};
use tower::{service_fn, ServiceExt};
use tower_http::services::{ServeDir, ServeFile};

const IMMUTABLE_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";
const CONSERVATIVE_CACHE_CONTROL: &str = "no-cache";

pub fn attach_frontend(router: Router, dist_dir: PathBuf) -> Router {
    let index = dist_dir.join("index.html");
    if index.exists() {
        let files = ServeDir::new(dist_dir).append_index_html_on_directories(true);
        let frontend = files.clone().fallback(ServeFile::new(index));

        router.fallback_service(service_fn(move |request: Request<Body>| {
            let path = request.uri().path().to_string();
            let frontend = frontend.clone();
            let files = files.clone();
            async move {
                if path == "/v1" || path.starts_with("/v1/") {
                    return Ok(StatusCode::NOT_FOUND.into_response());
                }
                // Asset misses are errors. A viewer HTML miss must never mount
                // another copy of the workspace inside its own iframe.
                let mut response = if path.starts_with("/assets/") {
                    files.oneshot(request).await?
                } else {
                    frontend.oneshot(request).await?
                };
                apply_cache_control(&path, &mut response);
                Ok::<_, std::convert::Infallible>(response.into_response())
            }
        }))
    } else {
        router
    }
}

fn apply_cache_control<B>(path: &str, response: &mut Response<B>) {
    if response.status().is_client_error() || response.status().is_server_error() {
        response
            .headers_mut()
            .insert(CACHE_CONTROL, "no-store".parse().unwrap());
        return;
    }
    if response.headers().contains_key(CACHE_CONTROL) {
        return;
    }

    let cache_control = if is_hashed_vite_asset(path, response) {
        IMMUTABLE_CACHE_CONTROL
    } else {
        CONSERVATIVE_CACHE_CONTROL
    };
    response.headers_mut().insert(
        CACHE_CONTROL,
        cache_control
            .parse()
            .expect("static cache-control value must be valid"),
    );
}

fn is_hashed_vite_asset<B>(path: &str, response: &Response<B>) -> bool {
    if !path.starts_with("/assets/") || is_html_response(response) {
        return false;
    }

    let Some(filename) = path.rsplit('/').next() else {
        return false;
    };
    let Some(stem) = filename.rsplit_once('.').map(|(stem, _)| stem) else {
        return false;
    };

    let Some((_, hash)) = stem.rsplit_once('-') else {
        return false;
    };
    hash.len() >= 8
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn is_html_response<B>(response: &Response<B>) -> bool {
    response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|content_type| content_type.starts_with("text/html"))
}

#[cfg(test)]
mod tests {
    use axum::body::to_bytes;

    use super::*;

    #[tokio::test]
    async fn conditional_asset_hits_keep_their_cache_policy() {
        let dist = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dist.path().join("assets/desktop-viewer/revision")).unwrap();
        std::fs::write(dist.path().join("index.html"), "<main>Kodex</main>").unwrap();
        let app = attach_frontend(Router::new(), dist.path().to_path_buf());
        for (path, expected) in [
            ("/assets/main-abcdefgh.js", IMMUTABLE_CACHE_CONTROL),
            (
                "/assets/desktop-viewer/revision/index.html",
                CONSERVATIVE_CACHE_CONTROL,
            ),
        ] {
            let file = dist.path().join(path.trim_start_matches('/'));
            std::fs::write(&file, "fixture").unwrap();
            std::fs::File::options()
                .write(true)
                .open(&file)
                .unwrap()
                .set_times(
                    std::fs::FileTimes::new().set_modified(
                        std::time::UNIX_EPOCH + std::time::Duration::from_secs(100000),
                    ),
                )
                .unwrap();
            let response = app
                .clone()
                .oneshot(Request::get(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            let modified = response.headers()[axum::http::header::LAST_MODIFIED].clone();
            let response = app
                .clone()
                .oneshot(
                    Request::get(path)
                        .header(axum::http::header::IF_MODIFIED_SINCE, modified)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
            assert_eq!(response.headers()[CACHE_CONTROL], expected);
        }
    }

    #[tokio::test]
    async fn missing_viewer_assets_do_not_load_the_kodex_app_in_an_iframe() {
        let dist = tempfile::tempdir().unwrap();
        std::fs::write(
            dist.path().join("index.html"),
            "<main>Kodex application</main>",
        )
        .unwrap();
        let app = attach_frontend(Router::new(), dist.path().to_path_buf());
        for path in [
            "/assets/desktop-viewer/missing/index.html",
            "/assets/missing-chunk.js",
        ] {
            let response = app
                .clone()
                .oneshot(Request::get(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
            assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            assert!(!String::from_utf8_lossy(&body).contains("Kodex application"));
        }
    }

    #[tokio::test]
    async fn unknown_api_routes_do_not_fall_back_to_the_frontend() {
        let dist = tempfile::tempdir().unwrap();
        std::fs::write(
            dist.path().join("index.html"),
            "<!doctype html><main>Kodex</main>",
        )
        .unwrap();
        let app = attach_frontend(Router::new(), dist.path().to_path_buf());
        for path in ["/v1", "/v1/unknown", "/v1/projects/project-1/previews"] {
            let response = app
                .clone()
                .oneshot(Request::get(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
        }
        let response = app
            .oneshot(
                Request::get("/threads/thread-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body.as_ref(), b"<!doctype html><main>Kodex</main>");
    }
}
