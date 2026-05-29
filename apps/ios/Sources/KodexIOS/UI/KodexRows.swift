import SwiftUI
import KodexCore

struct KodexSegmentedScopeControl: View {
    @Binding var selection: WorkspaceScope

    var body: some View {
        Picker("Scope", selection: $selection) {
            ForEach(WorkspaceScope.allCases) { scope in
                Text(scope.rawValue)
                    .tag(scope)
                    .accessibilityIdentifier("WorkspaceScope-\(scope.rawValue)")
            }
        }
        .pickerStyle(.segmented)
        .accessibilityLabel("Workspace Scope")
        .accessibilityValue(selection.rawValue)
    }
}

struct KodexThreadRow: View {
    let thread: WorkspaceThread
    let isSelected: Bool
    let needsApproval: Bool
    let onSelect: () -> Void
    let onPinToggle: () -> Void
    let onArchive: () -> Void

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 10) {
                HStack(spacing: 6) {
                    Text(thread.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(KodexTheme.primaryText)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if needsApproval {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.caption2)
                            .foregroundStyle(KodexTheme.warning)
                            .accessibilityLabel("Needs approval")
                    } else if thread.status == .active {
                        Image(systemName: "dot.radiowaves.left.and.right")
                            .font(.caption2)
                            .foregroundStyle(KodexTheme.positive)
                            .accessibilityLabel("Active")
                    }
                    if thread.unread {
                        Circle()
                            .fill(KodexTheme.accent)
                            .frame(width: 7, height: 7)
                            .accessibilityLabel("Unread")
                    }
                }
                Spacer(minLength: 8)
            }
            .frame(height: KodexTheme.rowHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(thread.pinned ? "Unpin" : "Pin", action: onPinToggle)
                .tint(.blue)
            Button("Archive", role: .destructive, action: onArchive)
        }
        .contextMenu {
            Button(thread.pinned ? "Unpin" : "Pin", action: onPinToggle)
            Button("Archive", role: .destructive, action: onArchive)
        }
        .accessibilityIdentifier("ThreadRow-\(thread.id)")
        .accessibilityLabel(thread.title)
        .accessibilityValue(threadAccessibilityValue)
    }

    private var threadAccessibilityValue: String {
        [
            needsApproval ? "Needs approval" : nil,
            thread.status == .active ? "Active" : nil,
            thread.pinned ? "Pinned" : nil,
            thread.unread ? "Unread" : nil
        ]
        .compactMap(\.self)
        .joined(separator: ", ")
    }

}

struct KodexRowBackground: View {
    let isSelected: Bool
    var cornerRadius: CGFloat = 24

    var body: some View {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(isSelected ? KodexTheme.panelBackground.opacity(0.92) : Color.clear)
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(isSelected ? KodexTheme.hairline : Color.clear, lineWidth: 1)
            )
    }
}
