import PhotosUI
import SwiftUI
import KodexCore
import KodexAPI

struct ConnectionView: View {
    private static let gatewayURLStorageKey = "kodex.gatewayURL"
    @Environment(\.scenePhase) private var scenePhase
    private let launchMode: FixtureLaunchMode
    private let liveE2EEnabled: Bool
    @AppStorage(Self.gatewayURLStorageKey) private var gatewayURL = GatewayConfiguration.simulatorDefault.baseURL.absoluteString
    @State private var state: FixtureAppState
    @State private var accountState: KodexAccountState = .unknown
    @State private var selectedThreadID: String?
    @State private var composerText = ""
    @State private var localImagePaths: [String] = []
    @State private var selectedPhotoItem: PhotosPickerItem?
    @State private var queuedInputs: [QueuedInputSummary] = []
    @State private var skills: [SkillSummary] = []
    @State private var composerSettings = ComposerRunSettings(model: "gpt-5.4", effort: "medium")
    @State private var composerPermissionsPreset: String?
    @State private var isExpandedComposerPresented = false
    @State private var isBusy = false
    @State private var statusMessage: String?
    @State private var preferredCompactColumn = NavigationSplitViewColumn.sidebar
    @State private var workspaceScope: WorkspaceScope = .projects
    @State private var workspaceSearchQuery = ""
    @State private var pinnedCollapsed = false
    @State private var projectsCollapsed = false
    @State private var chatsCollapsed = false
    @State private var collapsedProjectIds: Set<String> = []
    @State private var isConnectionSettingsPresented = false
    @State private var notificationStatus = "Notifications not enabled"
    @State private var selectedStreamTask: Task<Void, Never>?
    @State private var selectedStreamThreadID: String?
    @State private var globalStreamTask: Task<Void, Never>?
    @State private var globalStreamExcludedThreadID: String?
    @State private var selectedStreamCheckpoint = GatewayStreamCheckpoint()
    @State private var globalStreamCheckpoint = GatewayStreamCheckpoint()

    init(launchArguments: [String] = ProcessInfo.processInfo.arguments) {
        let mode = FixtureLaunchMode(arguments: launchArguments)
        if let configuredURL = ProcessInfo.processInfo.environment["KODEX_GATEWAY_URL"] {
            UserDefaults.standard.set(configuredURL, forKey: Self.gatewayURLStorageKey)
        }
        let fixtureState = FixtureStore.state(for: mode)
        self.launchMode = mode
        self.liveE2EEnabled = ProcessInfo.processInfo.environment["KODEX_IOS_LIVE_E2E"] == "1"
        let selectedFixtureThreadID = fixtureState.selectedThread?.thread.id ?? fixtureState.workspace.firstThread?.id
        _state = State(initialValue: mode == .live ? FixtureAppState(connection: .offline(message: "Not connected"), workspace: WorkspaceSnapshot(projects: [], chats: [], pinned: []), selectedThread: nil, approvals: []) : fixtureState)
        _accountState = State(initialValue: mode == .authRequired ? .requiresOpenAIAuth : .unknown)
        _selectedThreadID = State(initialValue: selectedFixtureThreadID)
        _workspaceScope = State(initialValue: fixtureState.workspace.chats.contains { $0.id == selectedFixtureThreadID } ? .chats : .projects)
    }

