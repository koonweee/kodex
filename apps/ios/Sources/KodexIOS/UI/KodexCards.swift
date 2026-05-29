import SwiftUI

enum KodexCardTone {
    case neutral
    case warning
    case destructive

    var fill: Color {
        switch self {
        case .neutral:
            return KodexTheme.accent.opacity(0.10)
        case .warning:
            return KodexTheme.warning.opacity(0.12)
        case .destructive:
            return KodexTheme.destructive.opacity(0.12)
        }
    }

    var stroke: Color {
        switch self {
        case .neutral:
            return KodexTheme.accent.opacity(0.22)
        case .warning:
            return KodexTheme.warning.opacity(0.25)
        case .destructive:
            return KodexTheme.destructive.opacity(0.25)
        }
    }
}

struct KodexStatusCardChrome: ViewModifier {
    let tone: KodexCardTone
    var cornerRadius: CGFloat = 12

    func body(content: Content) -> some View {
        content
            .padding(12)
            .background(tone.fill, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(tone.stroke, lineWidth: 1)
            )
    }
}

struct KodexPanelSurfaceChrome: ViewModifier {
    var cornerRadius: CGFloat = KodexTheme.cornerRadius

    func body(content: Content) -> some View {
        content
            .background(KodexTheme.panelBackground, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    }
}

struct KodexTimelineBubbleChrome: ViewModifier {
    let background: Color
    let cornerRadius: CGFloat
    var showsHairline = false

    func body(content: Content) -> some View {
        content
            .background(background, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(showsHairline ? KodexTheme.hairline : Color.clear, lineWidth: 1)
            )
    }
}

extension View {
    func kodexStatusCard(tone: KodexCardTone, cornerRadius: CGFloat = 12) -> some View {
        modifier(KodexStatusCardChrome(tone: tone, cornerRadius: cornerRadius))
    }

    func kodexPanelSurface(cornerRadius: CGFloat = KodexTheme.cornerRadius) -> some View {
        modifier(KodexPanelSurfaceChrome(cornerRadius: cornerRadius))
    }

    func kodexTimelineBubble(background: Color, cornerRadius: CGFloat, showsHairline: Bool = false) -> some View {
        modifier(KodexTimelineBubbleChrome(background: background, cornerRadius: cornerRadius, showsHairline: showsHairline))
    }
}
