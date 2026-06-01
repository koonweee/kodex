import PhotosUI
import SwiftUI
import KodexCore
import KodexAPI

struct ConnectionView: View {
    private static let gatewayURLStorageKey = "kodex.gatewayURL"
    private static let selectedPatchFlushDelay: Duration = .milliseconds(25)
    private static let selectedSnapshotRecoveryDelays: [Duration] = [.seconds(2), .seconds(6), .seconds(12)]
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.scenePhase) private var scenePhase
    private let launchMode: FixtureLaunchMode
    private let liveE2EEnabled: Bool
    private let makeService: (String) throws -> LiveGatewayService
    @AppStorage(Self.gatewayURLStorageKey) private var gatewayURL = GatewayConfiguration.simulatorDefault.baseURL.absoluteString
    @State private var model: ConnectionModel

    init(
        launchArguments: [String] = ProcessInfo.processInfo.arguments,
        makeService: @escaping (String) throws -> LiveGatewayService = { userInput in
            let configuration = try GatewayConfiguration(userInput: userInput)
            return LiveGatewayService(configuration: configuration)
        }
    ) {
        let mode = FixtureLaunchMode(arguments: launchArguments)
        if let configuredURL = ProcessInfo.processInfo.environment["KODEX_GATEWAY_URL"] {
            UserDefaults.standard.set(configuredURL, forKey: Self.gatewayURLStorageKey)
        }
        let fixtureState = FixtureStore.state(for: mode)
        self.launchMode = mode
        self.liveE2EEnabled = ProcessInfo.processInfo.environment["KODEX_IOS_LIVE_E2E"] == "1"
        self.makeService = makeService
        _model = State(initialValue: ConnectionModel(launchMode: mode, fixtureState: fixtureState))
    }

    var body: some View {
        Group {
            if usesCompactStackNavigation {
                NavigationStack(path: model.binding(\.compactThreadPath)) {
                    workspaceDrawer
                        .navigationDestination(for: String.self) { threadID in
                            detailColumn(for: threadID)
                        }
                }
            } else {
                NavigationSplitView(preferredCompactColumn: model.binding(\.preferredCompactColumn)) {
                    workspaceDrawer
                } detail: {
                    detailColumn(for: model.selectedThreadID)
                }
            }
        }
        .task {
            if launchMode == .live {
                await refresh()
            }
        }
        .task(id: model.selectedThreadID) {
            guard launchMode == .live, let threadID = model.selectedThreadID else {
                return
            }
            await loadSelectedThread(threadID, markSeen: true)
        }
        .onDisappear {
            model.cancelStreams()
        }
        .onChange(of: model.selectedPhotoItem) { _, newValue in
            guard let newValue else {
                return
            }
            Task {
                await uploadPhoto(newValue)
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

    private var usesCompactStackNavigation: Bool {
        horizontalSizeClass == .compact
    }

    private var workspaceDrawer: some View {
        WorkspaceDrawerView(
            workspace: model.state.workspace,
            selectedThreadID: model.selectedThreadID,
            connection: model.state.connection,
            accountState: model.accountState,
            approvalThreadIds: model.approvalThreadIds,
            isBusy: model.isBusy,
            launchMode: launchMode,
            gatewayURL: $gatewayURL,
            searchQuery: model.binding(\.workspaceSearchQuery),
            scope: model.binding(\.workspaceScope),
            pinnedCollapsed: model.binding(\.pinnedCollapsed),
            projectsCollapsed: model.binding(\.projectsCollapsed),
            chatsCollapsed: model.binding(\.chatsCollapsed),
            collapsedProjectIds: model.binding(\.collapsedProjectIds),
            isConnectionSettingsPresented: model.binding(\.isConnectionSettingsPresented),
            onRefresh: { await refresh() },
            onCreateChat: { await createChatThread() },
            onCreateProjectThread: { projectId in await createProjectThread(projectId: projectId) },
            onSelectThread: { threadID in routeToThreadLocally(threadID) },
            onPinThread: { thread, pinned in await setPinned(thread, pinned: pinned) },
            onArchiveThread: { threadID in await archiveThread(threadID) },
            onEnableNotifications: { await enableNotifications() }
        )
        .refreshable {
            await refresh()
        }
    }

    @ViewBuilder
    private func detailColumn(for threadID: String?) -> some View {
        if let detail = model.detail(for: threadID) {
            ThreadDetailView(
                detail: detail,
                approvals: model.state.approvals.filter { $0.threadId.isEmpty || $0.threadId == detail.thread.id },
                queuedInputs: model.queuedInputs,
                modelOptions: model.availableModels,
                localImagePaths: model.localImagePaths,
                composerText: model.binding(\.composerText),
                selectedPhotoItem: model.binding(\.selectedPhotoItem),
                isBusy: model.isBusy,
                statusMessage: model.statusMessage,
                composerSettings: model.composerSettings,
                permissionsPreset: model.composerPermissionsPreset,
                canLoadOlderHistory: true,
                usesNativeNavigationBar: usesCompactStackNavigation,
                onShowSidebar: { showSidebar() },
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
            .id(detail.thread.id)
        } else if let threadID {
            ThreadLoadingView(title: model.state.workspace.thread(id: threadID)?.title ?? "Loading Thread")
        } else {
            ContentUnavailableView("Select a Thread", systemImage: "bubble.left.and.bubble.right")
        }
    }

    private func routeToThreadLocally(_ threadID: String) {
        showThreadDetail(threadID)
    }

    private func showThreadDetail(_ threadID: String) {
        model.showThreadDetail(threadID, usesCompactStackNavigation: usesCompactStackNavigation)
    }

    private func showSidebar() {
        model.showSidebar(usesCompactStackNavigation: usesCompactStackNavigation)
    }

    private func service() throws -> LiveGatewayService {
        try makeService(gatewayURL)
    }

    @MainActor
    private func refresh() async {
        if launchMode != .live {
            model.state = FixtureStore.state(for: .connected)
            model.selectedThreadID = model.state.selectedThread?.thread.id
            return
        }

        model.isBusy = true
        defer { model.isBusy = false }

        do {
            let connection = await GatewayConnectionChecker(probe: GatewayProbe(load: URLSessionGatewayLoader.load)).check(userInput: gatewayURL)
            model.state = FixtureAppState(connection: connection, workspace: model.state.workspace, selectedThread: model.state.selectedThread, approvals: model.state.approvals)
            guard connection.canLoadLiveWorkspace else {
                model.accountState = .unavailable(message: connection.displayText)
                model.statusMessage = connection.displayText
                return
            }

            let live = try service()
            model.accountState = await live.loadAccount()
            try await live.loadCapabilities()
            let models = try? await live.listModels()
            let workspace = try await live.loadWorkspace()
            let nextSelected = model.selectedThreadID ?? workspace.firstThread?.id
            model.state = FixtureAppState(connection: connection, workspace: workspace, selectedThread: nil, approvals: [])
            if let models {
                model.availableModels = ComposerModelOption.options(from: models)
            }
            model.selectedThreadID = nextSelected
            if let nextSelected {
                await loadSelectedThread(nextSelected, markSeen: false)
            }
            startGlobalStream()
            model.statusMessage = nil
        } catch {
            model.state = FixtureAppState(connection: model.state.connection, workspace: model.state.workspace, selectedThread: model.state.selectedThread, approvals: model.state.approvals)
            model.statusMessage = error.localizedDescription
        }
    }

    @MainActor
    private func loadSelectedThread(_ threadId: String, markSeen: Bool) async {
        guard launchMode == .live else {
            return
        }
        guard model.selectedThreadID == threadId else {
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
            guard !Task.isCancelled, model.selectedThreadID == threadId else {
                return
            }
            model.state = FixtureAppState(connection: model.state.connection, workspace: model.state.workspace, selectedThread: detail, approvals: approvals)
            model.queuedInputs = queue
            model.skills = loadedSkills ?? []
            if let threadSettings = detail.thread.composerSettings {
                model.composerSettings = threadSettings
                model.composerPermissionsPreset = detail.thread.permissionsPreset
            } else if let loadedSettings {
                model.composerSettings = loadedSettings.settings
                model.composerPermissionsPreset = loadedSettings.permissionsPreset
            }
            model.statusMessage = nil
            startSelectedStream(threadId)
            startGlobalStream()
        } catch {
            if model.selectedThreadID == threadId {
                model.statusMessage = error.localizedDescription
            }
        }
    }

    @MainActor
    private func createChatThread() async {
        await runLiveAction {
            let prompt = liveE2EEnabled ? "Reply with the common four-letter response to ping." : "Hello from Kodex iOS"
            let live = try service()
            let thread = try await live.createChatThread(firstMessageText: prompt)
            showThreadDetail(thread.id)
            await refresh()
            scheduleSelectedSnapshotRecovery(threadId: thread.id, submittedText: prompt)
        }
    }

    @MainActor
    private func createProjectThread() async {
        guard let project = model.state.workspace.projects.first else {
            return
        }
        await createProjectThread(projectId: project.id)
    }

    @MainActor
    private func createProjectThread(projectId: String) async {
        await runLiveAction {
            let thread = try await service().createProjectThread(projectId: projectId)
            showThreadDetail(thread.id)
            await refresh()
        }
    }

    @MainActor
    private func sendComposer() async {
        guard let threadId = model.selectedThreadID else {
            return
        }
        let submittedText = model.composerText
        let submittedImagePaths = model.localImagePaths
        let submittedSettings = model.composerSettings
        let submittedSkills = model.skills
        let baselineTimeline = model.detail(for: threadId)?.timeline
        let baselineViewRevision = baselineTimeline?.viewRevision
        let baselineRowIds = Set(baselineTimeline?.rows.map(\.id) ?? [])
        guard !submittedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }
        await runLiveAction {
            let skillMentions = SkillMentionDetector.mentions(
                in: submittedText,
                skills: submittedSkills.map { SkillCatalogEntry(name: $0.name, path: $0.path) }
            )
            _ = try await service().submitTextInput(
                threadId: threadId,
                text: submittedText,
                skillMentions: skillMentions,
                localImagePaths: submittedImagePaths,
                settings: submittedSettings
            )
            if model.selectedThreadID == threadId {
                model.composerText = ""
                model.localImagePaths = []
            }
            startSelectedStream(threadId)
            scheduleSelectedSnapshotRecovery(
                threadId: threadId,
                submittedText: submittedText,
                baselineViewRevision: baselineViewRevision,
                baselineRowIds: baselineRowIds
            )
        }
    }

    @MainActor
    private func updateComposerSettings(_ settings: ComposerRunSettings) async {
        model.composerSettings = settings
        guard launchMode == .live else {
            return
        }
        await runLiveAction {
            if let threadId = model.selectedThreadID {
                let previousSettings = model.detail(for: threadId)?.thread.composerSettings
                let thread = try await service().updateThreadSettings(
                    threadId: threadId,
                    settings: settings,
                    previousSettings: previousSettings
                )
                if model.selectedThreadID == threadId, let detail = model.detail(for: threadId) {
                    model.state = FixtureAppState(
                        connection: model.state.connection,
                        workspace: model.state.workspace,
                        selectedThread: ThreadDetail(thread: thread, timeline: detail.timeline),
                        approvals: model.state.approvals
                    )
                    model.composerSettings = thread.composerSettings ?? settings
                    model.composerPermissionsPreset = thread.permissionsPreset
                }
            } else {
                try await service().persistComposerSettings(settings)
            }
        }
    }

    @MainActor
    private func uploadPhoto(_ item: PhotosPickerItem) async {
        let threadId = model.selectedThreadID
        defer {
            model.selectedPhotoItem = nil
        }
        guard launchMode == .live else {
            return
        }
        await runLiveAction {
            guard let data = try await item.loadTransferable(type: Data.self) else {
                return
            }
            let images = try await service().uploadImageData(data, fileName: "ios-photo-\(UUID().uuidString).png")
            guard model.selectedThreadID == threadId else {
                return
            }
            model.localImagePaths.append(contentsOf: images.map(\.path))
        }
    }

    @MainActor
    private func stopSelectedThread() async {
        guard let threadId = model.selectedThreadID else {
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
            guard !Task.isCancelled, model.selectedThreadID == threadId else {
                return
            }
            await loadSelectedThread(threadId, markSeen: false)
            if model.detail(for: threadId)?.timeline.liveState == .idle {
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
        guard model.selectedThreadID == threadId else {
            return
        }
        guard model.selectedStreamThreadID != threadId else {
            return
        }
        model.selectedStreamTask?.cancel()
        cancelSelectedPatchFlush()
        model.selectedStreamThreadID = threadId
        let cursor = model.selectedStreamCheckpoint.cursor
        model.selectedStreamTask = Task {
            do {
                let configuration = try GatewayConfiguration(userInput: gatewayURL)
                let stream = GatewayEventStream(configuration: configuration, cursor: cursor, threadId: threadId)
                let scope = GatewayEventScope.selected(threadId: threadId)
                for try await envelope in stream.envelopes() {
                    guard scope.accepts(threadId: envelope.event.threadId) else {
                        continue
                    }
                    await MainActor.run {
                        model.selectedStreamCheckpoint.observe(envelope)
                    }
                    if case .threadViewPatch = envelope.event {
                        await enqueueSelectedThreadPatch(envelope, threadId: threadId)
                        continue
                    }
                    await handleLiveEvent(envelope.event, selectedThreadId: threadId)
                }
                guard !Task.isCancelled else {
                    return
                }
                await handleSelectedStreamDisconnect(threadId: threadId, message: "Live stream ended. Reconnecting.")
            } catch {
                guard !Task.isCancelled else {
                    return
                }
                await handleSelectedStreamDisconnect(
                    threadId: threadId,
                    message: "Live stream reconnect needed: \(error.localizedDescription)"
                )
            }
        }
    }

    @MainActor
    private func handleSelectedStreamDisconnect(threadId: String, message: String) async {
        guard model.selectedThreadID == threadId else {
            return
        }
        cancelSelectedPatchFlush()
        model.selectedStreamCheckpoint.recordDisconnect()
        model.selectedStreamTask = nil
        model.selectedStreamThreadID = nil
        model.statusMessage = message

        if model.selectedStreamCheckpoint.shouldUsePollingFallback() {
            await pollSelectedThreadUntilIdle(threadId)
        } else {
            await loadSelectedThread(threadId, markSeen: false)
        }

        try? await Task.sleep(for: .seconds(2))
        if model.selectedThreadID == threadId {
            startSelectedStream(threadId)
        }
    }

    @MainActor
    private func startGlobalStream() {
        guard launchMode == .live else {
            return
        }
        let excludedThreadId = model.selectedThreadID
        guard model.globalStreamTask == nil || model.globalStreamExcludedThreadID != excludedThreadId else {
            return
        }
        model.globalStreamTask?.cancel()
        model.globalStreamExcludedThreadID = excludedThreadId
        let cursor = model.globalStreamCheckpoint.cursor
        model.globalStreamTask = Task {
            do {
                let configuration = try GatewayConfiguration(userInput: gatewayURL)
                let stream = GatewayEventStream(configuration: configuration, cursor: cursor, excludeThreadId: excludedThreadId)
                let scope = GatewayEventScope.global(excludingThreadId: excludedThreadId)
                for try await envelope in stream.envelopes() {
                    guard scope.accepts(threadId: envelope.event.threadId) else {
                        continue
                    }
                    await MainActor.run {
                        model.globalStreamCheckpoint.observe(envelope)
                    }
                    await handleLiveEvent(envelope.event, selectedThreadId: model.selectedThreadID)
                }
            } catch {
                await MainActor.run {
                    model.globalStreamCheckpoint.recordDisconnect()
                    model.globalStreamTask = nil
                    model.globalStreamExcludedThreadID = nil
                    model.statusMessage = "Global stream reconnect needed: \(error.localizedDescription)"
                }
                await refreshWorkspacePreservingSelection()
                let usePollingFallback = await MainActor.run {
                    model.globalStreamCheckpoint.shouldUsePollingFallback()
                }
                if usePollingFallback, let selectedThreadID = model.selectedThreadID {
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
        case .threadViewPatch(let patch):
            if patch.threadId == selectedThreadId {
                await enqueueSelectedThreadPatch(GatewayLiveEnvelope(seq: nil, event: event), threadId: patch.threadId)
            }
        case .refreshRequired(let threadId),
             .queuedInputUpdated(let threadId):
            if threadId == selectedThreadId {
                cancelSelectedPatchFlush()
                await loadSelectedThread(threadId, markSeen: false)
            }
        case .approvalUpdated(let threadId):
            if let selectedThreadId, threadId == nil || threadId == selectedThreadId {
                await loadSelectedThread(selectedThreadId, markSeen: false)
            }
        case .threadReadUpdated, .threadPinUpdated, .threadNotificationsUpdated, .threadUpserted:
            await refreshWorkspacePreservingSelection()
        case .threadMetadataUpdated(let threadId):
            await refreshWorkspacePreservingSelection()
            if threadId == selectedThreadId {
                cancelSelectedPatchFlush()
                await loadSelectedThread(threadId, markSeen: false)
            }
        case .unknown:
            break
        }
    }

    @MainActor
    private func enqueueSelectedThreadPatch(_ envelope: GatewayLiveEnvelope, threadId: String) async {
        guard model.selectedThreadID == threadId else {
            return
        }
        model.selectedPatchBuffer.append(envelope)
        guard model.selectedPatchFlushTask == nil else {
            return
        }
        model.selectedPatchFlushTask = Task { @MainActor in
            do {
                try await Task.sleep(for: Self.selectedPatchFlushDelay)
            } catch {
                return
            }
            guard !Task.isCancelled else {
                return
            }
            await flushSelectedThreadPatches(threadId: threadId)
        }
    }

    @MainActor
    private func flushSelectedThreadPatches(threadId: String) async {
        guard model.selectedThreadID == threadId else {
            model.selectedPatchBuffer.removeAll()
            model.selectedPatchFlushTask = nil
            return
        }

        let envelopes = GatewayLiveEventBatch.coalesce(model.selectedPatchBuffer)
        model.selectedPatchBuffer.removeAll()
        model.selectedPatchFlushTask = nil

        for envelope in envelopes {
            guard case .threadViewPatch(let patch) = envelope.event else {
                continue
            }
            switch applySelectedThreadPatch(patch, selectedThreadId: threadId) {
            case .applied, .ignoredStale:
                continue
            case .needsSnapshotRefresh(let reason):
                model.statusMessage = "Refreshing selected thread: \(reason)"
                await loadSelectedThread(threadId, markSeen: false)
                return
            }
        }
    }

    @MainActor
    private func applySelectedThreadPatch(_ patch: GatewayThreadViewPatch, selectedThreadId: String) -> ThreadTimelinePatchResult {
        guard patch.threadId == selectedThreadId, let currentDetail = model.detail(for: selectedThreadId) else {
            return .needsSnapshotRefresh(reason: "Selected thread patch did not match the loaded thread.")
        }

        let result = currentDetail.timeline.applying(patch)
        switch result {
        case .applied(let timeline), .ignoredStale(let timeline):
            let thread = currentDetail.thread.replacing(liveState: timeline.liveState)
            let workspace = model.state.workspace.replacingThreadStatus(threadId: selectedThreadId, liveState: timeline.liveState)
            model.state = FixtureAppState(
                connection: model.state.connection,
                workspace: workspace,
                selectedThread: ThreadDetail(thread: thread, timeline: timeline),
                approvals: model.state.approvals
            )
        case .needsSnapshotRefresh:
            break
        }
        return result
    }

    @MainActor
    private func cancelSelectedPatchFlush() {
        model.selectedPatchFlushTask?.cancel()
        model.selectedPatchFlushTask = nil
        model.selectedPatchBuffer.removeAll()
    }

    @MainActor
    private func scheduleSelectedSnapshotRecovery(
        threadId: String,
        submittedText: String,
        baselineViewRevision: Int64? = nil,
        baselineRowIds: Set<String> = []
    ) {
        model.selectedSnapshotRecoveryTask?.cancel()
        model.selectedSnapshotRecoveryTask = Task { @MainActor in
            for delay in Self.selectedSnapshotRecoveryDelays {
                do {
                    try await Task.sleep(for: delay)
                } catch {
                    return
                }
                guard !Task.isCancelled, model.selectedThreadID == threadId else {
                    return
                }
                if selectedThreadHasConvergedAfterSubmit(
                    threadId: threadId,
                    submittedText: submittedText,
                    baselineViewRevision: baselineViewRevision,
                    baselineRowIds: baselineRowIds
                ) {
                    return
                }
                await loadSelectedThread(threadId, markSeen: false)
            }
        }
    }

    @MainActor
    private func selectedThreadHasConvergedAfterSubmit(
        threadId: String,
        submittedText: String,
        baselineViewRevision: Int64?,
        baselineRowIds: Set<String>
    ) -> Bool {
        guard let timeline = model.detail(for: threadId)?.timeline else {
            return false
        }
        if let baselineViewRevision, timeline.viewRevision <= baselineViewRevision {
            return false
        }
        let containsSubmittedText = timeline.rows.contains { row in
            !baselineRowIds.contains(row.id) &&
            row.body.localizedCaseInsensitiveContains(submittedText)
        }
        return containsSubmittedText && timeline.liveState == .idle
    }

    @MainActor
    private func refreshWorkspacePreservingSelection() async {
        guard launchMode == .live else {
            return
        }
        do {
            let workspace = try await service().loadWorkspace()
            model.state = FixtureAppState(connection: model.state.connection, workspace: workspace, selectedThread: model.state.selectedThread, approvals: model.state.approvals)
        } catch {
            model.statusMessage = error.localizedDescription
        }
    }

    @MainActor
    private func toggleSelectedNotifications() async {
        guard let selectedThreadID = model.selectedThreadID, let detail = model.detail(for: selectedThreadID) else {
            return
        }
        await runLiveAction {
            try await service().setThreadNotifications(threadId: detail.thread.id, enabled: !detail.thread.notificationsEnabled)
            await refresh()
        }
    }

    @MainActor
    private func loadOlderTimeline() async {
        guard let threadId = model.selectedThreadID, let currentDetail = model.detail(for: threadId) else {
            return
        }
        guard let cursor = currentDetail.timeline.olderCursor else {
            model.statusMessage = "No older timeline page available."
            return
        }
        guard launchMode == .live else {
            let olderRows = ConnectionModel.fixtureOlderTimelineRows(threadId: threadId, before: currentDetail.timeline.rows.first?.displayOrder ?? 1)
            let mergedRows = WorkspaceNormalizer.mergeOlderHistory(current: currentDetail.timeline.rows, older: olderRows)
            let mergedDetail = ThreadDetail(
                thread: currentDetail.thread,
                timeline: ThreadTimeline(
                    threadId: currentDetail.timeline.threadId,
                    liveState: currentDetail.timeline.liveState,
                    viewRevision: currentDetail.timeline.viewRevision + 1,
                    rows: mergedRows,
                    olderCursor: nil,
                    hasOlder: false
                )
            )
            guard model.selectedThreadID == threadId else {
                return
            }
            model.state = FixtureAppState(connection: model.state.connection, workspace: model.state.workspace, selectedThread: mergedDetail, approvals: model.state.approvals)
            model.statusMessage = nil
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
            guard model.selectedThreadID == threadId else {
                return
            }
            model.state = FixtureAppState(connection: model.state.connection, workspace: model.state.workspace, selectedThread: mergedDetail, approvals: model.state.approvals)
        }
    }

    @MainActor
    private func routeToThread(_ threadId: String) async {
        showThreadDetail(threadId)
        if launchMode == .live {
            await loadSelectedThread(threadId, markSeen: true)
        }
    }

    @MainActor
    private func renameSelectedThread(name: String) async {
        guard let threadId = model.selectedThreadID else {
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
        guard let threadId = model.selectedThreadID else {
            return
        }
        await archiveThread(threadId)
    }

    @MainActor
    private func archiveThread(_ threadId: String) async {
        await runLiveAction {
            try await service().archiveThread(threadId: threadId)
            model.selectedThreadID = nil
            showSidebar()
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
            model.state = FixtureAppState(
                connection: model.state.connection,
                workspace: model.state.workspace,
                selectedThread: model.state.selectedThread,
                approvals: model.state.approvals.filter { $0.id != approval.id }
            )
            return
        }
        await runLiveAction {
            try await service().decideApproval(approvalId: approval.id, decision: decision)
            if let selectedThreadID = model.selectedThreadID {
                await loadSelectedThread(selectedThreadID, markSeen: false)
            }
        }
    }

    @MainActor
    private func retryQueuedInput(_ queueId: String) async {
        guard let threadId = model.selectedThreadID else {
            return
        }
        await runLiveAction {
            _ = try await service().retryQueuedInput(threadId: threadId, queueId: queueId)
            await loadSelectedThread(threadId, markSeen: false)
        }
    }

    @MainActor
    private func steerQueuedInput(_ queueId: String) async {
        guard let threadId = model.selectedThreadID else {
            return
        }
        await runLiveAction {
            _ = try await service().steerQueuedInput(threadId: threadId, queueId: queueId)
            await loadSelectedThread(threadId, markSeen: false)
        }
    }

    @MainActor
    private func deleteQueuedInput(_ queueId: String) async {
        guard let threadId = model.selectedThreadID else {
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
        model.isBusy = true
        defer { model.isBusy = false }
        do {
            try await action()
            model.statusMessage = nil
        } catch {
            model.statusMessage = error.localizedDescription
        }
    }

    @MainActor
    private func enableNotifications(authorizer: NativeNotificationAuthorizing = SystemNativeNotificationAuthorizer()) async {
        do {
            NativeNotificationRuntime.gatewayConfiguration = try GatewayConfiguration(userInput: gatewayURL)
            guard try await authorizer.requestAuthorization() else {
                model.statusMessage = "Notifications denied"
                return
            }
            await authorizer.registerForRemoteNotifications()
            model.statusMessage = "Notification registration requested"
        } catch {
            model.statusMessage = "Notifications unavailable: \(error.localizedDescription)"
        }
    }
}

#Preview {
    ConnectionView(launchArguments: ["--fixture-connected"])
}
