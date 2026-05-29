import SwiftUI
import KodexAPI
import KodexCore

struct WorkspaceHeaderView: View {
    let canCreateChat: Bool
    let onCreateChat: () async -> Void

    var body: some View {
        HStack(spacing: 10) {
            Text("Kodex")
                .font(.title2.weight(.semibold))
                .foregroundStyle(KodexTheme.primaryText)
            Spacer()
            KodexGlassCluster(spacing: 8) {
                HStack(spacing: 8) {
                    KodexIconButton(systemName: "square.and.pencil", label: "New Chat", isProminent: true) {
                        Task {
                            await onCreateChat()
                        }
                    }
                    .disabled(!canCreateChat)
                }
            }
        }
    }
}

struct WorkspaceSearchField: View {
    @Binding var searchQuery: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(KodexTheme.mutedText)
            TextField("Search", text: $searchQuery)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .foregroundStyle(KodexTheme.primaryText)
                .accessibilityIdentifier("WorkspaceSearch")
            if !searchQuery.isEmpty {
                Button {
                    searchQuery = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(KodexTheme.mutedText)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear Search")
            }
        }
        .font(.subheadline)
        .padding(.horizontal, 16)
        .frame(height: 50)
        .kodexGlass(cornerRadius: 25, tint: KodexTheme.panelBackground.opacity(0.42), interactive: true)
    }
}

struct WorkspaceToolbarSearchField: View {
    @Binding var searchQuery: String
    var isFocused: FocusState<Bool>.Binding
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(KodexTheme.mutedText)
            TextField("Search", text: $searchQuery)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .foregroundStyle(KodexTheme.primaryText)
                .focused(isFocused)
                .accessibilityIdentifier("WorkspaceSearch")
            Button(action: onDismiss) {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(KodexTheme.mutedText)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close Search")
        }
        .font(.subheadline)
        .padding(.horizontal, 14)
        .frame(height: KodexTheme.iconButtonSize)
        .kodexGlass(cornerRadius: KodexTheme.iconButtonSize / 2, tint: KodexTheme.panelBackground.opacity(0.42), interactive: true)
    }
}

struct WorkspaceFooterView: View {
    let accountState: KodexAccountState
    let onShowConnectionSettings: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            KodexProfileAvatar(initial: profileInitial)
            if let displayName = compactProfileName {
                Text(displayName)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(KodexTheme.secondaryText)
                    .lineLimit(2)
                    .accessibilityIdentifier("AccountStatus")
            }
            Spacer()
            KodexIconButton(systemName: "gearshape", label: "Connection Settings") {
                onShowConnectionSettings()
            }
            .frame(minWidth: 44, minHeight: 44)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(KodexTheme.background)
        .overlay(Rectangle().fill(KodexTheme.hairline).frame(height: 1), alignment: .top)
    }

    private var profileInitial: String {
        if let source = profileSource {
            return String(source.prefix(1)).uppercased()
        }
        return "?"
    }

    private var compactProfileName: String? {
        switch accountState {
        case .authenticated:
            return nil
        case .requiresOpenAIAuth:
            return "Sign in"
        case .unknown:
            return nil
        case .unavailable:
            return nil
        }
    }

    private var profileSource: String? {
        switch accountState {
        case .authenticated(let email):
            return email?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? "Kodex"
        case .requiresOpenAIAuth:
            return "Sign in"
        case .unknown:
            return "Kodex"
        case .unavailable:
            return "Kodex"
        }
    }
}

struct WorkspaceProjectSection: View {
    let project: WorkspaceProject
    let selectedThreadID: String?
    let isCollapsed: Bool
    let approvalThreadIds: Set<String>
    let onToggleCollapsed: () -> Void
    let onCreateThread: () -> Void
    let onSelectThread: (String) -> Void
    let onPinThread: (WorkspaceThread, Bool) async -> Void
    let onArchiveThread: (String) async -> Void

