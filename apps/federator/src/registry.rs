use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    time::Duration,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{RegistryChange, State as FederatorState};

pub const SUPPORTED_EXECUTOR_API_VERSION: &str = "4";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ExecutorStatus {
    Unknown,
    Ready,
    Unready,
    Incompatible,
}

impl ExecutorStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Ready => "ready",
            Self::Unready => "unready",
            Self::Incompatible => "incompatible",
        }
    }

    pub(crate) fn parse(value: &str) -> anyhow::Result<Self> {
        match value {
            "unknown" => Ok(Self::Unknown),
            "ready" => Ok(Self::Ready),
            "unready" => Ok(Self::Unready),
            "incompatible" => Ok(Self::Incompatible),
            _ => anyhow::bail!("invalid executor status {value}"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorRecord {
    pub id: String,
    pub generation: i64,
    pub display_name: String,
    pub base_url: String,
    pub instance_id: String,
    pub api_version: String,
    pub app_server_schema_version: String,
    pub enabled: bool,
    pub status: ExecutorStatus,
    pub last_error: Option<String>,
    pub last_seen_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RegisterExecutorRequest {
    pub display_name: String,
    pub base_url: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateExecutorRequest {
    pub display_name: Option<String>,
    pub enabled: Option<bool>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorListResponse {
    pub executors: Vec<ExecutorRecord>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ErrorBody {
    code: &'static str,
    message: String,
}

#[derive(Debug)]
pub(crate) struct RegistryError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl RegistryError {
    pub(crate) fn message(&self) -> &str {
        &self.message
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_executor",
            message: message.into(),
        }
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code: "executor_conflict",
            message: message.into(),
        }
    }

    fn not_found() -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: "executor_not_found",
            message: "Executor not found.".to_string(),
        }
    }

    fn upstream(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: "executor_unreachable",
            message: message.into(),
        }
    }

    fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!(%error, "federator registry operation failed");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal_error",
            message: "Federator registry operation failed.".to_string(),
        }
    }
}

impl IntoResponse for RegistryError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorBody {
                code: self.code,
                message: self.message,
            }),
        )
            .into_response()
    }
}

pub fn router() -> Router<FederatorState> {
    Router::new()
        .route(
            "/v1/federation/executors",
            get(list_executors).post(register_executor),
        )
        .route(
            "/v1/federation/executors/{executor_id}",
            get(get_executor)
                .patch(update_executor)
                .delete(delete_executor),
        )
}

#[utoipa::path(
    get,
    path = "/v1/federation/executors",
    responses((status = 200, body = ExecutorListResponse))
)]
pub(crate) async fn list_executors(
    State(state): State<FederatorState>,
) -> Result<Json<ExecutorListResponse>, RegistryError> {
    let executors = state
        .store
        .list_executors()
        .await
        .map_err(RegistryError::internal)?;
    Ok(Json(ExecutorListResponse { executors }))
}

#[utoipa::path(
    get,
    path = "/v1/federation/executors/{executorId}",
    params(("executorId" = String, Path)),
    responses((status = 200, body = ExecutorRecord), (status = 404, body = ErrorBody))
)]
pub(crate) async fn get_executor(
    State(state): State<FederatorState>,
    Path(executor_id): Path<String>,
) -> Result<Json<ExecutorRecord>, RegistryError> {
    state
        .store
        .get_executor(&executor_id)
        .await
        .map_err(RegistryError::internal)?
        .map(Json)
        .ok_or_else(RegistryError::not_found)
}

