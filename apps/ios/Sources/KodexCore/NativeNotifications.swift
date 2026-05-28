import Foundation

public struct NativeNotificationPayload: Decodable, Equatable, Sendable {
    public let threadId: String?
    public let route: String?
    public let badgeCount: Int?

    enum CodingKeys: String, CodingKey {
        case threadId
        case route
        case badgeCount
    }

    public var destination: NativeNotificationDestination {
        if let threadId {
            return .thread(threadId)
        }
        if let route, !route.isEmpty {
            return .route(route)
        }
        return .home
    }
}

public enum NativeNotificationDestination: Equatable, Sendable {
    case home
    case thread(String)
    case route(String)
}

public struct ApnsDeviceRegistration: Codable, Equatable, Sendable {
    public let deviceToken: String
    public let bundleId: String
    public let environment: String
    public let deviceName: String?

    public init(deviceToken: String, bundleId: String, environment: String, deviceName: String?) {
        self.deviceToken = deviceToken
        self.bundleId = bundleId
        self.environment = environment
        self.deviceName = deviceName
    }

    public var route: GatewayRoute {
        .apnsDeviceRegister
    }
}

public enum NativeNotificationRoutes {
    public static let status: GatewayRoute = .nativeNotificationStatus
    public static let registerDevice: GatewayRoute = .apnsDeviceRegister
    public static let test: GatewayRoute = .apnsTestNotification

    public static func deleteDevice(_ deviceId: String) -> GatewayRoute {
        .apnsDeviceDelete(deviceId)
    }
}

public protocol NativeNotificationAuthorizing: Sendable {
    @MainActor
    func requestAuthorization() async throws -> Bool
    @MainActor
    func registerForRemoteNotifications() async
}

public struct NativeNotificationRegistrationIntent: Equatable, Sendable {
    public let registration: ApnsDeviceRegistration
    public let route: GatewayRoute

    public init(deviceToken: String, bundleId: String, environment: String, deviceName: String?) {
        self.registration = ApnsDeviceRegistration(
            deviceToken: deviceToken,
            bundleId: bundleId,
            environment: environment,
            deviceName: deviceName
        )
        self.route = .apnsDeviceRegister
    }
}

public struct NativeNotificationGatewayRegistrar: Sendable {
    private let client: GatewayClient

    public init(client: GatewayClient) {
        self.client = client
    }

    public func upload(_ intent: NativeNotificationRegistrationIntent) async -> Result<Data, GatewayClientError> {
        do {
            let body = try JSONEncoder().encode(intent.registration)
            return await client.send(intent.route, method: .post, body: body)
        } catch {
            return .failure(.decoding(error.localizedDescription))
        }
    }
}
