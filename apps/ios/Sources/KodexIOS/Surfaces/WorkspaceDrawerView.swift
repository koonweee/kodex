import SwiftUI
import KodexAPI
import KodexCore

struct WorkspaceDrawerView: View {
    let workspace: WorkspaceSnapshot
    let selectedThreadID: String?
    let connection: GatewayConnectionStatus
    let accountState: KodexAccountState
    let approvalThreadIds: Set<String>
    let isBusy: Bool
    let launchMode: FixtureLaunchMode
    @Binding var gatewayURL: String
    @Binding var searchQuery: String
    @Binding var scope: WorkspaceScope
    @Binding var pinnedCollapsed: Bool
    @Binding var projectsCollapsed: Bool
    @Binding var chatsCollapsed: Bool
    @Binding var collapsedProjectIds: Set<String>
    @Binding var isConnectionSettingsPresented: Bool
    let onRefresh: () async -> Void
    let onCreateChat: () async -> Void
    let onCreateProjectThread: (String) async -> Void
    let onSelectThread: (String) -> Void
    let onPinThread: (WorkspaceThread, Bool) async -> Void
    let onArchiveThread: (String) async -> Void
    let onShowThread: () -> Void
    let onEnableNotifications: () async -> Void

    var body: some View {
        ZStack {
            KodexTheme.background.ignoresSafeArea()
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        header
                        searchField
                        KodexSegmentedScopeControl(selection: $scope)
                            .accessibilityIdentifier("WorkspaceScopeControl")

                        if workspace.firstThread == nil {
                            emptyState
                        } else {
                            if !workspace.pinned.isEmpty {
                                drawerSection(
                                    title: "Pinned",
                                    count: filteredPinned.count,
                                    systemImage: "pin.fill",
                                    isCollapsed: $pinnedCollapsed
                                ) {
                                    threadStack(filteredPinned, showsProjectPath: true)
                                }
                            }

                            switch scope {
                            case .projects:
                                drawerSection(
                                    title: "Projects",
                                    count: filteredProjects.reduce(0) { $0 + $1.threads.count },
                                    systemImage: "folder",
                                    isCollapsed: $projectsCollapsed
                                ) {
                                    projectsStack
                                }
                            case .chats:
                                drawerSection(
                                    title: "Chats",
                                    count: filteredChats.count,
                                    systemImage: "bubble.left.and.bubble.right",
                                    isCollapsed: $chatsCollapsed
                                ) {
                                    threadStack(filteredChats, showsProjectPath: false)
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.top, 14)
                    .padding(.bottom, 18)
                }
                footer
            }
        }
        .navigationBarHidden(true)
        .refreshable {
            await onRefresh()
        }
        .sheet(isPresented: $isConnectionSettingsPresented) {
            ConnectionSettingsSheet(
                gatewayURL: $gatewayURL,
                connection: connection,
                accountState: accountState,
                isBusy: isBusy,
                onRefresh: onRefresh,
                onEnableNotifications: onEnableNotifications
            )
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            HStack(spacing: 8) {
                Text("Kodex")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(KodexTheme.primaryText)
                KodexStatusDot(status: connection)
            }
            Spacer()
            KodexGlassCluster(spacing: 8) {
                HStack(spacing: 8) {
                    KodexIconButton(systemName: "square.and.pencil", label: "New Chat", isProminent: true) {
                        Task {
                            await onCreateChat()
                        }
                    }
                    .disabled(launchMode != .live || isBusy)
                    KodexIconButton(systemName: "sidebar.right", label: "Show Thread") {
                        onShowThread()
                    }
                    .accessibilityIdentifier("BackButton")
                }
            }
        }
    }