#[utoipa::path(
    post,
    path = "/v1/federation/executors",
    request_body = RegisterExecutorRequest,
    responses((status = 201, body = ExecutorRecord), (status = 400, body = ErrorBody), (status = 409, body = ErrorBody), (status = 502, body = ErrorBody))
)]
pub(crate) async fn register_executor(
    State(state): State<FederatorState>,
    Json(request): Json<RegisterExecutorRequest>,
) -> Result<(StatusCode, Json<ExecutorRecord>), RegistryError> {
    let display_name = validate_display_name(&request.display_name)?;
    let endpoint = validate_executor_probe_endpoint(&request.base_url).await?;
    let base_url = endpoint.base_url.clone();
    let capabilities = probe_executor(&endpoint).await?;
    let existing = state
        .store
        .list_executors()
        .await
        .map_err(RegistryError::internal)?;
    if existing
        .iter()
        .any(|executor| executor.base_url == base_url)
    {
        return Err(RegistryError::conflict(
            "An executor with this backend URL is already registered.",
        ));
    }
    if existing
        .iter()
        .any(|executor| executor.instance_id == capabilities.instance_id)
    {
        return Err(RegistryError::conflict(
            "This executor instance is already registered at another URL.",
        ));
    }
    let now = unix_seconds();
    let status = capabilities.status();
    let last_error = capabilities.status_error();
    let record = ExecutorRecord {
        id: Uuid::new_v4().to_string(),
        generation: 1,
        display_name,
        base_url,
        instance_id: capabilities.instance_id,
        api_version: capabilities.api_version,
        app_server_schema_version: capabilities.app_server_schema_version,
        enabled: true,
        status,
        last_error,
        last_seen_at: now,
        created_at: now,
        updated_at: now,
    };
    state
        .store
        .insert_executor(&record)
        .await
        .map_err(|error| {
            if error.to_string().contains("UNIQUE constraint failed") {
                RegistryError::conflict("Executor registration conflicts with an existing record.")
            } else {
                RegistryError::internal(error)
            }
        })?;
    let _ = state.registry_changes.send(RegistryChange {
        executor_id: record.id.clone(),
        generation: Some(record.generation),
    });
    Ok((StatusCode::CREATED, Json(record)))
}

#[utoipa::path(
    patch,
    path = "/v1/federation/executors/{executorId}",
    params(("executorId" = String, Path)),
    request_body = UpdateExecutorRequest,
    responses((status = 200, body = ExecutorRecord), (status = 400, body = ErrorBody), (status = 404, body = ErrorBody))
)]
pub(crate) async fn update_executor(
    State(state): State<FederatorState>,
    Path(executor_id): Path<String>,
    Json(request): Json<UpdateExecutorRequest>,
) -> Result<Json<ExecutorRecord>, RegistryError> {
    if request.display_name.is_none() && request.enabled.is_none() {
        return Err(RegistryError::bad_request("Supply displayName or enabled."));
    }
    let display_name = request
        .display_name
        .as_deref()
        .map(validate_display_name)
        .transpose()?;
    let updated = state
        .store
        .update_executor_sparse(
            &executor_id,
            display_name.as_deref(),
            request.enabled,
            unix_seconds(),
        )
        .await
        .map_err(RegistryError::internal)?
        .ok_or_else(RegistryError::not_found)?;
    let _ = state.registry_changes.send(RegistryChange {
        executor_id: updated.id.clone(),
        generation: Some(updated.generation),
    });
    Ok(Json(updated))
}

#[utoipa::path(
    delete,
    path = "/v1/federation/executors/{executorId}",
    params(("executorId" = String, Path)),
    responses((status = 204), (status = 404, body = ErrorBody))
)]
pub(crate) async fn delete_executor(
    State(state): State<FederatorState>,
    Path(executor_id): Path<String>,
) -> Result<StatusCode, RegistryError> {
    if state
        .store
        .delete_executor(&executor_id)
        .await
        .map_err(RegistryError::internal)?
    {
        let _ = state.registry_changes.send(RegistryChange {
            executor_id,
            generation: None,
        });
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(RegistryError::not_found())
    }
}

