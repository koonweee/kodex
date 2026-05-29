import SwiftUI

enum KodexTheme {
    static let background = Color(uiColor: .systemBackground)
    static let groupedBackground = Color(uiColor: .systemGroupedBackground)
    static let elevatedBackground = Color(uiColor: .secondarySystemGroupedBackground)
    static let panelBackground = Color(uiColor: .secondarySystemBackground)
    static let bubbleBackground = Color(uiColor: .tertiarySystemFill)
    static let assistantBubbleBackground = Color.clear
    static let composerChrome = Color(uiColor: .secondarySystemBackground)
    static let composerInput = Color(uiColor: .tertiarySystemBackground)
    static let hairline = Color(uiColor: .separator)
    static let primaryText = Color.primary
    static let secondaryText = Color.secondary
    static let mutedText = Color.secondary.opacity(0.72)
    static let accent = Color.accentColor
    static let positive = Color.green
    static let warning = Color.orange
    static let destructive = Color.red

    static let cornerRadius: CGFloat = 28
    static let compactRadius: CGFloat = 18
    static let rowHeight: CGFloat = 44
    static let workspaceListRowInsets = EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16)
    static let iconButtonSize: CGFloat = 44
    static let composerButtonSize: CGFloat = 44
    static let composerSecondaryButtonSize: CGFloat = 44
}

enum WorkspaceScope: String, CaseIterable, Identifiable {
    case projects = "Projects"
    case chats = "Chats"

    var id: String { rawValue }
}
