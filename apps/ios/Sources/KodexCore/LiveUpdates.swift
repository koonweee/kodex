import Foundation

public enum GatewayLiveEvent: Equatable, Sendable {
    case threadViewPatch(GatewayThreadViewPatch)
    case refreshRequired(threadId: String)
    case threadReadUpdated(threadId: String)
    case threadPinUpdated(threadId: String)
    case threadNotificationsUpdated(threadId: String)
    case threadUpserted(threadId: String)
    case queuedInputUpdated(threadId: String)
    case approvalUpdated(threadId: String?)
    case unknown(kind: String)

    public var threadId: String? {
        switch self {
        case .threadViewPatch(let patch):
            return patch.threadId
        case .refreshRequired(let threadId),
             .threadReadUpdated(let threadId),
             .threadPinUpdated(let threadId),
             .threadNotificationsUpdated(let threadId),
             .threadUpserted(let threadId),
             .queuedInputUpdated(let threadId):
            return threadId
        case .approvalUpdated(let threadId):
            return threadId
        case .unknown:
            return nil
        }
    }
}

public struct GatewayLiveEnvelope: Equatable, Sendable {
    public let seq: Int64?
    public let event: GatewayLiveEvent

    public init(seq: Int64?, event: GatewayLiveEvent) {
        self.seq = seq
        self.event = event
    }
}

public struct GatewayStreamCheckpoint: Equatable, Sendable {
    public private(set) var cursor: Int64?
    public private(set) var reconnectAttempts: Int

    public init(cursor: Int64? = nil, reconnectAttempts: Int = 0) {
        self.cursor = cursor
        self.reconnectAttempts = reconnectAttempts
    }

    public mutating func observe(_ envelope: GatewayLiveEnvelope) {
        guard let seq = envelope.seq else {
            return
        }
        cursor = max(cursor ?? 0, seq)
        reconnectAttempts = 0
    }

    public mutating func recordDisconnect() {
        reconnectAttempts += 1
    }

    public mutating func reset() {
        cursor = nil
        reconnectAttempts = 0
    }

    public func shouldUsePollingFallback(threshold: Int = 2) -> Bool {
        reconnectAttempts >= threshold
    }
}

public enum GatewayEventScope: Equatable, Sendable {
    case selected(threadId: String)
    case global(excludingThreadId: String?)

    public func accepts(threadId: String?) -> Bool {
        switch self {
        case .selected(let selectedThreadId):
            return threadId == selectedThreadId
        case .global(let excludedThreadId):
            return threadId == nil || threadId != excludedThreadId
        }
    }
}

public struct GatewayLiveEventDecoder: Sendable {
    public init() {}

    public func decode(_ data: Data) throws -> GatewayLiveEvent {
        let envelope = try JSONDecoder().decode(EventEnvelope.self, from: data)
        return event(from: envelope)
    }

    public func decodeEnvelope(_ data: Data) throws -> GatewayLiveEnvelope {
        let envelope = try JSONDecoder().decode(EventEnvelope.self, from: data)
        return GatewayLiveEnvelope(seq: envelope.seq, event: event(from: envelope))
    }

    private func event(from envelope: EventEnvelope) -> GatewayLiveEvent {
        switch envelope.kind {
        case "thread_view.patch":
            return .threadViewPatch(envelope.payload.threadViewPatch)
        case "thread_view.refresh_required":
            return .refreshRequired(threadId: envelope.payload.threadId ?? "")
        case "thread.read_updated":
            return .threadReadUpdated(threadId: envelope.payload.threadId ?? "")
        case "thread.pin_updated":
            return .threadPinUpdated(threadId: envelope.payload.threadId ?? "")
        case "thread.notifications_updated":
            return .threadNotificationsUpdated(threadId: envelope.payload.threadId ?? "")
        case "thread.upserted":
            return .threadUpserted(threadId: envelope.payload.threadId ?? envelope.payload.thread?.id ?? "")
        case "turn_queue.item_upsert", "turn_queue.item_deleted", "queued_input.created", "queued_input.updated", "queued_input.deleted":
            return .queuedInputUpdated(threadId: envelope.payload.threadId ?? "")
        case "approval.created", "approval.updated", "approval.resolved":
            return .approvalUpdated(threadId: envelope.payload.threadId)
        default:
            return .unknown(kind: envelope.kind)
        }
    }
}

