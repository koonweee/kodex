use std::path::PathBuf;

use axum::Router;
use tower_http::services::{ServeDir, ServeFile};

pub fn attach_frontend(router: Router, dist_dir: PathBuf) -> Router {
    let index = dist_dir.join("index.html");
    if index.exists() {
        router.fallback_service(
            ServeDir::new(dist_dir)
                .append_index_html_on_directories(true)
                .fallback(ServeFile::new(index)),
        )
    } else {
        router
    }
}
