import Foundation
import KodexCore
import OpenAPIRuntime
import OpenAPIURLSession

public enum KodexAccountState: Equatable, Sendable {
    case unknown
    case authenticated(email: String?)
    case requiresOpenAIAuth
    case unavailable(message: String)

    public var displayText: String {
        switch self {
        case .unknown:
            return "Account unknown"
        case .authenticated(let email):
            return email.map { "Signed in as \($0)" } ?? "Signed in"
        case .requiresOpenAIAuth:
            return "OpenAI auth required"
        case .unavailable(let message):
            return "Account unavailable: \(message)"
        }
    }
}

public enum ThreadInputSubmitDisposition: String, Decodable, Equatable, Sendable {
    case started
    case queued
    case steered
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ThreadInputSubmitDisposition(rawValue: raw) ?? .unknown
    }
}

public struct QueuedInputSummary: Identifiable, Decodable, Equatable, Sendable {
    public let id: String
    public let threadId: String
    public let status: String
    public let priority: String
    public let lastError: String?

    public init(id: String, threadId: String, status: String, priority: String, lastError: String? = nil) {
        self.id = id
        self.threadId = threadId
        self.status = status
        self.priority = priority
        self.lastError = lastError
    }
}

public struct SkillSummary: Identifiable, Decodable, Equatable, Sendable {
    public var id: String { path }
    public let name: String
    public let path: String
    public let description: String
    public let enabled: Bool
    public let shortDescription: String?
}

public struct UploadedImageSummary: Decodable, Equatable, Sendable {
    public let path: String
    public let fileName: String?
}

public struct ComposerSettingsSnapshot: Equatable, Sendable {
    public var settings: ComposerRunSettings
    public var permissionsPreset: String?

    public init(settings: ComposerRunSettings = ComposerRunSettings(), permissionsPreset: String? = nil) {
        self.settings = settings
        self.permissionsPreset = permissionsPreset
    }
}

public struct LiveE2EReadiness: Equatable, Sendable {
    public let connection: GatewayConnectionStatus
    public let account: KodexAccountState

    public init(connection: GatewayConnectionStatus, account: KodexAccountState) {
        self.connection = connection
        self.account = account
    }

    public var skipReason: String? {
        switch connection {
        case .connected:
            break
        case .degraded(let message):
            return "Gateway degraded: \(message)"
        case .offline(let message):
            return "Gateway offline: \(message)"
        case .invalidURL(let message):
            return message
        }

        switch account {
        case .authenticated:
            return nil
        case .requiresOpenAIAuth:
            return "OpenAI auth is required before live iOS E2E can send prompts."
        case .unknown:
            return "Account state is unknown."
        case .unavailable(let message):
            return "Account unavailable: \(message)"
        }
    }
}

public struct SelectedThreadProjection: Equatable, Sendable {
    public let detail: ThreadDetail?
    public let needsRefresh: Bool

    public init(detail: ThreadDetail?, needsRefresh: Bool = false) {
        self.detail = detail
        self.needsRefresh = needsRefresh
    }

    public func applying(_ event: LiveUpdateEvent) -> SelectedThreadProjection {
        guard let detail else {
            return self
        }
        switch event {
        case .threadViewPatch(let threadId, let viewRevision) where threadId == detail.thread.id:
            return SelectedThreadProjection(
                detail: ThreadDetail(
                    thread: detail.thread,
                    timeline: ThreadTimeline(
                        threadId: detail.timeline.threadId,
                        liveState: detail.timeline.liveState,
                        viewRevision: max(detail.timeline.viewRevision, viewRevision),
                        rows: detail.timeline.rows
                    )
                ),
                needsRefresh: false
            )
        case .refreshRequired(let threadId) where threadId == detail.thread.id:
            return SelectedThreadProjection(detail: detail, needsRefresh: true)
        default:
            return self
        }
    }
}

public struct LiveGatewayService: Sendable {
    private let client: GatewayClient
    private let generatedClient: (any APIProtocol)?
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    public init(client: GatewayClient) {
        self.client = client
        self.generatedClient = nil
        self.decoder = JSONDecoder()
        self.encoder = JSONEncoder()
    }

    public init(configuration: GatewayConfiguration) {
        self.client = GatewayClient(configuration: configuration, send: URLSessionGatewayLoader.send)
        self.generatedClient = Client(serverURL: configuration.baseURL, transport: URLSessionTransport())
        self.decoder = JSONDecoder()
        self.encoder = JSONEncoder()
    }

    public func checkConnection() async -> GatewayConnectionStatus {
        await GatewayConnectionChecker(probe: GatewayProbe(load: URLSessionGatewayLoader.load)).check(
            userInput: client.configuration.baseURL.absoluteString
        )
    }

