import Foundation

public struct GatewayHTTPResponse: Equatable, Sendable {
    public let statusCode: Int
    public let body: Data

    public init(statusCode: Int, body: Data = Data()) {
        self.statusCode = statusCode
        self.body = body
    }
}

public enum GatewayReadiness: Equatable, Sendable {
    case connected
    case degraded(message: String)
    case offline(message: String)
}

public struct GatewayProbe: Sendable {
    public typealias Loader = @Sendable (URL) async throws -> GatewayHTTPResponse

    private let load: Loader

    public init(load: @escaping Loader) {
        self.load = load
    }

    public func check(_ configuration: GatewayConfiguration) async -> GatewayReadiness {
        do {
            let health = try await load(configuration.endpoint(.healthz))
            guard (200..<300).contains(health.statusCode) else {
                return .offline(message: "Gateway health check returned HTTP \(health.statusCode).")
            }

            let ready = try await load(configuration.endpoint(.readyz))
            guard (200..<300).contains(ready.statusCode) else {
                return .degraded(message: "Gateway readiness check returned HTTP \(ready.statusCode).")
            }

            return decodeReadyResponse(ready.body)
        } catch {
            return .offline(message: error.localizedDescription)
        }
    }

    private func decodeReadyResponse(_ body: Data) -> GatewayReadiness {
        guard !body.isEmpty else {
            return .degraded(message: "Gateway readiness response was empty.")
        }

        do {
            let response = try JSONDecoder().decode(ReadyResponse.self, from: body)
            if response.ready {
                return .connected
            }
            return .degraded(message: response.message ?? "Codex app-server is not ready.")
        } catch {
            return .degraded(message: "Gateway readiness response could not be decoded.")
        }
    }
}

private struct ReadyResponse: Decodable {
    let ready: Bool
    let message: String?
}

public enum GatewayHTTPMethod: String, Sendable {
    case get = "GET"
    case post = "POST"
    case patch = "PATCH"
    case delete = "DELETE"
}

public struct GatewayRequest: Equatable, Sendable {
    public let method: GatewayHTTPMethod
    public let url: URL
    public let headers: [String: String]
    public let body: Data?

    public init(method: GatewayHTTPMethod, url: URL, headers: [String: String] = [:], body: Data? = nil) {
        self.method = method
        self.url = url
        self.headers = headers
        self.body = body
    }
}

public enum GatewayClientError: Error, Equatable, Sendable {
    case invalidBaseURL(String)
    case transport(String)
    case gateway(statusCode: Int, message: String)
    case decoding(String)
}

public struct GatewayClient: Sendable {
    public typealias Sender = @Sendable (GatewayRequest) async throws -> GatewayHTTPResponse

    public let configuration: GatewayConfiguration
    public let timeout: TimeInterval
    private let sendRequest: Sender

    public init(configuration: GatewayConfiguration, timeout: TimeInterval = 30, send: @escaping Sender) {
        self.configuration = configuration
        self.timeout = timeout
        self.sendRequest = send
    }

    public func request(_ route: GatewayRoute, method: GatewayHTTPMethod = .get, body: Data? = nil) -> GatewayRequest {
        var headers = ["Accept": "application/json"]
        if body != nil {
            headers["Content-Type"] = "application/json"
        }
        return GatewayRequest(method: method, url: configuration.endpoint(route), headers: headers, body: body)
    }

    public func send(_ route: GatewayRoute, method: GatewayHTTPMethod = .get, body: Data? = nil) async -> Result<Data, GatewayClientError> {
        await send(request(route, method: method, body: body))
    }

    public func send(_ request: GatewayRequest) async -> Result<Data, GatewayClientError> {
        do {
            let response = try await sendRequest(request)
            return Self.normalize(response)
        } catch {
            return .failure(.transport(error.localizedDescription))
        }
    }

    public static func normalize(_ response: GatewayHTTPResponse) -> Result<Data, GatewayClientError> {
        guard (200..<300).contains(response.statusCode) else {
            return .failure(.gateway(statusCode: response.statusCode, message: decodeGatewayError(response.body)))
        }
        return .success(response.body)
    }