public struct GatewayEventStream: Sendable {
    public let configuration: GatewayConfiguration
    public let cursor: Int64?
    public let threadId: String?
    public let excludeThreadId: String?
    public let decoder: GatewayLiveEventDecoder

    public init(configuration: GatewayConfiguration, cursor: Int64? = nil, threadId: String? = nil, excludeThreadId: String? = nil, decoder: GatewayLiveEventDecoder = GatewayLiveEventDecoder()) {
        self.configuration = configuration
        self.cursor = cursor
        self.threadId = threadId
        self.excludeThreadId = excludeThreadId
        self.decoder = decoder
    }

    public func events() -> AsyncThrowingStream<GatewayLiveEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await envelope in envelopes() {
                        continuation.yield(envelope.event)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    public func envelopes() -> AsyncThrowingStream<GatewayLiveEnvelope, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var request = URLRequest(url: configuration.endpoint(.events(cursor: cursor, projectId: nil, threadId: threadId, excludeThreadId: excludeThreadId)))
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
                        throw GatewayClientError.gateway(statusCode: (response as? HTTPURLResponse)?.statusCode ?? 0, message: "Live event stream failed.")
                    }
                    var dataLines: [String] = []
                    for try await line in bytes.lines {
                        if Task.isCancelled {
                            break
                        }
                        if line.hasPrefix("data:") {
                            dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
                        } else if line.isEmpty, !dataLines.isEmpty {
                            let payload = dataLines.joined(separator: "\n")
                            dataLines.removeAll(keepingCapacity: true)
                            if let data = payload.data(using: .utf8) {
                                continuation.yield(try decoder.decodeEnvelope(data))
                            }
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }
}

public enum GatewayLiveEventBatch {
    public static func coalesce(_ envelopes: [GatewayLiveEnvelope]) -> [GatewayLiveEnvelope] {
        let sorted = envelopes.sorted { ($0.seq ?? 0) < ($1.seq ?? 0) }
        var result: [GatewayLiveEnvelope] = []
        var turnPatchIndexes: [String: Int] = [:]

        for envelope in sorted {
            guard let key = turnPatchCoalesceKey(envelope) else {
                result.append(envelope)
                continue
            }
            if let existingIndex = turnPatchIndexes[key] {
                result[existingIndex] = envelope
            } else {
                turnPatchIndexes[key] = result.count
                result.append(envelope)
            }
        }

        return result.sorted { ($0.seq ?? 0) < ($1.seq ?? 0) }
    }

    private static func turnPatchCoalesceKey(_ envelope: GatewayLiveEnvelope) -> String? {
        guard case .threadViewPatch(let patch) = envelope.event else {
            return nil
        }
        guard patch.scope == .turn, !patch.upsertRows.isEmpty, patch.removeRowIds.isEmpty else {
            return nil
        }
        let rowIds = patch.upsertRows.map(\.id)
        guard rowIds.count == Set(rowIds).count else {
            return nil
        }
        let turnId = patch.activeTurnId ?? patch.upsertRows.first?.turnId
        guard let turnId, !turnId.isEmpty else {
            return nil
        }
        return "\(patch.threadId):\(turnId):\(rowIds.sorted().joined(separator: ","))"
    }
}

private struct EventEnvelope: Decodable {
    let seq: Int64?
    let kind: String
    let payload: EventPayload
}

private struct EventPayload: Decodable {
    let threadId: String?
    let thread: EventThreadPayload?
    let viewRevision: Int64?
    let scope: String?
    let liveState: String?
    let activeTurnId: String?
    let rows: [EventTimelineRow]?
    let upsertRows: [EventTimelineRow]?
    let removeRowIds: [String]?

    var threadViewPatch: GatewayThreadViewPatch {
        GatewayThreadViewPatch(
            threadId: threadId ?? "",
            viewRevision: viewRevision ?? 0,
            scope: GatewayThreadViewPatchScope(rawValue: scope ?? ""),
            liveState: ThreadLiveState(rawValue: liveState ?? "") ?? .syncing,
            activeTurnId: activeTurnId,
            rows: rows?.map(\.timelineRow),
            upsertRows: upsertRows?.map(\.timelineRow) ?? [],
            removeRowIds: removeRowIds ?? []
        )
    }
}

private struct EventThreadPayload: Decodable {
    let id: String?
}

private struct EventTimelineRow: Decodable {
    let id: String
    let kind: String
    let displayOrder: Int64
    let status: String
    let turnId: String?
    let items: [EventTimelineItem]
    let item: EventTimelineItem?
    let fileChanges: [EventTimelineFileChange]
    let work: EventTimelineWorkSummary?