    public func loadAccount() async -> KodexAccountState {
        do {
            if let generatedClient {
                _ = try await generatedClient.read_account(.init())
                let response: AccountResponseDTO = try await decode(.account)
                return Self.accountState(response)
            }
            let response: AccountResponseDTO = try await decode(.account)
            return Self.accountState(response)
        } catch {
            return .unavailable(message: error.localizedDescription)
        }
    }

    public func loadWorkspace() async throws -> WorkspaceSnapshot {
        if let generatedClient {
            do {
                let response = try await generatedClient.get_sidebar_threads(.init())
                return Self.workspace(try response.ok.body.json)
            } catch {
                return try await loadWorkspaceFromRawDTO()
            }
        }
        return try await loadWorkspaceFromRawDTO()
    }

    private func loadWorkspaceFromRawDTO() async throws -> WorkspaceSnapshot {
        let response: SidebarThreadsResponseDTO = try await decode(.sidebarThreads)
        let projects = response.projects.map { project in
            WorkspaceProject(
                id: project.id,
                name: project.name,
                path: project.cwd,
                threads: response.projectThreads[project.id]?.threads.map { Self.workspaceThread($0) } ?? []
            )
        }
        return WorkspaceSnapshot(
            projects: projects,
            chats: response.chatThreads.threads.map { Self.workspaceThread($0) },
            pinned: response.pinnedThreads.threads.map { Self.workspaceThread($0, pinnedOverride: true) }
        )
    }

    private static func threadDetail(from response: ThreadViewResponseDTO) -> ThreadDetail {
        ThreadDetail(
            thread: Self.workspaceThread(response.thread),
            timeline: Self.timeline(response.timeline, fallbackThreadId: response.thread.id, historyPage: response.historyPage)
        )
    }

    public func loadCapabilities() async throws {
        if let generatedClient {
            _ = try await generatedClient.capabilities(.init())
            return
        }
        try await requireSuccess(.capabilities)
    }

    public func loadComposerSettings(projectId: String? = nil) async throws -> ComposerSettingsSnapshot {
        if let generatedClient {
            let response = try await generatedClient.read_composer_settings(.init(query: .init(projectId: projectId)))
            let generated = try response.ok.body.json
            let rawSettings: ComposerSettingsResponseDTO? = try? await decode(.composerSettings(projectId: projectId))
            let snapshot = ComposerSettingsSnapshot(
                settings: ComposerRunSettings(
                    model: generated.model,
                    effort: generated.effort,
                    serviceTier: generated.serviceTier
                ),
                permissionsPreset: rawSettings?.permissionsPreset
            )
            return snapshot
        }
        let response: ComposerSettingsResponseDTO = try await decode(.composerSettings(projectId: projectId))
        return response.snapshot
    }

    public func persistComposerSettings(_ settings: ComposerRunSettings) async throws {
        if let generatedClient {
            _ = try await generatedClient.update_composer_settings(.init(body: .json(.init(
                effort: settings.effort,
                model: settings.model,
                serviceTier: settings.serviceTier
            ))))
            return
        }
        let body = try encode(.object([
            "model": settings.model.map(AnySendable.string) ?? .null,
            "effort": settings.effort.map(AnySendable.string) ?? .null,
            "serviceTier": settings.serviceTier.map(AnySendable.string) ?? .null
        ]))
        try await requireSuccess(.composerSettings(projectId: nil), method: .patch, body: body)
    }

    public func loadThreadDetail(threadId: String) async throws -> ThreadDetail {
        if let generatedClient {
            do {
                _ = try await generatedClient.get_thread(.init(path: .init(threadId: threadId)))
                let response: ThreadViewResponseDTO = try await decode(.thread(threadId))
                return Self.threadDetail(from: response)
            } catch {
                let response: ThreadViewResponseDTO = try await decode(.thread(threadId))
                return Self.threadDetail(from: response)
            }
        }
        let response: ThreadViewResponseDTO = try await decode(.thread(threadId))
        return Self.threadDetail(from: response)
    }

    public func loadOlderTimeline(threadId: String, cursor: String?, limit: Int? = 50) async throws -> ThreadDetail {
        if let generatedClient {
            do {
                _ = try await generatedClient.get_thread_timeline_page(.init(
                    path: .init(threadId: threadId),
                    query: .init(cursor: cursor, limit: limit.map(Int32.init))
                ))
                let response: ThreadViewResponseDTO = try await decode(.threadTimelinePage(threadId: threadId, cursor: cursor, limit: limit))
                return Self.threadDetail(from: response)
            } catch {
                let response: ThreadViewResponseDTO = try await decode(.threadTimelinePage(threadId: threadId, cursor: cursor, limit: limit))
                return Self.threadDetail(from: response)
            }
        }
        let response: ThreadViewResponseDTO = try await decode(.threadTimelinePage(threadId: threadId, cursor: cursor, limit: limit))
        return Self.threadDetail(from: response)
    }

