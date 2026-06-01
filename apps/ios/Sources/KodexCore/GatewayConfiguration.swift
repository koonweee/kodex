import Foundation

public struct GatewayConfiguration: Equatable, Sendable {
    public static let simulatorDefault = GatewayConfiguration(
        baseURL: URL(string: "http://127.0.0.1:8787")!
    )

    public let baseURL: URL

    public init(baseURL: URL) {
        self.baseURL = Self.normalized(baseURL)
    }

    public init(userInput: String) throws {
        let trimmed = userInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed) else {
            throw GatewayConfigurationError.invalidURL
        }
        try self.init(validating: url)
    }

    public init(validating url: URL) throws {
        let normalizedURL = Self.normalized(url)
        guard let scheme = normalizedURL.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            throw GatewayConfigurationError.unsupportedScheme
        }
        guard normalizedURL.host?.isEmpty == false else {
            throw GatewayConfigurationError.missingHost
        }
        self.baseURL = normalizedURL
    }

    public func endpoint(_ route: GatewayRoute) -> URL {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        let basePath = components?.percentEncodedPath == "/" ? "" : (components?.percentEncodedPath ?? "")
        components?.percentEncodedPath = basePath + route.path
        components?.queryItems = route.queryItems.isEmpty ? nil : route.queryItems
        return components?.url ?? baseURL.appending(path: route.path)
    }

    private static func normalized(_ url: URL) -> URL {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        if components?.path == "/" {
            components?.path = ""
        }
        return components?.url ?? url
    }
}

public enum GatewayConfigurationError: Error, Equatable {
    case invalidURL
    case unsupportedScheme
    case missingHost
}

public enum GatewayRoute: Equatable, Sendable {
    case healthz
    case readyz
    case capabilities
    case account
    case openAPI
    case composerSettings(projectId: String?)
    case sidebarThreads
    case createChatThread
    case createProjectThread
    case thread(String)
    case threadTimelinePage(threadId: String, cursor: String?, limit: Int?)
    case threadSeen(String)
    case threadInput(String)
    case threadInterruptCurrent(String)
    case queuedInputs(String)
    case queuedInput(threadId: String, queueId: String)
    case queuedInputRetry(threadId: String, queueId: String)
    case queuedInputSteer(threadId: String, queueId: String)
    case imageUploads
    case skills(cwd: String?, forceReload: Bool?)
    case approvals(status: String?, threadId: String?)
    case approvalDecision(String)
    case threadPin(String)
    case threadName(String)
    case threadArchive(String)
    case threadSettings(String)
    case threadNotifications(String)
    case nativeNotificationStatus
    case apnsDeviceRegister
    case apnsDeviceDelete(String)
    case apnsTestNotification
    case events(cursor: Int64?, projectId: String?, threadId: String?, excludeThreadId: String?)

    public var path: String {
        switch self {
        case .healthz:
            return "/healthz"
        case .readyz:
            return "/readyz"
        case .capabilities:
            return "/v1/capabilities"
        case .account:
            return "/v1/account"
        case .openAPI:
            return "/openapi.json"
        case .composerSettings:
            return "/v1/composer-settings"
        case .sidebarThreads:
            return "/v1/sidebar/threads"
        case .createChatThread:
            return "/v1/chats/threads"
        case .createProjectThread:
            return "/v1/threads"
        case .thread(let threadId):
            return "/v1/threads/\(threadId.percentEncodedPathSegment)"
        case .threadTimelinePage(let threadId, _, _):
            return "/v1/threads/\(threadId.percentEncodedPathSegment)/timeline/pages"
        case .threadSeen(let threadId):
            return "/v1/threads/\(threadId.percentEncodedPathSegment)/seen"
        case .threadInput(let threadId):
            return "/v1/threads/\(threadId.percentEncodedPathSegment)/input"
        case .threadInterruptCurrent(let threadId):
            return "/v1/threads/\(threadId.percentEncodedPathSegment)/interrupt-current"
        case .queuedInputs(let threadId):
            return "/v1/threads/\(threadId.percentEncodedPathSegment)/queued-inputs"
        case .queuedInput(let threadId, let queueId):
            return "/v1/threads/\(threadId.percentEncodedPathSegment)/queued-inputs/\(queueId.percentEncodedPathSegment)"
        case .queuedInputRetry(let threadId, let queueId):
            return "/v1/threads/\(threadId.percentEncodedPathSegment)/queued-inputs/\(queueId.percentEncodedPathSegment)/retry"
        case .queuedInputSteer(let threadId, let queueId):
            return "/v1/threads/\(threadId.percentEncodedPathSegment)/queued-inputs/\(queueId.percentEncodedPathSegment)/steer"
        case .imageUploads:
            return "/v1/uploads/images"
        case .skills:
            return "/v1/skills"
        case .approvals:
            return "/v1/approvals"
        case .approvalDecision(let approvalId):
            return "/v1/approvals/\(approvalId.percentEncodedPathSegment)/decision"
        case .threadPin(let threadId):
            return "/v1/threads/\(threadId.percentEncodedPathSegment)/pin"
        case .threadName(let threadId):
            return "/v1/threads/\(threadId.percentEncodedPathSegment)/name"
        case .threadArchive(let threadId):
            return "/v1/threads/\(threadId.percentEncodedPathSegment)/archive"
        case .threadSettings(let threadId):
            return "/v1/threads/\(threadId.percentEncodedPathSegment)/settings"
        case .threadNotifications(let threadId):
            return "/v1/threads/\(threadId.percentEncodedPathSegment)/notifications"
        case .nativeNotificationStatus:
            return "/v1/notifications/native/status"
        case .apnsDeviceRegister:
            return "/v1/notifications/apns/devices"
        case .apnsDeviceDelete(let deviceId):
            return "/v1/notifications/apns/devices/\(deviceId.percentEncodedPathSegment)"
        case .apnsTestNotification:
            return "/v1/notifications/apns/test"
        case .events:
            return "/v1/events"
        }
    }

