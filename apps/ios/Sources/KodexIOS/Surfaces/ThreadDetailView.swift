import PhotosUI
import SwiftUI
import KodexAPI
import KodexCore

struct ThreadDetailView: View {
    private static let timelineBottomTolerance: CGFloat = 44
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    let detail: ThreadDetail
    let approvals: [ApprovalRequest]
    let queuedInputs: [QueuedInputSummary]
    let modelOptions: [ComposerModelOption]
    let localImagePaths: [String]
    @Binding var composerText: String
    @Binding var selectedPhotoItem: PhotosPickerItem?
    let isBusy: Bool
    let statusMessage: String?
    let composerSettings: ComposerRunSettings
    let permissionsPreset: String?
    let canLoadOlderHistory: Bool
    let usesNativeNavigationBar: Bool
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
    @State private var hasSeenOlderSentinel = false
    @State private var olderLoadInFlightFor: String?
    @State private var isTimelineAtBottom = true
    @State private var hasPerformedInitialScroll = false
    @FocusState private var isComposerFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            if !usesNativeNavigationBar {
                header
            }
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
            ThreadComposerBar(
                text: $composerText,
                selectedPhotoItem: $selectedPhotoItem,
                isComposerFocused: $isComposerFocused,
                modelOptions: modelOptions,
                localImagePaths: localImagePaths,
                isBusy: isBusy,
                showStopAction: showsStopAction,
                settings: composerSettings,
                permissionsPreset: permissionsPreset,
                onSettingsChange: onSettingsChange,
                onSend: onSend,
                onStop: onStop
            )
        }
        .background(KodexTheme.background.ignoresSafeArea())
        .foregroundStyle(KodexTheme.primaryText)
        .navigationTitle(usesNativeNavigationBar ? detail.thread.title : "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(usesNativeNavigationBar ? .visible : .hidden, for: .navigationBar)
        .toolbarBackground(KodexTheme.background, for: .navigationBar)
        .toolbar {
            if usesNativeNavigationBar {
                ToolbarItemGroup(placement: .primaryAction) {
                    threadActionControls
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
    }

    private var showsStopAction: Bool {
        detail.thread.status == .active || detail.timeline.liveState == .streaming || detail.timeline.liveState == .syncing
    }

    private var header: some View {
        HStack(spacing: 10) {
            if showsSidebarButton {
                KodexGlassToolbarButton(systemName: "sidebar.left", label: "BackButton") {
                    onShowSidebar()
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(detail.thread.title)
                    .font(.headline.weight(.semibold))
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            KodexGlassCluster(spacing: 8) {
                HStack(spacing: 8) {
                    threadActionControls
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 12)
        .padding(.bottom, 10)
        .background(KodexTheme.background.opacity(0.98))
    }

    private var showsSidebarButton: Bool {
        horizontalSizeClass == .compact && !usesNativeNavigationBar
    }

    @ViewBuilder
    private var threadActionControls: some View {
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

    private var timeline: some View {
        GeometryReader { viewport in
            ScrollViewReader { proxy in
                ZStack(alignment: .bottomTrailing) {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 10) {
                            olderHistorySentinel

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
                            timelineBottomAnchor
                        }
                        .padding(.horizontal, 16)
                        .padding(.top, 14)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            dismissKeyboard()
                        }
                    }
                    .coordinateSpace(name: timelineCoordinateSpace)
                    .scrollContentBackground(.hidden)
                    .defaultScrollAnchor(.bottom)
                    .scrollDismissesKeyboard(.interactively)
                    .accessibilityIdentifier("ThreadTimeline")
                    .onPreferenceChange(TimelineBottomMaxYPreferenceKey.self) { bottomMaxY in
                        guard bottomMaxY.isFinite else {
                            return
                        }
                        isTimelineAtBottom = bottomMaxY <= viewport.size.height + Self.timelineBottomTolerance
                    }
                    .onAppear {
                        scrollTimelineToBottom(proxy, animated: false)
                    }
                    .onChange(of: detail.thread.id) { _, _ in
                        hasSeenOlderSentinel = false
                        olderLoadInFlightFor = nil
                        hasPerformedInitialScroll = false
                        scrollTimelineToBottom(proxy, animated: false)
                    }
                    .onChange(of: timelineFollowToken) { _, _ in
                        guard isTimelineAtBottom else {
                            return
                        }
                        scrollTimelineToBottom(proxy, animated: hasPerformedInitialScroll)
                    }

                    if showsJumpToBottom {
                        Button {
                            scrollTimelineToBottom(proxy, animated: true)
                        } label: {
                            Image(systemName: "arrow.down")
                                .font(.system(size: 15, weight: .semibold))
                                .frame(width: 38, height: 38)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(KodexTheme.primaryText)
                        .background(KodexTheme.panelBackground.opacity(0.82), in: Circle())
                        .overlay(Circle().stroke(KodexTheme.hairline, lineWidth: 1))
                        .kodexGlass(cornerRadius: 19, tint: KodexTheme.panelBackground.opacity(0.54), interactive: true)
                        .padding(.trailing, 20)
                        .padding(.bottom, 18)
                        .accessibilityLabel("Jump to Latest")
                    }
                }
            }
        }
    }

    private var timelineBottomAnchor: some View {
        Color.clear
            .frame(height: 24)
            .id(timelineBottomID)
            .background {
                GeometryReader { proxy in
                    Color.clear.preference(
                        key: TimelineBottomMaxYPreferenceKey.self,
                        value: proxy.frame(in: .named(timelineCoordinateSpace)).maxY
                    )
                }
            }
    }

    private var timelineFollowToken: String {
        [
            detail.thread.id,
            String(detail.timeline.viewRevision)
        ].joined(separator: ":")
    }

    private var showsJumpToBottom: Bool {
        !isTimelineAtBottom && (!detail.timeline.rows.isEmpty || !queuedInputs.isEmpty || !approvals.isEmpty)
    }

    private var timelineBottomID: String {
        "timeline-bottom-\(detail.thread.id)"
    }

    private var timelineCoordinateSpace: String {
        "thread-timeline-\(detail.thread.id)"
    }

    private func scrollTimelineToBottom(_ proxy: ScrollViewProxy, animated: Bool) {
        let action = {
            proxy.scrollTo(timelineBottomID, anchor: .bottom)
            hasPerformedInitialScroll = true
        }
        if animated {
            withAnimation(.easeOut(duration: 0.2)) {
                action()
            }
        } else {
            DispatchQueue.main.async {
                action()
            }
        }
    }

    private func dismissKeyboard() {
        isComposerFocused = false
    }

    @ViewBuilder
    private var olderHistorySentinel: some View {
        if canLoadOlderHistory, detail.timeline.hasOlder, let cursor = detail.timeline.olderCursor {
            HStack {
                Spacer()
                if olderLoadInFlightFor == cursor {
                    ProgressView()
                        .controlSize(.small)
                        .tint(KodexTheme.secondaryText)
                        .accessibilityLabel("Loading older history")
                } else {
                    Color.clear
                        .frame(width: 1, height: 1)
                        .accessibilityHidden(true)
                }
                Spacer()
            }
            .frame(height: 10)
            .onAppear {
                guard hasSeenOlderSentinel else {
                    hasSeenOlderSentinel = true
                    return
                }
                guard olderLoadInFlightFor != cursor else {
                    return
                }
                olderLoadInFlightFor = cursor
                Task {
                    await onLoadOlder()
                    await MainActor.run {
                        if olderLoadInFlightFor == cursor {
                            olderLoadInFlightFor = nil
                        }
                    }
                }
            }
        }
    }
}

private struct TimelineBottomMaxYPreferenceKey: PreferenceKey {
    static let defaultValue = CGFloat.infinity

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}
