use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, patch, post},
    Json, Router,
};
use rmcp::schemars;
use serde::{Deserialize, Serialize};
use serde_json::json;
use utoipa::{IntoParams, ToSchema};

use crate::{
    api::AppState,
    app_server_api::{self, ThreadListResponse, ThreadSection, ThreadSectionAppearance},
    error::ApiResult,
    store::NewEvent,
};

pub const THREAD_SECTIONS_UPDATED_EVENT: &str = "thread.sections_updated";

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/thread-sections",
            get(list_thread_sections).post(create_thread_section),
        )
        .route(
            "/v1/thread-sections/{section_id}",
            patch(update_thread_section).delete(delete_thread_section),
        )
        .route(
            "/v1/thread-sections/{section_id}/threads",
            get(list_section_threads),
        )
        .route(
            "/v1/threads/{thread_id}/section",
            post(move_thread_to_section),
        )
}

#[derive(Debug, Deserialize, IntoParams, ToSchema, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSectionListQuery {
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSectionListResponse {
    pub sections: Vec<ThreadSection>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSectionResponse {
    pub section: ThreadSection,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateThreadSectionRequest {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub appearance: Option<ThreadSectionAppearance>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateThreadSectionRequest {
    pub name: String,
    /// Omit to preserve appearance, use null to clear, or provide a replacement.
    #[serde(
        default,
        deserialize_with = "appearance_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub appearance: Option<Option<ThreadSectionAppearance>>,
}

fn appearance_update<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<ThreadSectionAppearance>>, D::Error> {
    Option::<ThreadSectionAppearance>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Serialize, Deserialize, ToSchema, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MoveThreadToSectionRequest {
    #[serde(deserialize_with = "required_nullable_section_id")]
    #[schema(required = true)]
    #[schemars(required, schema_with = "nullable_section_id_schema")]
    pub section_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_thread_id: Option<String>,
}

// Schemars' `required` alone strips Option's null variant. Keep the field
// mandatory while generating its value schema from the actual nullable type.
fn nullable_section_id_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    <Option<String> as schemars::JsonSchema>::json_schema(generator)
}

fn required_nullable_section_id<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}

#[utoipa::path(get, path = "/v1/thread-sections", params(ThreadSectionListQuery), responses((status = 200, body = ThreadSectionListResponse)))]
pub async fn list_thread_sections(
    State(state): State<AppState>,
    Query(query): Query<ThreadSectionListQuery>,
) -> ApiResult<Json<ThreadSectionListResponse>> {
    let page = app_server_api::client(&state.app_server)
        .thread_section_list(query.cursor, query.limit)
        .await?;
    Ok(Json(ThreadSectionListResponse {
        sections: page.data,
        next_cursor: page.next_cursor,
    }))
}

pub(crate) async fn all_thread_sections(state: &AppState) -> ApiResult<Vec<ThreadSection>> {
    let client = app_server_api::client(&state.app_server);
    let mut sections = Vec::new();
    let mut cursor = None;
    loop {
        let page = client.thread_section_list(cursor, Some(100)).await?;
        sections.extend(page.data);
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => return Ok(sections),
        }
    }
}

#[utoipa::path(post, path = "/v1/thread-sections", request_body = CreateThreadSectionRequest, responses((status = 201, body = ThreadSectionResponse)))]
pub async fn create_thread_section(
    State(state): State<AppState>,
    Json(request): Json<CreateThreadSectionRequest>,
) -> ApiResult<(StatusCode, Json<ThreadSectionResponse>)> {
    let section = app_server_api::client(&state.app_server)
        .thread_section_create(serde_json::to_value(request)?)
        .await?;
    broadcast_sections_updated(&state).await?;
    Ok((StatusCode::CREATED, Json(ThreadSectionResponse { section })))
}

#[utoipa::path(patch, path = "/v1/thread-sections/{sectionId}", request_body = UpdateThreadSectionRequest, responses((status = 200, body = ThreadSectionResponse)))]
pub async fn update_thread_section(
    State(state): State<AppState>,
    Path(section_id): Path<String>,
    Json(request): Json<UpdateThreadSectionRequest>,
) -> ApiResult<Json<ThreadSectionResponse>> {
    let section = app_server_api::client(&state.app_server)
        .thread_section_update(section_id, serde_json::to_value(request)?)
        .await?;
    broadcast_sections_updated(&state).await?;
    Ok(Json(ThreadSectionResponse { section }))
}

#[utoipa::path(delete, path = "/v1/thread-sections/{sectionId}", responses((status = 204)))]
pub async fn delete_thread_section(
    State(state): State<AppState>,
    Path(section_id): Path<String>,
) -> ApiResult<StatusCode> {
    app_server_api::client(&state.app_server)
        .thread_section_delete(section_id)
        .await?;
    broadcast_sections_updated(&state).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/section", request_body = MoveThreadToSectionRequest, responses((status = 204)))]
pub async fn move_thread_to_section(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<MoveThreadToSectionRequest>,
) -> ApiResult<StatusCode> {
    app_server_api::client(&state.app_server)
        .thread_move_to_section(thread_id, serde_json::to_value(request)?)
        .await?;
    broadcast_sections_updated(&state).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(get, path = "/v1/thread-sections/{sectionId}/threads", params(ThreadSectionListQuery), responses((status = 200, body = ThreadListResponse)))]
pub async fn list_section_threads(
    State(state): State<AppState>,
    Path(section_id): Path<String>,
    Query(query): Query<ThreadSectionListQuery>,
) -> ApiResult<Json<ThreadListResponse>> {
    Ok(Json(
        section_threads_response(&state, section_id, query.cursor, query.limit).await?,
    ))
}

pub(crate) async fn section_threads_response(
    state: &AppState,
    section_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
) -> ApiResult<ThreadListResponse> {
    let mut response = app_server_api::client(&state.app_server)
        .thread_list_in_section(section_id, cursor, limit)
        .await?;
    super::threads::apply_thread_list_response_state(state, &mut response).await?;
    Ok(response)
}

async fn broadcast_sections_updated(state: &AppState) -> ApiResult<()> {
    // Native 0.160.0 exposes no section notification. This marker carries no
    // membership or order: every client refills from native reads.
    let event = state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: None,
            turn_id: None,
            item_id: None,
            kind: THREAD_SECTIONS_UPDATED_EVENT.into(),
            codex_method: None,
            payload: json!({}),
        })
        .await?;
    let _ = state.events.send(event);
    Ok(())
}
