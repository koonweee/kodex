use std::sync::Arc;

use axum::Router;
use tokio::sync::broadcast;
use tower_http::trace::TraceLayer;
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;

use crate::{
    app_server::DynAppServer,
    app_server_api::{
        AccountResponse, AppSummary, ComposerPermissionsPreset, ComposerSettingsResponse,
        ComposerSettingsUpdateRequest, ComposerSettingsUpdateResponse, LoginStartResponse,
        MarketplaceAddResponse, ModelListResponse, PluginDetail, PluginInstallResponse,
        PluginInterface, PluginListResponse, PluginMarketplaceEntry, PluginReadResponse,
        PluginSummary, RateLimitsResponse, RawAppServerResponse, SkillErrorInfo, SkillInterface,
        SkillMetadata, SkillsCatalogResponse, ThreadCommandResponse, ThreadDetailResponse,
        ThreadItemSnapshot, ThreadListResponse, ThreadLiveState, ThreadTurnSnapshot,
        TimelineItemDeltaPayload, TimelineItemUpsertPayload, TimelineSkillMention,
        TimelineThreadMetadataPayload, TimelineThreadStatusPayload, TimelineTurnUpsertPayload,
        TimelineUpdateSource, UserInput,
    },
    config::Config,
    error::ApiErrorBody,
    previews::{
        PreviewRuntimeStateKind, PreviewRuntimeStatus, PreviewServiceReachability,
        PreviewServiceStatus, PreviewSubsystemState, PreviewSubsystemStatus,
    },
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
        kodex_control_plugin::{
            KodexControlPluginInstallResponse, KodexControlPluginStatusKind,
            KodexControlPluginStatusResponse,
        },
        models::ModelsQuery,
        project_previews::{
            PreviewCreateRequest, PreviewListResponse, PreviewRouteCreateRequest,
            PreviewRouteResponse, PreviewRouteUpdateRequest, PreviewServiceCreateRequest,
            PreviewServiceResponse, PreviewServiceUpdateRequest, PreviewUpdateRequest,
            ProjectPreviewDto, ProjectPreviewRouteDto, ProjectPreviewServiceDto,
        },
        projects::{CreateProjectRequest, ProjectListResponse},
        self_control::{
            SelfControlApplyAction, SelfControlApplyChange, SelfControlAutomationCreateRequest,
            SelfControlAutomationResponse, SelfControlAutomationUpdateRequest,
            SelfControlCapabilities, SelfControlCreateThreadRequest, SelfControlDesiredPreview,
            SelfControlDesiredPreviewRoute, SelfControlDesiredPreviewService,
            SelfControlPreviewApplyRequest, SelfControlPreviewApplyResponse,
            SelfControlRequestedBy, SelfControlSource, SelfControlSourceType,
            SelfControlStatusResponse, SelfControlThreadInputAction, SelfControlThreadInputRequest,
            SelfControlThreadInputResponse,
        },
        skills::{SkillIconQuery, SkillsQuery},
        threads::{
            CreateChatThreadRequest, CreateThreadRequest, MarkThreadSeenRequest, ThreadListQuery,
            ThreadPinResponse, ThreadSubagentListResponse, ThreadSubagentSummary,
        },
        turns::{TurnStartRequest, TurnSteerRequest},
        uploads::{ImageUpload, ImageUploadRequest, ImageUploadResponse},
    },
    static_assets,
    store::{
        Approval, AutomationStatus, EventEnvelope, Project, ProjectPreview, ProjectPreviewRoute,
        ProjectPreviewService, QueuedInput, QueuedInputPriority, QueuedInputStatus, Store,
        ThreadRead,
    },
};

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub store: Store,
    pub app_server: DynAppServer,
    pub events: broadcast::Sender<EventEnvelope>,
    pub skills: crate::skills::SkillCatalogCache,
    pub previews: crate::previews::PreviewManager,
}