    private var searchField: some View {
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

    private var projectsStack: some View {
        VStack(spacing: 8) {
            ForEach(filteredProjects) { project in
                ProjectDrawerSection(
                    project: project,
                    selectedThreadID: selectedThreadID,
                    isCollapsed: collapsedProjectIds.contains(project.id),
                    approvalThreadIds: approvalThreadIds,
                    onToggleCollapsed: { toggleProject(project.id) },
                    onCreateThread: {
                        Task {
                            await onCreateProjectThread(project.id)
                        }
                    },
                    onSelectThread: onSelectThread,
                    onPinThread: onPinThread,
                    onArchiveThread: onArchiveThread
                )
            }
        }
    }

    private func threadStack(_ threads: [WorkspaceThread], showsProjectPath: Bool) -> some View {
        VStack(spacing: 6) {
            ForEach(threads) { thread in
                KodexThreadRow(
                    thread: thread,
                    isSelected: thread.id == selectedThreadID,
                    needsApproval: approvalThreadIds.contains(thread.id),
                    showsProjectPath: showsProjectPath,
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
            }
        }
    }

    private func drawerSection<Content: View>(
        title: String,
        count: Int,
        systemImage: String,
        isCollapsed: Binding<Bool>,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            KodexDisclosureRow(
                title: title,
                count: count,
                systemImage: systemImage,
                isCollapsed: isCollapsed.wrappedValue,
                onToggle: { isCollapsed.wrappedValue.toggle() }
            )
            if !isCollapsed.wrappedValue {
                content()
            }
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: "tray")
                .font(.title2)
            Text("No Threads")
                .font(.headline)
            Text("Connect to a Kodex gateway or use a fixture launch mode.")
                .font(.caption)
                .foregroundStyle(KodexTheme.secondaryText)
        }
        .foregroundStyle(KodexTheme.primaryText)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .kodexGlass(cornerRadius: KodexTheme.cornerRadius)
        .accessibilityIdentifier("EmptyWorkspace")
    }

