use std::sync::OnceLock;

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, Method, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::{any, get},
    Json, Router,
};
use futures_util::StreamExt;
use serde::Serialize;

use crate::{
    registry::{self, ExecutorRecord, ExecutorStatus, SUPPORTED_EXECUTOR_API_VERSION},
    State as FederatorState,
};

const EXPECTED_INSTANCE_HEADER: &str = "x-kodex-expected-instance";
const API_VERSION_HEADER: &str = "x-kodex-api-version";
const FRONTEND_UPDATE_PATH: &str = "/v1/frontend-updates";

mod websocket;

pub fn router() -> Router<FederatorState> {
    Router::new()
        .route(
            "/v1/executors/{executor_id}/terminals/{terminal_id}/ws",
            get(websocket::proxy_terminal_websocket),
        )
        .route("/v1/executors/{executor_id}/{*path}", any(proxy_executor))
}

async fn load_routable_binding(
    state: &FederatorState,
    executor_id: &str,
) -> Result<ExecutorRecord, ProxyError> {
    let binding = state
        .store
        .get_executor(executor_id)
        .await
        .map_err(ProxyError::internal)?
        .ok_or_else(|| ProxyError::not_found("Executor not found."))?;
    if !binding.enabled {
        return Err(ProxyError::unavailable("Executor is disabled."));
    }
    if binding.api_version != SUPPORTED_EXECUTOR_API_VERSION
        || binding.status == ExecutorStatus::Incompatible
    {
        return Err(ProxyError::conflict(
            "Executor API/native version is incompatible.",
        ));
    }
    Ok(binding)
}

async fn proxy_executor(
    State(state): State<FederatorState>,
    Path((executor_id, path)): Path<(String, String)>,
    request: Request<Body>,
) -> Response {
    match proxy_executor_inner(&state, &executor_id, &path, request).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

async fn proxy_executor_inner(
    state: &FederatorState,
    executor_id: &str,
    path: &str,
    request: Request<Body>,
) -> Result<Response, ProxyError> {
    let registry_changes = state.registry_changes.subscribe();
    validate_proxy_path(path)?;
    let upstream_path = format!("/v1/{path}");
    if !allowlist().allows(request.method(), &upstream_path) {
        return Err(ProxyError::not_found(
            "The requested executor route is not exposed by the federator.",
        ));
    }

    let binding = load_routable_binding(state, executor_id).await?;

    // Resolve and constrain the endpoint for every routed request. The returned
    // client is pinned to that address set, so a later DNS answer cannot change
    // the peer used by this operation.
    let endpoint = registry::validate_executor_proxy_endpoint(&binding.base_url)
        .await
        .map_err(|error| ProxyError::upstream(error.message().to_string()))?;
    let mut upstream_url = url::Url::parse(&endpoint.base_url).map_err(ProxyError::internal)?;
    upstream_url.set_path(&upstream_path);
    upstream_url.set_query(request.uri().query());

    let (parts, body) = request.into_parts();
    let mut headers = parts.headers;
    remove_hop_by_hop_headers(&mut headers);
    headers.remove(header::HOST);
    headers.insert(
        EXPECTED_INSTANCE_HEADER,
        binding
            .instance_id
            .parse()
            .map_err(|_| ProxyError::internal("invalid stored executor instance identity"))?,
    );
    headers.insert(
        API_VERSION_HEADER,
        SUPPORTED_EXECUTOR_API_VERSION
            .parse()
            .expect("supported API version is a valid header value"),
    );
    let upstream = endpoint
        .client
        .request(parts.method, upstream_url)
        .headers(headers)
        .body(reqwest::Body::wrap_stream(body.into_data_stream()))
        .send()
        .await
        .map_err(|error| ProxyError::upstream(format!("Executor request failed: {error}")))?;

    if upstream
        .headers()
        .get(API_VERSION_HEADER)
        .is_none_or(|version| version != SUPPORTED_EXECUTOR_API_VERSION)
    {
        return Err(ProxyError::incompatible(
            "Executor response did not confirm the required API version.",
        ));
    }
    if upstream.status().is_redirection() {
        return Err(ProxyError::upstream(
            "Executor redirects are not permitted through the federator.",
        ));
    }
    ensure_binding_current(state, &binding).await?;

    let status = upstream.status();
    let mut response_headers = upstream.headers().clone();
    remove_hop_by_hop_headers(&mut response_headers);
    let body = generation_fenced_body(upstream, binding, registry_changes);
    let mut response = Response::new(body);
    *response.status_mut() = status;
    *response.headers_mut() = response_headers;
    Ok(response)
}

fn generation_fenced_body(
    upstream: reqwest::Response,
    binding: ExecutorRecord,
    mut registry_changes: tokio::sync::broadcast::Receiver<crate::RegistryChange>,
) -> Body {
    let stream = async_stream::stream! {
        let mut upstream = upstream.bytes_stream();
        loop {
            tokio::select! {
                biased;
                change = registry_changes.recv() => match change {
                    Ok(change)
                        if change.executor_id == binding.id
                            && change
                                .generation
                                .map_or(true, |generation| generation > binding.generation) =>
                    {
                        yield Err(std::io::Error::other(
                            "executor registration changed while streaming the response",
                        ));
                        break;
                    }
                    Ok(_) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        yield Err(std::io::Error::other(
                            "executor registry changes were missed while streaming the response",
                        ));
                        break;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        yield Err(std::io::Error::other(
                            "executor registry closed while streaming the response",
                        ));
                        break;
                    }
                },
                chunk = upstream.next() => match chunk {
                    Some(Ok(chunk)) => yield Ok(chunk),
                    Some(Err(error)) => {
                        yield Err(std::io::Error::other(error));
                        break;
                    }
                    None => break,
                }
            }
        }
    };
    Body::from_stream(stream)
}

