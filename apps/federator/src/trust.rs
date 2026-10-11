use axum::{
    extract::{Request, State},
    http::{header, HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

pub(crate) const FEDERATOR_API_VERSION: &str = "4";

#[derive(Debug, Clone)]
pub(crate) struct TrustPolicy {
    origin: String,
    authority: String,
}

impl TrustPolicy {
    pub(crate) fn new(value: &str) -> anyhow::Result<Self> {
        let url = url::Url::parse(value)?;
        anyhow::ensure!(
            matches!(url.scheme(), "http" | "https")
                && !url.cannot_be_a_base()
                && url.username().is_empty()
                && url.password().is_none()
                && matches!(url.path(), "" | "/")
                && url.query().is_none()
                && url.fragment().is_none(),
            "KODEX_FEDERATOR_PUBLIC_ORIGIN must be an HTTP(S) origin without a path, query, fragment, or credentials"
        );
        let origin = url[url::Position::BeforeScheme..url::Position::BeforePath]
            .trim_end_matches('/')
            .to_string();
        let authority = url[url::Position::BeforeHost..url::Position::AfterPort].to_string();
        anyhow::ensure!(
            !authority.is_empty(),
            "KODEX_FEDERATOR_PUBLIC_ORIGIN must include a host"
        );
        Ok(Self { origin, authority })
    }
}

pub(crate) async fn enforce(
    State(policy): State<TrustPolicy>,
    request: Request,
    next: Next,
) -> Response {
    if !host_matches(request.headers(), &policy.authority) {
        return advertise(rejection(
            "invalid_host",
            "Request Host does not match the federator origin.",
            StatusCode::FORBIDDEN,
        ));
    }

    let origin = request.headers().get(header::ORIGIN);
    if origin.is_some_and(|origin| origin.as_bytes() != policy.origin.as_bytes()) {
        return advertise(rejection(
            "invalid_origin",
            "Request Origin does not match the federator origin.",
            StatusCode::FORBIDDEN,
        ));
    }

    if is_websocket_upgrade(request.headers()) && origin.is_none() {
        return advertise(rejection(
            "origin_required",
            "WebSocket requests require the federator browser origin.",
            StatusCode::FORBIDDEN,
        ));
    }

    if !request.method().is_safe() && !has_current_api_version(request.headers()) {
        return advertise(rejection(
            "client_update_required",
            "Update Kodex before making changes.",
            StatusCode::CONFLICT,
        ));
    }

    advertise(next.run(request).await)
}

fn host_matches(headers: &HeaderMap, authority: &str) -> bool {
    headers
        .get(header::HOST)
        .is_some_and(|host| host.as_bytes().eq_ignore_ascii_case(authority.as_bytes()))
}

fn has_current_api_version(headers: &HeaderMap) -> bool {
    headers
        .get("x-kodex-api-version")
        .is_some_and(|version| version == FEDERATOR_API_VERSION)
}

fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    headers
        .get(header::UPGRADE)
        .is_some_and(|value| value.as_bytes().eq_ignore_ascii_case(b"websocket"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TrustErrorBody {
    code: &'static str,
    message: &'static str,
    retryable: bool,
}

fn rejection(code: &'static str, message: &'static str, status: StatusCode) -> Response {
    (
        status,
        Json(TrustErrorBody {
            code,
            message,
            retryable: false,
        }),
    )
        .into_response()
}

fn advertise(mut response: Response) -> Response {
    response.headers_mut().insert(
        "x-kodex-api-version",
        FEDERATOR_API_VERSION
            .parse()
            .expect("federator API version is a valid header value"),
    );
    response
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    use axum::{body::Body, middleware, routing::post, Router};
    use tower::ServiceExt;

    use super::*;

    fn guarded(executions: Arc<AtomicUsize>) -> Router {
        Router::new()
            .route(
                "/mutate",
                post(move || async move {
                    executions.fetch_add(1, Ordering::SeqCst);
                    StatusCode::NO_CONTENT
                }),
            )
            .layer(middleware::from_fn_with_state(
                TrustPolicy::new("https://kodex.tailnet.ts.net").unwrap(),
                enforce,
            ))
    }

    #[tokio::test]
    async fn mutations_require_exact_host_origin_and_current_browser_epoch() {
        let executions = Arc::new(AtomicUsize::new(0));
        for (host, origin, version, expected) in [
            (
                "kodex.tailnet.ts.net",
                Some("https://kodex.tailnet.ts.net"),
                Some("4"),
                StatusCode::NO_CONTENT,
            ),
            (
                "kodex.tailnet.ts.net",
                None,
                Some("4"),
                StatusCode::NO_CONTENT,
            ),
            (
                "evil.example",
                Some("https://kodex.tailnet.ts.net"),
                Some("4"),
                StatusCode::FORBIDDEN,
            ),
            (
                "kodex.tailnet.ts.net",
                Some("https://evil.example"),
                Some("4"),
                StatusCode::FORBIDDEN,
            ),
            (
                "kodex.tailnet.ts.net",
                Some("null"),
                Some("4"),
                StatusCode::FORBIDDEN,
            ),
            (
                "kodex.tailnet.ts.net",
                Some("https://kodex.tailnet.ts.net"),
                None,
                StatusCode::CONFLICT,
            ),
            (
                "kodex.tailnet.ts.net",
                Some("https://kodex.tailnet.ts.net"),
                Some("3"),
                StatusCode::CONFLICT,
            ),
            ("kodex.tailnet.ts.net", None, None, StatusCode::CONFLICT),
            (
                "kodex.tailnet.ts.net",
                None,
                Some("3"),
                StatusCode::CONFLICT,
            ),
        ] {
            let mut request = Request::post("/mutate").header(header::HOST, host);
            if let Some(origin) = origin {
                request = request.header(header::ORIGIN, origin);
            }
            if let Some(version) = version {
                request = request.header("x-kodex-api-version", version);
            }
            let response = guarded(executions.clone())
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                expected,
                "{host:?} {origin:?} {version:?}"
            );
            assert_eq!(response.headers()["x-kodex-api-version"], "4");
        }
        assert_eq!(executions.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn websocket_upgrades_require_exact_browser_origin() {
        for (origin, expected) in [
            (Some("https://kodex.tailnet.ts.net"), StatusCode::NOT_FOUND),
            (Some("https://evil.example"), StatusCode::FORBIDDEN),
            (Some("null"), StatusCode::FORBIDDEN),
            (None, StatusCode::FORBIDDEN),
        ] {
            let mut request = Request::get("/socket")
                .header(header::HOST, "kodex.tailnet.ts.net")
                .header(header::UPGRADE, "websocket")
                .header("x-kodex-api-version", "4");
            if let Some(origin) = origin {
                request = request.header(header::ORIGIN, origin);
            }
            let response = guarded(Arc::new(AtomicUsize::new(0)))
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), expected, "{origin:?}");
        }
    }

    #[test]
    fn public_origin_rejects_paths_credentials_and_non_http_schemes() {
        for invalid in [
            "https://kodex.tailnet.ts.net/path",
            "https://user@kodex.tailnet.ts.net",
            "file:///tmp/kodex",
        ] {
            assert!(TrustPolicy::new(invalid).is_err(), "{invalid}");
        }
    }
}
