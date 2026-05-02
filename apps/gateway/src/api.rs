use std::sync::Arc;

use axum::Router;
use tokio::sync::broadcast;
use tower_http::trace::TraceLayer;
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;

use crate::{
    app_server::DynAppServer,
    app_server_api::{
        AccountResponse, ComposerPermissionsPreset, ComposerSettingsResponse,
        ComposerSettingsUpdateRequest, ComposerSettingsUpdateResponse, LoginStartResponse,
        ModelListResponse, RateLimitsResponse, RawAppServerResponse, ThreadCommandResponse,
        ThreadDetailResponse, ThreadItemSnapshot, ThreadListResponse, ThreadLiveState,
        ThreadTurnSnapshot, TimelineItemDeltaPayload, TimelineItemUpsertPayload,
        TimelineThreadMetadataPayload, TimelineThreadStatusPayload, TimelineTurnUpsertPayload,
        TimelineUpdateSource, UserInput,
    },
    config::Config,
    error::ApiErrorBody,
    routes,
    routes::{
        account::{AccountQuery, LoginRequest},
        approvals::{ApprovalDecisionRequest, ApprovalListResponse},
        capabilities::{AppServerCapabilities, CapabilitiesResponse, GatewayCapabilities},
        composer_settings::ComposerSettingsQuery,
        events::EventListResponse,
        health::{HealthResponse, ReadyResponse},
        models::ModelsQuery,
        projects::{CreateProjectRequest, ProjectListResponse},
        threads::{CreateThreadRequest, MarkThreadSeenRequest, ThreadListQuery},
        turns::{TurnStartRequest, TurnSteerRequest},
        uploads::{ImageUpload, ImageUploadRequest, ImageUploadResponse},
    },
    static_assets,
    store::{Approval, EventEnvelope, Project, Store, ThreadRead},
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
        crate::routes::health::healthz,
        crate::routes::health::readyz,
        crate::routes::capabilities::capabilities,
        crate::routes::composer_settings::read_composer_settings,
        crate::routes::composer_settings::update_composer_settings,
        crate::events::events,
        crate::routes::projects::list_projects,
        crate::routes::projects::create_project,
        crate::routes::projects::get_project,
        crate::routes::threads::list_threads,
        crate::routes::threads::create_thread,
        crate::routes::threads::get_thread,
        crate::routes::threads::resume_thread,
        crate::routes::threads::fork_thread,
        crate::routes::threads::archive_thread,
        crate::routes::threads::mark_thread_seen,
        crate::routes::turns::start_turn,
        crate::routes::turns::steer_turn,
        crate::routes::turns::interrupt_turn,
        crate::routes::uploads::upload_images,
        crate::routes::approvals::list_approvals,
        crate::routes::approvals::get_approval,
        crate::routes::approvals::decide_approval,
        crate::routes::account::read_account,
        crate::routes::account::start_login,
        crate::routes::account::cancel_login,
        crate::routes::account::logout,
        crate::routes::account::read_rate_limits,
        crate::routes::models::list_models
    ),
    components(schemas(
        ApiErrorBody,
        HealthResponse,
        ReadyResponse,
        CapabilitiesResponse,
        GatewayCapabilities,
        AppServerCapabilities,
        ComposerSettingsQuery,
        ComposerSettingsResponse,
        ComposerSettingsUpdateRequest,
        ComposerSettingsUpdateResponse,
        ComposerPermissionsPreset,
        EventEnvelope,
        EventListResponse,
        Project,
        ProjectListResponse,
        CreateProjectRequest,
        RawAppServerResponse,
        ThreadListResponse,
        ThreadDetailResponse,
        ThreadTurnSnapshot,
        ThreadItemSnapshot,
        ThreadLiveState,
        ThreadCommandResponse,
        TimelineUpdateSource,
        TimelineTurnUpsertPayload,
        TimelineItemUpsertPayload,
        TimelineItemDeltaPayload,
        TimelineThreadStatusPayload,
        TimelineThreadMetadataPayload,
        ThreadListQuery,
        CreateThreadRequest,
        MarkThreadSeenRequest,
        ThreadRead,
        UserInput,
        TurnStartRequest,
        TurnSteerRequest,
        ImageUpload,
        ImageUploadRequest,
        ImageUploadResponse,
        Approval,
        ApprovalListResponse,
        ApprovalDecisionRequest,
        AccountQuery,
        AccountResponse,
        LoginRequest,
        LoginStartResponse,
        RateLimitsResponse,
        ModelsQuery,
        ModelListResponse
    ))
)]
pub struct ApiDoc;

pub fn build_router(state: AppState) -> Router {
    let mut router = Router::new()
        .merge(routes::health::router())
        .merge(routes::capabilities::router())
        .merge(routes::composer_settings::router())
        .merge(routes::events::router())
        .merge(routes::projects::router())
        .merge(routes::threads::router())
        .merge(routes::turns::router())
        .merge(routes::uploads::router())
        .merge(routes::approvals::router())
        .merge(routes::account::router())
        .merge(routes::models::router())
        .merge(SwaggerUi::new("/docs").url("/openapi.json", ApiDoc::openapi()))
        .layer(TraceLayer::new_for_http())
        .with_state(state.clone());

    if let Some(dist_dir) = state.config.frontend.dist_dir.clone() {
        router = static_assets::attach_frontend(router, dist_dir);
    }

    router
}