    var body: some View {
        NavigationSplitView(preferredCompactColumn: $preferredCompactColumn) {
            WorkspaceDrawerView(
                workspace: state.workspace,
                selectedThreadID: selectedThreadID,
                connection: state.connection,
                accountState: accountState,
                notificationStatus: notificationStatus,
                approvalThreadIds: Set(state.approvals.map(\.threadId)),
                isBusy: isBusy,
                launchMode: launchMode,
                gatewayURL: $gatewayURL,
                searchQuery: $workspaceSearchQuery,
                scope: $workspaceScope,
                pinnedCollapsed: $pinnedCollapsed,
                projectsCollapsed: $projectsCollapsed,
                chatsCollapsed: $chatsCollapsed,
                collapsedProjectIds: $collapsedProjectIds,
                isConnectionSettingsPresented: $isConnectionSettingsPresented,
                onRefresh: { await refresh() },
                onCreateChat: { await createChatThread() },
                onCreateProjectThread: { projectId in await createProjectThread(projectId: projectId) },
                onSelectThread: { threadID in routeToThreadLocally(threadID) },
                onPinThread: { thread, pinned in await setPinned(thread, pinned: pinned) },
                onArchiveThread: { threadID in await archiveThread(threadID) },
                onShowThread: { preferredCompactColumn = .detail },
                onEnableNotifications: { await enableNotifications() }
            )
            .refreshable {
                await refresh()
            }
            .task {
                if launchMode == .live {
                    await refresh()
                }
            }
            .onDisappear {
                selectedStreamTask?.cancel()
                globalStreamTask?.cancel()
            }
            .onChange(of: selectedThreadID) { _, newValue in
                guard launchMode == .live, let newValue else {
                    return
                }
                Task {
                    await loadSelectedThread(newValue, markSeen: true)
                }
            }
            .onChange(of: selectedPhotoItem) { _, newValue in
                guard let newValue else {
                    return
                }
                Task {
                    await uploadPhoto(newValue)
                }
            }
        } detail: {
            if let detail = selectedDetail {
                ThreadDetailView(
                    detail: detail,
                    approvals: state.approvals.filter { $0.threadId.isEmpty || $0.threadId == detail.thread.id },
                    queuedInputs: queuedInputs,
                    skills: skills,
                    localImagePaths: localImagePaths,
                    composerText: $composerText,
                    isExpandedComposerPresented: $isExpandedComposerPresented,
                    selectedPhotoItem: $selectedPhotoItem,
                    isBusy: isBusy,
                    statusMessage: statusMessage,
                    composerSettings: composerSettings,
                    permissionsPreset: composerPermissionsPreset,
                    onShowSidebar: { preferredCompactColumn = .sidebar },
                    onSend: { await sendComposer() },
                    onSettingsChange: { settings in await updateComposerSettings(settings) },
                    onStop: { await stopSelectedThread() },
                    onLoadOlder: { await loadOlderTimeline() },
                    onRename: { name in await renameSelectedThread(name: name) },
                    onSetPinned: { pinned in await setPinned(detail.thread, pinned: pinned) },
                    onToggleNotifications: { await toggleSelectedNotifications() },
                    onArchive: { await archiveSelectedThread() },
                    onApprovalDecision: { approval, decision in await decideApproval(approval, decision: decision) },
                    onQueuedRetry: { queueId in await retryQueuedInput(queueId) },
                    onQueuedSteer: { queueId in await steerQueuedInput(queueId) },
                    onQueuedDelete: { queueId in await deleteQueuedInput(queueId) }
                )
            } else {
                ContentUnavailableView("Select a Thread", systemImage: "bubble.left.and.bubble.right")
            }
        }
        .onChange(of: scenePhase) { _, newValue in
            guard launchMode == .live, newValue == .active else {
                return
            }
            Task {
                if let pendingThreadID = NativeNotificationRuntime.pendingRouteThreadID {
                    NativeNotificationRuntime.pendingRouteThreadID = nil
                    await routeToThread(pendingThreadID)
                } else {
                    await refresh()
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .kodexNativeNotificationRoute)) { notification in
            guard let threadId = notification.userInfo?["threadId"] as? String else {
                return
            }
            Task {
                await routeToThread(threadId)
            }
        }
    }

    private var selectedDetail: ThreadDetail? {
        if let selectedThreadID, state.selectedThread?.thread.id == selectedThreadID {
            return state.selectedThread
        }
        if launchMode != .live, let selectedThreadID, let thread = state.workspace.thread(id: selectedThreadID) {
            return ThreadDetail(
                thread: thread,
                timeline: ThreadTimeline(threadId: thread.id, liveState: thread.status == .active ? .streaming : .idle, viewRevision: 1, rows: [
                    TimelineRow(id: "\(thread.id)-summary", kind: .message, displayOrder: 1, title: thread.title, body: "Fixture timeline row for \(thread.cwd).")
                ])
            )
        }
        return state.selectedThread
    }

    private func routeToThreadLocally(_ threadID: String) {
        selectedThreadID = threadID
        preferredCompactColumn = .detail
    }

    private func service() throws -> LiveGatewayService {
        let configuration = try GatewayConfiguration(userInput: gatewayURL)
        return LiveGatewayService(configuration: configuration)
    }

    @MainActor
    private func refresh() async {
        if launchMode != .live {
            state = FixtureStore.state(for: .connected)
            selectedThreadID = state.selectedThread?.thread.id
            return
        }

        isBusy = true
        defer { isBusy = false }

        do {
            let connection = await GatewayConnectionChecker(probe: GatewayProbe(load: URLSessionGatewayLoader.load)).check(userInput: gatewayURL)
            state = FixtureAppState(connection: connection, workspace: state.workspace, selectedThread: state.selectedThread, approvals: state.approvals)
            guard connection.canLoadLiveWorkspace else {
                accountState = .unavailable(message: connection.displayText)
                statusMessage = connection.displayText
                return
            }

            let live = try service()
            accountState = await live.loadAccount()
            try await live.loadCapabilities()
            let workspace = try await live.loadWorkspace()
            let nextSelected = selectedThreadID ?? workspace.firstThread?.id
            state = FixtureAppState(connection: connection, workspace: workspace, selectedThread: nil, approvals: [])
            selectedThreadID = nextSelected
            if let nextSelected {
                await loadSelectedThread(nextSelected, markSeen: false)
            }
            startGlobalStream()
            statusMessage = nil
        } catch {
            state = FixtureAppState(connection: state.connection, workspace: state.workspace, selectedThread: state.selectedThread, approvals: state.approvals)
            statusMessage = error.localizedDescription
        }
    }

    @MainActor
    private func loadSelectedThread(_ threadId: String, markSeen: Bool) async {
        guard launchMode == .live else {
            return
        }
        do {
            let live = try service()
            if markSeen {
                try? await live.markThreadSeen(threadId: threadId)
            }
            let detail = try await live.loadThreadDetail(threadId: threadId)
            let approvals = try await live.listPendingApprovals(threadId: threadId)
            let queue = try await live.listQueuedInputs(threadId: threadId)
            let loadedSkills = try? await live.listSkills(cwd: detail.thread.cwd)
            let loadedSettings = try? await live.loadComposerSettings()
            state = FixtureAppState(connection: state.connection, workspace: state.workspace, selectedThread: detail, approvals: approvals)
            queuedInputs = queue
            skills = loadedSkills ?? []
            if let loadedSettings {
                composerSettings = loadedSettings.settings
                composerPermissionsPreset = loadedSettings.permissionsPreset
            }
            statusMessage = nil
            startSelectedStream(threadId)
            startGlobalStream()
        } catch {
            statusMessage = error.localizedDescription
        }
    }

    @MainActor
    private func createChatThread() async {
        await runLiveAction {
            let prompt = liveE2EEnabled ? "Say pong" : "Hello from Kodex iOS"
            let live = try service()
            let thread = try await live.createChatThread(firstMessageText: prompt)
            selectedThreadID = thread.id
            preferredCompactColumn = .detail
            if liveE2EEnabled {
                _ = try await live.submitTextInput(threadId: thread.id, text: prompt, settings: composerSettings)
            }
            await refresh()
            await pollSelectedThreadUntilIdle(thread.id)
        }
    }

    @MainActor
    private func createProjectThread() async {
        guard let project = state.workspace.projects.first else {
            return
        }
        await createProjectThread(projectId: project.id)
    }

    @MainActor
    private func createProjectThread(projectId: String) async {
        await runLiveAction {
            let thread = try await service().createProjectThread(projectId: projectId)
            selectedThreadID = thread.id
            preferredCompactColumn = .detail
            await refresh()
        }
    }

    @MainActor
    private func sendComposer() async {
        guard let threadId = selectedThreadID, !composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }
        await runLiveAction {
            let skillMentions = SkillMentionDetector.mentions(
                in: composerText,
                skills: skills.map { SkillCatalogEntry(name: $0.name, path: $0.path) }
            )
            _ = try await service().submitTextInput(
                threadId: threadId,
                text: composerText,
                skillMentions: skillMentions,
                localImagePaths: localImagePaths,
                settings: composerSettings
            )
            composerText = ""
            localImagePaths = []
            startSelectedStream(threadId)
            await pollSelectedThreadUntilIdle(threadId)
        }
    }

