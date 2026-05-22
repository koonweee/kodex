use std::path::PathBuf;

use axum::{
    body::Body,
    http::{
        header::{CACHE_CONTROL, CONTENT_TYPE},
        Request, Response,
    },
    Router,
};
use tower::{service_fn, ServiceExt};
use tower_http::services::{ServeDir, ServeFile};

const IMMUTABLE_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";
const CONSERVATIVE_CACHE_CONTROL: &str = "no-cache";

pub fn attach_frontend(router: Router, dist_dir: PathBuf) -> Router {
    let index = dist_dir.join("index.html");
    if index.exists() {
        let frontend = ServeDir::new(dist_dir)
            .append_index_html_on_directories(true)
            .fallback(ServeFile::new(index));

        router.fallback_service(service_fn(move |request: Request<Body>| {
            let path = request.uri().path().to_string();
            let frontend = frontend.clone();
            async move {
                let mut response = frontend.oneshot(request).await?;
                apply_cache_control(&path, &mut response);
                Ok::<_, std::convert::Infallible>(response)
            }
        }))
    } else {
        router
    }
}

fn apply_cache_control<B>(path: &str, response: &mut Response<B>) {
    if !response.status().is_success() || response.headers().contains_key(CACHE_CONTROL) {
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
