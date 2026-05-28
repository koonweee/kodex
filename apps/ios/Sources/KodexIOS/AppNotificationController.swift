import Foundation
import KodexCore
import SwiftUI
import UIKit
import UserNotifications

final class AppNotificationDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in
            let intent = NativeNotificationRegistrationIntent(
                deviceToken: Self.hexToken(deviceToken),
                bundleId: Bundle.main.bundleIdentifier ?? "dev.kodex.KodexIOS",
                environment: "sandbox",
                deviceName: UIDevice.current.name
            )
            NativeNotificationRuntime.lastRegistrationIntent = intent
            let client = GatewayClient(
                configuration: NativeNotificationRuntime.gatewayConfiguration,
                send: URLSessionGatewayLoader.send
            )
            let result = await NativeNotificationGatewayRegistrar(client: client).upload(intent)
            NativeNotificationRuntime.lastRegistrationUploadResult = result
        }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in
            NativeNotificationRuntime.lastRegistrationError = error.localizedDescription
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        let userInfo = Self.stringKeyedUserInfo(notification.request.content.userInfo)
        if userInfo["kodexRouteOnForeground"] as? Bool == true {
            await Self.routeNotification(userInfo: userInfo)
        }
        return [.banner, .sound, .badge]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        await Self.routeNotification(userInfo: Self.stringKeyedUserInfo(response.notification.request.content.userInfo))
    }

    private nonisolated static func routeNotification(userInfo: [String: Any]) async {
        let intent = NativeNotificationParser.parse(userInfo: userInfo)
        guard let threadId = intent.routeThreadId else {
            return
        }
        await MainActor.run {
            NativeNotificationRuntime.pendingRouteThreadID = threadId
            UserDefaults.standard.set(threadId, forKey: "lastNotificationRouteThreadID")
            NotificationCenter.default.post(
                name: .kodexNativeNotificationRoute,
                object: nil,
                userInfo: ["threadId": threadId]
            )
        }
    }

    private nonisolated static func stringKeyedUserInfo(_ userInfo: [AnyHashable: Any]) -> [String: Any] {
        Dictionary(
            uniqueKeysWithValues: userInfo.compactMap { key, value in
                (key as? String).map { ($0, value) }
            }
        )
    }

    private static func hexToken(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }
}

struct SystemNativeNotificationAuthorizer: NativeNotificationAuthorizing {
    @MainActor
    func requestAuthorization() async throws -> Bool {
        try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
    }

    @MainActor
    func registerForRemoteNotifications() async {
        UIApplication.shared.registerForRemoteNotifications()
    }
}

@MainActor
enum NativeNotificationRuntime {
    static var gatewayConfiguration = GatewayConfiguration.simulatorDefault
    static var lastRegistrationIntent: NativeNotificationRegistrationIntent?
    static var lastRegistrationError: String?
    static var lastRegistrationUploadResult: Result<Data, GatewayClientError>?
    static var pendingRouteThreadID: String?
}

extension Notification.Name {
    static let kodexNativeNotificationRoute = Notification.Name("kodex.nativeNotificationRoute")
}