    public func createChatThread(firstMessageText: String) async throws -> WorkspaceThread {
        if let generatedClient {
            let response = try await generatedClient.create_chat_thread(.init(body: .json(.init(firstMessageText: firstMessageText))))
            return Self.workspaceThread(try response.ok.body.json.thread)
        }
        let body = try encode(.object(["firstMessageText": .string(firstMessageText)]))
        let response: ThreadCommandResponseDTO = try await decode(.createChatThread, method: .post, body: body)
        return Self.workspaceThread(response.thread)
    }

    public func createProjectThread(projectId: String) async throws -> WorkspaceThread {
        if let generatedClient {
            let response = try await generatedClient.create_thread(.init(body: .json(.init(projectId: projectId))))
            return Self.workspaceThread(try response.ok.body.json.thread)
        }
        let body = try encode(.object(["projectId": .string(projectId)]))
        let response: ThreadCommandResponseDTO = try await decode(.createProjectThread, method: .post, body: body)
        return Self.workspaceThread(response.thread)
    }

    public func markThreadSeen(threadId: String, seenCompletedAgentTurnSeq: Int? = nil) async throws {
        if let generatedClient {
            _ = try await generatedClient.mark_thread_seen(.init(
                path: .init(threadId: threadId),
                body: .json(.init(seenCompletedAgentTurnSeq: seenCompletedAgentTurnSeq.map(Int64.init)))
            ))
            return
        }
        let body = try encode(.object(["seenCompletedAgentTurnSeq": seenCompletedAgentTurnSeq.map { .int($0) } ?? .null]))
        try await requireSuccess(.threadSeen(threadId), method: .post, body: body)
    }

    public func pinThread(threadId: String, pinned: Bool) async throws {
        if let generatedClient {
            if pinned {
                _ = try await generatedClient.pin_thread(.init(path: .init(threadId: threadId)))
            } else {
                _ = try await generatedClient.unpin_thread(.init(path: .init(threadId: threadId)))
            }
            return
        }
        try await requireSuccess(.threadPin(threadId), method: pinned ? .post : .delete)
    }

    public func renameThread(threadId: String, name: String) async throws {
        if let generatedClient {
            _ = try await generatedClient.rename_thread(.init(
                path: .init(threadId: threadId),
                body: .json(.init(name: name))
            ))
            return
        }
        let body = try encode(.object(["name": .string(name)]))
        try await requireSuccess(.threadName(threadId), method: .patch, body: body)
    }

    public func archiveThread(threadId: String) async throws {
        if let generatedClient {
            _ = try await generatedClient.archive_thread(.init(path: .init(threadId: threadId)))
            return
        }
        try await requireSuccess(.threadArchive(threadId), method: .post)
    }

    public func setThreadNotifications(threadId: String, enabled: Bool) async throws {
        if let generatedClient {
            _ = try await generatedClient.update_thread_notifications(.init(
                path: .init(threadId: threadId),
                body: .json(.init(enabled: enabled))
            ))
            return
        }
        let body = try encode(.object(["enabled": .bool(enabled)]))
        try await requireSuccess(.threadNotifications(threadId), method: .patch, body: body)
    }

    public func submitTextInput(threadId: String, text: String, skillMentions: [SkillMention] = [], localImagePaths: [String] = [], settings: ComposerRunSettings = ComposerRunSettings()) async throws -> ThreadInputSubmitDisposition {
        if let generatedClient {
            let response = try await generatedClient.submit_thread_input(.init(
                path: .init(threadId: threadId),
                body: .json(try Self.turnStartRequest(text: text, skillMentions: skillMentions, localImagePaths: localImagePaths, settings: settings))
            ))
            return ThreadInputSubmitDisposition(rawValue: try response.ok.body.json.disposition.rawValue) ?? .unknown
        }
        let body = try encode(ComposerPayloadBuilder.turnStartPayload(text: text, skillMentions: skillMentions, localImagePaths: localImagePaths, settings: settings))
        let response: ThreadInputResponseDTO = try await decode(.threadInput(threadId), method: .post, body: body)
        return response.disposition
    }

    public func listQueuedInputs(threadId: String) async throws -> [QueuedInputSummary] {
        if let generatedClient {
            let response = try await generatedClient.list_queued_inputs(.init(path: .init(threadId: threadId)))
            return try response.ok.body.json.queuedInputs.map(Self.queuedInput)
        }
        let response: QueuedInputListResponseDTO = try await decode(.queuedInputs(threadId))
        return response.queuedInputs
    }

    public func createQueuedInput(threadId: String, text: String, settings: ComposerRunSettings = ComposerRunSettings()) async throws -> QueuedInputSummary {
        if let generatedClient {
            let response = try await generatedClient.create_queued_input(.init(
                path: .init(threadId: threadId),
                body: .json(try Self.queuedInputCreateRequest(text: text, settings: settings))
            ))
            return Self.queuedInput(try response.ok.body.json.queuedInput)
        }
        let body = try encode(ComposerPayloadBuilder.turnStartPayload(text: text, settings: settings))
        let response: QueuedInputResponseDTO = try await decode(.queuedInputs(threadId), method: .post, body: body)
        return response.queuedInput
    }