async fn ensure_binding_current(
    state: &FederatorState,
    expected: &ExecutorRecord,
) -> Result<(), ProxyError> {
    let current = state
        .store
        .get_executor(&expected.id)
        .await
        .map_err(ProxyError::internal)?;
    if !current.is_some_and(|current| {
        current.enabled
            && current.generation == expected.generation
            && current.instance_id == expected.instance_id
            && current.base_url == expected.base_url
    }) {
        return Err(ProxyError::conflict(
            "Executor registration changed while the request was in flight.",
        ));
    }
    Ok(())
}

fn validate_proxy_path(path: &str) -> Result<(), ProxyError> {
    if path.is_empty()
        || path.split('/').any(|segment| {
            segment.is_empty()
                || matches!(segment, "." | "..")
                || segment.contains('\\')
                || segment.contains('\0')
        })
    {
        return Err(ProxyError::not_found("Invalid executor route."));
    }
    Ok(())
}

fn remove_hop_by_hop_headers(headers: &mut HeaderMap) {
    let connection_headers = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .filter_map(|name| name.trim().parse::<header::HeaderName>().ok())
        .collect::<Vec<_>>();
    for name in connection_headers {
        headers.remove(name);
    }
    for name in [
        header::CONNECTION,
        header::PROXY_AUTHENTICATE,
        header::PROXY_AUTHORIZATION,
        header::TE,
        header::TRAILER,
        header::TRANSFER_ENCODING,
        header::UPGRADE,
    ] {
        headers.remove(name);
    }
    headers.remove("keep-alive");
}

fn allowlist() -> &'static ExecutorRouteAllowlist {
    static ALLOWLIST: OnceLock<ExecutorRouteAllowlist> = OnceLock::new();
    ALLOWLIST.get_or_init(ExecutorRouteAllowlist::from_gateway_openapi)
}

struct ExecutorRouteAllowlist {
    rules: Vec<RouteRule>,
}

struct RouteRule {
    method: String,
    segments: Vec<RouteSegment>,
}

enum RouteSegment {
    Literal(String),
    Parameter,
    RestParameter,
}

impl ExecutorRouteAllowlist {
    fn from_gateway_openapi() -> Self {
        let contract = serde_json::to_value(kodex_gateway::executor_openapi())
            .expect("executor OpenAPI serializes");
        let paths = contract["paths"]
            .as_object()
            .expect("executor OpenAPI contains paths");
        let mut rules = Vec::new();
        for (path, item) in paths {
            if path == FRONTEND_UPDATE_PATH || path.starts_with("/v1/notifications/deliveries/") {
                continue;
            }
            let Some(item) = item.as_object() else {
                continue;
            };
            for method in ["get", "post", "put", "patch", "delete"] {
                if item.contains_key(method) {
                    rules.push(RouteRule {
                        method: method.to_string(),
                        segments: path
                            .trim_start_matches('/')
                            .split('/')
                            .map(|segment| {
                                if path.contains("/files/content/") && segment == "{filePath}" {
                                    RouteSegment::RestParameter
                                } else if segment.starts_with('{') && segment.ends_with('}') {
                                    RouteSegment::Parameter
                                } else {
                                    RouteSegment::Literal(segment.to_string())
                                }
                            })
                            .collect(),
                    });
                }
            }
        }
        Self { rules }
    }

    fn allows(&self, method: &Method, path: &str) -> bool {
        let method = if method == Method::HEAD {
            "get"
        } else {
            method.as_str()
        };
        let method = method.to_ascii_lowercase();
        let segments = path.trim_start_matches('/').split('/').collect::<Vec<_>>();
        self.rules.iter().any(|rule| {
            let has_rest = matches!(rule.segments.last(), Some(RouteSegment::RestParameter));
            rule.method == method
                && if has_rest {
                    segments.len() >= rule.segments.len()
                } else {
                    rule.segments.len() == segments.len()
                }
                && rule
                    .segments
                    .iter()
                    .zip(&segments)
                    .all(|(rule, actual)| match rule {
                        RouteSegment::Literal(expected) => expected == actual,
                        RouteSegment::Parameter | RouteSegment::RestParameter => !actual.is_empty(),
                    })
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProxyErrorBody {
    code: &'static str,
    message: String,
}

#[derive(Debug)]
struct ProxyError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ProxyError {
    fn client_update_required() -> Self {
        Self::new(
            StatusCode::CONFLICT,
            "client_update_required",
            "Update Kodex before making changes.",
        )
    }
    fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "executor_route_not_found", message)
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "executor_unavailable",
            message,
        )
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, "executor_binding_changed", message)
    }

    fn incompatible(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, "executor_incompatible", message)
    }

    fn upstream(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, "executor_proxy_failed", message)
    }

    fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!(%error, "federator proxy failed");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "Federator proxy failed.",
        )
    }

    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
}

impl IntoResponse for ProxyError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ProxyErrorBody {
                code: self.code,
                message: self.message,
            }),
        )
            .into_response()
    }
}

#[cfg(test)]
mod routing_tests;

#[cfg(test)]
mod tests;
