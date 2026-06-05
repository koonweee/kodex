use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::{IntoParams, ToSchema};

use crate::{
    api::AppState,
    app_server_api::UserInput,
    app_surfaces::{app_surface_csp, validate_app_surface_html, validate_app_surface_title},
    error::{ApiError, ApiResult},
    routes::app_surfaces::{broadcast_app_surface_event, APP_SURFACE_SUBMITTED_EVENT},
    routes::turns::{submit_thread_input, ThreadInputResponse, TurnStartRequest},
    store::{AppSurfaceSession, AppSurfaceSessionStatus, GeneratedUiSessionStatus},
};

pub const GENERATED_UI_UPSERTED_EVENT: &str = "generated_ui.session_upserted";
pub const GENERATED_UI_SUBMITTED_EVENT: &str = "generated_ui.session_submitted";
pub const GENERATED_UI_ARCHIVED_EVENT: &str = "generated_ui.session_archived";
pub const GENERATED_UI_NETWORK_POLICY: &str = "self_contained";

const MAX_MESSAGE_BYTES: usize = 16 * 1024;
const MAX_METADATA_BYTES: usize = 64 * 1024;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/threads/{thread_id}/generated-ui",
            get(get_thread_generated_ui),
        )
        .route(
            "/v1/generated-ui/sessions/{session_id}/document",
            get(generated_ui_document),
        )
        .route(
            "/v1/generated-ui/sessions/{session_id}/submit",
            post(submit_generated_ui),
        )
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedUiSessionDto {
    pub id: String,
    pub thread_id: String,
    pub title: String,
    pub revision: i64,
    pub status: GeneratedUiSessionStatus,
    pub submitted_revision: Option<i64>,
    pub submitted_message: Option<String>,
    pub submitted_metadata: Option<Value>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub submitted_at: Option<DateTime<Utc>>,
    pub archived_at: Option<DateTime<Utc>>,
    pub document_url: String,
    pub submit_available: bool,
    pub network_policy: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedUiSessionReadResponse {
    pub session: Option<GeneratedUiSessionDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedUiSessionResponse {
    pub session: GeneratedUiSessionDto,
}

#[derive(Debug, Clone, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedUiDocumentQuery {
    pub revision: i64,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedUiSubmitRequest {
    pub revision: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedUiSubmitResponse {
    pub session: GeneratedUiSessionDto,
    pub input: ThreadInputResponse,
}

#[utoipa::path(
    get,
    path = "/v1/threads/{threadId}/generated-ui",
    responses((status = 200, body = GeneratedUiSessionReadResponse))
)]
pub async fn get_thread_generated_ui(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> ApiResult<Json<GeneratedUiSessionReadResponse>> {
    let session = state
        .store
        .latest_app_surface_session(&thread_id)
        .await?
        .filter(|session| session.status != AppSurfaceSessionStatus::Archived)
        .map(session_dto);
    Ok(Json(GeneratedUiSessionReadResponse { session }))
}

#[utoipa::path(
    get,
    path = "/v1/generated-ui/sessions/{sessionId}/document",
    params(GeneratedUiDocumentQuery),
    responses((status = 200, content_type = "text/html"))
)]
pub async fn generated_ui_document(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Query(query): Query<GeneratedUiDocumentQuery>,
) -> ApiResult<Response> {
    let session = state.store.get_app_surface_session(&session_id).await?;
    if session.revision != query.revision {
        return Err(ApiError::Conflict(format!(
            "generated UI revision {} is not current",
            query.revision
        )));
    }
    let mut response = Html(session.html).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_str(&app_surface_csp(&session.csp))
            .map_err(|error| ApiError::Other(error.into()))?,
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, no-cache, must-revalidate"),
    );
    Ok(response)
}