    public func retryQueuedInput(threadId: String, queueId: String) async throws -> QueuedInputSummary {
        if let generatedClient {
            let response = try await generatedClient.retry_queued_input(.init(path: .init(threadId: threadId, queueId: queueId)))
            return Self.queuedInput(try response.ok.body.json.queuedInput)
        }
        let response: QueuedInputResponseDTO = try await decode(.queuedInputRetry(threadId: threadId, queueId: queueId), method: .post)
        return response.queuedInput
    }

    public func steerQueuedInput(threadId: String, queueId: String) async throws -> QueuedInputSummary {
        if let generatedClient {
            let response = try await generatedClient.steer_queued_input(.init(path: .init(threadId: threadId, queueId: queueId)))
            return Self.queuedInput(try response.ok.body.json.queuedInput)
        }
        let response: QueuedInputResponseDTO = try await decode(.queuedInputSteer(threadId: threadId, queueId: queueId), method: .post)
        return response.queuedInput
    }

    public func deleteQueuedInput(threadId: String, queueId: String) async throws {
        if let generatedClient {
            _ = try await generatedClient.delete_queued_input(.init(path: .init(threadId: threadId, queueId: queueId)))
            return
        }
        try await requireSuccess(.queuedInput(threadId: threadId, queueId: queueId), method: .delete)
    }

    public func stopCurrentTurn(threadId: String) async throws {
        if let generatedClient {
            _ = try await generatedClient.interrupt_current_turn(.init(path: .init(threadId: threadId)))
            return
        }
        try await requireSuccess(.threadInterruptCurrent(threadId), method: .post)
    }

    public func listSkills(cwd: String?, forceReload: Bool = false) async throws -> [SkillSummary] {
        if let generatedClient {
            let response = try await generatedClient.list_skills(.init(query: .init(cwd: cwd, forceReload: forceReload)))
            return try response.ok.body.json.skills.map(Self.skill).filter(\.enabled)
        }
        let response: SkillsCatalogResponseDTO = try await decode(.skills(cwd: cwd, forceReload: forceReload))
        return response.skills.filter(\.enabled)
    }

    public func listPendingApprovals(threadId: String? = nil) async throws -> [ApprovalRequest] {
        if let generatedClient {
            _ = try await generatedClient.list_approvals(.init(query: .init(status: "pending", threadId: threadId)))
            let response: ApprovalListResponseDTO = try await decode(.approvals(status: "pending", threadId: threadId))
            return response.approvals.map(Self.approval)
        }
        let response: ApprovalListResponseDTO = try await decode(.approvals(status: "pending", threadId: threadId))
        return response.approvals.map(Self.approval)
    }

    public func decideApproval(approvalId: String, decision: ApprovalDecision) async throws {
        if let generatedClient {
            _ = try await generatedClient.decide_approval(.init(
                path: .init(approvalId: approvalId),
                body: .json(.init(decision: try Self.openAPIValue(.object(["decision": .string(decision.gatewayValue)]))))
            ))
            return
        }
        let body = try encode(ApprovalDecisionPayloadBuilder.payload(for: decision))
        try await requireSuccess(.approvalDecision(approvalId), method: .post, body: body)
    }

    public func uploadImageData(_ imageData: Data, fileName: String, mimeType: String = "image/png") async throws -> [UploadedImageSummary] {
        let boundary = "KodexBoundary-\(UUID().uuidString)"
        var body = Data()
        body.appendString("--\(boundary)\r\n")
        body.appendString("Content-Disposition: form-data; name=\"images\"; filename=\"\(fileName)\"\r\n")
        body.appendString("Content-Type: \(mimeType)\r\n\r\n")
        body.append(imageData)
        body.appendString("\r\n--\(boundary)--\r\n")

        var request = client.request(.imageUploads, method: .post, body: body)
        request = GatewayRequest(
            method: request.method,
            url: request.url,
            headers: ["Accept": "application/json", "Content-Type": "multipart/form-data; boundary=\(boundary)"],
            body: body
        )
        let data: Data
        switch await client.send(request) {
        case .success(let responseData):
            data = responseData
        case .failure(let error):
            throw error
        }
        let response = try decoder.decode(Components.Schemas.ImageUploadResponse.self, from: data)
        return response.images.map(Self.uploadedImage)
    }

    public func loadNativeNotificationStatus() async throws {
        if let generatedClient {
            _ = try await generatedClient.native_notification_status(.init())
            return
        }
        try await requireSuccess(.nativeNotificationStatus)
    }

