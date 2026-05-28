import SwiftUI
import KodexCore

struct KodexGlassCluster<Content: View>: View {
    let spacing: CGFloat
    @ViewBuilder let content: () -> Content

    init(spacing: CGFloat = 10, @ViewBuilder content: @escaping () -> Content) {
        self.spacing = spacing
        self.content = content
    }

    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) {
                content()
            }
        } else {
            content()
        }
    }
}

struct KodexGlassSurface<Content: View>: View {
    let cornerRadius: CGFloat
    let tint: Color?
    let interactive: Bool
    let content: Content

    init(
        cornerRadius: CGFloat = KodexTheme.cornerRadius,
        tint: Color? = nil,
        interactive: Bool = false,
        @ViewBuilder content: () -> Content
    ) {
        self.cornerRadius = cornerRadius
        self.tint = tint
        self.interactive = interactive
        self.content = content()
    }

    var body: some View {
        content
            .kodexGlass(cornerRadius: cornerRadius, tint: tint, interactive: interactive)
    }
}

extension View {
    @ViewBuilder
    func kodexGlass(cornerRadius: CGFloat = KodexTheme.cornerRadius, tint: Color? = nil, interactive: Bool = false) -> some View {
        if #available(iOS 26.0, *) {
            if let tint {
                if interactive {
                    glassEffect(.regular.tint(tint).interactive(), in: .rect(cornerRadius: cornerRadius))
                } else {
                    glassEffect(.regular.tint(tint), in: .rect(cornerRadius: cornerRadius))
                }
            } else if interactive {
                glassEffect(.regular.interactive(), in: .rect(cornerRadius: cornerRadius))
            } else {
                glassEffect(.regular, in: .rect(cornerRadius: cornerRadius))
            }
        } else {
            background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .stroke(KodexTheme.hairline, lineWidth: 1)
                )
        }
    }
}

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
        .foregroundStyle(isProminent ? Color.black : KodexTheme.primaryText)
        .background(isProminent ? KodexTheme.accent : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: KodexTheme.iconButtonSize / 2, style: .continuous))
        .kodexGlass(cornerRadius: KodexTheme.iconButtonSize / 2, tint: isProminent ? KodexTheme.accent.opacity(0.34) : nil, interactive: true)
        .accessibilityLabel(label)
    }
}

struct KodexMenuRow: View {
    let title: String
    let subtitle: String?
    let systemImage: String
    var isDestructive = false

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                if let subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        } icon: {
            Image(systemName: systemImage)
                .foregroundStyle(isDestructive ? KodexTheme.destructive : .primary)
        }
    }
}

struct KodexBottomComposerShell<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        content()
            .padding(.horizontal, 10)
            .padding(.top, 9)
            .padding(.bottom, 9)
            .background(KodexTheme.composerChrome, in: RoundedRectangle(cornerRadius: 31, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 31, style: .continuous)
                    .stroke(KodexTheme.hairline, lineWidth: 1)
            )
            .kodexGlass(cornerRadius: 31, tint: KodexTheme.composerChrome.opacity(0.72))
            .padding(.horizontal, 10)
            .padding(.top, 8)
            .padding(.bottom, 8)
            .background(
                LinearGradient(
                    colors: [KodexTheme.background.opacity(0.05), KodexTheme.background],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .ignoresSafeArea()
            )
    }
}

struct KodexStatusDot: View {
    let status: GatewayConnectionStatus

    var body: some View {
        Image(systemName: "circle.fill")
            .font(.system(size: 8, weight: .bold))
            .foregroundStyle(color)
            .accessibilityLabel(accessibilityLabel)
            .accessibilityIdentifier("GatewayStatusDot")
    }

    private var color: Color {
        switch status {
        case .connected:
            return KodexTheme.positive
        case .degraded:
            return KodexTheme.warning
        case .offline, .invalidURL:
            return KodexTheme.destructive
        }
    }

    private var accessibilityLabel: String {
        switch status {
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

struct KodexSegmentedScopeControl: View {
    @Binding var selection: WorkspaceScope

    var body: some View {
        HStack(spacing: 4) {
            ForEach(WorkspaceScope.allCases) { scope in
                Button {
                    selection = scope
                } label: {
                    Text(scope.rawValue)
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .frame(height: 38)
                        .foregroundStyle(selection == scope ? KodexTheme.primaryText : KodexTheme.secondaryText)
                        .background(
                            Capsule(style: .continuous)
                                .fill(selection == scope ? Color.white.opacity(0.14) : Color.clear)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("WorkspaceScope-\(scope.rawValue)")
            }
        }
        .padding(4)
        .kodexGlass(cornerRadius: 22, interactive: true)
    }
}
