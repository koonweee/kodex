import SwiftUI
import KodexCore

struct KodexStatusDot: View {
    let status: GatewayConnectionStatus

    var body: some View {
        Image(systemName: "circle.fill")
            .font(.system(size: 8, weight: .bold))
            .foregroundStyle(status.kodexColor)
            .accessibilityLabel(status.accessibilityLabel)
            .accessibilityIdentifier("GatewayStatusDot")
    }
}

struct KodexProfileAvatar: View {
    let initial: String

    var body: some View {
        Text(initial)
            .font(.headline.weight(.semibold))
            .foregroundStyle(KodexTheme.primaryText)
            .frame(width: 44, height: 44)
            .background(KodexTheme.panelBackground, in: Circle())
            .overlay(Circle().stroke(KodexTheme.hairline, lineWidth: 1))
            .accessibilityLabel("Profile \(initial)")
            .accessibilityIdentifier("ProfileAvatar")
    }
}

extension GatewayConnectionStatus {
    var kodexColor: Color {
        switch self {
        case .connected:
            return KodexTheme.positive
        case .degraded:
            return KodexTheme.warning
        case .offline, .invalidURL:
            return KodexTheme.destructive
        }
    }

    var accessibilityLabel: String {
        switch self {
        case .connected:
            return "Gateway connected"
        case .degraded:
            return "Gateway degraded"
        case .offline:
            return "Gateway offline"
        case .invalidURL:
            return "Gateway URL invalid"
        }
    }
}