    public func unregisterApnsDevice(deviceId: String) async throws {
        if let generatedClient {
            _ = try await generatedClient.delete_apns_device(.init(path: .init(deviceId: deviceId)))
            return
        }
        try await requireSuccess(.apnsDeviceDelete(deviceId), method: .delete)
    }

    private func decode<T: Decodable>(_ route: GatewayRoute, method: GatewayHTTPMethod = .get, body: Data? = nil) async throws -> T {
        let data = try await requestData(route, method: method, body: body)
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw GatewayClientError.decoding("Failed to decode \(T.self): \(error.localizedDescription)")
        }
    }

    private func requireSuccess(_ route: GatewayRoute, method: GatewayHTTPMethod = .get, body: Data? = nil) async throws {
        _ = try await requestData(route, method: method, body: body)
    }

    private func requestData(_ route: GatewayRoute, method: GatewayHTTPMethod = .get, body: Data? = nil) async throws -> Data {
        switch await client.send(route, method: method, body: body) {
        case .success(let data):
            return data
        case .failure(let error):
            throw error
        }
    }

    private func encode(_ value: AnySendable) throws -> Data {
        do {
            return try encoder.encode(value)
        } catch {
            throw GatewayClientError.decoding(error.localizedDescription)
        }
    }

    private static func turnStartRequest(
        text: String,
        skillMentions: [SkillMention],
        localImagePaths: [String],
        settings: ComposerRunSettings
    ) throws -> Components.Schemas.TurnStartRequest {
        var input: [Components.Schemas.UserInput] = [
            .case1(.init(
                text: text,
                text_elements: skillMentions.map {
                    let range = ComposerPayloadBuilder.byteRange(for: $0.range, in: text)
                    return .init(byteRange: .init(end: Int32(range.end), start: Int32(range.start)))
                },
                _type: .text
            ))
        ]
        input.append(contentsOf: skillMentions.map {
            .case4(.init(name: $0.name, path: $0.path, _type: .skill))
        })
        input.append(contentsOf: localImagePaths.map {
            .case3(.init(path: $0, _type: .localImage))
        })

        return .init(
            value1: .init(
                approvalPolicy: settings.approvalPolicy,
                effort: settings.effort,
                model: settings.model,
                sandboxPolicy: try settings.sandboxPolicy.map(openAPIValue),
                serviceTier: settings.serviceTier
            ),
            value2: .init(input: input)
        )
    }

    private static func queuedInputCreateRequest(
        text: String,
        settings: ComposerRunSettings
    ) throws -> Components.Schemas.QueuedInputCreateRequest {
        .init(
            value1: .init(
                approvalPolicy: settings.approvalPolicy,
                effort: settings.effort,
                model: settings.model,
                sandboxPolicy: try settings.sandboxPolicy.map(openAPIValue),
                serviceTier: settings.serviceTier
            ),
            value2: .init(input: [
                .case1(.init(text: text, text_elements: [], _type: .text))
            ])
        )
    }


    private static func openAPIValue(_ value: AnySendable) throws -> OpenAPIValueContainer {
        try OpenAPIValueContainer(unvalidatedValue: value.openAPIValue)
    }

    private static func accountState(_ dto: AccountResponseDTO) -> KodexAccountState {
        if let account = dto.account {
            return .authenticated(email: account.email)
        }
        if dto.requiresOpenaiAuth {
            return .requiresOpenAIAuth
        }
        return .authenticated(email: nil)
    }

    private static func workspaceThread(_ dto: ThreadSummaryDTO, pinnedOverride: Bool? = nil) -> WorkspaceThread {
        WorkspaceThread(
            id: dto.id,
            title: WorkspaceNormalizer.title(name: dto.name, cwd: dto.cwd, id: dto.id),
            cwd: dto.cwd,
            status: ThreadStatus(rawValue: dto.status) ?? .idle,
            unread: dto.unreadCompletedAgentTurn,
            pinned: pinnedOverride ?? (dto.pinnedAt != nil),
            notificationsEnabled: dto.notificationsEnabled
        )
    }

    private static func workspace(_ dto: Components.Schemas.SidebarThreadsResponse) -> WorkspaceSnapshot {
        let projects = dto.projects.map { project in
            WorkspaceProject(
                id: project.id,
                name: project.name,
                path: project.cwd,
                threads: dto.projectThreads.additionalProperties[project.id]?.threads.map { workspaceThread($0) } ?? []
            )
        }
        return WorkspaceSnapshot(
            projects: projects,
            chats: dto.chatThreads.threads.map { workspaceThread($0) },
            pinned: dto.pinnedThreads.threads.map { workspaceThread($0, pinnedOverride: true) }
        )
    }

    private static func threadDetail(_ dto: Components.Schemas.ThreadViewResponse) -> ThreadDetail {
        ThreadDetail(
            thread: workspaceThread(dto.thread),
            timeline: timeline(dto.timeline, fallbackThreadId: dto.thread.id)
        )
    }

    private static func workspaceThread(_ dto: Components.Schemas.SidebarThreadSummary, pinnedOverride: Bool? = nil) -> WorkspaceThread {
        WorkspaceThread(
            id: dto.id,
            title: WorkspaceNormalizer.title(name: dto.name, cwd: dto.cwd, id: dto.id),
            cwd: dto.cwd,
            status: ThreadStatus(rawValue: dto.status.rawValue) ?? .idle,
            unread: dto.unreadCompletedAgentTurn,
            pinned: pinnedOverride ?? (dto.pinnedAt != nil),
            notificationsEnabled: dto.notificationsEnabled
        )
    }

    private static func workspaceThread(_ dto: Components.Schemas.ThreadSummary, pinnedOverride: Bool? = nil) -> WorkspaceThread {
        WorkspaceThread(
            id: dto.id,
            title: WorkspaceNormalizer.title(name: dto.name, cwd: dto.cwd, id: dto.id),
            cwd: dto.cwd,
            status: ThreadStatus(rawValue: dto.status.rawValue) ?? .idle,
            unread: dto.unreadCompletedAgentTurn,
            pinned: pinnedOverride ?? (dto.pinnedAt != nil),
            notificationsEnabled: dto.notificationsEnabled
        )
    }

    private static func workspaceThread(_ dto: Components.Schemas.ThreadViewThreadSummary) -> WorkspaceThread {
        WorkspaceThread(
            id: dto.id,
            title: WorkspaceNormalizer.title(name: dto.name, cwd: dto.cwd, id: dto.id),
            cwd: dto.cwd,
            status: ThreadStatus(rawValue: dto.status.rawValue) ?? .idle,
            unread: dto.unreadCompletedAgentTurn,
            pinned: dto.pinnedAt != nil,
            notificationsEnabled: dto.notificationsEnabled
        )
    }

    private static func timeline(_ dto: Components.Schemas.ThreadTimelineSnapshot, fallbackThreadId: String) -> ThreadTimeline {
        ThreadTimeline(
            threadId: fallbackThreadId,
            liveState: ThreadLiveState(rawValue: dto.liveState.rawValue) ?? .idle,
            viewRevision: dto.viewRevision,
            rows: dto.rows.map { row in
                TimelineRow(
                    id: row.id,
                    kind: TimelineRowKind(
                        gatewayKind: row.kind,
                        status: row.status,
                        hasFileChanges: !row.fileChanges.isEmpty,
                        itemType: row.items.first?.itemType
                    ),
                    displayOrder: row.displayOrder,
                    title: generatedRowTitle(row),
                    body: generatedRowBody(row),
                    status: row.status
                )
            },
            olderCursor: nil,
            hasOlder: false
        )
    }

    private static func generatedRowTitle(_ row: Components.Schemas.ThreadTimelineRow) -> String {
        if let role = generatedRole(row.items.first), !role.isEmpty {
            return role.capitalized
        }
        return row.kind.replacingOccurrences(of: "_", with: " ").capitalized
    }

    private static func generatedRowBody(_ row: Components.Schemas.ThreadTimelineRow) -> String {
        if let text = row.items.lazy.compactMap(generatedText).first, !text.isEmpty {
            return text
        }
        if !row.fileChanges.isEmpty {
            return row.fileChanges.map(\.path).joined(separator: "\n")
        }
        return row.status
    }

    private static func generatedRole(_ item: Components.Schemas.ThreadTimelineSnapshotItem?) -> String? {
        item?.payload.item.agentRole ?? item?.payload.item.agent_role ?? item?.itemType
    }

    private static func generatedText(_ item: Components.Schemas.ThreadTimelineSnapshotItem) -> String? {
        item.payload.item.text
            ?? item.payload.item.message
            ?? item.payload.item.output
            ?? item.payload.item.result
            ?? item.payload.item.review
            ?? item.payload.item.command
            ?? item.payload.item.name
            ?? item.payload.item.summary?.stringValue
    }

    private static func queuedInput(_ dto: Components.Schemas.QueuedInput) -> QueuedInputSummary {
        QueuedInputSummary(
            id: dto.id,
            threadId: dto.threadId,
            status: dto.status.rawValue,
            priority: dto.priority.rawValue,
            lastError: dto.lastError
        )
    }

    private static func skill(_ dto: Components.Schemas.SkillMetadata) -> SkillSummary {
        SkillSummary(
            name: dto.name,
            path: dto.path,
            description: dto.description,
            enabled: dto.enabled,
            shortDescription: dto.shortDescription
        )
    }

    private static func approval(_ dto: ApprovalDTO) -> ApprovalRequest {
        ApprovalRequest(
            id: dto.id,
            threadId: dto.threadId ?? "",
            title: approvalTitle(method: dto.method),
            risk: approvalRisk(method: dto.method, payload: dto.payload),
            context: approvalContext(method: dto.method, payload: dto.payload)
        )
    }

    private static func approvalTitle(method: String) -> String {
        switch method {
        case "item/commandExecution/requestApproval":
            return "Command Approval"
        case "item/fileChange/requestApproval":
            return "File Change Approval"
        case "item/permissions/requestApproval":
            return "Permissions Approval"
        default:
            return method.replacingOccurrences(of: "/", with: " ")
        }
    }

    private static func approvalRisk(method: String, payload: AnySendable) -> String {
        let context = approvalContext(method: method, payload: payload).lowercased()
        if method.contains("commandExecution") || method.contains("permissions") {
            return "high"
        }
        if method.contains("fileChange") || context.contains("write") || context.contains("delete") {
            return "medium"
        }
        if ApprovalRiskPolicy.requiresConfirmation(
            ApprovalRequest(id: "probe", threadId: "", title: method, risk: "low", context: context),
            decision: .accept
        ) {
            return "medium"
        }
        return "low"
    }

    private static func approvalContext(method: String, payload: AnySendable) -> String {
        let values = payload.flatStringValues(preferredKeys: ["command", "cmd", "path", "cwd", "reason", "description", "summary", "title"])
        if values.isEmpty {
            return method
        }
        return values.prefix(4).joined(separator: "\n")
    }

    private static func uploadedImage(_ dto: Components.Schemas.ImageUpload) -> UploadedImageSummary {
        UploadedImageSummary(path: dto.path, fileName: dto.fileName)
    }

    private static func timeline(_ dto: ThreadTimelineSnapshotDTO, fallbackThreadId: String, historyPage: ThreadTimelineWindowPageDTO? = nil) -> ThreadTimeline {
        ThreadTimeline(
            threadId: fallbackThreadId,
            liveState: ThreadLiveState(rawValue: dto.liveState) ?? .idle,
            viewRevision: dto.viewRevision,
            rows: dto.rows.map { row in
                TimelineRow(
                    id: row.id,
                    kind: TimelineRowKind(
                        gatewayKind: row.kind,
                        status: row.status,
                        hasFileChanges: !row.fileChanges.isEmpty,
                        itemType: row.item?.itemType ?? row.items.first?.itemType
                    ),
                    displayOrder: row.displayOrder,
                    title: row.title,
                    body: row.body,
                    status: row.status
                )
            },
            olderCursor: historyPage?.olderCursor,
            hasOlder: historyPage?.hasOlder ?? false
        )
    }
}