    @MainActor
    private func updateComposerSettings(_ settings: ComposerRunSettings) async {
        composerSettings = settings
        guard launchMode == .live else {
            return
        }
        await runLiveAction {
            try await service().persistComposerSettings(settings)
        }
    }

    @MainActor
    private func uploadPhoto(_ item: PhotosPickerItem) async {
        guard launchMode == .live else {
            return
        }
        await runLiveAction {
            guard let data = try await item.loadTransferable(type: Data.self) else {
                return
            }
            let images = try await service().uploadImageData(data, fileName: "ios-photo-\(UUID().uuidString).png")
            localImagePaths.append(contentsOf: images.map(\.path))
        }
    }

    @MainActor
    private func stopSelectedThread() async {
        guard let threadId = selectedThreadID else {
            return
        }
        await runLiveAction {
            try await service().stopCurrentTurn(threadId: threadId)
            await loadSelectedThread(threadId, markSeen: false)
        }
    }

    @MainActor
    private func pollSelectedThreadUntilIdle(_ threadId: String) async {
        for _ in 0..<45 {
            await loadSelectedThread(threadId, markSeen: false)
            if state.selectedThread?.timeline.liveState == .idle {
                return
            }
            try? await Task.sleep(for: .seconds(2))
        }
    }

    @MainActor
    private func startSelectedStream(_ threadId: String) {
        guard launchMode == .live else {
            return
        }
        guard selectedStreamThreadID != threadId else {
            return
        }
        selectedStreamTask?.cancel()
        selectedStreamThreadID = threadId
        let cursor = selectedStreamCheckpoint.cursor
        selectedStreamTask = Task {
            do {
                let configuration = try GatewayConfiguration(userInput: gatewayURL)
                let stream = GatewayEventStream(configuration: configuration, cursor: cursor, threadId: threadId)
                let scope = GatewayEventScope.selected(threadId: threadId)
                for try await envelope in stream.envelopes() {
                    guard scope.accepts(threadId: envelope.event.threadId) else {
                        continue
                    }
                    await MainActor.run {
                        selectedStreamCheckpoint.observe(envelope)
                    }
                    await handleLiveEvent(envelope.event, selectedThreadId: threadId)
                }
            } catch {
                await MainActor.run {
                    selectedStreamCheckpoint.recordDisconnect()
                    selectedStreamTask = nil
                    selectedStreamThreadID = nil
                    statusMessage = "Live stream reconnect needed: \(error.localizedDescription)"
                }
                let usePollingFallback = await MainActor.run {
                    selectedStreamCheckpoint.shouldUsePollingFallback()
                }
                if usePollingFallback {
                    await pollSelectedThreadUntilIdle(threadId)
                } else {
                    await loadSelectedThread(threadId, markSeen: false)
                }
                try? await Task.sleep(for: .seconds(2))
                await MainActor.run {
                    if selectedThreadID == threadId {
                        startSelectedStream(threadId)
                    }
                }
            }
        }
    }

