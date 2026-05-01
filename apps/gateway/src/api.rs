use std::{convert::Infallible, path::PathBuf, sync::Arc};

use async_stream::stream;
use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use futures_core::Stream;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc};
use tower_http::{
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use utoipa::{IntoParams, OpenApi, ToSchema};
use utoipa_swagger_ui::SwaggerUi;

use crate::{
    app_server::{DynAppServer, InboundMessage},
    config::Config,
    error::{ApiError, ApiErrorBody, ApiResult},
    schema::{is_supported_approval_method, validate_approval_response},
    store::{Approval, EventEnvelope, NewApproval, NewEvent, Project, Store},
};

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub store: Store,
    pub app_server: DynAppServer,
    pub events: broadcast::Sender<EventEnvelope>,
}

impl AppState {
    pub fn new(config: Config, store: Store, app_server: DynAppServer) -> Self {
        let (events, _) = broadcast::channel(1024);
        Self {
            config: Arc::new(config),
            store,
            app_server,
            events,
        }
    }
}

#[derive(OpenApi)]
#[openapi(
    paths(
        healthz,
        readyz,
        capabilities,
        events,
        list_projects,
        create_project,
        get_project,
        list_threads,
        create_thread,
        get_thread,
        resume_thread,
        fork_thread,
        archive_thread,
        start_turn,
        steer_turn,
        interrupt_turn,
        list_approvals,
        get_approval,
        decide_approval,
        read_account,
        start_login,
        cancel_login,
        logout,
        read_rate_limits,
        list_models
    ),
    components(schemas(
        ApiErrorBody,
        HealthResponse,
        ReadyResponse,
        CapabilitiesResponse,
        GatewayCapabilities,
        AppServerCapabilities,
        EventEnvelope,
        EventListResponse,
        Project,
        ProjectListResponse,
        CreateProjectRequest,
        RawAppServerResponse,
        ThreadListQuery,
        CreateThreadRequest,
        TurnStartRequest,
        TurnSteerRequest,
        Approval,
        ApprovalListResponse,
        ApprovalDecisionRequest,
        AccountQuery,
        LoginRequest,
        ModelsQuery
    ))
)]
pub struct ApiDoc;

pub fn build_router(state: AppState) -> Router {
    let mut router = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/v1/capabilities", get(capabilities))
        .route("/v1/events", get(events))
        .route("/v1/projects", get(list_projects).post(create_project))
        .route("/v1/projects/{project_id}", get(get_project))
        .route("/v1/threads", get(list_threads).post(create_thread))
        .route("/v1/threads/{thread_id}", get(get_thread))
        .route("/v1/threads/{thread_id}/resume", post(resume_thread))
        .route("/v1/threads/{thread_id}/fork", post(fork_thread))
        .route("/v1/threads/{thread_id}/archive", post(archive_thread))
        .route("/v1/threads/{thread_id}/turns", post(start_turn))
        .route(
            "/v1/threads/{thread_id}/turns/{turn_id}/steer",
            post(steer_turn),
        )
        .route(
            "/v1/threads/{thread_id}/turns/{turn_id}/interrupt",
            post(interrupt_turn),
        )
        .route("/v1/approvals", get(list_approvals))
        .route("/v1/approvals/{approval_id}", get(get_approval))
        .route(
            "/v1/approvals/{approval_id}/decision",
            post(decide_approval),
        )
        .route("/v1/account", get(read_account))
        .route("/v1/account/login", post(start_login))
        .route("/v1/account/login/{login_id}/cancel", post(cancel_login))
        .route("/v1/account/logout", post(logout))
        .route("/v1/account/rate-limits", get(read_rate_limits))
        .route("/v1/models", get(list_models))
        .merge(SwaggerUi::new("/docs").url("/openapi.json", ApiDoc::openapi()))
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(state.clone());

    if let Some(dist_dir) = state.config.frontend.dist_dir.clone() {
        router = attach_frontend(router, dist_dir);
    }

    router
}