private struct AccountResponseDTO: Decodable {
    let requiresOpenaiAuth: Bool
    let account: AccountSummaryDTO?
}

private struct AccountSummaryDTO: Decodable {
    let email: String?
}

private struct ComposerSettingsResponseDTO: Decodable {
    let model: String?
    let effort: String?
    let serviceTier: String?
    let permissionsPreset: String?

    var snapshot: ComposerSettingsSnapshot {
        ComposerSettingsSnapshot(
            settings: ComposerRunSettings(model: model, effort: effort, serviceTier: serviceTier),
            permissionsPreset: permissionsPreset
        )
    }
}

private struct SidebarThreadsResponseDTO: Decodable {
    let projects: [ProjectDTO]
    let projectThreads: [String: SidebarThreadListResponseDTO]
    let chatThreads: SidebarThreadListResponseDTO
    let pinnedThreads: SidebarThreadListResponseDTO
}

private struct ProjectDTO: Decodable {
    let id: String
    let name: String
    let cwd: String
}

private struct SidebarThreadListResponseDTO: Decodable {
    let threads: [ThreadSummaryDTO]
}

private struct ThreadViewResponseDTO: Decodable {
    let thread: ThreadSummaryDTO
    let timeline: ThreadTimelineSnapshotDTO
    let historyPage: ThreadTimelineWindowPageDTO?
}