    @MainActor
    private func startGlobalStream() {
        guard launchMode == .live else {
            return
        }
        let excludedThreadId = selectedThreadID
        guard globalStreamTask == nil || globalStreamExcludedThreadID != excludedThreadId else {
            return
        }
        globalStreamTask?.cancel()
        globalStreamExcludedThreadID = excludedThreadId
        let cursor = globalStreamCheckpoint.cursor
        globalStreamTask = Task {
            do {
                let configuration = try GatewayConfiguration(userInput: gatewayURL)
                let stream = GatewayEventStream(configuration: configuration, cursor: cursor, excludeThreadId: excludedThreadId)
                let scope = GatewayEventScope.global(excludingThreadId: excludedThreadId)
                for try await envelope in stream.envelopes() {
                    guard scope.accepts(threadId: envelope.event.threadId) else {
                        continue
                    }
                    await MainActor.run {
                        globalStreamCheckpoint.observe(envelope)
                    }
                    await handleLiveEvent(envelope.event, selectedThreadId: selectedThreadID)
                }
            } catch {
                await MainActor.run {
                    globalStreamCheckpoint.recordDisconnect()
                    globalStreamTask = nil
                    globalStreamExcludedThreadID = nil
                    statusMessage = "Global stream reconnect needed: \(error.localizedDescription)"
                }
                await refreshWorkspacePreservingSelection()
                let usePollingFallback = await MainActor.run {
                    globalStreamCheckpoint.shouldUsePollingFallback()
                }
                if usePollingFallback, let selectedThreadID {
                    await loadSelectedThread(selectedThreadID, markSeen: false)
                }
                try? await Task.sleep(for: .seconds(2))
                await MainActor.run {
                    startGlobalStream()
                }
            }
        }
    }

