import PhotosUI
import SwiftUI
import KodexAPI
import KodexCore

struct ThreadDetailView: View {
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
    let onShowSidebar: () -> Void
    let onSend: () async -> Void
    let onSettingsChange: (ComposerRunSettings) async -> Void
    let onStop: () async -> Void
    let onLoadOlder: () async -> Void
    let onRename: (String) async -> Void
    let onSetPinned: (Bool) async -> Void
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
            header
            timeline
            if let statusMessage {
                Text(statusMessage)
                    .font(.caption)
                    .foregroundStyle(KodexTheme.destructive)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 6)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            ComposerBar(
                text: $composerText,
                selectedPhotoItem: $selectedPhotoItem,
                isExpandedComposerPresented: $isExpandedComposerPresented,
                skills: skills,
                localImagePaths: localImagePaths,
                isBusy: isBusy,
                showStopAction: showsStopAction,
                settings: composerSettings,
                permissionsPreset: permissionsPreset,
                cwd: detail.thread.cwd,
                onSettingsChange: onSettingsChange,
                onSend: onSend,
                onStop: onStop
            )
        }
        .background(KodexTheme.background.ignoresSafeArea())
        .foregroundStyle(KodexTheme.primaryText)
        .toolbar(.hidden, for: .navigationBar)
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
                    .font(.body)
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
                            .disabled(isBusy || composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                    }
            }
        }
    }

    private var showsStopAction: Bool {
        detail.thread.status == .active || detail.timeline.liveState == .streaming || detail.timeline.liveState == .syncing
    }

    private var header: some View {
        HStack(spacing: 10) {
            KodexIconButton(systemName: "sidebar.left", label: "BackButton") {
                onShowSidebar()
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(detail.thread.title)
                    .font(.headline.weight(.semibold))
                    .lineLimit(1)
                HStack(spacing: 6) {
                    statusDot
                    Text(detail.thread.cwd)
                        .font(.caption2)
                        .foregroundStyle(KodexTheme.secondaryText)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            KodexGlassCluster(spacing: 8) {
                HStack(spacing: 8) {
                    if showsStopAction {
                        KodexIconButton(systemName: "stop.fill", label: "Stop") {
                            Task {
                                await onStop()
                            }
                        }
                        .disabled(isBusy)
                    }
                    ThreadActionMenu(
                        thread: detail.thread,
                        onRename: {
                            renameText = detail.thread.title
                            isRenamePresented = true
                        },
                        onSetPinned: onSetPinned,
                        onToggleNotifications: onToggleNotifications,
                        onArchive: onArchive
                    )
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 12)
        .padding(.bottom, 10)
        .background(KodexTheme.background.opacity(0.98))
    }

    private var statusDot: some View {
        Circle()
            .fill(detail.thread.status == .active ? KodexTheme.positive : KodexTheme.accent.opacity(0.65))
            .frame(width: 7, height: 7)
    }

    private var timeline: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                Button {
                    Task {
                        await onLoadOlder()
                    }
                } label: {
                    Label("Load Older", systemImage: "clock.arrow.circlepath")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(KodexTheme.accent)
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
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 24)
        }
        .scrollContentBackground(.hidden)
        .accessibilityIdentifier("ThreadTimeline")
    }
}

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
            Image(systemName: "ellipsis")
                .font(.system(size: 16, weight: .semibold))
                .frame(width: KodexTheme.iconButtonSize, height: KodexTheme.iconButtonSize)
                .foregroundStyle(KodexTheme.primaryText)
                .contentShape(Rectangle())
                .kodexGlass(cornerRadius: 13, interactive: true)
        }
        .accessibilityLabel("Thread Actions")
        .accessibilityIdentifier("ThreadActions")
    }
}

struct TimelineRowView: View {
    let row: TimelineRow