private struct ThreadTimelineWindowPageDTO: Decodable {
    let olderCursor: String?
    let hasOlder: Bool
}

private extension ThreadDetail {
    func withHistoryPage(from response: ThreadViewResponseDTO) -> ThreadDetail {
        ThreadDetail(
            thread: thread,
            timeline: ThreadTimeline(
                threadId: timeline.threadId,
                liveState: timeline.liveState,
                viewRevision: timeline.viewRevision,
                rows: timeline.rows,
                olderCursor: response.historyPage?.olderCursor,
                hasOlder: response.historyPage?.hasOlder ?? false
            )
        )
    }
}

private struct ThreadCommandResponseDTO: Decodable {
    let thread: ThreadSummaryDTO
}

private struct ThreadSummaryDTO: Decodable {
    let id: String
    let name: String?
    let cwd: String
    let status: String
    let unreadCompletedAgentTurn: Bool
    let notificationsEnabled: Bool
    let pinnedAt: String?
}

private struct ThreadTimelineSnapshotDTO: Decodable {
    let viewRevision: Int64
    let liveState: String
    let rows: [ThreadTimelineRowDTO]
}

private struct ThreadTimelineRowDTO: Decodable {
    let id: String
    let kind: String
    let displayOrder: Int64
    let status: String
    let items: [ThreadTimelineItemDTO]
    let item: ThreadTimelineItemDTO?
    let fileChanges: [ThreadTimelineFileChangeDTO]
    let work: ThreadTimelineWorkSummaryDTO?