fn validate_display_name(value: &str) -> Result<String, RegistryError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 80 {
        return Err(RegistryError::bad_request(
            "displayName must contain 1 to 80 characters.",
        ));
    }
    Ok(value.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NetworkBoundary {
    Loopback,
    Tailscale,
}

struct ParsedEndpoint {
    base_url: String,
    url: url::Url,
    boundary: NetworkBoundary,
}

pub(crate) struct ValidatedEndpoint {
    pub(crate) base_url: String,
    pub(crate) client: reqwest::Client,
}

fn parse_executor_url(value: &str) -> Result<ParsedEndpoint, RegistryError> {
    let mut url = url::Url::parse(value)
        .map_err(|_| RegistryError::bad_request("baseUrl must be an absolute HTTP(S) URL."))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err(RegistryError::bad_request(
            "baseUrl must contain only an HTTP(S) scheme, trusted host, and optional port.",
        ));
    }
    let host = url
        .host()
        .ok_or_else(|| RegistryError::bad_request("baseUrl must include a host."))?;
    let boundary = match host {
        url::Host::Ipv4(address) if address.is_loopback() => NetworkBoundary::Loopback,
        url::Host::Ipv4(address) if tailscale_ipv4(address) => NetworkBoundary::Tailscale,
        url::Host::Ipv6(address) if address.is_loopback() => NetworkBoundary::Loopback,
        url::Host::Ipv6(address) if tailscale_ipv6(address) => NetworkBoundary::Tailscale,
        url::Host::Domain(domain) => {
            if domain.eq_ignore_ascii_case("localhost") {
                NetworkBoundary::Loopback
            } else if domain.to_ascii_lowercase().ends_with(".ts.net") {
                NetworkBoundary::Tailscale
            } else {
                return Err(RegistryError::bad_request(
                    "baseUrl host must be loopback or a Tailscale IP/.ts.net name.",
                ));
            }
        }
        _ => {
            return Err(RegistryError::bad_request(
                "baseUrl host must be loopback or a Tailscale IP/.ts.net name.",
            ));
        }
    };
    if url.scheme() == "http" && boundary != NetworkBoundary::Loopback {
        return Err(RegistryError::bad_request(
            "Remote executor baseUrl values must use HTTPS; HTTP is allowed only for loopback.",
        ));
    }
    url.set_path("");
    Ok(ParsedEndpoint {
        base_url: url.as_str().trim_end_matches('/').to_string(),
        url,
        boundary,
    })
}

async fn validate_executor_probe_endpoint(value: &str) -> Result<ValidatedEndpoint, RegistryError> {
    validate_executor_endpoint(value, Some(Duration::from_secs(5))).await
}

pub(crate) async fn validate_executor_proxy_endpoint(
    value: &str,
) -> Result<ValidatedEndpoint, RegistryError> {
    validate_executor_endpoint(value, None).await
}

async fn validate_executor_endpoint(
    value: &str,
    total_timeout: Option<Duration>,
) -> Result<ValidatedEndpoint, RegistryError> {
    let endpoint = parse_executor_url(value)?;
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy();
    if let Some(timeout) = total_timeout {
        builder = builder.timeout(timeout);
    }
    if let url::Host::Domain(domain) = endpoint.url.host().expect("validated URL has a host") {
        let port = endpoint
            .url
            .port_or_known_default()
            .expect("validated HTTP(S) URL has a default port");
        let addresses = tokio::net::lookup_host((domain, port))
            .await
            .map_err(|error| {
                RegistryError::upstream(format!("Executor hostname resolution failed: {error}"))
            })?
            .collect::<Vec<_>>();
        validate_resolved_addresses(endpoint.boundary, &addresses)?;
        builder = builder.resolve_to_addrs(domain, &addresses);
    }
    let client = builder.build().map_err(RegistryError::internal)?;
    Ok(ValidatedEndpoint {
        base_url: endpoint.base_url,
        client,
    })
}

fn validate_resolved_addresses(
    boundary: NetworkBoundary,
    addresses: &[SocketAddr],
) -> Result<(), RegistryError> {
    if addresses.is_empty() {
        return Err(RegistryError::upstream(
            "Executor hostname did not resolve to an address.",
        ));
    }
    let valid = |address: IpAddr| match boundary {
        NetworkBoundary::Loopback => address.is_loopback(),
        NetworkBoundary::Tailscale => match address {
            IpAddr::V4(address) => tailscale_ipv4(address),
            IpAddr::V6(address) => tailscale_ipv6(address),
        },
    };
    if addresses.iter().any(|address| !valid(address.ip())) {
        return Err(RegistryError::bad_request(
            "Executor hostname resolved outside its permitted loopback or Tailscale network.",
        ));
    }
    Ok(())
}

fn tailscale_ipv4(address: Ipv4Addr) -> bool {
    let value = u32::from(address);
    let start = u32::from(Ipv4Addr::new(100, 64, 0, 0));
    let end = u32::from(Ipv4Addr::new(100, 127, 255, 255));
    (start..=end).contains(&value)
}