    var body: some View {
        HStack(alignment: .bottom) {
            if isUserMessage {
                Spacer(minLength: 54)
                bubble
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    if shouldShowAuthor {
                        Text(row.title)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(KodexTheme.secondaryText)
                            .padding(.leading, 6)
                    }
                    bubble
                }
                Spacer(minLength: 54)
            }
        }
        .accessibilityIdentifier("TimelineRow-\(row.kind.rawValue)")
    }

    private var bubble: some View {
        Text(row.body)
            .font(.body)
            .lineSpacing(3)
            .foregroundStyle(KodexTheme.primaryText.opacity(isStatusRow ? 0.82 : 0.94))
            .textSelection(.enabled)
            .padding(.horizontal, isStatusRow ? 14 : 18)
            .padding(.vertical, isStatusRow ? 10 : 14)
            .background(bubbleBackground, in: RoundedRectangle(cornerRadius: bubbleRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: bubbleRadius, style: .continuous)
                    .stroke(isStatusRow ? KodexTheme.hairline : Color.clear, lineWidth: 1)
            )
    }

    private var isUserMessage: Bool {
        row.title.localizedCaseInsensitiveCompare("You") == .orderedSame
    }

    private var isStatusRow: Bool {
        row.kind != .message
    }

    private var shouldShowAuthor: Bool {
        row.kind == .message && !isUserMessage && !row.title.isEmpty
    }

    private var bubbleRadius: CGFloat {
        isStatusRow ? 18 : 28
    }

    private var bubbleBackground: Color {
        if isUserMessage {
            return KodexTheme.bubbleBackground
        }
        switch row.kind {
        case .warning:
            return KodexTheme.warning.opacity(0.16)
        case .error:
            return KodexTheme.destructive.opacity(0.16)
        case .message:
            return KodexTheme.background
        default:
            return KodexTheme.panelBackground.opacity(0.78)
        }
    }
}

struct ComposerBar: View {
    @Binding var text: String
    @Binding var selectedPhotoItem: PhotosPickerItem?
    @Binding var isExpandedComposerPresented: Bool
    let skills: [SkillSummary]
    let localImagePaths: [String]
    let isBusy: Bool
    let showStopAction: Bool
    let settings: ComposerRunSettings
    let permissionsPreset: String?
    let cwd: String
    let onSettingsChange: (ComposerRunSettings) async -> Void
    let onSend: () async -> Void
    let onStop: () async -> Void

    var body: some View {
        KodexBottomComposerShell {
            VStack(alignment: .leading, spacing: 9) {
                if !localImagePaths.isEmpty {
                    Label("\(localImagePaths.count) image attachment\(localImagePaths.count == 1 ? "" : "s")", systemImage: "photo")
                        .font(.caption)
                        .foregroundStyle(KodexTheme.secondaryText)
                }
                HStack(alignment: .center, spacing: 8) {
                    attachmentMenu
                    TextField("", text: $text, prompt: Text("type clever thing here"), axis: .vertical)
                        .lineLimit(1...4)
                        .font(.body)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 13)
                        .foregroundStyle(KodexTheme.primaryText)
                        .background(KodexTheme.elevatedBackground, in: Capsule(style: .continuous))
                        .accessibilityLabel("Message Kodex")
                        .accessibilityIdentifier("ComposerInput")
                    if showStopAction {
                        KodexIconButton(systemName: "stop.fill", label: "Stop") {
                            Task {
                                await onStop()
                            }
                        }
                        .disabled(isBusy)
                    } else {
                        sendButton
                    }
                }
                HStack(spacing: 8) {
                    Button {
                        isExpandedComposerPresented = true
                    } label: {
                        Image(systemName: "arrow.up.left.and.arrow.down.right")
                            .frame(width: 30, height: 30)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(KodexTheme.secondaryText)
                    .accessibilityLabel("Expanded Composer")
                    permissionsMenu
                    modelMenu
                    Spacer(minLength: 4)
                    if showStopAction {
                        sendButton
                    }
                }
                .font(.caption.weight(.semibold))
                Text("\(lastPathComponent(cwd))  \(settings.model ?? "default") / \(settings.effort ?? "default")")
                    .font(.caption2)
                    .foregroundStyle(KodexTheme.mutedText)
                    .lineLimit(1)
            }
        }
    }