    public var queryItems: [URLQueryItem] {
        switch self {
        case .composerSettings(let projectId):
            return [
                projectId.map { URLQueryItem(name: "projectId", value: $0) }
            ].compactMap { $0 }
        case .threadTimelinePage(_, let cursor, let limit):
            return [
                cursor.map { URLQueryItem(name: "cursor", value: $0) },
                limit.map { URLQueryItem(name: "limit", value: String($0)) }
            ].compactMap { $0 }
        case .skills(let cwd, let forceReload):
            return [
                cwd.map { URLQueryItem(name: "cwd", value: $0) },
                forceReload.map { URLQueryItem(name: "forceReload", value: String($0)) }
            ].compactMap { $0 }
        case .approvals(let status, let threadId):
            return [
                status.map { URLQueryItem(name: "status", value: $0) },
                threadId.map { URLQueryItem(name: "threadId", value: $0) }
            ].compactMap { $0 }
        case .events(let cursor, let projectId, let threadId, let excludeThreadId):
            return [
                cursor.map { URLQueryItem(name: "cursor", value: String($0)) },
                projectId.map { URLQueryItem(name: "projectId", value: $0) },
                threadId.map { URLQueryItem(name: "threadId", value: $0) },
                excludeThreadId.map { URLQueryItem(name: "excludeThreadId", value: $0) }
            ].compactMap { $0 }
        default:
            return []
        }
    }
}

private extension String {
    var percentEncodedPathSegment: String {
        addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#[]@!$&'()*+,;="))) ?? self
    }
}

public enum FixtureLaunchMode: String, Sendable {
    case live
    case connected
    case degraded
    case offline
    case authRequired

    public init(arguments: [String]) {
        if arguments.contains("--fixture-connected") {
            self = .connected
        } else if arguments.contains("--fixture-degraded") {
            self = .degraded
        } else if arguments.contains("--fixture-offline") {
            self = .offline
        } else if arguments.contains("--fixture-auth-required") {
            self = .authRequired
        } else {
            self = .live
        }
    }
}

public struct FixtureAppState: Equatable, Sendable {
    public let connection: GatewayConnectionStatus
    public let workspace: WorkspaceSnapshot
    public let selectedThread: ThreadDetail?
    public let approvals: [ApprovalRequest]

    public init(connection: GatewayConnectionStatus, workspace: WorkspaceSnapshot, selectedThread: ThreadDetail?, approvals: [ApprovalRequest]) {
        self.connection = connection
        self.workspace = workspace
        self.selectedThread = selectedThread
        self.approvals = approvals
    }
}

