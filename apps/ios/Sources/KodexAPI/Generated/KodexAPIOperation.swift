import Foundation
import KodexCore

// Generated from apps/ios/openapi/openapi.json by apps/ios/scripts/generate-api.sh.
// Keep this file checked in so normal SwiftPM and Xcode builds do not need
// network access or plugin execution.
public enum KodexAPIOperation: String, CaseIterable, Sendable {
    case addMcpServer = "add_mcp_server"
    case applyProjectPreviewConfig = "apply_project_preview_config"
    case archiveThread = "archive_thread"
    case attachThread = "attach_thread"
    case cancelLogin = "cancel_login"
    case capabilities = "capabilities"
    case createAutomation = "create_automation"
    case createChatThread = "create_chat_thread"
    case createPreview = "create_preview"
    case createPreviewRoute = "create_preview_route"
    case createPreviewService = "create_preview_service"
    case createProject = "create_project"
    case createQueuedInput = "create_queued_input"
    case createSelfControlAutomation = "create_self_control_automation"
    case createSelfControlThread = "create_self_control_thread"
    case createThread = "create_thread"
    case currentPushSubscription = "current_push_subscription"
    case debugEvents = "debug_events"
    case decideApproval = "decide_approval"
    case deleteApnsDevice = "delete_apns_device"
    case deleteAutomation = "delete_automation"
    case deleteCurrentPushSubscription = "delete_current_push_subscription"
    case deletePreview = "delete_preview"
    case deletePreviewRoute = "delete_preview_route"
    case deletePreviewService = "delete_preview_service"
    case deletePushSubscription = "delete_push_subscription"
    case deleteQueuedInput = "delete_queued_input"
    case events = "events"
    case forkThread = "fork_thread"
    case getApproval = "get_approval"
    case getAutomation = "get_automation"
    case getProject = "get_project"
    case getSidebarThreads = "get_sidebar_threads"
    case getThread = "get_thread"
    case getThreadTimelinePage = "get_thread_timeline_page"
    case healthz = "healthz"
    case installKodexControlPlugin = "install_kodex_control_plugin"
    case interruptCurrentTurn = "interrupt_current_turn"
    case interruptTurn = "interrupt_turn"
    case kodexControlPluginStatus = "kodex_control_plugin_status"
    case listApprovals = "list_approvals"
    case listAutomations = "list_automations"
    case listChatThreads = "list_chat_threads"
    case listConfiguredMcpServers = "list_configured_mcp_servers"
    case listMcpServers = "list_mcp_servers"
    case listModels = "list_models"
    case listPinnedThreads = "list_pinned_threads"
    case listProjectPreviews = "list_project_previews"
    case listProjects = "list_projects"
    case listQueuedInputs = "list_queued_inputs"
    case listSkills = "list_skills"
    case listSubagents = "list_subagents"
    case listThreads = "list_threads"
    case logout = "logout"
    case markThreadSeen = "mark_thread_seen"
    case nativeNotificationStatus = "native_notification_status"
    case notificationStatus = "notification_status"
    case pauseAutomation = "pause_automation"
    case pauseSelfControlAutomation = "pause_self_control_automation"
    case pinThread = "pin_thread"
    case previewSkillIcon = "preview_skill_icon"
    case previewThreadFile = "preview_thread_file"
    case readAccount = "read_account"
    case readComposerSettings = "read_composer_settings"
    case readMcpResource = "read_mcp_resource"
    case readRateLimits = "read_rate_limits"
    case readyz = "readyz"
    case reloadMcpServers = "reload_mcp_servers"
    case reloadPreviews = "reload_previews"
    case removeMcpServer = "remove_mcp_server"
    case renameThread = "rename_thread"
    case replaceMcpServer = "replace_mcp_server"
    case resumeAutomation = "resume_automation"
    case resumeSelfControlAutomation = "resume_self_control_automation"
    case resumeThread = "resume_thread"
    case retryQueuedInput = "retry_queued_input"
    case selfControlStatus = "self_control_status"
    case sendSelfControlThreadInput = "send_self_control_thread_input"
    case setMcpServerEnabled = "set_mcp_server_enabled"
    case startLogin = "start_login"
    case startMcpOauthLogin = "start_mcp_oauth_login"
    case startTurn = "start_turn"
    case steerQueuedInput = "steer_queued_input"
    case steerTurn = "steer_turn"
    case submitThreadInput = "submit_thread_input"
    case testApnsNotification = "test_apns_notification"
    case testNotification = "test_notification"
    case unpinThread = "unpin_thread"
    case updateAutomation = "update_automation"
    case updateComposerSettings = "update_composer_settings"
    case updatePreview = "update_preview"
    case updatePreviewRoute = "update_preview_route"
    case updatePreviewService = "update_preview_service"
    case updateSelfControlAutomation = "update_self_control_automation"
    case updateThreadNotifications = "update_thread_notifications"
    case uploadImages = "upload_images"
    case upsertApnsDevice = "upsert_apns_device"
    case upsertPushSubscription = "upsert_push_subscription"

    public var operationId: String {
        rawValue
    }
}

public struct KodexGeneratedGatewayClient: Sendable {
    private let client: GatewayClient

    public init(client: GatewayClient) {
        self.client = client
    }

    public func execute(
        _ operation: KodexAPIOperation,
        route: GatewayRoute,
        method: GatewayHTTPMethod = .get,
        body: Data? = nil
    ) async -> Result<Data, GatewayClientError> {
        _ = operation
        return await client.send(route, method: method, body: body)
    }
}