    private var attachmentMenu: some View {
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
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 17, weight: .semibold))
                .frame(width: KodexTheme.iconButtonSize, height: KodexTheme.iconButtonSize)
                .foregroundStyle(KodexTheme.primaryText)
                .kodexGlass(cornerRadius: KodexTheme.iconButtonSize / 2, tint: KodexTheme.panelBackground.opacity(0.38), interactive: true)
        }
        .accessibilityLabel("Add Attachment")
    }

    private var permissionsMenu: some View {
        Menu {
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
            Label(permissionsPreset ?? settings.sandboxDisplay, systemImage: "lock.shield")
                .lineLimit(1)
                .padding(.horizontal, 10)
                .frame(height: 32)
                .kodexGlass(cornerRadius: 16, tint: KodexTheme.panelBackground.opacity(0.36), interactive: true)
        }
        .accessibilityLabel("Permissions")
    }

    private var modelMenu: some View {
        Menu {
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
        } label: {
            Label(settings.model ?? "default", systemImage: "cpu")
                .lineLimit(1)
                .padding(.horizontal, 10)
                .frame(height: 32)
                .kodexGlass(cornerRadius: 16, tint: KodexTheme.panelBackground.opacity(0.36), interactive: true)
        }
        .accessibilityLabel("Composer Options, model \(settings.model ?? "default"), reasoning \(settings.effort ?? "default"), approvals \(settings.approvalPolicy ?? "default"), permissions \(permissionsPreset ?? settings.sandboxDisplay)")
    }

    private var sendButton: some View {
        KodexIconButton(systemName: "arrow.up", label: "Send", isProminent: true) {
            Task {
                await onSend()
            }
        }
        .disabled(isBusy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    private func lastPathComponent(_ path: String) -> String {
        URL(fileURLWithPath: path).lastPathComponent
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

struct ComposerTextOption: Identifiable {
    let label: String
    let value: String

    var id: String { value }
}

struct ComposerPolicyOption: Identifiable {
    let label: String
    let value: String
    let policy: AnySendable

    var id: String { value }
}

struct ApprovalCard: View {
    let approval: ApprovalRequest
    let onDecision: (ApprovalDecision) async -> Void
    @State private var pendingDecision: ApprovalDecision?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(approval.title, systemImage: "exclamationmark.triangle.fill")
                .font(.headline)
                .foregroundStyle(KodexTheme.warning)
            Text("Risk: \(approval.risk)")
                .font(.caption)
                .foregroundStyle(KodexTheme.secondaryText)
            if !approval.context.isEmpty {
                Text(approval.context)
                    .font(.caption)
                    .foregroundStyle(KodexTheme.secondaryText)
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
        .background(KodexTheme.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(KodexTheme.warning.opacity(0.25), lineWidth: 1)
        )
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

struct QueuedInputCard: View {
    let queuedInput: QueuedInputSummary
    let onRetry: () async -> Void
    let onSteer: () async -> Void
    let onDelete: () async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Queued input", systemImage: "tray.and.arrow.up")
                .font(.headline)
            Text(queuedInput.status)
                .font(.caption)
                .foregroundStyle(KodexTheme.secondaryText)
            if let lastError = queuedInput.lastError {
                Text(lastError)
                    .font(.caption)
                    .foregroundStyle(KodexTheme.destructive)
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
        .background(KodexTheme.accent.opacity(0.10), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(KodexTheme.accent.opacity(0.22), lineWidth: 1)
        )
        .accessibilityIdentifier("QueuedInputCard")
    }
}
