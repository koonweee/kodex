import Observation
import PhotosUI
import SwiftUI
import KodexAPI
import KodexCore

@MainActor
@Observable
final class ConnectionModel {
    var state: FixtureAppState
    var accountState: KodexAccountState
    var selectedThreadID: String?
    var composerText = ""
    var localImagePaths: [String] = []
    var selectedPhotoItem: PhotosPickerItem?
    var queuedInputs: [QueuedInputSummary] = []
    var skills: [SkillSummary] = []
    var availableModels = ComposerModelOption.fallbackOptions
    var composerSettings = ComposerRunSettings(model: "gpt-5.4", effort: "medium")
    var composerPermissionsPreset: String?
    var isBusy = false
    var statusMessage: String?
    var compactThreadPath: [String] = []
    var preferredCompactColumn = NavigationSplitViewColumn.sidebar
    var workspaceScope: WorkspaceScope
    var workspaceSearchQuery = ""
    var pinnedCollapsed = false
    var projectsCollapsed = false
    var chatsCollapsed = false
    var collapsedProjectIds: Set<String> = []
    var isConnectionSettingsPresented = false
    var selectedStreamCheckpoint = GatewayStreamCheckpoint()
    var globalStreamCheckpoint = GatewayStreamCheckpoint()

    @ObservationIgnored var selectedStreamTask: Task<Void, Never>?
    @ObservationIgnored var selectedStreamThreadID: String?
    @ObservationIgnored var selectedPatchBuffer: [GatewayLiveEnvelope] = []
    @ObservationIgnored var selectedPatchFlushTask: Task<Void, Never>?
    @ObservationIgnored var selectedSnapshotRecoveryTask: Task<Void, Never>?
    @ObservationIgnored var globalStreamTask: Task<Void, Never>?
    @ObservationIgnored var globalStreamExcludedThreadID: String?

    private let launchMode: FixtureLaunchMode

    init(launchMode: FixtureLaunchMode, fixtureState: FixtureAppState) {
        self.launchMode = launchMode
        self.state = launchMode == .live
            ? FixtureAppState(
                connection: .offline(message: "Not connected"),
                workspace: WorkspaceSnapshot(projects: [], chats: [], pinned: []),
                selectedThread: nil,
                approvals: []
            )
            : fixtureState
        self.accountState = launchMode == .authRequired ? .requiresOpenAIAuth : .unknown
        let initialSelectedThreadID = launchMode == .live ? nil : fixtureState.selectedThread?.thread.id ?? fixtureState.workspace.firstThread?.id
        self.selectedThreadID = initialSelectedThreadID
        self.workspaceScope = fixtureState.workspace.chats.contains { $0.id == initialSelectedThreadID } ? .chats : .projects
    }

    var selectedDetail: ThreadDetail? {
        detail(for: selectedThreadID)
    }

    func detail(for threadID: String?) -> ThreadDetail? {
        guard let threadID else {
            return nil
        }
        if state.selectedThread?.thread.id == threadID {
            return state.selectedThread
        }
        if launchMode != .live, let thread = state.workspace.thread(id: threadID) {
            return ThreadDetail(
                thread: thread,
                timeline: ThreadTimeline(
                    threadId: thread.id,
                    liveState: thread.status == .active ? .streaming : .idle,
                    viewRevision: 1,
                    rows: [
                        TimelineRow(id: "\(thread.id)-summary", kind: .message, speaker: .assistant, displayOrder: 1, title: thread.title, body: "Fixture timeline row for \(thread.cwd).")
                    ]
                )
            )
        }
        return nil
    }

    var approvalThreadIds: Set<String> {
        Set(state.approvals.map(\.threadId))
    }

    func binding<Value>(_ keyPath: ReferenceWritableKeyPath<ConnectionModel, Value>) -> Binding<Value> {
        Binding {
            self[keyPath: keyPath]
        } set: { newValue in
            self[keyPath: keyPath] = newValue
        }
    }

    func showThreadDetail(_ threadID: String, usesCompactStackNavigation: Bool) {
        if selectedThreadID != threadID {
            selectedStreamTask?.cancel()
            selectedStreamTask = nil
            selectedStreamThreadID = nil
            selectedPatchFlushTask?.cancel()
            selectedPatchFlushTask = nil
            selectedPatchBuffer.removeAll()
            selectedSnapshotRecoveryTask?.cancel()
            selectedSnapshotRecoveryTask = nil
            selectedStreamCheckpoint.reset()
        }
        selectedThreadID = threadID
        if usesCompactStackNavigation {
            compactThreadPath = [threadID]
        } else {
            preferredCompactColumn = .detail
        }
    }

    func showSidebar(usesCompactStackNavigation: Bool) {
        if usesCompactStackNavigation {
            compactThreadPath.removeAll()
        } else {
            preferredCompactColumn = .sidebar
        }
    }

    func cancelStreams() {
        selectedStreamTask?.cancel()
        selectedPatchFlushTask?.cancel()
        selectedSnapshotRecoveryTask?.cancel()
        selectedPatchFlushTask = nil
        selectedSnapshotRecoveryTask = nil
        selectedPatchBuffer.removeAll()
        globalStreamTask?.cancel()
    }

    static func fixtureOlderTimelineRows(threadId: String, before firstDisplayOrder: Int64) -> [TimelineRow] {
        (1...3).map { index in
            TimelineRow(
                id: "\(threadId)-older-\(index)",
                kind: .message,
                speaker: index.isMultiple(of: 2) ? .assistant : .user,
                displayOrder: firstDisplayOrder - Int64(4 - index),
                title: index.isMultiple(of: 2) ? "Kodex" : "You",
                body: "Older fixture row \(index)."
            )
        }
    }
}
