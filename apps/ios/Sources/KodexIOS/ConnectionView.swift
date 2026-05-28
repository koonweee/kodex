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
        _state = State(initialValue: mode == .live ? FixtureAppState(connection: .offline(message: "Not connected"), workspace: WorkspaceSnapshot(projects: [], chats: [], pinned: []), selectedThread: nil, approvals: []) : fixtureState)
        _accountState = State(initialValue: mode == .authRequired ? .requiresOpenAIAuth : .unknown)
        _selectedThreadID = State(initialValue: fixtureState.selectedThread?.thread.id ?? fixtureState.workspace.firstThread?.id)
    }

    var body: some View {
        NavigationSplitView(preferredCompactColumn: $preferredCompactColumn) {
            List(selection: $selectedThreadID) {
                gatewaySection
                actionSection

                if !state.workspace.pinned.isEmpty {
                    Section("Pinned") {
                        threadRows(state.workspace.pinned)
                    }
                }

                if !state.workspace.chats.isEmpty {
                    Section("Chats") {
                        threadRows(state.workspace.chats)
                    }
                }

                ForEach(state.workspace.projects) { project in
                    Section(project.name) {
                        threadRows(project.threads)
                    }
                }

                if state.workspace.firstThread == nil {
                    ContentUnavailableView("No Threads", systemImage: "tray", description: Text("Connect to a Kodex gateway or use a fixture launch mode."))
                        .accessibilityIdentifier("EmptyWorkspace")
                }
            }
            .navigationTitle("Kodex")
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
                    onSend: { await sendComposer() },
                    onSettingsChange: { settings in await updateComposerSettings(settings) },
                    onStop: { await stopSelectedThread() },
                    onLoadOlder: { await loadOlderTimeline() },
                    onRename: { name in await renameSelectedThread(name: name) },
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

    private var gatewaySection: some View {
        Section("Gateway") {
            Text(state.connection.displayText)
                .font(.footnote)
                .foregroundStyle(connectionColor)
                .accessibilityIdentifier("GatewayStatus")
            Text(accountState.displayText)
                .font(.caption)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("AccountStatus")
            TextField("Gateway URL", text: $gatewayURL)
                .textContentType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Check Connection") {
                Task {
                    await refresh()
                }
            }
            Button("Enable Notifications") {
                Task {
                    await enableNotifications()
                }
            }
            Text(notificationStatus)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var actionSection: some View {
        Section {
            Button("New Chat") {
                Task {
                    await createChatThread()
                }
            }
            .disabled(launchMode != .live || isBusy)

            Button("New Project Thread") {
                Task {
                    await createProjectThread()
                }
            }
            .disabled(launchMode != .live || state.workspace.projects.first == nil || isBusy)
        }
    }

    @ViewBuilder
    private func threadRows(_ threads: [WorkspaceThread]) -> some View {
        ForEach(threads) { thread in
            NavigationLink(value: thread.id) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(thread.title)
                            .font(.headline)
                        Text(thread.cwd)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if thread.unread {
                        Circle()
                            .fill(Color.accentColor)
                            .frame(width: 9, height: 9)
                            .accessibilityLabel("Unread")
                    }
                }
            }
            .swipeActions(edge: .trailing) {
                Button(thread.pinned ? "Unpin" : "Pin") {
                    Task {
                        await setPinned(thread, pinned: !thread.pinned)
                    }
                }
                .tint(.blue)
                Button("Archive", role: .destructive) {
                    Task {
                        await archiveThread(thread.id)
                    }
                }
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

    private var connectionColor: Color {
        switch state.connection {
        case .connected:
            return .green
        case .degraded:
            return .orange
        case .offline, .invalidURL:
            return .red
        }
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
        await runLiveAction {
            let thread = try await service().createProjectThread(projectId: project.id)
            selectedThreadID = thread.id
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

private struct ThreadDetailView: View {
    let detail: ThreadDetail
    let approvals: [ApprovalRequest]
    let queuedInputs: [QueuedInputSummary]
    let skills: [SkillSummary]
    let localImagePaths: [String]
    @Binding var composerText: String
    @Binding var isExpandedComposerPresented: Bool
    @Binding var selectedPhotoItem: PhotosPickerItem?
    let isBusy: Bool
    let statusMessage: String?
    let composerSettings: ComposerRunSettings
    let permissionsPreset: String?
    let onSend: () async -> Void
    let onSettingsChange: (ComposerRunSettings) async -> Void
    let onStop: () async -> Void
    let onLoadOlder: () async -> Void
    let onRename: (String) async -> Void
    let onToggleNotifications: () async -> Void
    let onArchive: () async -> Void
    let onApprovalDecision: (ApprovalRequest, ApprovalDecision) async -> Void
    let onQueuedRetry: (String) async -> Void
    let onQueuedSteer: (String) async -> Void
    let onQueuedDelete: (String) async -> Void
    @State private var isRenamePresented = false
    @State private var renameText = ""

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    Button {
                        Task {
                            await onLoadOlder()
                        }
                    } label: {
                        Label("Load Older", systemImage: "clock.arrow.circlepath")
                    }
                    .buttonStyle(.bordered)
                    .disabled(!detail.timeline.hasOlder || detail.timeline.olderCursor == nil)
                    .accessibilityIdentifier("LoadOlderTimeline")

                    ForEach(queuedInputs) { queuedInput in
                        QueuedInputCard(
                            queuedInput: queuedInput,
                            onRetry: { await onQueuedRetry(queuedInput.id) },
                            onSteer: { await onQueuedSteer(queuedInput.id) },
                            onDelete: { await onQueuedDelete(queuedInput.id) }
                        )
                    }
                    ForEach(approvals) { approval in
                        ApprovalCard(
                            approval: approval,
                            onDecision: { decision in await onApprovalDecision(approval, decision) }
                        )
                    }
                    ForEach(detail.timeline.rows) { row in
                        TimelineRowView(row: row)
                    }
                }
                .padding()
            }
            .accessibilityIdentifier("ThreadTimeline")

            if let statusMessage {
                Text(statusMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal)
            }

            ComposerBar(
                text: $composerText,
                selectedPhotoItem: $selectedPhotoItem,
                isExpandedComposerPresented: $isExpandedComposerPresented,
                skills: skills,
                localImagePaths: localImagePaths,
                isBusy: isBusy,
                settings: composerSettings,
                permissionsPreset: permissionsPreset,
                onSettingsChange: onSettingsChange,
                onSend: onSend
            )
        }
        .navigationTitle(detail.thread.title)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button("Stop") {
                    Task {
                        await onStop()
                    }
                }
                .accessibilityIdentifier("StopThread")
                Menu("Actions") {
                    Button("Rename") {
                        renameText = detail.thread.title
                        isRenamePresented = true
                    }
                    Button(detail.thread.notificationsEnabled ? "Mute Notifications" : "Enable Notifications") {
                        Task {
                            await onToggleNotifications()
                        }
                    }
                    Button("Archive", role: .destructive) {
                        Task {
                            await onArchive()
                        }
                    }
                }
            }
        }
        .alert("Rename Thread", isPresented: $isRenamePresented) {
            TextField("Name", text: $renameText)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                Task {
                    await onRename(renameText)
                }
            }
        }
        .sheet(isPresented: $isExpandedComposerPresented) {
            NavigationStack {
                TextEditor(text: $composerText)
                    .padding()
                    .navigationTitle("Compose")
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Send") {
                                Task {
                                    await onSend()
                                    isExpandedComposerPresented = false
                                }
                            }
                            .disabled(isBusy)
                        }
                    }
            }
        }
    }
}

