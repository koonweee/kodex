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
    @State private var isSearchPresented = false
    @FocusState private var isSearchFocused: Bool
    let onRefresh: () async -> Void
    let onCreateChat: () async -> Void
    let onCreateProjectThread: (String) async -> Void
    let onSelectThread: (String) -> Void
    let onPinThread: (WorkspaceThread, Bool) async -> Void
    let onArchiveThread: (String) async -> Void
    let onEnableNotifications: () async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            fixedHeader
            threadTabs
        }
        .background(KodexTheme.groupedBackground.ignoresSafeArea())
        .navigationBarHidden(true)
        .refreshable {
            await onRefresh()
        }
        .sheet(isPresented: $isConnectionSettingsPresented) {
            NavigationStack {
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
    }

    private var fixedHeader: some View {
        headerControls
            .padding(.horizontal, 14)
            .padding(.top, 8)
            .padding(.bottom, 8)
        .background(KodexTheme.groupedBackground)
        .zIndex(1)
    }

    private var threadTabs: some View {
        TabView(selection: $scope) {
            workspaceList(for: .projects)
                .tabItem {
                    Label("Projects", systemImage: "folder")
                }
                .tag(WorkspaceScope.projects)
            workspaceList(for: .chats)
                .tabItem {
                    Label("Chats", systemImage: "bubble.left.and.bubble.right")
                }
                .tag(WorkspaceScope.chats)
        }
        .tint(KodexTheme.primaryText)
        .accessibilityIdentifier("WorkspaceScopeControl")
    }

    private func workspaceList(for selectedScope: WorkspaceScope) -> some View {
        List {
            if workspace.firstThread == nil {
                emptyState
                    .listRowSeparator(.hidden)
            } else {
                threadSections(for: selectedScope)
            }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
        .contentMargins(.top, 8, for: .scrollContent)
        .background(KodexTheme.groupedBackground)
    }

    @ViewBuilder
    private func threadSections(for selectedScope: WorkspaceScope) -> some View {
        switch selectedScope {
        case .projects:
            if !filteredProjectPinned.isEmpty {
                WorkspaceCollapsibleSection(
                    title: "Pinned",
                    systemImage: "pin.fill",
                    isCollapsed: pinnedCollapsed,
                    onToggleCollapsed: { pinnedCollapsed.toggle() }
                ) {
                    threadStack(filteredProjectPinned)
                }
            }
            projectsStack
        case .chats:
            if !filteredChatPinned.isEmpty {
                WorkspaceCollapsibleSection(
                    title: "Pinned",
                    systemImage: "pin.fill",
                    isCollapsed: pinnedCollapsed,
                    onToggleCollapsed: { pinnedCollapsed.toggle() }
                ) {
                    threadStack(filteredChatPinned)
                }
            }
            WorkspaceCollapsibleSection(
                title: "Chats",
                systemImage: "bubble.left.and.bubble.right",
                isCollapsed: chatsCollapsed,
                onToggleCollapsed: { chatsCollapsed.toggle() }
            ) {
                threadStack(filteredChats)
            }
        }
    }

    private var headerControls: some View {
        HStack(spacing: 6) {
            if isSearchPresented {
                WorkspaceToolbarSearchField(
                    searchQuery: $searchQuery,
                    isFocused: $isSearchFocused,
                    onDismiss: dismissSearch
                )
            } else {
                KodexGlassToolbarButton(systemName: "gearshape", label: "Connection Settings") {
                    isConnectionSettingsPresented = true
                }
                Spacer(minLength: 0)
                KodexGlassToolbarButton(systemName: "magnifyingglass", label: "Search") {
                    withAnimation(.easeOut(duration: 0.18)) {
                        isSearchPresented = true
                    }
                    isSearchFocused = true
                }
                .accessibilityIdentifier("WorkspaceSearchButton")
            }
            KodexGlassToolbarButton(systemName: "square.and.pencil", label: "New Chat") {
                Task {
                    await onCreateChat()
                }
            }
            .disabled(launchMode != .live || isBusy)
        }
        .onChange(of: searchQuery) { _, newValue in
            if !newValue.isEmpty {
                isSearchPresented = true
            }
        }
    }

    private var projectsStack: some View {
        Group {
            ForEach(filteredProjects) { project in
                WorkspaceProjectSection(
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

    private func threadStack(_ threads: [WorkspaceThread]) -> some View {
        Group {
            ForEach(threads) { thread in
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

    private var filteredProjectPinned: [WorkspaceThread] {
        filter(threads: workspace.pinned.filter(isProjectPinnedThread))
    }

    private var filteredChatPinned: [WorkspaceThread] {
        filter(threads: workspace.pinned.filter(isChatPinnedThread))
    }

    private var filteredChats: [WorkspaceThread] {
        filter(threads: workspace.chats.filter { thread in
            !thread.pinned && !pinnedThreadIDs.contains(thread.id)
        })
    }

    private var filteredProjects: [WorkspaceProject] {
        workspace.projects.compactMap { project in
            let query = normalizedSearch
            let projectMatches = query.isEmpty || project.name.localizedCaseInsensitiveContains(query) || project.path.localizedCaseInsensitiveContains(query)
            let unpinnedThreads = project.threads.filter { thread in
                !thread.pinned && !pinnedThreadIDs.contains(thread.id)
            }
            let threads = projectMatches ? unpinnedThreads : filter(threads: unpinnedThreads)
            guard !threads.isEmpty || projectMatches else {
                return nil
            }
            return WorkspaceProject(id: project.id, name: project.name, path: project.path, threads: threads)
        }
    }

    private var pinnedThreadIDs: Set<String> {
        Set(workspace.pinned.map(\.id))
    }

    private var chatThreadIDs: Set<String> {
        Set(workspace.chats.map(\.id))
    }

    private var projectThreadIDs: Set<String> {
        Set(workspace.projects.flatMap { $0.threads.map(\.id) })
    }

    private func isProjectPinnedThread(_ thread: WorkspaceThread) -> Bool {
        if projectThreadIDs.contains(thread.id) {
            return true
        }
        if chatThreadIDs.contains(thread.id) {
            return false
        }
        return workspace.projects.contains { project in
            thread.cwd == project.path || thread.cwd.hasPrefix(project.path + "/")
        }
    }

    private func isChatPinnedThread(_ thread: WorkspaceThread) -> Bool {
        !isProjectPinnedThread(thread)
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

    private func dismissSearch() {
        searchQuery = ""
        isSearchFocused = false
        withAnimation(.easeOut(duration: 0.18)) {
            isSearchPresented = false
        }
    }

}
