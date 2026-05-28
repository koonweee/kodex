import SwiftUI

enum KodexTheme {
    static let background = Color.black
    static let elevatedBackground = Color(red: 0.075, green: 0.075, blue: 0.08)
    static let panelBackground = Color(red: 0.145, green: 0.145, blue: 0.155)
    static let bubbleBackground = Color(red: 0.18, green: 0.18, blue: 0.19)
    static let hairline = Color.white.opacity(0.10)
    static let primaryText = Color.white.opacity(0.96)
    static let secondaryText = Color.white.opacity(0.68)
    static let mutedText = Color.white.opacity(0.44)
    static let accent = Color.white
    static let positive = Color(red: 0.34, green: 0.84, blue: 0.57)
    static let warning = Color(red: 1.0, green: 0.76, blue: 0.28)
    static let destructive = Color(red: 1.0, green: 0.39, blue: 0.39)

    static let cornerRadius: CGFloat = 28
    static let compactRadius: CGFloat = 18
    static let rowHeight: CGFloat = 62
    static let iconButtonSize: CGFloat = 48
}

enum WorkspaceScope: String, CaseIterable, Identifiable {
    case projects = "Projects"
    case chats = "Chats"

    var id: String { rawValue }
}