fn attach_frontend(router: Router, dist_dir: PathBuf) -> Router {
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

pub async fn run_inbound_ingest(mut inbound: mpsc::Receiver<InboundMessage>, state: AppState) {
    while let Some(message) = inbound.recv().await {
        if let Err(error) = ingest_inbound(message, &state).await {
            tracing::warn!(%error, "failed to ingest app-server message");
        }
    }
}

async fn ingest_inbound(message: InboundMessage, state: &AppState) -> ApiResult<()> {
    match message {
        InboundMessage::Notification { method, params } => {
            let metadata = EventMetadata::from_payload(&params);
            let event = state
                .store
                .append_event(NewEvent {
                    project_id: metadata.project_id,
                    thread_id: metadata.thread_id,
                    turn_id: metadata.turn_id,
                    item_id: metadata.item_id,
                    kind: "codex.notification".to_string(),
                    codex_method: Some(method),
                    payload: params,
                })
                .await?;
            let _ = state.events.send(event);
        }
        InboundMessage::ServerRequest {
            request_id,
            method,
            params,
        } => {
            let metadata = EventMetadata::from_payload(&params);
            let server_request_event = state
                .store
                .append_event(NewEvent {
                    project_id: metadata.project_id.clone(),
                    thread_id: metadata.thread_id.clone(),
                    turn_id: metadata.turn_id.clone(),
                    item_id: metadata.item_id.clone(),
                    kind: "codex.server_request".to_string(),
                    codex_method: Some(method.clone()),
                    payload: json!({
                        "requestId": request_id,
                        "method": method,
                        "params": params,
                    }),
                })
                .await?;
            let _ = state.events.send(server_request_event);

            if !is_supported_approval_method(&method) {
                let warning = state
                    .store
                    .append_event(NewEvent {
                        project_id: metadata.project_id,
                        thread_id: metadata.thread_id,
                        turn_id: metadata.turn_id,
                        item_id: metadata.item_id,
                        kind: "gateway.warning".to_string(),
                        codex_method: Some(method),
                        payload: json!({"message": "unsupported app-server server request"}),
                    })
                    .await?;
                let _ = state.events.send(warning);
                return Ok(());
            }

            let approval = state
                .store
                .insert_approval(NewApproval {
                    request_id,
                    thread_id: metadata.thread_id.clone(),
                    turn_id: metadata.turn_id.clone(),
                    item_id: metadata.item_id.clone(),
                    method: method.clone(),
                    payload: params,
                })
                .await?;
            let event = state
                .store
                .append_event(NewEvent {
                    project_id: metadata.project_id,
                    thread_id: metadata.thread_id,
                    turn_id: metadata.turn_id,
                    item_id: metadata.item_id,
                    kind: "approval.created".to_string(),
                    codex_method: Some(method),
                    payload: serde_json::to_value(&approval)?,
                })
                .await?;
            let _ = state.events.send(event);
        }
    }
    Ok(())
}

#[derive(Debug, Default)]
struct EventMetadata {
    project_id: Option<String>,
    thread_id: Option<String>,
    turn_id: Option<String>,
    item_id: Option<String>,
}

impl EventMetadata {
    fn from_payload(payload: &Value) -> Self {
        Self {
            project_id: string_field(payload, &["projectId", "project_id"]),
            thread_id: string_field(payload, &["threadId", "thread_id"]),
            turn_id: string_field(payload, &["turnId", "turn_id"])
                .or_else(|| nested_string_field(payload, "turn", &["id", "turnId", "turn_id"])),
            item_id: string_field(payload, &["itemId", "item_id"])
                .or_else(|| nested_string_field(payload, "item", &["id", "itemId", "item_id"])),
        }
    }
}

fn string_field(payload: &Value, names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| payload.get(*name).and_then(Value::as_str))
        .map(str::to_string)
}

