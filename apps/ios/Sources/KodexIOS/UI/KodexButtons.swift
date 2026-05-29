import SwiftUI

struct KodexIconButton: View {
    let systemName: String
    let label: String
    var isProminent = false
    var role: ButtonRole?
    let action: () -> Void

    var body: some View {
        Button(role: role, action: action) {
            Image(systemName: systemName)
                .font(.system(size: 16, weight: .semibold))
                .frame(width: KodexTheme.iconButtonSize, height: KodexTheme.iconButtonSize)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(isProminent ? Color.white : KodexTheme.primaryText)
        .background(isProminent ? KodexTheme.accent : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: KodexTheme.iconButtonSize / 2, style: .continuous))
        .kodexGlass(cornerRadius: KodexTheme.iconButtonSize / 2, tint: isProminent ? KodexTheme.accent.opacity(0.34) : nil, interactive: true)
        .accessibilityLabel(label)
    }
}

struct KodexGlassToolbarButton: View {
    let systemName: String
    let label: String
    var role: ButtonRole?
    let action: () -> Void

    var body: some View {
        Button(role: role, action: action) {
            KodexToolbarIconLabel(systemName: systemName)
        }
        .kodexGlassToolbarControl()
        .accessibilityLabel(label)
    }
}

struct KodexToolbarIconLabel: View {
    let systemName: String

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: 16, weight: .semibold))
            .frame(width: 32, height: 32)
            .contentShape(Circle())
    }
}

struct KodexGlassToolbarControlModifier: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .frame(minWidth: KodexTheme.iconButtonSize, minHeight: KodexTheme.iconButtonSize)
                .foregroundStyle(KodexTheme.primaryText)
        } else {
            content
                .buttonStyle(.plain)
                .frame(minWidth: KodexTheme.iconButtonSize, minHeight: KodexTheme.iconButtonSize)
                .foregroundStyle(KodexTheme.primaryText)
                .background(.ultraThinMaterial, in: Circle())
                .overlay(Circle().stroke(KodexTheme.hairline, lineWidth: 1))
        }
    }
}

extension View {
    func kodexGlassToolbarControl() -> some View {
        modifier(KodexGlassToolbarControlModifier())
    }
}

struct KodexComposerRoundButton: View {
    let systemName: String
    let label: String
    var isProminent = false
    var role: ButtonRole?
    let action: () -> Void

    var body: some View {
        Button(role: role, action: action) {
            KodexComposerIconLabel(systemName: systemName)
        }
        .kodexComposerGlassControl(isProminent: isProminent)
        .accessibilityLabel(label)
    }
}

struct KodexComposerIconLabel: View {
    let systemName: String

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: 17, weight: .semibold))
            .frame(width: 32, height: 32)
            .contentShape(Circle())
    }
}

struct KodexComposerGlassControlModifier: ViewModifier {
    var isProminent = false

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            if isProminent {
                content
                    .buttonStyle(.glassProminent)
                    .buttonBorderShape(.circle)
                    .tint(KodexTheme.accent)
                    .frame(minWidth: KodexTheme.composerButtonSize, minHeight: KodexTheme.composerButtonSize)
                    .foregroundStyle(Color.white)
            } else {
                content
                    .buttonStyle(.glass)
                    .buttonBorderShape(.circle)
                    .frame(minWidth: KodexTheme.composerButtonSize, minHeight: KodexTheme.composerButtonSize)
                    .foregroundStyle(KodexTheme.primaryText)
            }
        } else {
            content
                .buttonStyle(.plain)
                .frame(minWidth: KodexTheme.composerButtonSize, minHeight: KodexTheme.composerButtonSize)
                .foregroundStyle(isProminent ? Color.white : KodexTheme.primaryText)
                .background(isProminent ? KodexTheme.accent : KodexTheme.panelBackground.opacity(0.58), in: Circle())
                .overlay(Circle().stroke(KodexTheme.hairline, lineWidth: 1))
        }
    }
}

extension View {
    func kodexComposerGlassControl(isProminent: Bool = false) -> some View {
        modifier(KodexComposerGlassControlModifier(isProminent: isProminent))
    }
}
