import Foundation

public enum URLSessionGatewayLoader {
    public static func load(_ url: URL) async throws -> GatewayHTTPResponse {
        let (data, response) = try await URLSession.shared.data(from: url)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw URLSessionGatewayLoaderError.nonHTTPResponse
        }
        return GatewayHTTPResponse(statusCode: httpResponse.statusCode, body: data)
    }

    public static func send(_ request: GatewayRequest) async throws -> GatewayHTTPResponse {
        var urlRequest = URLRequest(url: request.url)
        urlRequest.httpMethod = request.method.rawValue
        urlRequest.httpBody = request.body
        for (name, value) in request.headers {
            urlRequest.setValue(value, forHTTPHeaderField: name)
        }
        let (data, response) = try await URLSession.shared.data(for: urlRequest)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw URLSessionGatewayLoaderError.nonHTTPResponse
        }
        return GatewayHTTPResponse(statusCode: httpResponse.statusCode, body: data)
    }
}

public enum URLSessionGatewayLoaderError: Error {
    case nonHTTPResponse
}

public enum NativeNotificationIntent: Equatable, Sendable {
    case unreadAgentMessage(threadId: String)
    case test
    case unknown

    public var badgeDelta: Int {
        switch self {
        case .unreadAgentMessage:
            return 1
        case .test, .unknown:
            return 0
        }
    }

    public var routeThreadId: String? {
        switch self {
        case .unreadAgentMessage(let threadId):
            return threadId
        case .test, .unknown:
            return nil
        }
    }
}

public enum NativeNotificationParser {
    public static func parse(userInfo: [String: Any]) -> NativeNotificationIntent {
        if let kind = userInfo["kind"] as? String, kind == "test" {
            return .test
        }
        if let threadId = userInfo["threadId"] as? String, !threadId.isEmpty {
            return .unreadAgentMessage(threadId: threadId)
        }
        return .unknown
    }

    public static func parseAPNSFixture(_ data: Data) throws -> NativeNotificationIntent {
        let object = try JSONSerialization.jsonObject(with: data)
        guard let dictionary = object as? [String: Any] else {
            return .unknown
        }
        return parse(userInfo: dictionary)
    }
}

public enum LiveUpdateEvent: Equatable, Sendable {
    case threadViewPatch(threadId: String, viewRevision: Int64)
    case refreshRequired(threadId: String)
    case threadReadUpdated(threadId: String)
    case threadPinUpdated(threadId: String)
    case threadNotificationsUpdated(threadId: String)
    case threadUpserted(threadId: String)
    case turnQueueItemUpsert(threadId: String, queueId: String?)
    case turnQueueItemDeleted(threadId: String, queueId: String?)
    case approvalLifecycle(approvalId: String?)
    case ignored(kind: String)
}

public enum LiveUpdateParser {
    public static func parse(_ data: Data) throws -> LiveUpdateEvent {
        let event = try JSONDecoder().decode(RawGatewayEvent.self, from: data)
        let payload = event.payload ?? event.data
        switch event.kind {
        case "thread_view.patch":
            return .threadViewPatch(threadId: payload?.threadId ?? "", viewRevision: payload?.viewRevision ?? 0)
        case "thread_view.refresh_required":
            return .refreshRequired(threadId: payload?.threadId ?? "")
        case "thread.read_updated":
            return .threadReadUpdated(threadId: payload?.threadId ?? "")
        case "thread.pin_updated":
            return .threadPinUpdated(threadId: payload?.threadId ?? "")
        case "thread.notifications_updated":
            return .threadNotificationsUpdated(threadId: payload?.threadId ?? "")
        case "thread.upserted":
            return .threadUpserted(threadId: payload?.threadId ?? "")
        case "turn_queue.item_upsert":
            return .turnQueueItemUpsert(threadId: payload?.threadId ?? "", queueId: payload?.queueId)
        case "turn_queue.item_deleted":
            return .turnQueueItemDeleted(threadId: payload?.threadId ?? "", queueId: payload?.queueId)
        case let type where type.contains("approval"):
            return .approvalLifecycle(approvalId: payload?.approvalId)
        default:
            return .ignored(kind: event.kind)
        }
    }
}

private struct RawGatewayEvent: Decodable {
    let kind: String
    let payload: RawEventPayload?
    let data: RawEventPayload?

    enum CodingKeys: String, CodingKey {
        case kind
        case type
        case payload
        case data
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decodeIfPresent(String.self, forKey: .kind)
            ?? container.decode(String.self, forKey: .type)
        payload = try container.decodeIfPresent(RawEventPayload.self, forKey: .payload)
        data = try container.decodeIfPresent(RawEventPayload.self, forKey: .data)
    }
}

private struct RawEventPayload: Decodable {
    let threadId: String?
    let queueId: String?
    let approvalId: String?
    let viewRevision: Int64?
}
