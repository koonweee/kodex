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