    @MainActor
    private func handleLiveEvent(_ event: GatewayLiveEvent, selectedThreadId: String?) async {
        switch event {
        case .threadViewPatch(let threadId),
             .refreshRequired(let threadId),
             .queuedInputUpdated(let threadId):
            if threadId == selectedThreadId {
                await loadSelectedThread(threadId, markSeen: false)
            }
        case .approvalUpdated(let threadId):
            if let selectedThreadId, threadId == nil || threadId == selectedThreadId {
                await loadSelectedThread(selectedThreadId, markSeen: false)
            }
        case .threadReadUpdated, .threadPinUpdated, .threadNotificationsUpdated, .threadUpserted:
            await refreshWorkspacePreservingSelection()
        case .unknown:
            break
        }
    }

    @MainActor
    private func refreshWorkspacePreservingSelection() async {
        guard launchMode == .live else {
            return
        }
        do {
            let workspace = try await service().loadWorkspace()
            state = FixtureAppState(connection: state.connection, workspace: workspace, selectedThread: state.selectedThread, approvals: state.approvals)
        } catch {
            statusMessage = error.localizedDescription
        }
    }

    @MainActor
    private func toggleSelectedNotifications() async {
        guard let detail = state.selectedThread else {
            return
        }
        await runLiveAction {
            try await service().setThreadNotifications(threadId: detail.thread.id, enabled: !detail.thread.notificationsEnabled)
            await refresh()
        }
    }

    @MainActor
    private func loadOlderTimeline() async {
        guard let threadId = selectedThreadID, let currentDetail = state.selectedThread else {
            return
        }
        guard let cursor = currentDetail.timeline.olderCursor else {
            statusMessage = "No older timeline page available."
            return
        }
        await runLiveAction {
            let page = try await service().loadOlderTimeline(threadId: threadId, cursor: cursor)
            let mergedRows = WorkspaceNormalizer.mergeOlderHistory(current: currentDetail.timeline.rows, older: page.timeline.rows)
            let mergedDetail = ThreadDetail(
                thread: page.thread,
                timeline: ThreadTimeline(
                    threadId: page.timeline.threadId,
                    liveState: page.timeline.liveState,
                    viewRevision: max(currentDetail.timeline.viewRevision, page.timeline.viewRevision),
                    rows: mergedRows,
                    olderCursor: page.timeline.olderCursor,
                    hasOlder: page.timeline.hasOlder
                )
            )
            state = FixtureAppState(connection: state.connection, workspace: state.workspace, selectedThread: mergedDetail, approvals: state.approvals)
        }
    }

