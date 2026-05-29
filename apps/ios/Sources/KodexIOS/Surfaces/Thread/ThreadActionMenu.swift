import SwiftUI
import KodexCore

struct ThreadActionMenu: View {
    let thread: WorkspaceThread
    let onRename: () -> Void
    let onSetPinned: (Bool) async -> Void
    let onToggleNotifications: () async -> Void
    let onArchive: () async -> Void

    var body: some View {
        Menu {
            Button {
                Task {
                    await onSetPinned(!thread.pinned)
                }
            } label: {
                KodexMenuRow(
                    title: thread.pinned ? "Unpin" : "Pin",
                    subtitle: thread.pinned ? "Remove from Pinned" : "Keep near the top",
                    systemImage: thread.pinned ? "pin.slash" : "pin"
                )
            }
            Button(action: onRename) {
                KodexMenuRow(title: "Rename", subtitle: nil, systemImage: "pencil")
            }
            Button {
                Task {
                    await onToggleNotifications()
                }
            } label: {
                KodexMenuRow(
                    title: "Notifications",
                    subtitle: thread.notificationsEnabled ? "Enabled" : "Muted",
                    systemImage: thread.notificationsEnabled ? "bell.badge" : "bell.slash"
                )
            }
            Button(role: .destructive) {
                Task {
                    await onArchive()
                }
            } label: {
                KodexMenuRow(title: "Archive", subtitle: nil, systemImage: "archivebox", isDestructive: true)
            }
        } label: {
            KodexToolbarIconLabel(systemName: "ellipsis")
        }
        .kodexGlassToolbarControl()
        .accessibilityLabel("Thread Actions")
        .accessibilityIdentifier("ThreadActions")
    }
}