    private static func decodeGatewayError(_ body: Data) -> String {
        guard !body.isEmpty else {
            return "Gateway returned an error without a response body."
        }
        if let decoded = try? JSONDecoder().decode(GatewayErrorBody.self, from: body) {
            return decoded.message ?? decoded.error ?? decoded.detail ?? "Gateway request failed."
        }
        return String(data: body, encoding: .utf8) ?? "Gateway error body could not be decoded."
    }
}

private struct GatewayErrorBody: Decodable {
    let error: String?
    let message: String?
    let detail: String?
}

public enum ThreadStatus: String, Codable, Sendable {
    case notLoaded
    case idle
    case systemError
    case active
}

public struct WorkspaceThread: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let cwd: String
    public let status: ThreadStatus
    public let unread: Bool
    public let pinned: Bool
    public let notificationsEnabled: Bool

    public init(id: String, title: String, cwd: String, status: ThreadStatus = .idle, unread: Bool = false, pinned: Bool = false, notificationsEnabled: Bool = true) {
        self.id = id
        self.title = title
        self.cwd = cwd
        self.status = status
        self.unread = unread
        self.pinned = pinned
        self.notificationsEnabled = notificationsEnabled
    }

    public func replacing(status: ThreadStatus) -> WorkspaceThread {
        WorkspaceThread(
            id: id,
            title: title,
            cwd: cwd,
            status: status,
            unread: unread,
            pinned: pinned,
            notificationsEnabled: notificationsEnabled
        )
    }

    public func replacing(liveState: ThreadLiveState) -> WorkspaceThread {
        replacing(status: ThreadStatus(liveState: liveState))
    }
}

public struct WorkspaceProject: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let path: String
    public let threads: [WorkspaceThread]

    public init(id: String, name: String, path: String, threads: [WorkspaceThread]) {
        self.id = id
        self.name = name
        self.path = path
        self.threads = threads
    }

    public func replacingThreadStatus(threadId: String, liveState: ThreadLiveState) -> WorkspaceProject {
        WorkspaceProject(
            id: id,
            name: name,
            path: path,
            threads: threads.map { thread in
                thread.id == threadId ? thread.replacing(liveState: liveState) : thread
            }
        )
    }
}

public struct WorkspaceSnapshot: Codable, Equatable, Sendable {
    public let projects: [WorkspaceProject]
    public let chats: [WorkspaceThread]
    public let pinned: [WorkspaceThread]

    public init(projects: [WorkspaceProject], chats: [WorkspaceThread], pinned: [WorkspaceThread]) {
        self.projects = projects
        self.chats = chats
        self.pinned = pinned
    }

    public var firstThread: WorkspaceThread? {
        pinned.first ?? chats.first ?? projects.lazy.compactMap { $0.threads.first }.first
    }

    public func thread(id: String) -> WorkspaceThread? {
        let projectThreads = projects.flatMap(\.threads)
        return (pinned + chats + projectThreads).first { $0.id == id }
    }

    public func replacingThreadStatus(threadId: String, liveState: ThreadLiveState) -> WorkspaceSnapshot {
        WorkspaceSnapshot(
            projects: projects.map { $0.replacingThreadStatus(threadId: threadId, liveState: liveState) },
            chats: chats.map { thread in
                thread.id == threadId ? thread.replacing(liveState: liveState) : thread
            },
            pinned: pinned.map { thread in
                thread.id == threadId ? thread.replacing(liveState: liveState) : thread
            }
        )
    }
}

public enum ThreadLiveState: String, Codable, Sendable {
    case idle
    case streaming
    case syncing
    case notLoaded
}

public extension ThreadStatus {
    init(liveState: ThreadLiveState) {
        switch liveState {
        case .idle:
            self = .idle
        case .streaming, .syncing:
            self = .active
        case .notLoaded:
            self = .notLoaded
        }
    }
}