    @MainActor
    private func routeToThread(_ threadId: String) async {
        selectedThreadID = threadId
        preferredCompactColumn = .detail
        if launchMode == .live {
            await loadSelectedThread(threadId, markSeen: true)
        }
    }

    @MainActor
    private func renameSelectedThread(name: String) async {
        guard let threadId = selectedThreadID else {
            return
        }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return
        }
        await runLiveAction {
            try await service().renameThread(threadId: threadId, name: trimmed)
            await refresh()
        }
    }

    @MainActor
    private func archiveSelectedThread() async {
        guard let threadId = selectedThreadID else {
            return
        }
        await archiveThread(threadId)
    }

    @MainActor
    private func archiveThread(_ threadId: String) async {
        await runLiveAction {
            try await service().archiveThread(threadId: threadId)
            selectedThreadID = nil
            await refresh()
        }
    }

    @MainActor
    private func setPinned(_ thread: WorkspaceThread, pinned: Bool) async {
        await runLiveAction {
            try await service().pinThread(threadId: thread.id, pinned: pinned)
            await refresh()
        }
    }

    @MainActor
    private func decideApproval(_ approval: ApprovalRequest, decision: ApprovalDecision) async {
        guard launchMode == .live else {
            state = FixtureAppState(
                connection: state.connection,
                workspace: state.workspace,
                selectedThread: state.selectedThread,
                approvals: state.approvals.filter { $0.id != approval.id }
            )
            return
        }
        await runLiveAction {
            try await service().decideApproval(approvalId: approval.id, decision: decision)
            if let selectedThreadID {
                await loadSelectedThread(selectedThreadID, markSeen: false)
            }
        }
    }

    @MainActor
    private func retryQueuedInput(_ queueId: String) async {
        guard let threadId = selectedThreadID else {
            return
        }
        await runLiveAction {
            _ = try await service().retryQueuedInput(threadId: threadId, queueId: queueId)
            await loadSelectedThread(threadId, markSeen: false)
        }
    }

    @MainActor
    private func steerQueuedInput(_ queueId: String) async {
        guard let threadId = selectedThreadID else {
            return
        }
        await runLiveAction {
            _ = try await service().steerQueuedInput(threadId: threadId, queueId: queueId)
            await loadSelectedThread(threadId, markSeen: false)
        }
    }

    @MainActor
    private func deleteQueuedInput(_ queueId: String) async {
        guard let threadId = selectedThreadID else {
            return
        }
        await runLiveAction {
            try await service().deleteQueuedInput(threadId: threadId, queueId: queueId)
            await loadSelectedThread(threadId, markSeen: false)
        }
    }

    @MainActor
    private func runLiveAction(_ action: () async throws -> Void) async {
        guard launchMode == .live else {
            return
        }
        isBusy = true
        defer { isBusy = false }
        do {
            try await action()
            statusMessage = nil
        } catch {
            statusMessage = error.localizedDescription
        }
    }

    @MainActor
    private func enableNotifications(authorizer: NativeNotificationAuthorizing = SystemNativeNotificationAuthorizer()) async {
        do {
            NativeNotificationRuntime.gatewayConfiguration = try GatewayConfiguration(userInput: gatewayURL)
            guard try await authorizer.requestAuthorization() else {
                notificationStatus = "Notifications denied"
                return
            }
            await authorizer.registerForRemoteNotifications()
            notificationStatus = "Notification registration requested"
        } catch {
            notificationStatus = "Notifications unavailable: \(error.localizedDescription)"
        }
    }
}

#Preview {
    ConnectionView(launchArguments: ["--fixture-connected"])
}