private struct TimelineRowView: View {
    let row: TimelineRow

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(row.title, systemImage: iconName)
                .font(.headline)
            Text(row.body)
                .font(.body)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 8))
        .accessibilityIdentifier("TimelineRow-\(row.kind.rawValue)")
    }

    private var iconName: String {
        switch row.kind {
        case .message:
            return "text.bubble"
        case .work:
            return "gearshape"
        case .activity:
            return "waveform.path.ecg"
        case .tool:
            return "hammer"
        case .fileChange:
            return "doc.text"
        case .image:
            return "photo"
        case .warning:
            return "exclamationmark.triangle"
        case .error:
            return "xmark.octagon"
        case .unknown:
            return "circle"
        }
    }
}

private struct ComposerBar: View {
    @Binding var text: String
    @Binding var selectedPhotoItem: PhotosPickerItem?
    @Binding var isExpandedComposerPresented: Bool
    let skills: [SkillSummary]
    let localImagePaths: [String]
    let isBusy: Bool
    let settings: ComposerRunSettings
    let permissionsPreset: String?
    let onSettingsChange: (ComposerRunSettings) async -> Void
    let onSend: () async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !localImagePaths.isEmpty {
                Text("\(localImagePaths.count) image attachment\(localImagePaths.count == 1 ? "" : "s")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 8) {
                Button {
                    isExpandedComposerPresented = true
                } label: {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                }
                .accessibilityLabel("Expanded Composer")

                TextField("Message Kodex", text: $text, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...4)
                    .accessibilityIdentifier("ComposerInput")

                Menu {
                    PhotosPicker(selection: $selectedPhotoItem, matching: .images) {
                        Label("Attach Photo", systemImage: "photo")
                    }
                    if !skills.isEmpty {
                        Section("Skills") {
                            ForEach(skills.prefix(8)) { skill in
                                Button("$\(skill.name)") {
                                    text.append(text.isEmpty ? "$\(skill.name)" : " $\(skill.name)")
                                }
                            }
                        }
                    }
                    Section("Model") {
                        ForEach(Self.modelOptions, id: \.self) { model in
                            Button(model) {
                                Task {
                                    await onSettingsChange(settings.with(model: model))
                                }
                            }
                        }
                    }
                    Section("Reasoning") {
                        ForEach(Self.effortOptions, id: \.self) { effort in
                            Button(effort.capitalized) {
                                Task {
                                    await onSettingsChange(settings.with(effort: effort))
                                }
                            }
                        }
                    }
                    Section("Approvals") {
                        ForEach(Self.approvalPolicyOptions) { option in
                            Button(option.label) {
                                Task {
                                    await onSettingsChange(settings.with(approvalPolicy: option.value))
                                }
                            }
                        }
                    }
                    Section("Sandbox") {
                        ForEach(Self.sandboxOptions) { option in
                            Button(option.label) {
                                Task {
                                    await onSettingsChange(settings.with(sandboxPolicy: option.policy))
                                }
                            }
                        }
                    }
                } label: {
                    Image(systemName: "slider.horizontal.3")
                }
                .accessibilityLabel("Composer Options, model \(settings.model ?? "default"), reasoning \(settings.effort ?? "default"), approvals \(settings.approvalPolicy ?? "default"), permissions \(permissionsPreset ?? settings.sandboxDisplay)")

                Button("Send") {
                    Task {
                        await onSend()
                    }
                }
                .disabled(isBusy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .buttonStyle(.borderedProminent)
            }
        }
        .padding()
        .background(.bar)
    }