public enum TimelineRowKind: String, Codable, Sendable {
    case message
    case work
    case activity
    case tool
    case fileChange
    case image
    case warning
    case error
    case unknown

    public init(gatewayKind: String, status: String, hasFileChanges: Bool = false, itemType: String? = nil) {
        let lowerKind = gatewayKind.lowercased()
        let lowerStatus = status.lowercased()
        let lowerItemType = itemType?.lowercased() ?? ""
        if lowerStatus.contains("error") || lowerKind.contains("error") {
            self = .error
        } else if lowerKind.contains("warning") {
            self = .warning
        } else if hasFileChanges {
            self = .fileChange
        } else if lowerItemType.contains("image") || lowerKind.contains("image") {
            self = .image
        } else if lowerKind.contains("message") || lowerItemType.contains("message") {
            self = .message
        } else if lowerKind.contains("work") {
            self = .work
        } else if lowerKind.contains("tool") || lowerItemType.contains("tool") {
            self = .tool
        } else if lowerKind.contains("activity") {
            self = .activity
        } else {
            self = .unknown
        }
    }
}

public enum TimelineSpeaker: String, Codable, Sendable {
    case user
    case assistant
    case system
    case unknown

    public init(role: String?) {
        switch role?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() {
        case "user", "you", "human", "user_message", "usermessage":
            self = .user
        case "assistant", "agent", "kodex", "codex", "agent_message", "agentmessage":
            self = .assistant
        case "system", "tool", "activity", "work":
            self = .system
        default:
            self = .unknown
        }
    }
}

public struct TimelineRow: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let kind: TimelineRowKind
    public let speaker: TimelineSpeaker
    public let displayOrder: Int64
    public let title: String
    public let body: String
    public let status: String
    public let turnId: String?

    public init(
        id: String,
        kind: TimelineRowKind,
        speaker: TimelineSpeaker = .unknown,
        displayOrder: Int64,
        title: String,
        body: String,
        status: String = "complete",
        turnId: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.speaker = speaker
        self.displayOrder = displayOrder
        self.title = title
        self.body = body
        self.status = status
        self.turnId = turnId
    }
}

public struct ThreadTimeline: Codable, Equatable, Sendable {
    public let threadId: String
    public let liveState: ThreadLiveState
    public let viewRevision: Int64
    public let rows: [TimelineRow]
    public let olderCursor: String?
    public let hasOlder: Bool

    public init(threadId: String, liveState: ThreadLiveState, viewRevision: Int64, rows: [TimelineRow], olderCursor: String? = nil, hasOlder: Bool = false) {
        self.threadId = threadId
        self.liveState = liveState
        self.viewRevision = viewRevision
        self.rows = rows.sorted { $0.displayOrder < $1.displayOrder }
        self.olderCursor = olderCursor
        self.hasOlder = hasOlder
    }
}

public struct ThreadDetail: Codable, Equatable, Sendable {
    public let thread: WorkspaceThread
    public let timeline: ThreadTimeline

    public init(thread: WorkspaceThread, timeline: ThreadTimeline) {
        self.thread = thread
        self.timeline = timeline
    }
}

public enum GatewayThreadViewPatchScope: Equatable, Sendable {
    case fullSnapshot
    case turn
    case lifecycle
    case unsupported(String)

    public init(rawValue: String) {
        switch rawValue {
        case "full_snapshot":
            self = .fullSnapshot
        case "turn":
            self = .turn
        case "lifecycle":
            self = .lifecycle
        default:
            self = .unsupported(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .fullSnapshot:
            return "full_snapshot"
        case .turn:
            return "turn"
        case .lifecycle:
            return "lifecycle"
        case .unsupported(let rawValue):
            return rawValue
        }
    }

    public var isRenderable: Bool {
        switch self {
        case .fullSnapshot, .turn, .lifecycle:
            return true
        case .unsupported:
            return false
        }
    }
}

public struct GatewayThreadViewPatch: Equatable, Sendable {
    public let threadId: String
    public let viewRevision: Int64
    public let scope: GatewayThreadViewPatchScope
    public let liveState: ThreadLiveState
    public let activeTurnId: String?
    public let rows: [TimelineRow]?
    public let upsertRows: [TimelineRow]
    public let removeRowIds: [String]

