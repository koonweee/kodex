use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, patch, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::{
    api::AppState,
    error::{ApiError, ApiResult},
    previews::{
        is_valid_route_pattern, PreviewRuntimeStatus, PreviewServiceStatus, PreviewSubsystemStatus,
    },
    store::{
        NewProjectPreview, NewProjectPreviewRoute, NewProjectPreviewService, ProjectPreview,
        ProjectPreviewRoute, ProjectPreviewRouteUpdate, ProjectPreviewService,
        ProjectPreviewServiceUpdate, ProjectPreviewUpdate,
    },
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/projects/{project_id}/previews",
            get(list_project_previews).post(create_preview),
        )
        .route(
            "/v1/projects/{project_id}/preview-services",
            post(create_preview_service),
        )
        .route(
            "/v1/projects/{project_id}/preview-services/{service_id}",
            patch(update_preview_service).delete(delete_preview_service),
        )
        .route(
            "/v1/projects/{project_id}/previews/{preview_id}",
            patch(update_preview).delete(delete_preview),
        )
        .route(
            "/v1/projects/{project_id}/previews/{preview_id}/routes",
            post(create_preview_route),
        )
        .route(
            "/v1/projects/{project_id}/previews/{preview_id}/routes/{route_id}",
            patch(update_preview_route).delete(delete_preview_route),
        )
        .route("/v1/project-previews/reload", post(reload_previews))
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPreviewServiceDto {
    #[serde(flatten)]
    pub service: ProjectPreviewService,
    pub status: PreviewServiceStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPreviewRouteDto {
    #[serde(flatten)]
    pub route: ProjectPreviewRoute,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPreviewDto {
    #[serde(flatten)]
    pub preview: ProjectPreview,
    pub routes: Vec<ProjectPreviewRouteDto>,
    pub status: PreviewRuntimeStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewListResponse {
    pub subsystem: PreviewSubsystemStatus,
    pub project_id: String,
    pub services: Vec<ProjectPreviewServiceDto>,
    pub previews: Vec<ProjectPreviewDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewServiceCreateRequest {
    pub name: String,
    pub protocol: Option<String>,
    pub local_port: i64,
    pub health_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewServiceUpdateRequest {
    pub name: Option<String>,
    pub protocol: Option<String>,
    pub local_port: Option<i64>,
    pub health_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewServiceResponse {
    pub service: ProjectPreviewServiceDto,
    pub subsystem: PreviewSubsystemStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCreateRequest {
    pub name: String,
    pub public_port: Option<i64>,
    pub root_service_id: String,
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewUpdateRequest {
    pub name: Option<String>,
    pub public_port: Option<i64>,
    pub root_service_id: Option<String>,
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRouteCreateRequest {
    pub path_pattern: String,
    pub service_id: String,
    pub strip_prefix: Option<bool>,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRouteUpdateRequest {
    pub path_pattern: Option<String>,
    pub service_id: Option<String>,
    pub strip_prefix: Option<bool>,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRouteResponse {
    pub route: ProjectPreviewRouteDto,
    pub subsystem: PreviewSubsystemStatus,
}

#[utoipa::path(get, path = "/v1/projects/{projectId}/previews", responses((status = 200, body = PreviewListResponse)))]
pub async fn list_project_previews(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> ApiResult<Json<PreviewListResponse>> {
    Ok(Json(project_preview_response(&state, &project_id).await?))
}

#[utoipa::path(post, path = "/v1/projects/{projectId}/preview-services", request_body = PreviewServiceCreateRequest, responses((status = 201, body = PreviewServiceResponse)))]
pub async fn create_preview_service(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(request): Json<PreviewServiceCreateRequest>,
) -> ApiResult<(StatusCode, Json<PreviewServiceResponse>)> {
    let name = required_text(request.name, "service name")?;
    let protocol = validate_protocol(request.protocol.as_deref().unwrap_or("http"))?;
    let local_port = validate_port(request.local_port, "local port")?;
    let health_path = validate_path(request.health_path.as_deref().unwrap_or("/"), "health path")?;
    let service = state
        .store
        .create_project_preview_service(NewProjectPreviewService {
            project_id: project_id.clone(),
            name,
            protocol,
            local_port,
            health_path,
        })
        .await?;
    state.previews.apply(&state.store).await?;
    Ok((
        StatusCode::CREATED,
        Json(PreviewServiceResponse {
            service: service_dto(&state, service).await,
            subsystem: state.previews.subsystem_status().await,
        }),
    ))
}

#[utoipa::path(patch, path = "/v1/projects/{projectId}/preview-services/{serviceId}", request_body = PreviewServiceUpdateRequest, responses((status = 200, body = PreviewServiceResponse)))]
pub async fn update_preview_service(
    State(state): State<AppState>,
    Path((project_id, service_id)): Path<(String, String)>,
    Json(request): Json<PreviewServiceUpdateRequest>,
) -> ApiResult<Json<PreviewServiceResponse>> {
    let update = ProjectPreviewServiceUpdate {
        name: request
            .name
            .map(|value| required_text(value, "service name"))
            .transpose()?,
        protocol: request
            .protocol
            .as_deref()
            .map(validate_protocol)
            .transpose()?,
        local_port: request
            .local_port
            .map(|port| validate_port(port, "local port"))
            .transpose()?,
        health_path: request
            .health_path
            .as_deref()
            .map(|path| validate_path(path, "health path"))
            .transpose()?,
    };
    let service = state
        .store
        .update_project_preview_service(&project_id, &service_id, update)
        .await?;
    state.previews.apply(&state.store).await?;
    Ok(Json(PreviewServiceResponse {
        service: service_dto(&state, service).await,
        subsystem: state.previews.subsystem_status().await,
    }))
}

#[utoipa::path(delete, path = "/v1/projects/{projectId}/preview-services/{serviceId}", responses((status = 204)))]
pub async fn delete_preview_service(
    State(state): State<AppState>,
    Path((project_id, service_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    state
        .store
        .delete_project_preview_service(&project_id, &service_id)
        .await?;
    state.previews.apply(&state.store).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(post, path = "/v1/projects/{projectId}/previews", request_body = PreviewCreateRequest, responses((status = 201, body = ProjectPreviewDto)))]
pub async fn create_preview(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(request): Json<PreviewCreateRequest>,
) -> ApiResult<(StatusCode, Json<ProjectPreviewDto>)> {
    let name = required_text(request.name, "preview name")?;
    let root_service = state
        .store
        .get_project_preview_service(&project_id, &request.root_service_id)
        .await?;
    let public_port = match request.public_port {
        Some(port) => validate_public_port(&state, port)?,
        None => {
            state
                .store
                .allocate_project_preview_public_port(
                    10000 + root_service.local_port,
                    state.config.previews.port_range_start as i64,
                    state.config.previews.port_range_end as i64,
                )
                .await?
        }
    };
    let preview = state
        .store
        .create_project_preview(NewProjectPreview {
            project_id: project_id.clone(),
            name,
            public_port,
            root_service_id: request.root_service_id,
            enabled: request.enabled.unwrap_or(true),
        })
        .await?;
    state.previews.apply(&state.store).await?;
    Ok((
        StatusCode::CREATED,
        Json(preview_dto(&state, preview).await?),
    ))
}

#[utoipa::path(patch, path = "/v1/projects/{projectId}/previews/{previewId}", request_body = PreviewUpdateRequest, responses((status = 200, body = ProjectPreviewDto)))]
pub async fn update_preview(
    State(state): State<AppState>,
    Path((project_id, preview_id)): Path<(String, String)>,
    Json(request): Json<PreviewUpdateRequest>,
) -> ApiResult<Json<ProjectPreviewDto>> {
    if let Some(port) = request.public_port {
        validate_public_port(&state, port)?;
    }
    if let Some(root_service_id) = &request.root_service_id {
        state
            .store
            .get_project_preview_service(&project_id, root_service_id)
            .await?;
    }
    let update = ProjectPreviewUpdate {
        name: request
            .name
            .map(|value| required_text(value, "preview name"))
            .transpose()?,
        public_port: request.public_port,
        root_service_id: request.root_service_id,
        enabled: request.enabled,
    };
    let preview = state
        .store
        .update_project_preview(&project_id, &preview_id, update)
        .await?;
    state.previews.apply(&state.store).await?;
    Ok(Json(preview_dto(&state, preview).await?))
}

#[utoipa::path(delete, path = "/v1/projects/{projectId}/previews/{previewId}", responses((status = 204)))]
pub async fn delete_preview(
    State(state): State<AppState>,
    Path((project_id, preview_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    state
        .store
        .delete_project_preview(&project_id, &preview_id)
        .await?;
    state.previews.apply(&state.store).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(post, path = "/v1/projects/{projectId}/previews/{previewId}/routes", request_body = PreviewRouteCreateRequest, responses((status = 201, body = PreviewRouteResponse)))]
pub async fn create_preview_route(
    State(state): State<AppState>,
    Path((project_id, preview_id)): Path<(String, String)>,
    Json(request): Json<PreviewRouteCreateRequest>,
) -> ApiResult<(StatusCode, Json<PreviewRouteResponse>)> {
    let path_pattern = validate_route_path(&request.path_pattern)?;
    state
        .store
        .get_project_preview_service(&project_id, &request.service_id)
        .await?;
    let sort_order = request.sort_order.unwrap_or(0);
    let route = state
        .store
        .create_project_preview_route(
            &project_id,
            NewProjectPreviewRoute {
                preview_id,
                path_pattern,
                service_id: request.service_id,
                strip_prefix: request.strip_prefix.unwrap_or(true),
                sort_order,
            },
        )
        .await?;
    state.previews.apply(&state.store).await?;
    Ok((
        StatusCode::CREATED,
        Json(PreviewRouteResponse {
            route: ProjectPreviewRouteDto { route },
            subsystem: state.previews.subsystem_status().await,
        }),
    ))
}

#[utoipa::path(patch, path = "/v1/projects/{projectId}/previews/{previewId}/routes/{routeId}", request_body = PreviewRouteUpdateRequest, responses((status = 200, body = PreviewRouteResponse)))]
pub async fn update_preview_route(
    State(state): State<AppState>,
    Path((project_id, preview_id, route_id)): Path<(String, String, String)>,
    Json(request): Json<PreviewRouteUpdateRequest>,
) -> ApiResult<Json<PreviewRouteResponse>> {
    if let Some(service_id) = &request.service_id {
        state
            .store
            .get_project_preview_service(&project_id, service_id)
            .await?;
    }
    let update = ProjectPreviewRouteUpdate {
        path_pattern: request
            .path_pattern
            .as_deref()
            .map(validate_route_path)
            .transpose()?,
        service_id: request.service_id,
        strip_prefix: request.strip_prefix,
        sort_order: request.sort_order,
    };
    let route = state
        .store
        .update_project_preview_route(&project_id, &preview_id, &route_id, update)
        .await?;
    state.previews.apply(&state.store).await?;
    Ok(Json(PreviewRouteResponse {
        route: ProjectPreviewRouteDto { route },
        subsystem: state.previews.subsystem_status().await,
    }))
}

#[utoipa::path(delete, path = "/v1/projects/{projectId}/previews/{previewId}/routes/{routeId}", responses((status = 204)))]
pub async fn delete_preview_route(
    State(state): State<AppState>,
    Path((project_id, preview_id, route_id)): Path<(String, String, String)>,
) -> ApiResult<StatusCode> {
    state
        .store
        .delete_project_preview_route(&project_id, &preview_id, &route_id)
        .await?;
    state.previews.apply(&state.store).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(post, path = "/v1/project-previews/reload", responses((status = 200, body = PreviewSubsystemStatus)))]
pub async fn reload_previews(
    State(state): State<AppState>,
) -> ApiResult<Json<PreviewSubsystemStatus>> {
    state.previews.apply(&state.store).await?;
    Ok(Json(state.previews.subsystem_status().await))
}

pub(crate) async fn project_preview_response(
    state: &AppState,
    project_id: &str,
) -> ApiResult<PreviewListResponse> {
    let services = state
        .store
        .list_project_preview_services(project_id)
        .await?;
    let previews = state.store.list_project_previews(project_id).await?;
    let mut service_dtos = Vec::with_capacity(services.len());
    for service in services {
        service_dtos.push(service_dto(state, service).await);
    }
    let mut preview_dtos = Vec::with_capacity(previews.len());
    for preview in previews {
        preview_dtos.push(preview_dto(state, preview).await?);
    }
    Ok(PreviewListResponse {
        subsystem: state.previews.subsystem_status().await,
        project_id: project_id.to_string(),
        services: service_dtos,
        previews: preview_dtos,
    })
}

async fn service_dto(state: &AppState, service: ProjectPreviewService) -> ProjectPreviewServiceDto {
    let status = state.previews.service_status(&service).await;
    ProjectPreviewServiceDto { service, status }
}

async fn preview_dto(state: &AppState, preview: ProjectPreview) -> ApiResult<ProjectPreviewDto> {
    let routes = state.store.list_project_preview_routes(&preview.id).await?;
    let status = state.previews.preview_status(&preview, &routes).await;
    Ok(ProjectPreviewDto {
        preview,
        routes: routes
            .into_iter()
            .map(|route| ProjectPreviewRouteDto { route })
            .collect(),
        status,
    })
}

pub(crate) fn required_text(value: String, label: &str) -> ApiResult<String> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(ApiError::BadRequest(format!("{label} is required")));
    }
    Ok(value)
}

pub(crate) fn validate_protocol(value: &str) -> ApiResult<String> {
    if value != "http" {
        return Err(ApiError::BadRequest(
            "only http preview services are supported".to_string(),
        ));
    }
    Ok(value.to_string())
}

pub(crate) fn validate_port(value: i64, label: &str) -> ApiResult<i64> {
    if !(1..=65535).contains(&value) {
        return Err(ApiError::BadRequest(format!(
            "{label} must be a valid TCP port"
        )));
    }
    Ok(value)
}

pub(crate) fn validate_public_port(state: &AppState, value: i64) -> ApiResult<i64> {
    validate_port(value, "public port")?;
    if value < state.config.previews.port_range_start as i64
        || value > state.config.previews.port_range_end as i64
    {
        return Err(ApiError::BadRequest(format!(
            "public port must be within {}-{}",
            state.config.previews.port_range_start, state.config.previews.port_range_end
        )));
    }
    Ok(value)
}

pub(crate) fn validate_path(value: &str, label: &str) -> ApiResult<String> {
    let value = value.trim();
    if !value.starts_with('/') {
        return Err(ApiError::BadRequest(format!("{label} must start with /")));
    }
    Ok(value.to_string())
}

pub(crate) fn validate_route_path(value: &str) -> ApiResult<String> {
    let value = validate_path(value, "route path")?;
    if value == "/" {
        return Err(ApiError::BadRequest(
            "preview route path cannot be /; use the root service instead".to_string(),
        ));
    }
    if !is_valid_route_pattern(&value) {
        return Err(ApiError::BadRequest(
            "preview route path must be a simple wildcard prefix like /api/*".to_string(),
        ));
    }
    Ok(value)
}
