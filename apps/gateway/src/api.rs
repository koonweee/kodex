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
        ModelListResponse, RateLimitsResponse, RawAppServerResponse, SkillErrorInfo,
        SkillInterface, SkillMetadata, SkillsCatalogResponse, ThreadCommandResponse,
        ThreadDetailResponse, ThreadItemSnapshot, ThreadListResponse, ThreadLiveState,
        ThreadTurnSnapshot, TimelineItemDeltaPayload, TimelineItemUpsertPayload,
        TimelineSkillMention, TimelineThreadMetadataPayload, TimelineThreadStatusPayload,
        TimelineTurnUpsertPayload, TimelineUpdateSource, UserInput,
    },
    config::Config,
    error::ApiErrorBody,
    queue::{
        QueuedInputCreateRequest, QueuedInputDeleteResponse, QueuedInputListResponse,
        QueuedInputResponse,
    },
    routes,
    routes::{
        account::{AccountQuery, LoginRequest},
        approvals::{ApprovalDecisionRequest, ApprovalListResponse},
        automations::{
            AutomationCreateRequest, AutomationDeleteResponse, AutomationDto, AutomationListQuery,
            AutomationListResponse, AutomationRepeatEvery, AutomationRepeatUnit,
            AutomationResponse, AutomationSchedule, AutomationUpdateRequest,
        },
        capabilities::{AppServerCapabilities, CapabilitiesResponse, GatewayCapabilities},
        composer_settings::ComposerSettingsQuery,
        events::EventListResponse,
        file_preview::FilePreviewQuery,
        health::{HealthResponse, ReadyResponse},
        models::ModelsQuery,
        projects::{CreateProjectRequest, ProjectListResponse},
        skills::SkillsQuery,
        threads::{
            CreateChatThreadRequest, CreateThreadRequest, MarkThreadSeenRequest, ThreadListQuery,
            ThreadPinResponse,
        },
        turns::{TurnStartRequest, TurnSteerRequest},
        uploads::{ImageUpload, ImageUploadRequest, ImageUploadResponse},
    },
    static_assets,
    store::{
        Approval, AutomationStatus, EventEnvelope, Project, QueuedInput, QueuedInputPriority,
        QueuedInputStatus, Store, ThreadRead,
    },
};

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub store: Store,
    pub app_server: DynAppServer,
    pub events: broadcast::Sender<EventEnvelope>,
    pub skills: crate::skills::SkillCatalogCache,
}

impl AppState {
    pub fn new(config: Config, store: Store, app_server: DynAppServer) -> Self {
        let (events, _) = broadcast::channel(1024);
        Self {
            config: Arc::new(config),
            store,
            app_server,
            events,
            skills: crate::skills::SkillCatalogCache::default(),
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
        crate::events::debug_events,
        crate::routes::projects::list_projects,
        crate::routes::projects::create_project,
        crate::routes::projects::get_project,
        crate::routes::threads::list_threads,
        crate::routes::threads::create_thread,
        crate::routes::threads::list_chat_threads,
        crate::routes::threads::create_chat_thread,
        crate::routes::threads::list_pinned_threads,
        crate::routes::threads::get_thread,
        crate::routes::threads::resume_thread,
        crate::routes::threads::fork_thread,
        crate::routes::threads::archive_thread,
        crate::routes::threads::pin_thread,
        crate::routes::threads::unpin_thread,
        crate::routes::threads::mark_thread_seen,
        crate::routes::turns::start_turn,
        crate::routes::turns::steer_turn,
        crate::routes::turns::interrupt_turn,
        crate::queue::list_queued_inputs,
        crate::queue::create_queued_input,
        crate::queue::retry_queued_input,
        crate::queue::steer_queued_input,
        crate::queue::delete_queued_input,
        crate::routes::file_preview::preview_thread_file,
        crate::routes::uploads::upload_images,
        crate::routes::approvals::list_approvals,
        crate::routes::approvals::get_approval,
        crate::routes::approvals::decide_approval,
        crate::routes::automations::list_automations,
        crate::routes::automations::create_automation,
        crate::routes::automations::get_automation,
        crate::routes::automations::update_automation,
        crate::routes::automations::pause_automation,
        crate::routes::automations::resume_automation,
        crate::routes::automations::delete_automation,
        crate::routes::account::read_account,
        crate::routes::account::start_login,
        crate::routes::account::cancel_login,
        crate::routes::account::logout,
        crate::routes::account::read_rate_limits,
        crate::routes::models::list_models,
        crate::routes::skills::list_skills
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
        TimelineSkillMention,
        TimelineThreadStatusPayload,
        TimelineThreadMetadataPayload,
        ThreadListQuery,
        CreateThreadRequest,
        CreateChatThreadRequest,
        MarkThreadSeenRequest,
        ThreadPinResponse,
        ThreadRead,
        UserInput,
        TurnStartRequest,
        TurnSteerRequest,
        QueuedInput,
        QueuedInputStatus,
        QueuedInputPriority,
        QueuedInputCreateRequest,
        QueuedInputListResponse,
        QueuedInputResponse,
        QueuedInputDeleteResponse,
        FilePreviewQuery,
        ImageUpload,
        ImageUploadRequest,
        ImageUploadResponse,
        Approval,
        ApprovalListResponse,
        ApprovalDecisionRequest,
        AutomationListQuery,
        AutomationSchedule,
        AutomationRepeatEvery,
        AutomationRepeatUnit,
        AutomationStatus,
        AutomationCreateRequest,
        AutomationUpdateRequest,
        AutomationDto,
        AutomationResponse,
        AutomationListResponse,
        AutomationDeleteResponse,
        AccountQuery,
        AccountResponse,
        LoginRequest,
        LoginStartResponse,
        RateLimitsResponse,
        ModelsQuery,
        ModelListResponse,
        SkillsQuery,
        SkillsCatalogResponse,
        SkillMetadata,
        SkillInterface,
        SkillErrorInfo
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
        .merge(crate::queue::router())
        .merge(routes::file_preview::router())
        .merge(routes::uploads::router())
        .merge(routes::approvals::router())
        .merge(routes::automations::router())
        .merge(routes::account::router())
        .merge(routes::models::router())
        .merge(routes::skills::router())
        .merge(SwaggerUi::new("/docs").url("/openapi.json", ApiDoc::openapi()))
        .layer(TraceLayer::new_for_http())
        .with_state(state.clone());

    if let Some(dist_dir) = state.config.frontend.dist_dir.clone() {
        router = static_assets::attach_frontend(router, dist_dir);
    }

    router
}