    public init(
        threadId: String,
        viewRevision: Int64,
        scope: GatewayThreadViewPatchScope,
        liveState: ThreadLiveState,
        activeTurnId: String? = nil,
        rows: [TimelineRow]? = nil,
        upsertRows: [TimelineRow] = [],
        removeRowIds: [String] = []
    ) {
        self.threadId = threadId
        self.viewRevision = viewRevision
        self.scope = scope
        self.liveState = liveState
        self.activeTurnId = activeTurnId
        self.rows = rows
        self.upsertRows = upsertRows
        self.removeRowIds = removeRowIds
    }
}

public enum ThreadTimelinePatchResult: Equatable, Sendable {
    case applied(ThreadTimeline)
    case ignoredStale(ThreadTimeline)
    case needsSnapshotRefresh(reason: String)
}

public extension ThreadTimeline {
    func applying(_ patch: GatewayThreadViewPatch) -> ThreadTimelinePatchResult {
        guard patch.threadId == threadId else {
            return .needsSnapshotRefresh(reason: "Patch thread did not match timeline thread.")
        }
        guard patch.scope.isRenderable else {
            return .needsSnapshotRefresh(reason: "Unsupported patch scope: \(patch.scope.rawValue)")
        }
        guard patch.viewRevision > viewRevision else {
            return .ignoredStale(self)
        }

        switch patch.scope {
        case .fullSnapshot:
            guard let rows = patch.rows else {
                return .needsSnapshotRefresh(reason: "Full snapshot patch did not include rows.")
            }
            return .applied(replacing(rows: rows, liveState: patch.liveState, viewRevision: patch.viewRevision))
        case .turn:
            guard patch.rows == nil else {
                return .needsSnapshotRefresh(reason: "Turn patch unexpectedly included full rows.")
            }
            return .applied(applyingTurnPatch(patch))
        case .lifecycle:
            return .applied(replacing(rows: rows, liveState: patch.liveState, viewRevision: patch.viewRevision))
        case .unsupported:
            return .needsSnapshotRefresh(reason: "Unsupported patch scope: \(patch.scope.rawValue)")
        }
    }

    private func applyingTurnPatch(_ patch: GatewayThreadViewPatch) -> ThreadTimeline {
        let removedIds = Set(patch.removeRowIds)
        var rowsById: [String: TimelineRow] = [:]
        for row in rows where !removedIds.contains(row.id) {
            rowsById[row.id] = row
        }
        for row in patch.upsertRows {
            rowsById[row.id] = row
        }
        return replacing(rows: Array(rowsById.values), liveState: patch.liveState, viewRevision: patch.viewRevision)
    }

    private func replacing(rows: [TimelineRow], liveState: ThreadLiveState, viewRevision: Int64) -> ThreadTimeline {
        ThreadTimeline(
            threadId: threadId,
            liveState: liveState,
            viewRevision: viewRevision,
            rows: rows,
            olderCursor: olderCursor,
            hasOlder: hasOlder
        )
    }
}

public enum WorkspaceNormalizer {
    public static func title(name: String?, preview: String?, id: String) -> String {
        if let name, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return name
        }
        if let preview {
            let firstLine = preview
                .split(whereSeparator: \.isNewline)
                .first?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if let firstLine, !firstLine.isEmpty {
                return firstLine
            }
        }
        return "Untitled Thread"
    }

    public static func mergeOlderHistory(current: [TimelineRow], older: [TimelineRow]) -> [TimelineRow] {
        var seen = Set(current.map(\.id))
        let uniqueOlder = older.filter { seen.insert($0.id).inserted }
        return (uniqueOlder + current).sorted { $0.displayOrder < $1.displayOrder }
    }
}