    var body: some View {
        WorkspaceCollapsibleSection(
            title: project.name,
            systemImage: "folder",
            isCollapsed: isCollapsed,
            onToggleCollapsed: onToggleCollapsed,
            trailingAction: onCreateThread,
            trailingSystemImage: "plus",
            trailingAccessibilityLabel: "New Project Thread"
        ) {
            ForEach(project.threads) { thread in
                KodexThreadRow(
                    thread: thread,
                    isSelected: thread.id == selectedThreadID,
                    needsApproval: approvalThreadIds.contains(thread.id),
                    onSelect: { onSelectThread(thread.id) },
                    onPinToggle: {
                        Task {
                            await onPinThread(thread, !thread.pinned)
                        }
                    },
                    onArchive: {
                        Task {
                            await onArchiveThread(thread.id)
                        }
                    }
                )
                .listRowInsets(KodexTheme.workspaceListRowInsets)
                .listRowBackground(KodexTheme.background)
            }
        }
    }
}

struct WorkspaceCollapsibleSection<Content: View>: View {
    let title: String
    let systemImage: String
    let isCollapsed: Bool
    let onToggleCollapsed: () -> Void
    var trailingAction: (() -> Void)? = nil
    var trailingSystemImage: String? = nil
    var trailingAccessibilityLabel: String? = nil
    @ViewBuilder let content: () -> Content

    var body: some View {
        Group {
            sectionHeader
            if !isCollapsed {
                content()
            }
        }
    }

    private var sectionHeader: some View {
        HStack(spacing: 10) {
            Button(action: onToggleCollapsed) {
                HStack(spacing: 10) {
                    Image(systemName: systemImage)
                        .font(.system(size: 16, weight: .semibold))
                        .frame(width: 22, height: KodexTheme.rowHeight)
                    Text(title)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(KodexTheme.primaryText)
            }
            .buttonStyle(.borderless)
            .foregroundStyle(KodexTheme.primaryText)
            .accessibilityLabel(isCollapsed ? "Expand \(title)" : "Collapse \(title)")

            if let trailingAction, let trailingSystemImage {
                Button(action: trailingAction) {
                    Image(systemName: trailingSystemImage)
                }
                .buttonStyle(.borderless)
                .foregroundStyle(KodexTheme.accent)
                .frame(width: KodexTheme.iconButtonSize, height: KodexTheme.iconButtonSize)
                .accessibilityLabel(trailingAccessibilityLabel ?? "")
            }
        }
        .frame(height: KodexTheme.rowHeight)
        .listRowInsets(KodexTheme.workspaceListRowInsets)
        .listRowBackground(KodexTheme.background)
    }
}

struct ConnectionSettingsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var gatewayURL: String
    let connection: GatewayConnectionStatus
    let accountState: KodexAccountState
    let isBusy: Bool
    let onRefresh: () async -> Void
    let onEnableNotifications: () async -> Void

    var body: some View {
        Form {
            Section("Profile") {
                LabeledContent {
                    Text(accountSummary)
                        .accessibilityIdentifier("AccountStatus")
                } label: {
                    Label("Account", systemImage: "person.crop.circle")
                }
            }

            Section("Gateway") {
                LabeledContent {
                    Text(connection.displayText)
                        .multilineTextAlignment(.trailing)
                        .accessibilityIdentifier("GatewayStatus")
                } label: {
                    Label("Status", systemImage: "bolt.horizontal")
                }

                TextField("Gateway URL", text: $gatewayURL)
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("Gateway URL")
                    .onSubmit {
                        Task {
                            await onRefresh()
                        }
                    }

                Button {
                    Task {
                        await onRefresh()
                    }
                } label: {
                    Label("Check Connection", systemImage: "arrow.clockwise")
                }
                .disabled(isBusy)
            }

            Section("Notifications") {
                Button {
                    Task {
                        await onEnableNotifications()
                    }
                } label: {
                    Label("Enable Notifications", systemImage: "bell.badge")
                }
                .disabled(isBusy)
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Done") {
                    dismiss()
                }
            }
        }
    }

    private var accountSummary: String {
        switch accountState {
        case .authenticated:
            return "Signed in"
        case .requiresOpenAIAuth:
            return "OpenAI auth required"
        case .unknown:
            return "Account unknown"
        case .unavailable:
            return "Account unavailable"
        }
    }

    private var profileInitial: String {
        switch accountState {
        case .authenticated(let email):
            return String((email?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? "Kodex").prefix(1)).uppercased()
        case .requiresOpenAIAuth:
            return "?"
        case .unknown, .unavailable:
            return "K"
        }
    }
}

extension String {
    var nilIfEmpty: String? {
        isEmpty ? nil : self
    }
}