    private var footer: some View {
        HStack(spacing: 10) {
            KodexProfileAvatar(initial: profileInitial)
            if let displayName = compactProfileName {
                Text(displayName)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(KodexTheme.secondaryText)
                    .lineLimit(1)
                    .accessibilityIdentifier("AccountStatus")
            }
            Spacer()
            KodexIconButton(systemName: "gearshape", label: "Connection Settings") {
                isConnectionSettingsPresented = true
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(KodexTheme.background)
        .overlay(Rectangle().fill(KodexTheme.hairline).frame(height: 1), alignment: .top)
    }

    private var filteredPinned: [WorkspaceThread] {
        filter(threads: workspace.pinned)
    }

    private var filteredChats: [WorkspaceThread] {
        filter(threads: workspace.chats)
    }

    private var filteredProjects: [WorkspaceProject] {
        workspace.projects.compactMap { project in
            let query = normalizedSearch
            let projectMatches = query.isEmpty || project.name.localizedCaseInsensitiveContains(query) || project.path.localizedCaseInsensitiveContains(query)
            let threads = projectMatches ? project.threads : filter(threads: project.threads)
            guard !threads.isEmpty || projectMatches else {
                return nil
            }
            return WorkspaceProject(id: project.id, name: project.name, path: project.path, threads: threads)
        }
    }

    private var normalizedSearch: String {
        searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func filter(threads: [WorkspaceThread]) -> [WorkspaceThread] {
        let query = normalizedSearch
        guard !query.isEmpty else {
            return threads
        }
        return threads.filter {
            $0.title.localizedCaseInsensitiveContains(query)
                || $0.cwd.localizedCaseInsensitiveContains(query)
                || $0.status.rawValue.localizedCaseInsensitiveContains(query)
        }
    }

    private func toggleProject(_ projectId: String) {
        if collapsedProjectIds.contains(projectId) {
            collapsedProjectIds.remove(projectId)
        } else {
            collapsedProjectIds.insert(projectId)
        }
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

private struct ProjectDrawerSection: View {
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
        VStack(spacing: 6) {
            HStack(spacing: 8) {
                Button(action: onToggleCollapsed) {
                    Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                        .font(.caption.weight(.bold))
                        .frame(width: 24, height: 24)
                }
                .buttonStyle(.plain)
                .foregroundStyle(KodexTheme.secondaryText)
                .accessibilityLabel(isCollapsed ? "Expand \(project.name)" : "Collapse \(project.name)")

                Image(systemName: "folder")
                    .foregroundStyle(KodexTheme.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text(project.name)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(KodexTheme.primaryText)
                    Text(project.path)
                        .font(.caption2)
                        .foregroundStyle(KodexTheme.mutedText)
                        .lineLimit(1)
                }
                Spacer()
                Button(action: onCreateThread) {
                    Image(systemName: "plus")
                        .frame(width: 30, height: 30)
                }
                .buttonStyle(.plain)
                .foregroundStyle(KodexTheme.primaryText)
                .accessibilityLabel("New Project Thread")
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 10)
            .background(KodexTheme.panelBackground.opacity(0.86), in: RoundedRectangle(cornerRadius: 24, style: .continuous))

            if !isCollapsed {
                ForEach(project.threads) { thread in
                    KodexThreadRow(
                        thread: thread,
                        isSelected: thread.id == selectedThreadID,
                        needsApproval: approvalThreadIds.contains(thread.id),
                        showsProjectPath: false,
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
                    .padding(.leading, 18)
                }
            }
        }
    }
}

struct KodexDisclosureRow: View {
    let title: String
    let count: Int
    let systemImage: String
    let isCollapsed: Bool
    let onToggle: () -> Void

    var body: some View {
        Button(action: onToggle) {
            HStack(spacing: 8) {
                Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                    .font(.caption.weight(.bold))
                    .frame(width: 18)
                Image(systemName: systemImage)
                    .foregroundStyle(KodexTheme.secondaryText)
                Text(title)
                    .font(.caption.weight(.semibold))
                    .textCase(.uppercase)
                    .foregroundStyle(KodexTheme.secondaryText)
                Spacer()
                Text("\(count)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(KodexTheme.mutedText)
            }
            .frame(height: 30)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("\(title)Section")
    }
}

struct KodexThreadRow: View {
    let thread: WorkspaceThread
    let isSelected: Bool
    let needsApproval: Bool
    let showsProjectPath: Bool
    let onSelect: () -> Void
    let onPinToggle: () -> Void
    let onArchive: () -> Void

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(thread.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(KodexTheme.primaryText)
                            .lineLimit(1)
                        if thread.pinned {
                            Image(systemName: "pin.fill")
                                .font(.caption2)
                                .foregroundStyle(KodexTheme.accent)
                                .accessibilityLabel("Pinned")
                        }
                        if thread.unread {
                            Circle()
                                .fill(KodexTheme.accent)
                                .frame(width: 7, height: 7)
                                .accessibilityLabel("Unread")
                        }
                    }
                    HStack(spacing: 6) {
                        if needsApproval {
                            Label("Needs approval", systemImage: "exclamationmark.triangle.fill")
                                .foregroundStyle(KodexTheme.warning)
                        } else if thread.status == .active {
                            Label("Active", systemImage: "dot.radiowaves.left.and.right")
                                .foregroundStyle(KodexTheme.positive)
                        } else {
                            Text(showsProjectPath ? thread.cwd : lastPathComponent(thread.cwd))
                                .foregroundStyle(KodexTheme.mutedText)
                        }
                    }
                    .font(.caption2)
                    .lineLimit(1)
                }
                Spacer(minLength: 8)
                Menu {
                    Button(thread.pinned ? "Unpin" : "Pin", action: onPinToggle)
                    Button("Archive", role: .destructive, action: onArchive)
                } label: {
                    Image(systemName: "ellipsis")
                        .frame(width: 30, height: 30)
                        .foregroundStyle(KodexTheme.secondaryText)
                }
                .accessibilityLabel("Thread Quick Actions")
            }
            .frame(minHeight: KodexTheme.rowHeight)
            .padding(.horizontal, 14)
            .background(rowBackground)
            .contentShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(thread.pinned ? "Unpin" : "Pin", action: onPinToggle)
                .tint(.blue)
            Button("Archive", role: .destructive, action: onArchive)
        }
        .accessibilityIdentifier("ThreadRow-\(thread.id)")
    }

    private var rowBackground: some View {
        RoundedRectangle(cornerRadius: 24, style: .continuous)
            .fill(isSelected ? KodexTheme.panelBackground.opacity(0.92) : Color.clear)
            .overlay(
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .stroke(isSelected ? KodexTheme.hairline : Color.clear, lineWidth: 1)
            )
    }

    private var statusColor: Color {
        if needsApproval {
            return KodexTheme.warning
        }
        switch thread.status {
        case .active:
            return KodexTheme.positive
        case .systemError:
            return KodexTheme.destructive
        case .idle:
            return KodexTheme.accent.opacity(0.65)
        case .notLoaded:
            return KodexTheme.mutedText
        }
    }

    private func lastPathComponent(_ path: String) -> String {
        URL(fileURLWithPath: path).lastPathComponent
    }
}

private struct ConnectionSettingsSheet: View {
    @Binding var gatewayURL: String
    let connection: GatewayConnectionStatus
    let accountState: KodexAccountState
    let isBusy: Bool
    let onRefresh: () async -> Void
    let onEnableNotifications: () async -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                Text("Connection")
                    .font(.largeTitle.weight(.bold))
                    .foregroundStyle(KodexTheme.primaryText)
                    .padding(.top, 28)

                HStack(spacing: 12) {
                    KodexProfileAvatar(initial: profileInitial)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(accountSummary)
                            .font(.headline)
                            .foregroundStyle(KodexTheme.primaryText)
                            .accessibilityIdentifier("AccountStatus")
                        Text("Profile")
                            .font(.caption)
                            .foregroundStyle(KodexTheme.mutedText)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .background(KodexTheme.panelBackground, in: RoundedRectangle(cornerRadius: 28, style: .continuous))

                settingsGroup(title: "Gateway") {
                    settingsRow(systemImage: "bolt.horizontal", title: connection.displayText)
                        .accessibilityIdentifier("GatewayStatus")
                    settingsDivider
                    HStack(spacing: 12) {
                        Image(systemName: "link")
                            .frame(width: 24)
                            .foregroundStyle(KodexTheme.secondaryText)
                        TextField("Gateway URL", text: $gatewayURL)
                            .textContentType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .foregroundStyle(KodexTheme.primaryText)
                    }
                    settingsDivider
                    Button("Check Connection") {
                        Task {
                            await onRefresh()
                        }
                    }
                    .disabled(isBusy)
                }

                settingsGroup(title: "Notifications") {
                    Button("Enable Notifications") {
                        Task {
                            await onEnableNotifications()
                        }
                    }
                    .disabled(isBusy)
                }
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 40)
        }
        .background(KodexTheme.background.ignoresSafeArea())
    }

    private func settingsGroup<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.headline)
                .foregroundStyle(KodexTheme.secondaryText)
                .padding(.leading, 12)
            VStack(alignment: .leading, spacing: 0) {
                content()
                    .font(.body)
                    .foregroundStyle(KodexTheme.primaryText)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
            }
            .background(KodexTheme.panelBackground, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        }
    }

    private func settingsRow(systemImage: String, title: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .frame(width: 24)
                .foregroundStyle(KodexTheme.secondaryText)
            Text(title)
                .lineLimit(2)
            Spacer(minLength: 0)
        }
    }

    private var settingsDivider: some View {
        Rectangle()
            .fill(KodexTheme.hairline)
            .frame(height: 1)
            .padding(.leading, 52)
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

private extension String {
    var nilIfEmpty: String? {
        isEmpty ? nil : self
    }
}
