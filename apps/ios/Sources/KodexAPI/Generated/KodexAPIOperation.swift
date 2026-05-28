import Foundation
import KodexCore

// Generated from apps/ios/openapi/openapi.json by apps/ios/scripts/generate-api.sh.
// Keep this file checked in so normal SwiftPM and Xcode builds do not need
// network access or plugin execution.
public enum KodexAPIOperation: String, CaseIterable, Sendable {
    case readAccount = "read_account"
    case getSidebarThreads = "get_sidebar_threads"
    case createChatThread = "create_chat_thread"
    case createThread = "create_thread"
    case getThread = "get_thread"
    case getThreadTimelinePage = "get_thread_timeline_page"
    case submitThreadInput = "submit_thread_input"
    case listQueuedInputs = "list_queued_inputs"
    case retryQueuedInput = "retry_queued_input"
    case steerQueuedInput = "steer_queued_input"
    case deleteQueuedInput = "delete_queued_input"
    case interruptCurrentTurn = "interrupt_current_turn"
    case uploadImages = "upload_images"
    case listApprovals = "list_approvals"
    case decideApproval = "decide_approval"
    case listSkills = "list_skills"
    case markThreadSeen = "mark_thread_seen"
    case pinThread = "pin_thread"
    case unpinThread = "unpin_thread"
    case renameThread = "rename_thread"
    case archiveThread = "archive_thread"
    case updateThreadNotifications = "update_thread_notifications"
    case nativeNotificationStatus = "native_notification_status"

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