    var title: String {
        if let workTitle = work?.title, !workTitle.isEmpty {
            return workTitle
        }
        if let role = item?.role ?? items.first?.role, !role.isEmpty {
            return role.capitalized
        }
        return kind.replacingOccurrences(of: "_", with: " ").capitalized
    }

    var body: String {
        if let text = item?.text ?? items.lazy.compactMap(\.text).first, !text.isEmpty {
            return text
        }
        if let summary = work?.summary, !summary.isEmpty {
            return summary
        }
        if !fileChanges.isEmpty {
            return fileChanges.map(\.path).joined(separator: "\n")
        }
        return status
    }
}

private struct ThreadTimelineItemDTO: Decodable {
    let itemType: String
    let payload: TimelineItemPayloadDTO

    var role: String? { payload.role }
    var text: String? { payload.text ?? payload.message ?? payload.title }
}

private struct TimelineItemPayloadDTO: Decodable {
    let role: String?
    let text: String?
    let message: String?
    let title: String?

    private enum CodingKeys: String, CodingKey {
        case role
        case text
        case message
        case title
        case item
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let nestedItem = try container.decodeIfPresent(TimelineNestedItemDTO.self, forKey: .item)
        let nestedText = nestedItem?.text ?? nestedItem?.content?.compactMap(\.text).first
        role = try container.decodeIfPresent(String.self, forKey: .role) ?? nestedItem?.role
        text = try container.decodeIfPresent(String.self, forKey: .text) ?? nestedText
        message = try container.decodeIfPresent(String.self, forKey: .message)
        title = try container.decodeIfPresent(String.self, forKey: .title)
    }
}

private struct TimelineNestedItemDTO: Decodable {
    let type: String?
    let role: String?
    let text: String?
    let content: [TimelineNestedContentDTO]?

    var inferredRole: String? {
        switch type {
        case "userMessage":
            return "User"
        case "agentMessage":
            return "Assistant"
        default:
            return nil
        }
    }

    private enum CodingKeys: String, CodingKey {
        case type
        case role
        case text
        case content
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decodeIfPresent(String.self, forKey: .type)
        role = try container.decodeIfPresent(String.self, forKey: .role) ?? TimelineNestedItemDTO.inferredRole(for: type)
        text = try container.decodeIfPresent(String.self, forKey: .text)
        content = try container.decodeIfPresent([TimelineNestedContentDTO].self, forKey: .content)
    }

    private static func inferredRole(for type: String?) -> String? {
        switch type {
        case "userMessage":
            return "User"
        case "agentMessage":
            return "Assistant"
        default:
            return nil
        }
    }
}

private struct TimelineNestedContentDTO: Decodable {
    let text: String?
}

private struct ThreadTimelineFileChangeDTO: Decodable {
    let path: String
}

private struct ThreadTimelineWorkSummaryDTO: Decodable {
    let title: String?
    let summary: String?
}

private struct ThreadInputResponseDTO: Decodable {
    let disposition: ThreadInputSubmitDisposition
}

private struct QueuedInputListResponseDTO: Decodable {
    let queuedInputs: [QueuedInputSummary]
}

private struct QueuedInputResponseDTO: Decodable {
    let queuedInput: QueuedInputSummary
}

private struct SkillsCatalogResponseDTO: Decodable {
    let skills: [SkillSummary]
}

private struct ApprovalListResponseDTO: Decodable {
    let approvals: [ApprovalDTO]
}

private struct ApprovalDTO: Decodable {
    let id: String
    let method: String
    let status: String
    let threadId: String?
    let payload: AnySendable
}

private struct ImageUploadResponseDTO: Decodable {
    let images: [UploadedImageSummary]
}

private extension Data {
    mutating func appendString(_ string: String) {
        append(Data(string.utf8))
    }
}

private extension OpenAPIValueContainer {
    var stringValue: String? {
        value as? String
    }
}

private extension AnySendable {
    var openAPIValue: (any Sendable)? {
        switch self {
        case .string(let value):
            return value
        case .int(let value):
            return value
        case .double(let value):
            return value
        case .bool(let value):
            return value
        case .array(let values):
            return values.map(\.openAPIValue)
        case .object(let object):
            return object.mapValues(\.openAPIValue)
        case .null:
            return nil
        }
    }
}