impl AppState {
    pub fn new(config: Config, store: Store, app_server: DynAppServer) -> Self {
        let (events, _) = broadcast::channel(1024);
        let config = Arc::new(config);
        Self {
            previews: crate::previews::PreviewManager::new(config.clone()),
            config,
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
        crate::routes::project_previews::list_project_previews,
        crate::routes::project_previews::create_preview_service,
        crate::routes::project_previews::update_preview_service,
        crate::routes::project_previews::delete_preview_service,
        crate::routes::project_previews::create_preview,
        crate::routes::project_previews::update_preview,
        crate::routes::project_previews::delete_preview,
        crate::routes::project_previews::create_preview_route,
        crate::routes::project_previews::update_preview_route,
        crate::routes::project_previews::delete_preview_route,
        crate::routes::project_previews::reload_previews,
        crate::routes::threads::list_threads,
        crate::routes::threads::create_thread,
        crate::routes::threads::list_chat_threads,
        crate::routes::threads::create_chat_thread,
        crate::routes::threads::list_pinned_threads,
        crate::routes::threads::list_subagents,
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
        crate::routes::skills::list_skills,
        crate::routes::skills::preview_skill_icon,
        crate::routes::kodex_control_plugin::kodex_control_plugin_status,
        crate::routes::kodex_control_plugin::install_kodex_control_plugin,
        crate::routes::self_control::self_control_status,
        crate::routes::self_control::apply_project_preview_config,
        crate::routes::self_control::create_self_control_thread,
        crate::routes::self_control::send_self_control_thread_input,
        crate::routes::self_control::create_self_control_automation,
        crate::routes::self_control::update_self_control_automation,
        crate::routes::self_control::pause_self_control_automation,
        crate::routes::self_control::resume_self_control_automation
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
        ProjectPreviewService,
        ProjectPreview,
        ProjectPreviewRoute,
        ProjectPreviewServiceDto,
        ProjectPreviewDto,
        ProjectPreviewRouteDto,
        PreviewListResponse,
        PreviewServiceCreateRequest,
        PreviewServiceUpdateRequest,
        PreviewServiceResponse,
        PreviewCreateRequest,
        PreviewUpdateRequest,
        PreviewRouteCreateRequest,
        PreviewRouteUpdateRequest,
        PreviewRouteResponse,
        PreviewSubsystemState,
        PreviewSubsystemStatus,
        PreviewServiceReachability,
        PreviewServiceStatus,
        PreviewRuntimeStateKind,
        PreviewRuntimeStatus,
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
        ThreadSubagentSummary,
        ThreadSubagentListResponse,
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
        SkillIconQuery,
        SkillsCatalogResponse,
        SkillMetadata,
        SkillInterface,
        SkillErrorInfo,
        AppSummary,
        MarketplaceAddResponse,
        PluginDetail,
        PluginInstallResponse,
        PluginInterface,
        PluginListResponse,
        PluginMarketplaceEntry,
        PluginReadResponse,
        PluginSummary,
        KodexControlPluginStatusKind,
        KodexControlPluginStatusResponse,
        KodexControlPluginInstallResponse,
        SelfControlStatusResponse,
        SelfControlCapabilities,
        SelfControlSource,
        SelfControlSourceType,
        SelfControlRequestedBy,
        SelfControlPreviewApplyRequest,
        SelfControlDesiredPreviewService,
        SelfControlDesiredPreview,
        SelfControlDesiredPreviewRoute,
        SelfControlPreviewApplyResponse,
        SelfControlApplyChange,
        SelfControlApplyAction,
        SelfControlCreateThreadRequest,
        SelfControlThreadInputRequest,
        SelfControlThreadInputResponse,
        SelfControlThreadInputAction,
        SelfControlAutomationCreateRequest,
        SelfControlAutomationUpdateRequest,
        SelfControlAutomationResponse
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
        .merge(routes::project_previews::router())
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
        .merge(routes::kodex_control_plugin::router())
        .merge(routes::self_control::router())
        .merge(SwaggerUi::new("/docs").url("/openapi.json", ApiDoc::openapi()))
        .layer(TraceLayer::new_for_http())
        .with_state(state.clone());

    if let Some(dist_dir) = state.config.frontend.dist_dir.clone() {
        router = static_assets::attach_frontend(router, dist_dir);
    }

    router
}