public enum FixtureStore {
    public static func state(for mode: FixtureLaunchMode) -> FixtureAppState {
        switch mode {
        case .live:
            return state(for: .connected)
        case .connected:
            return FixtureAppState(connection: .connected(baseURL: GatewayConfiguration.simulatorDefault.baseURL.absoluteString), workspace: workspace, selectedThread: detail(threadId: "fixture-chat"), approvals: approvals)
        case .degraded:
            return FixtureAppState(connection: .degraded(message: "app-server unavailable"), workspace: workspace, selectedThread: detail(threadId: "fixture-project-thread"), approvals: approvals)
        case .offline:
            return FixtureAppState(connection: .offline(message: "Could not reach http://127.0.0.1:8787"), workspace: WorkspaceSnapshot(projects: [], chats: [], pinned: []), selectedThread: nil, approvals: [])
        case .authRequired:
            return FixtureAppState(connection: .connected(baseURL: GatewayConfiguration.simulatorDefault.baseURL.absoluteString), workspace: WorkspaceSnapshot(projects: [], chats: [], pinned: []), selectedThread: nil, approvals: [])
        }
    }

    private static let workspace = WorkspaceSnapshot(
        projects: [
            WorkspaceProject(
                id: "project-kodex",
                name: "Kodex",
                path: "/Users/example/kodex",
                threads: [
                    WorkspaceThread(id: "fixture-project-thread", title: "Native iOS milestone", cwd: "/Users/example/kodex", status: .active, unread: true, pinned: false)
                ]
            )
        ],
        chats: [
            WorkspaceThread(id: "fixture-chat", title: "Release checklist", cwd: "/Users/example/kodex", status: .idle, unread: false, pinned: false)
        ],
        pinned: [
            WorkspaceThread(id: "fixture-thread", title: "Unread agent message", cwd: "/Users/example/kodex", status: .idle, unread: true, pinned: true),
            WorkspaceThread(id: "fixture-pinned-chat", title: "Pinned chat follow-up", cwd: "/Users/example/Documents/Codex/2026-05-28/pinned-chat", status: .idle, unread: false, pinned: true)
        ]
    )

    private static let approvals = [
        ApprovalRequest(id: "approval-accept-fixture", threadId: "fixture-project-thread", title: "List workspace", risk: "low", context: "pwd"),
        ApprovalRequest(id: "approval-decline-fixture", threadId: "fixture-project-thread", title: "Read project file", risk: "low", context: "README.md"),
        ApprovalRequest(id: "approval-fixture", threadId: "fixture-project-thread", title: "Run focused Swift tests", risk: "medium", context: "xcodebuild test")
    ]

    private static func detail(threadId: String) -> ThreadDetail? {
        guard let thread = workspace.thread(id: threadId) else {
            return nil
        }
        return ThreadDetail(
            thread: thread,
            timeline: ThreadTimeline(
                threadId: threadId,
                liveState: thread.status == .active ? .streaming : .idle,
                viewRevision: 12,
                rows: [
                    TimelineRow(id: "\(threadId)-1", kind: .message, speaker: .user, displayOrder: 1, title: "You", body: "Implement native iOS milestone coverage."),
                    TimelineRow(id: "\(threadId)-2", kind: .work, speaker: .assistant, displayOrder: 2, title: "Kodex", body: "Mapping workspace, thread, timeline, composer, approvals, and notifications."),
                    TimelineRow(id: "\(threadId)-3", kind: .activity, displayOrder: 3, title: "Activity", body: "Running deterministic simulator checks."),
                    TimelineRow(id: "\(threadId)-4", kind: .tool, displayOrder: 4, title: "Tool", body: "xcodebuild test"),
                    TimelineRow(id: "\(threadId)-5", kind: .image, displayOrder: 5, title: "Image", body: "Attached simulator screenshot fixture."),
                    TimelineRow(id: "\(threadId)-6", kind: .fileChange, displayOrder: 6, title: "Files", body: "apps/ios/Sources and Tests updated."),
                    TimelineRow(id: "\(threadId)-7", kind: .warning, displayOrder: 7, title: "Warning", body: "OpenAI auth required for live smoke."),
                    TimelineRow(id: "\(threadId)-8", kind: .error, displayOrder: 8, title: "Error", body: "Fixture-only error row.")
                ] + (9...34).map { index in
                    TimelineRow(id: "\(threadId)-long-\(index)", kind: .message, speaker: index.isMultiple(of: 2) ? .assistant : .user, displayOrder: index, title: "Long Row \(index)", body: "Long-thread fixture row \(index).")
                },
                olderCursor: "fixture-older",
                hasOlder: true
            )
        )
    }
}
