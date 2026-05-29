import SwiftUI

struct KodexBottomComposerShell<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: 8) {
                content()
                    .padding(.horizontal, 10)
                    .padding(.top, 9)
                    .padding(.bottom, 9)
                    .glassEffect(.regular.tint(KodexTheme.composerChrome.opacity(0.42)), in: .rect(cornerRadius: 31))
            }
            .padding(.horizontal, 10)
            .padding(.top, 8)
            .padding(.bottom, 8)
        } else {
            content()
                .padding(.horizontal, 10)
                .padding(.top, 9)
                .padding(.bottom, 9)
                .background(KodexTheme.composerChrome, in: RoundedRectangle(cornerRadius: 31, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 31, style: .continuous)
                        .stroke(KodexTheme.hairline, lineWidth: 1)
                )
                .padding(.horizontal, 10)
                .padding(.top, 8)
                .padding(.bottom, 8)
        }
    }
}

struct KodexComposerInputStyle: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 15)
            .padding(.vertical, 12)
            .foregroundStyle(KodexTheme.primaryText)
            .tint(KodexTheme.primaryText)
            .background(KodexTheme.composerInput, in: Capsule(style: .continuous))
            .overlay(Capsule(style: .continuous).stroke(KodexTheme.hairline, lineWidth: 1))
    }
}

struct KodexComposerChip<Label: View>: View {
    @ViewBuilder let label: () -> Label

    var body: some View {
        label()
            .lineLimit(1)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 9)
            .frame(height: 30)
            .foregroundStyle(KodexTheme.secondaryText)
            .background(KodexTheme.composerInput.opacity(0.72), in: Capsule(style: .continuous))
            .overlay(Capsule(style: .continuous).stroke(KodexTheme.hairline, lineWidth: 1))
    }
}

extension View {
    func kodexComposerInput() -> some View {
        modifier(KodexComposerInputStyle())
    }
}