fn nested_string_field(payload: &Value, parent: &str, names: &[&str]) -> Option<String> {
    payload
        .get(parent)
        .and_then(|value| string_field(value, names))
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct HealthResponse {
    pub status: String,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReadyResponse {
    pub ready: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitiesResponse {
    pub gateway: GatewayCapabilities,
    pub app_server: AppServerCapabilities,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GatewayCapabilities {
    pub version: String,
    pub sse: bool,
    pub approvals: bool,
    pub gateway_auth: bool,
    pub trusted_network_only: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppServerCapabilities {
    pub ready: bool,
    pub experimental_api: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct EventListResponse {
    pub events: Vec<EventEnvelope>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectListResponse {
    pub projects: Vec<Project>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectRequest {
    pub name: Option<String>,
    pub cwd: String,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RawAppServerResponse {
    pub payload: Value,
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct EventsQuery {
    pub cursor: Option<i64>,
    pub project_id: Option<String>,
    pub thread_id: Option<String>,
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListQuery {
    pub project_id: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateThreadRequest {
    pub project_id: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartRequest {
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnSteerRequest {
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalListQuery {
    pub status: Option<String>,
    pub thread_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalListResponse {
    pub approvals: Vec<Approval>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalDecisionRequest {
    pub decision: Value,
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccountQuery {
    #[serde(default)]
    pub refresh_token: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelsQuery {
    #[serde(default)]
    pub include_hidden: bool,
}

#[utoipa::path(get, path = "/healthz", responses((status = 200, body = HealthResponse)))]
async fn healthz() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
    })
}

#[utoipa::path(get, path = "/readyz", responses((status = 200, body = ReadyResponse)))]
async fn readyz(State(state): State<AppState>) -> Json<ReadyResponse> {
    Json(ReadyResponse {
        ready: state.app_server.is_ready(),
    })
}

#[utoipa::path(get, path = "/v1/capabilities", responses((status = 200, body = CapabilitiesResponse)))]
async fn capabilities(State(state): State<AppState>) -> Json<CapabilitiesResponse> {
    Json(CapabilitiesResponse {
        gateway: GatewayCapabilities {
            version: env!("CARGO_PKG_VERSION").to_string(),
            sse: true,
            approvals: true,
            gateway_auth: false,
            trusted_network_only: state.config.server.trusted_network_only,
        },
        app_server: AppServerCapabilities {
            ready: state.app_server.is_ready(),
            experimental_api: true,
        },
    })
}

#[utoipa::path(get, path = "/v1/events", params(EventsQuery), responses((status = 200, body = EventListResponse)))]
async fn events(
    headers: HeaderMap,
    State(state): State<AppState>,
    Query(query): Query<EventsQuery>,
) -> ApiResult<Response> {
    if wants_sse(&headers) {
        let stream = event_stream(state, query).await?;
        Ok(Sse::new(stream)
            .keep_alive(KeepAlive::default())
            .into_response())
    } else {
        let events = state
            .store
            .replay_events(query.cursor, query.project_id, query.thread_id)
            .await?;
        Ok(Json(EventListResponse { events }).into_response())
    }
}

fn wants_sse(headers: &HeaderMap) -> bool {
    headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|accept| accept.contains("text/event-stream"))
}

async fn event_stream(
    state: AppState,
    query: EventsQuery,
) -> ApiResult<impl Stream<Item = Result<Event, Infallible>>> {
    let replay = state
        .store
        .replay_events(
            query.cursor,
            query.project_id.clone(),
            query.thread_id.clone(),
        )
        .await?;
    let mut receiver = state.events.subscribe();

    Ok(stream! {
        for event in replay {
            if let Ok(sse_event) = event_to_sse(event) {
                yield Ok(sse_event);
            }
        }

        loop {
            match receiver.recv().await {
                Ok(event) if event_matches(&event, &query) => {
                    if let Ok(sse_event) = event_to_sse(event) {
                        yield Ok(sse_event);
                    }
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    })
}

fn event_matches(event: &EventEnvelope, query: &EventsQuery) -> bool {
    query
        .project_id
        .as_ref()
        .is_none_or(|project_id| event.project_id.as_ref() == Some(project_id))
        && query
            .thread_id
            .as_ref()
            .is_none_or(|thread_id| event.thread_id.as_ref() == Some(thread_id))
}

fn event_to_sse(event: EventEnvelope) -> Result<Event, axum::Error> {
    Event::default()
        .id(event.seq.to_string())
        .event(event.kind.clone())
        .json_data(event)
}

#[utoipa::path(get, path = "/v1/projects", responses((status = 200, body = ProjectListResponse)))]
async fn list_projects(State(state): State<AppState>) -> ApiResult<Json<ProjectListResponse>> {
    let projects = state.store.list_projects().await?;
    Ok(Json(ProjectListResponse { projects }))
}

#[utoipa::path(post, path = "/v1/projects", request_body = CreateProjectRequest, responses((status = 201, body = Project)))]
async fn create_project(
    State(state): State<AppState>,
    Json(request): Json<CreateProjectRequest>,
) -> ApiResult<(StatusCode, Json<Project>)> {
    if request.cwd.trim().is_empty() {
        return Err(ApiError::BadRequest("cwd is required".to_string()));
    }

    let cwd = std::fs::canonicalize(&request.cwd)
        .map_err(|_| ApiError::BadRequest("cwd must exist".to_string()))?;
    if !cwd.is_absolute() || !cwd.is_dir() {
        return Err(ApiError::BadRequest(
            "cwd must be an absolute directory".to_string(),
        ));
    }

    let name = request.name.unwrap_or_else(|| {
        cwd.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Project")
            .to_string()
    });
    let project = state
        .store
        .create_project(name, cwd.to_string_lossy().to_string())
        .await?;
    Ok((StatusCode::CREATED, Json(project)))
}

#[utoipa::path(get, path = "/v1/projects/{projectId}", responses((status = 200, body = Project)))]
async fn get_project(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> ApiResult<Json<Project>> {
    Ok(Json(state.store.get_project(&project_id).await?))
}

#[utoipa::path(get, path = "/v1/threads", params(ThreadListQuery), responses((status = 200, body = RawAppServerResponse)))]
async fn list_threads(
    State(state): State<AppState>,
    Query(query): Query<ThreadListQuery>,
) -> ApiResult<Json<RawAppServerResponse>> {
    let cwd = match query.project_id {
        Some(project_id) => Some(state.store.get_project(&project_id).await?.cwd),
        None => None,
    };

    app_request(
        &state,
        "thread/list",
        json!({
            "cursor": query.cursor,
            "limit": query.limit,
            "cwd": cwd,
        }),
    )
    .await
}

#[utoipa::path(post, path = "/v1/threads", request_body = CreateThreadRequest, responses((status = 200, body = RawAppServerResponse)))]
async fn create_thread(
    State(state): State<AppState>,
    Json(request): Json<CreateThreadRequest>,
) -> ApiResult<Json<RawAppServerResponse>> {
    let project = state.store.get_project(&request.project_id).await?;
    let payload = merge_path_payload("projectId", project.id, request.payload);
    let payload = merge_path_payload("cwd", project.cwd, payload);
    app_request(&state, "thread/start", payload).await
}

#[utoipa::path(get, path = "/v1/threads/{threadId}", responses((status = 200, body = RawAppServerResponse)))]
async fn get_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> ApiResult<Json<RawAppServerResponse>> {
    app_request(&state, "thread/read", json!({ "threadId": thread_id })).await
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/resume", responses((status = 200, body = RawAppServerResponse)))]
async fn resume_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(payload): Json<Value>,
) -> ApiResult<Json<RawAppServerResponse>> {
    app_request(
        &state,
        "thread/resume",
        merge_path_payload("threadId", thread_id, payload),
    )
    .await
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/fork", responses((status = 200, body = RawAppServerResponse)))]
async fn fork_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(payload): Json<Value>,
) -> ApiResult<Json<RawAppServerResponse>> {
    app_request(
        &state,
        "thread/fork",
        merge_path_payload("threadId", thread_id, payload),
    )
    .await
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/archive", responses((status = 200, body = RawAppServerResponse)))]
async fn archive_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> ApiResult<Json<RawAppServerResponse>> {
    app_request(&state, "thread/archive", json!({ "threadId": thread_id })).await
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/turns", request_body = TurnStartRequest, responses((status = 200, body = RawAppServerResponse)))]
async fn start_turn(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<TurnStartRequest>,
) -> ApiResult<Json<RawAppServerResponse>> {
    app_request(
        &state,
        "turn/start",
        merge_path_payload("threadId", thread_id, request.payload),
    )
    .await
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/turns/{turnId}/steer", request_body = TurnSteerRequest, responses((status = 200, body = RawAppServerResponse)))]
async fn steer_turn(
    State(state): State<AppState>,
    Path((thread_id, turn_id)): Path<(String, String)>,
    Json(request): Json<TurnSteerRequest>,
) -> ApiResult<Json<RawAppServerResponse>> {
    let payload = merge_path_payload("threadId", thread_id, request.payload);
    app_request(
        &state,
        "turn/steer",
        merge_path_payload("turnId", turn_id, payload),
    )
    .await
}

#[utoipa::path(post, path = "/v1/threads/{threadId}/turns/{turnId}/interrupt", responses((status = 200, body = RawAppServerResponse)))]
async fn interrupt_turn(
    State(state): State<AppState>,
    Path((thread_id, turn_id)): Path<(String, String)>,
) -> ApiResult<Json<RawAppServerResponse>> {
    app_request(
        &state,
        "turn/interrupt",
        json!({ "threadId": thread_id, "turnId": turn_id }),
    )
    .await
}

#[utoipa::path(get, path = "/v1/approvals", params(ApprovalListQuery), responses((status = 200, body = ApprovalListResponse)))]
async fn list_approvals(
    State(state): State<AppState>,
    Query(query): Query<ApprovalListQuery>,
) -> ApiResult<Json<ApprovalListResponse>> {
    let approvals = state
        .store
        .list_approvals(query.status, query.thread_id)
        .await?;
    Ok(Json(ApprovalListResponse { approvals }))
}

#[utoipa::path(get, path = "/v1/approvals/{approvalId}", responses((status = 200, body = Approval)))]
async fn get_approval(
    State(state): State<AppState>,
    Path(approval_id): Path<String>,
) -> ApiResult<Json<Approval>> {
    Ok(Json(state.store.get_approval(&approval_id).await?))
}

#[utoipa::path(post, path = "/v1/approvals/{approvalId}/decision", request_body = ApprovalDecisionRequest, responses((status = 200, body = Approval)))]
async fn decide_approval(
    State(state): State<AppState>,
    Path(approval_id): Path<String>,
    Json(request): Json<ApprovalDecisionRequest>,
) -> ApiResult<Json<Approval>> {
    let approval = state.store.get_approval(&approval_id).await?;
    if approval.status != "pending" {
        return Err(ApiError::BadRequest(format!(
            "approval {approval_id} is not pending"
        )));
    }
    validate_approval_response(&approval.method, &request.decision)?;

    state
        .app_server
        .respond(&approval.request_id, request.decision.clone())
        .await?;
    let resolved = state
        .store
        .resolve_approval(&approval_id, request.decision)
        .await?;
    let event = state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: resolved.thread_id.clone(),
            turn_id: resolved.turn_id.clone(),
            item_id: resolved.item_id.clone(),
            kind: "approval.resolved".to_string(),
            codex_method: Some(resolved.method.clone()),
            payload: serde_json::to_value(&resolved)?,
        })
        .await?;
    let _ = state.events.send(event);
    Ok(Json(resolved))
}

#[utoipa::path(get, path = "/v1/account", params(AccountQuery), responses((status = 200, body = RawAppServerResponse)))]
async fn read_account(
    State(state): State<AppState>,
    Query(query): Query<AccountQuery>,
) -> ApiResult<Json<RawAppServerResponse>> {
    app_request(
        &state,
        "account/read",
        json!({ "refreshToken": query.refresh_token }),
    )
    .await
}

#[utoipa::path(post, path = "/v1/account/login", request_body = LoginRequest, responses((status = 200, body = RawAppServerResponse)))]
async fn start_login(
    State(state): State<AppState>,
    Json(request): Json<LoginRequest>,
) -> ApiResult<Json<RawAppServerResponse>> {
    app_request(&state, "account/login/start", request.payload).await
}

#[utoipa::path(post, path = "/v1/account/login/{loginId}/cancel", responses((status = 200, body = RawAppServerResponse)))]
async fn cancel_login(
    State(state): State<AppState>,
    Path(login_id): Path<String>,
) -> ApiResult<Json<RawAppServerResponse>> {
    app_request(
        &state,
        "account/login/cancel",
        json!({ "loginId": login_id }),
    )
    .await
}

#[utoipa::path(post, path = "/v1/account/logout", responses((status = 200, body = RawAppServerResponse)))]
async fn logout(State(state): State<AppState>) -> ApiResult<Json<RawAppServerResponse>> {
    app_request(&state, "account/logout", Value::Null).await
}

#[utoipa::path(get, path = "/v1/account/rate-limits", responses((status = 200, body = RawAppServerResponse)))]
async fn read_rate_limits(State(state): State<AppState>) -> ApiResult<Json<RawAppServerResponse>> {
    app_request(&state, "account/rateLimits/read", Value::Null).await
}

#[utoipa::path(get, path = "/v1/models", params(ModelsQuery), responses((status = 200, body = RawAppServerResponse)))]
async fn list_models(
    State(state): State<AppState>,
    Query(query): Query<ModelsQuery>,
) -> ApiResult<Json<RawAppServerResponse>> {
    app_request(
        &state,
        "model/list",
        json!({ "includeHidden": query.include_hidden }),
    )
    .await
}

async fn app_request(
    state: &AppState,
    method: &str,
    params: Value,
) -> ApiResult<Json<RawAppServerResponse>> {
    let payload = state.app_server.request(method, params).await?;
    Ok(Json(RawAppServerResponse { payload }))
}

fn merge_path_payload(field: &str, value: String, payload: Value) -> Value {
    let mut payload = match payload {
        Value::Object(map) => Value::Object(map),
        other => json!({ "payload": other }),
    };
    payload[field] = Value::String(value);
    payload
}

#[cfg(test)]
mod tests {
    use std::sync::{atomic::Ordering, Arc};

    use async_trait::async_trait;
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
    };
    use http_body_util::BodyExt;
    use serde_json::json;
    use tempfile::tempdir;
    use tokio::time::{timeout, Duration};
    use tower::ServiceExt;

    use crate::{
        app_server::{tests::RecordingAppServer, AppServer},
        config::Config,
    };

    use super::*;

    async fn test_state() -> (AppState, Arc<RecordingAppServer>) {
        let store = Store::in_memory().await.unwrap();
        let app_server = Arc::new(RecordingAppServer::default());
        app_server.ready.store(true, Ordering::SeqCst);
        (
            AppState::new(Config::default(), store, app_server.clone()),
            app_server,
        )
    }

    #[tokio::test]
    async fn health_and_openapi_routes_exist() {
        let (state, _) = test_state().await;
        let app = build_router(state);

        let health = app
            .clone()
            .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);

        let openapi = app
            .oneshot(Request::get("/openapi.json").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(openapi.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn shell_routes_report_readiness_capabilities_docs_and_openapi_paths() {
        let (state, app_server) = test_state().await;
        app_server.ready.store(false, Ordering::SeqCst);
        let app = build_router(state);

        let ready = app
            .clone()
            .oneshot(Request::get("/readyz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(ready.status(), StatusCode::OK);
        let ready_body = response_json(ready).await;
        assert_eq!(ready_body["ready"], false);

        let capabilities = app
            .clone()
            .oneshot(
                Request::get("/v1/capabilities")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(capabilities.status(), StatusCode::OK);
        let capabilities_body = response_json(capabilities).await;
        assert_eq!(capabilities_body["gateway"]["sse"], true);
        assert_eq!(capabilities_body["appServer"]["ready"], false);

        let docs = app
            .clone()
            .oneshot(Request::get("/docs").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(docs.status().is_success() || docs.status().is_redirection());

        let openapi = app
            .oneshot(Request::get("/openapi.json").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let openapi = response_json(openapi).await;
        for path in [
            "/healthz",
            "/readyz",
            "/v1/capabilities",
            "/v1/events",
            "/v1/projects",
            "/v1/projects/{projectId}",
            "/v1/threads",
            "/v1/threads/{threadId}",
            "/v1/threads/{threadId}/resume",
            "/v1/threads/{threadId}/fork",
            "/v1/threads/{threadId}/archive",
            "/v1/account",
            "/v1/account/login",
            "/v1/account/login/{loginId}/cancel",
            "/v1/account/logout",
            "/v1/account/rate-limits",
            "/v1/models",
        ] {
            assert!(openapi["paths"].get(path).is_some(), "missing {path}");
        }
    }

    #[tokio::test]
    async fn project_create_rejects_relative_cwd() {
        let (state, _) = test_state().await;
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/projects")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"cwd":"relative"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn project_routes_create_list_get_and_reject_missing_cwd() {
        let (state, _) = test_state().await;
        let cwd = std::env::current_dir().unwrap().display().to_string();
        let app = build_router(state);

        let missing = app
            .clone()
            .oneshot(
                Request::post("/v1/projects")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(!missing.status().is_success());

        let created = app
            .clone()
            .oneshot(
                Request::post("/v1/projects")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"name": "Kodex", "cwd": cwd}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::CREATED);
        let project = response_json(created).await;
        let project_id = project["id"].as_str().unwrap();

        let listed = app
            .clone()
            .oneshot(Request::get("/v1/projects").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let listed = response_json(listed).await;
        assert_eq!(listed["projects"][0]["id"], project_id);

        let fetched = app
            .oneshot(
                Request::get(format!("/v1/projects/{project_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let fetched = response_json(fetched).await;
        assert_eq!(fetched["id"], project_id);
    }

    #[tokio::test]
    async fn thread_start_maps_to_app_server() {
        let (state, app_server) = test_state().await;
        let project = state
            .store
            .create_project(
                "Kodex".to_string(),
                std::env::current_dir().unwrap().display().to_string(),
            )
            .await
            .unwrap();
        let app = build_router(state);

        let body = json!({"projectId": project.id, "payload": {"prompt": "hi"}}).to_string();
        let response = app
            .oneshot(
                Request::post("/v1/threads")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/start");
        assert!(requests[0].1.get("cwd").is_some());
    }

    #[tokio::test]
    async fn thread_list_project_filter_maps_to_cwd() {
        let (state, app_server) = test_state().await;
        let cwd = std::env::current_dir().unwrap().display().to_string();
        let project = state
            .store
            .create_project("Kodex".to_string(), cwd.clone())
            .await
            .unwrap();
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::get(format!("/v1/threads?projectId={}", project.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/list");
        assert_eq!(requests[0].1["cwd"], cwd);
    }

    #[tokio::test]
    async fn thread_routes_map_read_resume_fork_and_archive() {
        let (state, app_server) = test_state().await;
        let app = build_router(state);

        assert_ok(
            app.clone()
                .oneshot(
                    Request::get("/v1/threads/thread-1")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/threads/thread-1/resume")
                        .header("content-type", "application/json")
                        .body(Body::from(r#"{"target":"latest"}"#))
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/threads/thread-1/fork")
                        .header("content-type", "application/json")
                        .body(Body::from(r#"{"fromItemId":"item-1"}"#))
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.oneshot(
                Request::post("/v1/threads/thread-1/archive")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
        );

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/read");
        assert_eq!(requests[0].1["threadId"], "thread-1");
        assert_eq!(requests[1].0, "thread/resume");
        assert_eq!(requests[1].1["threadId"], "thread-1");
        assert_eq!(requests[2].0, "thread/fork");
        assert_eq!(requests[2].1["threadId"], "thread-1");
        assert_eq!(requests[3].0, "thread/archive");
        assert_eq!(requests[3].1["threadId"], "thread-1");
    }

    #[tokio::test]
    async fn thread_start_requires_stored_project_before_app_server_call() {
        let (state, app_server) = test_state().await;
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/threads")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"projectId":"missing","payload":{"prompt":"hi"}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(app_server.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn turn_routes_map_start_steer_and_interrupt() {
        let (state, app_server) = test_state().await;
        let app = build_router(state);

        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/threads/thread-1/turns")
                        .header("content-type", "application/json")
                        .body(Body::from(r#"{"payload":{"prompt":"hi"}}"#))
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/threads/thread-1/turns/turn-1/steer")
                        .header("content-type", "application/json")
                        .body(Body::from(r#"{"payload":{"message":"continue"}}"#))
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.oneshot(
                Request::post("/v1/threads/thread-1/turns/turn-1/interrupt")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
        );

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "turn/start");
        assert_eq!(requests[0].1["threadId"], "thread-1");
        assert_eq!(requests[1].0, "turn/steer");
        assert_eq!(requests[1].1["threadId"], "thread-1");
        assert_eq!(requests[1].1["turnId"], "turn-1");
        assert_eq!(requests[2].0, "turn/interrupt");
        assert_eq!(
            requests[2].1,
            json!({"threadId": "thread-1", "turnId": "turn-1"})
        );
    }

    #[tokio::test]
    async fn turn_and_item_notifications_extract_metadata_and_persist_before_broadcast() {
        let (state, _) = test_state().await;
        let mut receiver = state.events.subscribe();

        ingest_inbound(
            InboundMessage::Notification {
                method: "item/agentMessage/delta".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-1",
                    "delta": "hello"
                }),
            },
            &state,
        )
        .await
        .unwrap();
        ingest_inbound(
            InboundMessage::Notification {
                method: "turn/completed".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turn": {"id": "turn-2"}
                }),
            },
            &state,
        )
        .await
        .unwrap();

        let first_broadcast = receiver.recv().await.unwrap();
        let persisted = state
            .store
            .replay_events(Some(first_broadcast.seq - 1), None, None)
            .await
            .unwrap();
        assert_eq!(persisted[0].id, first_broadcast.id);
        assert_eq!(persisted[0].thread_id.as_deref(), Some("thread-1"));
        assert_eq!(persisted[0].turn_id.as_deref(), Some("turn-1"));
        assert_eq!(persisted[0].item_id.as_deref(), Some("item-1"));

        let second_broadcast = receiver.recv().await.unwrap();
        assert_eq!(
            second_broadcast.codex_method.as_deref(),
            Some("turn/completed")
        );
        assert_eq!(second_broadcast.turn_id.as_deref(), Some("turn-2"));
    }

    #[tokio::test]
    async fn app_server_overload_maps_to_retryable_error_response() {
        let store = Store::in_memory().await.unwrap();
        let app_server = Arc::new(RetryableAppServer);
        let state = AppState::new(Config::default(), store, app_server);
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/turns")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"payload":{"prompt":"hi"}}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        let body = response_json(response).await;
        assert_eq!(body["code"], "app_server_retryable");
        assert_eq!(body["retryable"], true);
    }

    #[tokio::test]
    async fn approval_broker_creates_pending_approvals_for_supported_methods() {
        let (state, _) = test_state().await;
        for method in [
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
            "item/permissions/requestApproval",
            "mcpServer/elicitation/request",
            "item/tool/requestUserInput",
        ] {
            ingest_inbound(
                InboundMessage::ServerRequest {
                    request_id: format!("\"{method}\""),
                    method: method.to_string(),
                    params: json!({
                        "threadId": "thread-1",
                        "turnId": "turn-1",
                        "itemId": "item-1"
                    }),
                },
                &state,
            )
            .await
            .unwrap();
        }

        let approvals = state
            .store
            .list_approvals(Some("pending".to_string()), Some("thread-1".to_string()))
            .await
            .unwrap();
        assert_eq!(approvals.len(), 5);

        let events = state.store.replay_events(None, None, None).await.unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == "codex.server_request")
                .count(),
            5
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == "approval.created")
                .count(),
            5
        );
    }

    #[tokio::test]
    async fn unsupported_server_request_emits_warning_without_approval() {
        let (state, _) = test_state().await;
        ingest_inbound(
            InboundMessage::ServerRequest {
                request_id: "\"unsupported\"".to_string(),
                method: "unknown/request".to_string(),
                params: json!({"threadId": "thread-1"}),
            },
            &state,
        )
        .await
        .unwrap();

        assert!(state
            .store
            .list_approvals(None, None)
            .await
            .unwrap()
            .is_empty());
        let events = state.store.replay_events(None, None, None).await.unwrap();
        assert_eq!(events[0].kind, "codex.server_request");
        assert_eq!(events[1].kind, "gateway.warning");
    }

    #[tokio::test]
    async fn approval_decision_sends_one_response_and_emits_resolved_event() {
        let (state, app_server) = test_state().await;
        let approval = state
            .store
            .insert_approval(NewApproval {
                request_id: "\"approval-1\"".to_string(),
                thread_id: Some("thread-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("item-1".to_string()),
                method: "item/commandExecution/requestApproval".to_string(),
                payload: json!({"threadId": "thread-1"}),
            })
            .await
            .unwrap();
        let app = build_router(state.clone());

        let response = app
            .clone()
            .oneshot(
                Request::post(format!("/v1/approvals/{}/decision", approval.id))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"decision":{"decision":"accept"}}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(app_server.responses.lock().unwrap().len(), 1);

        let duplicate = app
            .clone()
            .oneshot(
                Request::post(format!("/v1/approvals/{}/decision", approval.id))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"decision":{"decision":"accept"}}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(duplicate.status(), StatusCode::BAD_REQUEST);
        assert_eq!(app_server.responses.lock().unwrap().len(), 1);

        let unknown = app
            .oneshot(
                Request::post("/v1/approvals/missing/decision")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"decision":{"decision":"accept"}}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unknown.status(), StatusCode::NOT_FOUND);

        let resolved_events = state
            .store
            .replay_events(None, None, Some("thread-1".to_string()))
            .await
            .unwrap()
            .into_iter()
            .filter(|event| event.kind == "approval.resolved")
            .collect::<Vec<_>>();
        assert_eq!(resolved_events.len(), 1);
    }

    #[tokio::test]
    async fn approval_decision_validates_payload_before_responding() {
        let (state, app_server) = test_state().await;
        let approval = state
            .store
            .insert_approval(NewApproval {
                request_id: "\"approval-1\"".to_string(),
                thread_id: Some("thread-1".to_string()),
                turn_id: None,
                item_id: None,
                method: "item/commandExecution/requestApproval".to_string(),
                payload: json!({"threadId": "thread-1"}),
            })
            .await
            .unwrap();
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post(format!("/v1/approvals/{}/decision", approval.id))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"decision":{"decision":"bogus"}}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(app_server.responses.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn account_and_model_routes_map_to_app_server_methods() {
        let (state, app_server) = test_state().await;
        let app = build_router(state);

        assert_ok(
            app.clone()
                .oneshot(
                    Request::get("/v1/account?refreshToken=true")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/account/login")
                        .header("content-type", "application/json")
                        .body(Body::from(r#"{"payload":{"provider":"chatgpt"}}"#))
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/account/login/login-1/cancel")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/account/logout")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.clone()
                .oneshot(
                    Request::get("/v1/account/rate-limits")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.oneshot(
                Request::get("/v1/models?includeHidden=true")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
        );

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "account/read");
        assert_eq!(requests[0].1, json!({"refreshToken": true}));
        assert_eq!(requests[1].0, "account/login/start");
        assert_eq!(requests[1].1, json!({"provider": "chatgpt"}));
        assert_eq!(requests[2].0, "account/login/cancel");
        assert_eq!(requests[2].1, json!({"loginId": "login-1"}));
        assert_eq!(requests[3].0, "account/logout");
        assert_eq!(requests[3].1, Value::Null);
        assert_eq!(requests[4].0, "account/rateLimits/read");
        assert_eq!(requests[4].1, Value::Null);
        assert_eq!(requests[5].0, "model/list");
        assert_eq!(requests[5].1, json!({"includeHidden": true}));
    }

    #[tokio::test]
    async fn account_notifications_flow_through_event_stream() {
        let (state, _) = test_state().await;
        for method in [
            "account/login/completed",
            "account/updated",
            "account/rateLimits/updated",
        ] {
            ingest_inbound(
                InboundMessage::Notification {
                    method: method.to_string(),
                    params: json!({"accountId": "acct-1"}),
                },
                &state,
            )
            .await
            .unwrap();
        }

        let methods = state
            .store
            .replay_events(None, None, None)
            .await
            .unwrap()
            .into_iter()
            .map(|event| event.codex_method.unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            methods,
            vec![
                "account/login/completed",
                "account/updated",
                "account/rateLimits/updated"
            ]
        );
    }

    #[tokio::test]
    async fn frontend_static_serving_returns_index_and_api_routes_win() {
        let (mut state, _) = test_state().await;
        let dist = tempdir().unwrap();
        std::fs::write(
            dist.path().join("index.html"),
            "<!doctype html><title>Kodex UI</title><main>Kodex UI</main>",
        )
        .unwrap();
        state.config = Arc::new(Config {
            frontend: crate::config::FrontendConfig {
                dist_dir: Some(dist.path().to_path_buf()),
            },
            ..Config::default()
        });
        let app = build_router(state);

        let root = app
            .clone()
            .oneshot(Request::get("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(root.status(), StatusCode::OK);
        assert!(response_text(root).await.contains("Kodex UI"));

        let fallback = app
            .clone()
            .oneshot(
                Request::get("/threads/thread-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(fallback.status(), StatusCode::OK);
        assert!(response_text(fallback).await.contains("Kodex UI"));

        let health = app
            .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);
        assert_eq!(response_json(health).await["status"], "ok");
    }

    #[tokio::test]
    async fn missing_frontend_build_keeps_api_only_development_working() {
        let (mut state, _) = test_state().await;
        let dist = tempdir().unwrap();
        state.config = Arc::new(Config {
            frontend: crate::config::FrontendConfig {
                dist_dir: Some(dist.path().join("missing")),
            },
            ..Config::default()
        });
        let app = build_router(state);

        let health = app
            .clone()
            .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);

        let fallback = app
            .oneshot(Request::get("/not-an-api").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(fallback.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn event_replay_returns_persisted_events() {
        let (state, _) = test_state().await;
        state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("t1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "codex.notification".to_string(),
                codex_method: Some("turn/completed".to_string()),
                payload: json!({"threadId": "t1"}),
            })
            .await
            .unwrap();
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::get("/v1/events?threadId=t1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["events"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn sse_replays_persisted_events_before_live_events() {
        let (state, _) = test_state().await;
        let replay = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("t1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "codex.notification".to_string(),
                codex_method: Some("turn/completed".to_string()),
                payload: json!({"threadId": "t1", "phase": "replay"}),
            })
            .await
            .unwrap();
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::get("/v1/events?threadId=t1")
                    .header("accept", "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let mut body = response.into_body();
        let first = next_sse_chunk(&mut body).await;
        assert!(first.contains(&format!("id: {}", replay.seq)));
        assert!(first.contains("\"phase\":\"replay\""));

        let live = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("t1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "codex.notification".to_string(),
                codex_method: Some("item/agentMessage/delta".to_string()),
                payload: json!({"threadId": "t1", "phase": "live"}),
            })
            .await
            .unwrap();
        state.events.send(live.clone()).unwrap();

        let second = next_sse_chunk(&mut body).await;
        assert!(second.contains(&format!("id: {}", live.seq)));
        assert!(second.contains("\"phase\":\"live\""));
    }

    async fn response_json(response: axum::response::Response) -> Value {
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    async fn response_text(response: axum::response::Response) -> String {
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        String::from_utf8(body.to_vec()).unwrap()
    }

    fn assert_ok(response: axum::response::Response) {
        assert_eq!(response.status(), StatusCode::OK);
    }

    async fn next_sse_chunk(body: &mut Body) -> String {
        let frame = timeout(Duration::from_secs(2), body.frame())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let data = frame.into_data().unwrap();
        String::from_utf8(data.to_vec()).unwrap()
    }

    struct RetryableAppServer;

    #[async_trait]
    impl AppServer for RetryableAppServer {
        fn is_ready(&self) -> bool {
            true
        }

        async fn request(&self, _method: &str, _params: Value) -> ApiResult<Value> {
            Err(ApiError::Retryable("server overloaded".to_string()))
        }

        async fn respond(&self, _request_id: &str, _result: Value) -> ApiResult<()> {
            Ok(())
        }
    }
}
