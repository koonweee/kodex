use std::time::Instant;

use axum::{body::Body, extract::Request, http::Method, middleware::Next, response::Response};

pub async fn route_timing_middleware(request: Request<Body>, next: Next) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    let route = hot_route_label(&method, &path);
    let started_at = Instant::now();
    let response = next.run(request).await;
    if let Some(route) = route {
        tracing::info!(
            target: "kodex.performance",
            http_method = method.as_str(),
            route,
            status = response.status().as_u16(),
            duration_ms = started_at.elapsed().as_secs_f64() * 1000.0,
            response_bytes = response
                .headers()
                .get(axum::http::header::CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<usize>().ok()),
            "gateway route completed"
        );
    }
    response
}

fn hot_route_label(method: &Method, path: &str) -> Option<&'static str> {
    if method == Method::GET && path == "/v1/sidebar/threads" {
        return Some("GET /v1/sidebar/threads");
    }
    if method == Method::POST && path == "/v1/threads" {
        return Some("POST /v1/threads");
    }
    if method == Method::POST && path == "/v1/chats/threads" {
        return Some("POST /v1/chats/threads");
    }
    if method == Method::GET && path == "/v1/events" {
        return Some("GET /v1/events");
    }
    let segments = path.trim_matches('/').split('/').collect::<Vec<_>>();
    match (method, segments.as_slice()) {
        (&Method::GET, ["v1", "threads", _thread_id]) => Some("GET /v1/threads/{threadId}"),
        (&Method::GET, ["v1", "threads", _thread_id, "timeline", "pages"]) => {
            Some("GET /v1/threads/{threadId}/timeline/pages")
        }
        (&Method::POST, ["v1", "threads", _thread_id, "input"]) => {
            Some("POST /v1/threads/{threadId}/input")
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::hot_route_label;
    use axum::http::Method;

    #[test]
    fn labels_hot_routes_without_thread_ids() {
        assert_eq!(
            hot_route_label(&Method::GET, "/v1/sidebar/threads"),
            Some("GET /v1/sidebar/threads")
        );
        assert_eq!(
            hot_route_label(&Method::GET, "/v1/threads/thread-1"),
            Some("GET /v1/threads/{threadId}")
        );
        assert_eq!(
            hot_route_label(&Method::GET, "/v1/threads/thread-1/timeline/pages"),
            Some("GET /v1/threads/{threadId}/timeline/pages")
        );
        assert_eq!(
            hot_route_label(&Method::POST, "/v1/threads/thread-1/input"),
            Some("POST /v1/threads/{threadId}/input")
        );
        assert_eq!(hot_route_label(&Method::GET, "/v1/threads"), None);
        assert_eq!(hot_route_label(&Method::GET, "/v1/projects"), None);
    }
}
