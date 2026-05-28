import Foundation

public enum GatewayLiveEvent: Equatable, Sendable {
    case threadViewPatch(threadId: String)
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
        case .threadViewPatch(let threadId),
             .refreshRequired(let threadId),
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
            return .threadViewPatch(threadId: envelope.payload.threadId ?? "")
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

private struct EventEnvelope: Decodable {
    let seq: Int64?
    let kind: String
    let payload: EventPayload
}

private struct EventPayload: Decodable {
    let threadId: String?
    let thread: EventThreadPayload?
}

private struct EventThreadPayload: Decodable {
    let id: String?
}