    private static let modelOptions = ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"]
    private static let effortOptions = ["low", "medium", "high", "xhigh"]
    private static let approvalPolicyOptions = [
        ComposerTextOption(label: "Ask First", value: "on-request"),
        ComposerTextOption(label: "On Failure", value: "on-failure"),
        ComposerTextOption(label: "Never Ask", value: "never")
    ]
    private static let sandboxOptions = [
        ComposerPolicyOption(label: "Read Only", value: "readOnly", policy: .object(["type": .string("readOnly")])),
        ComposerPolicyOption(label: "Workspace Write", value: "workspaceWrite", policy: .object(["type": .string("workspaceWrite"), "networkAccess": .bool(false), "writableRoots": .array([])])),
        ComposerPolicyOption(label: "Full Access", value: "dangerFullAccess", policy: .object(["type": .string("dangerFullAccess")]))
    ]
}

private struct ComposerTextOption: Identifiable {
    let label: String
    let value: String

    var id: String { value }
}

private struct ComposerPolicyOption: Identifiable {
    let label: String
    let value: String
    let policy: AnySendable

    var id: String { value }
}

private struct ApprovalCard: View {
    let approval: ApprovalRequest
    let onDecision: (ApprovalDecision) async -> Void
    @State private var pendingDecision: ApprovalDecision?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(approval.title)
                .font(.headline)
            Text("Risk: \(approval.risk)")
                .font(.caption)
                .foregroundStyle(.secondary)
            if !approval.context.isEmpty {
                Text(approval.context)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            HStack {
                Button("Decline", role: .destructive) {
                    Task {
                        await onDecision(.decline)
                    }
                }
                .accessibilityIdentifier("DeclineApproval-\(approval.id)")
                Button("Approve") {
                    submit(.accept)
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("ApproveApproval-\(approval.id)")
            }
        }
        .padding(12)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
        .confirmationDialog(
            "Approve Risky Action?",
            isPresented: Binding(
                get: { pendingDecision != nil },
                set: { if !$0 { pendingDecision = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Approve", role: .destructive) {
                guard let pendingDecision else {
                    return
                }
                Task {
                    await onDecision(pendingDecision)
                    self.pendingDecision = nil
                }
            }
            Button("Cancel", role: .cancel) {
                pendingDecision = nil
            }
        } message: {
            Text("\(approval.title) has \(approval.risk) risk.")
        }
    }

    private func submit(_ decision: ApprovalDecision) {
        if ApprovalRiskPolicy.requiresConfirmation(approval, decision: decision) {
            pendingDecision = decision
        } else {
            Task {
                await onDecision(decision)
            }
        }
    }
}

private struct QueuedInputCard: View {
    let queuedInput: QueuedInputSummary
    let onRetry: () async -> Void
    let onSteer: () async -> Void
    let onDelete: () async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Queued input")
                .font(.headline)
            Text(queuedInput.status)
                .font(.caption)
                .foregroundStyle(.secondary)
            if let lastError = queuedInput.lastError {
                Text(lastError)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            HStack {
                Button("Retry") {
                    Task {
                        await onRetry()
                    }
                }
                Button("Steer") {
                    Task {
                        await onSteer()
                    }
                }
                Button("Delete", role: .destructive) {
                    Task {
                        await onDelete()
                    }
                }
            }
        }
        .padding(12)
        .background(Color.blue.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityIdentifier("QueuedInputCard")
    }
}

#Preview {
    ConnectionView(launchArguments: ["--fixture-connected"])
}