#[utoipa::path(
    post,
    path = "/v1/generated-ui/sessions/{sessionId}/submit",
    request_body = GeneratedUiSubmitRequest,
    responses(
        (status = 200, body = GeneratedUiSubmitResponse),
        (status = 409, body = crate::error::ApiErrorBody)
    )
)]
pub async fn submit_generated_ui(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(request): Json<GeneratedUiSubmitRequest>,
) -> ApiResult<Json<GeneratedUiSubmitResponse>> {
    let message = validate_submit_message(request.message)?;
    validate_metadata(&request.metadata)?;
    let session = state.store.get_app_surface_session(&session_id).await?;
    if session.revision != request.revision {
        return Err(ApiError::Conflict(format!(
            "generated UI revision {} is not current",
            request.revision
        )));
    }
    if session.status == AppSurfaceSessionStatus::Archived {
        return Err(ApiError::Conflict(
            "generated UI session is archived".to_string(),
        ));
    }
    if session.submitted_revision == Some(request.revision)
        || session.status == AppSurfaceSessionStatus::Submitted
    {
        return Err(ApiError::Conflict(
            "generated UI revision has already been submitted".to_string(),
        ));
    }
    if !session.grants.can_send_message {
        return Err(ApiError::BadRequest(
            "generated UI session is not granted submit".to_string(),
        ));
    }
    let input_response = submit_thread_input(
        State(state.clone()),
        Path(session.thread_id.clone()),
        Json(TurnStartRequest {
            input: vec![UserInput::Text {
                text: message.clone(),
                text_elements: Vec::new(),
            }],
            attachments: Vec::new(),
            options: Default::default(),
        }),
    )
    .await?
    .0;
    let session = state
        .store
        .submit_app_surface_session(&session_id, request.revision, &message, request.metadata)
        .await?;
    broadcast_app_surface_event(&state, APP_SURFACE_SUBMITTED_EVENT, &session).await?;
    Ok(Json(GeneratedUiSubmitResponse {
        session: session_dto(session),
        input: input_response,
    }))
}

pub(crate) fn session_dto(session: AppSurfaceSession) -> GeneratedUiSessionDto {
    let document_url = format!(
        "/v1/generated-ui/sessions/{}/document?revision={}",
        url_path_segment(&session.id),
        session.revision
    );
    let status = match session.status {
        AppSurfaceSessionStatus::Active => GeneratedUiSessionStatus::Interactive,
        AppSurfaceSessionStatus::Submitting => GeneratedUiSessionStatus::Submitting,
        AppSurfaceSessionStatus::Submitted => GeneratedUiSessionStatus::Submitted,
        AppSurfaceSessionStatus::Archived => GeneratedUiSessionStatus::Archived,
        AppSurfaceSessionStatus::Errored => GeneratedUiSessionStatus::Interactive,
    };
    GeneratedUiSessionDto {
        submit_available: session.status == AppSurfaceSessionStatus::Active
            && session.submitted_revision != Some(session.revision)
            && session.archived_at.is_none(),
        id: session.id,
        thread_id: session.thread_id,
        title: session.title,
        revision: session.revision,
        status,
        submitted_revision: session.submitted_revision,
        submitted_message: session.submitted_message,
        submitted_metadata: session.submitted_metadata,
        created_at: session.created_at,
        updated_at: session.updated_at,
        submitted_at: session.submitted_at,
        archived_at: session.archived_at,
        document_url,
        network_policy: GENERATED_UI_NETWORK_POLICY.to_string(),
    }
}

pub(crate) fn validate_generated_ui_title(title: String) -> ApiResult<String> {
    validate_app_surface_title(title).map_err(|error| match error {
        ApiError::BadRequest(message) if message.contains("app surface") => {
            ApiError::BadRequest(message.replace("app surface", "generated UI"))
        }
        error => error,
    })
}

pub(crate) fn validate_generated_ui_html(html: String) -> ApiResult<String> {
    validate_app_surface_html(html).map_err(|error| match error {
        ApiError::BadRequest(message) if message.contains("app surface") => {
            ApiError::BadRequest(message.replace("app surface", "generated UI"))
        }
        error => error,
    })
}

fn validate_submit_message(message: String) -> ApiResult<String> {
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err(ApiError::BadRequest(
            "generated UI submit message cannot be empty".to_string(),
        ));
    }
    if message.len() > MAX_MESSAGE_BYTES {
        return Err(ApiError::BadRequest(
            "generated UI submit message is too large".to_string(),
        ));
    }
    Ok(message)
}

fn validate_metadata(metadata: &Option<Value>) -> ApiResult<()> {
    let Some(metadata) = metadata else {
        return Ok(());
    };
    let bytes = serde_json::to_vec(metadata)?;
    if bytes.len() > MAX_METADATA_BYTES {
        return Err(ApiError::BadRequest(
            "generated UI submit metadata is too large".to_string(),
        ));
    }
    Ok(())
}

fn url_path_segment(value: &str) -> String {
    value.replace('%', "%25").replace('/', "%2F")
}

impl IntoResponse for GeneratedUiSubmitResponse {
    fn into_response(self) -> Response {
        (StatusCode::OK, Json(self)).into_response()
    }
}