fn tailscale_ipv6(address: Ipv6Addr) -> bool {
    let segments = address.segments();
    segments[0] == 0xfd7a && segments[1] == 0x115c && segments[2] == 0xa1e0
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapabilitiesEnvelope {
    gateway: GatewayCapabilities,
    app_server: AppServerCapabilities,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewayCapabilities {
    api_version: String,
    instance_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppServerCapabilities {
    ready: bool,
    schema_version: String,
    detected_version_matches_schema: Option<bool>,
}

struct ProbedCapabilities {
    api_version: String,
    instance_id: String,
    app_server_schema_version: String,
    app_server_ready: bool,
    native_matches_schema: Option<bool>,
}

impl ProbedCapabilities {
    fn status(&self) -> ExecutorStatus {
        if self.api_version != SUPPORTED_EXECUTOR_API_VERSION
            || self.native_matches_schema == Some(false)
        {
            ExecutorStatus::Incompatible
        } else if self.app_server_ready {
            ExecutorStatus::Ready
        } else {
            ExecutorStatus::Unready
        }
    }

    fn status_error(&self) -> Option<String> {
        match self.status() {
            ExecutorStatus::Unknown => Some("Executor status has not been checked.".to_string()),
            ExecutorStatus::Ready => None,
            ExecutorStatus::Unready => Some("Executor app-server is not ready.".to_string()),
            ExecutorStatus::Incompatible => Some(format!(
                "Executor API/native version is incompatible (API {}, schema {}).",
                self.api_version, self.app_server_schema_version
            )),
        }
    }
}

async fn probe_executor(endpoint: &ValidatedEndpoint) -> Result<ProbedCapabilities, RegistryError> {
    let response = endpoint
        .client
        .get(format!("{}/v1/capabilities", endpoint.base_url))
        .send()
        .await
        .map_err(|error| RegistryError::upstream(format!("Executor probe failed: {error}")))?;
    if !response.status().is_success() {
        return Err(RegistryError::upstream(format!(
            "Executor capabilities returned HTTP {}.",
            response.status()
        )));
    }
    let capabilities: CapabilitiesEnvelope = response.json().await.map_err(|error| {
        RegistryError::upstream(format!("Invalid executor capabilities: {error}"))
    })?;
    if capabilities.gateway.instance_id.trim().is_empty() {
        return Err(RegistryError::upstream(
            "Executor capabilities omitted its instance identity.",
        ));
    }
    Ok(ProbedCapabilities {
        api_version: capabilities.gateway.api_version,
        instance_id: capabilities.gateway.instance_id,
        app_server_schema_version: capabilities.app_server.schema_version,
        app_server_ready: capabilities.app_server.ready,
        native_matches_schema: capabilities.app_server.detected_version_matches_schema,
    })
}

fn unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executor_urls_require_https_outside_loopback() {
        for allowed in [
            "http://127.0.0.1:8788",
            "http://[::1]:8788/",
            "https://100.64.0.1:8788",
            "https://devbox.example-tailnet.ts.net",
            "https://[fd7a:115c:a1e0::1]:8788",
        ] {
            assert!(parse_executor_url(allowed).is_ok(), "{allowed}");
        }
        for rejected in [
            "https://example.com",
            "http://192.168.1.5:8788",
            "http://devbox:8788",
            "http://100.64.0.1:8788",
            "http://devbox.example-tailnet.ts.net",
            "http://[fd7a:115c:a1e0::1]:8788",
            "file:///tmp/socket",
            "http://127.0.0.1:8788/path",
            "http://user@127.0.0.1:8788",
        ] {
            assert!(parse_executor_url(rejected).is_err(), "{rejected}");
        }
    }

    #[test]
    fn resolved_hostnames_must_remain_inside_the_expected_network() {
        let loopback = [SocketAddr::from(([127, 0, 0, 1], 8788))];
        let tailscale = [SocketAddr::from(([100, 100, 10, 20], 443))];
        let public = [SocketAddr::from(([203, 0, 113, 7], 443))];
        let mixed = [tailscale[0], public[0]];

        assert!(validate_resolved_addresses(NetworkBoundary::Loopback, &loopback).is_ok());
        assert!(validate_resolved_addresses(NetworkBoundary::Tailscale, &tailscale).is_ok());
        assert!(validate_resolved_addresses(NetworkBoundary::Tailscale, &public).is_err());
        assert!(validate_resolved_addresses(NetworkBoundary::Tailscale, &mixed).is_err());
        assert!(validate_resolved_addresses(NetworkBoundary::Tailscale, &[]).is_err());
    }
}