    var timelineRow: TimelineRow {
        TimelineRow(
            id: id,
            kind: TimelineRowKind(
                gatewayKind: kind,
                status: status,
                hasFileChanges: !fileChanges.isEmpty,
                itemType: item?.itemType ?? items.first?.itemType
            ),
            speaker: speaker,
            displayOrder: displayOrder,
            title: title,
            body: body,
            status: status,
            turnId: turnId ?? item?.turnId ?? items.first?.turnId
        )
    }

    private var title: String {
        if let workTitle = work?.title, !workTitle.isEmpty {
            return workTitle
        }
        if let role = item?.role ?? items.first?.role, !role.isEmpty {
            return role.capitalized
        }
        return kind.replacingOccurrences(of: "_", with: " ").capitalized
    }

    private var speaker: TimelineSpeaker {
        TimelineSpeaker(role: item?.role ?? items.first?.role)
    }

    private var body: String {
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

private struct EventTimelineItem: Decodable {
    let itemType: String
    let turnId: String?
    let payload: EventTimelineItemPayload

    var role: String? { payload.role }
    var text: String? { payload.text }
}

private struct EventTimelineItemPayload: Decodable {
    let rawRole: String?
    let rawText: String?
    let message: String?
    let title: String?
    let content: [EventTimelineContent]?
    let item: EventTimelineDisplayItem?
    let itemSnapshot: EventTimelineSnapshotItem?

    enum CodingKeys: String, CodingKey {
        case rawRole = "role"
        case rawText = "text"
        case message
        case title
        case content
        case item
        case itemSnapshot
    }

    var text: String? {
        if let rawText, !rawText.isEmpty {
            return rawText
        }
        if let message, !message.isEmpty {
            return message
        }
        if let title, !title.isEmpty {
            return title
        }
        if let itemText = item?.text, !itemText.isEmpty {
            return itemText
        }
        if let snapshotText = itemSnapshot?.text, !snapshotText.isEmpty {
            return snapshotText
        }
        return content?.lazy.compactMap(\.text).first { !$0.isEmpty }
    }

    var role: String? {
        rawRole ?? item?.role ?? itemSnapshot?.role
    }
}

private struct EventTimelineContent: Decodable {
    let text: String?
}

private struct EventTimelineDisplayItem: Decodable {
    let type: String?
    let role: String?
    let rawText: String?
    let message: String?
    let content: [EventTimelineContent]?

    enum CodingKeys: String, CodingKey {
        case type
        case role
        case rawText = "text"
        case message
        case content
    }

    var text: String? {
        if let rawText, !rawText.isEmpty {
            return rawText
        }
        if let message, !message.isEmpty {
            return message
        }
        return content?.lazy.compactMap(\.text).first { !$0.isEmpty }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decodeIfPresent(String.self, forKey: .type)
        role = try container.decodeIfPresent(String.self, forKey: .role) ?? Self.inferredRole(for: type)
        rawText = try container.decodeIfPresent(String.self, forKey: .rawText)
        message = try container.decodeIfPresent(String.self, forKey: .message)
        content = try container.decodeIfPresent([EventTimelineContent].self, forKey: .content)
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

private struct EventTimelineSnapshotItem: Decodable {
    let role: String?
    let rawText: String?
    let message: String?
    let content: [EventTimelineContent]?

    enum CodingKeys: String, CodingKey {
        case role
        case rawText = "text"
        case message
        case content
    }

    var text: String? {
        if let rawText, !rawText.isEmpty {
            return rawText
        }
        if let message, !message.isEmpty {
            return message
        }
        return content?.lazy.compactMap(\.text).first { !$0.isEmpty }
    }
}

private struct EventTimelineFileChange: Decodable {
    let path: String
}

private struct EventTimelineWorkSummary: Decodable {
    let title: String?
    let summary: String?
}
