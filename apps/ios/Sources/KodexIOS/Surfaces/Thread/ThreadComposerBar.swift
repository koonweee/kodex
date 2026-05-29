import PhotosUI
import SwiftUI
import KodexAPI
import KodexCore

struct ComposerModelOption: Identifiable, Equatable {
    let id: String
    let displayName: String
    let defaultEffort: String
    let reasoningEfforts: [String]

    static let fallbackOptions: [ComposerModelOption] = [
        ComposerModelOption(id: "gpt-5.5", displayName: "GPT-5.5", defaultEffort: "medium", reasoningEfforts: ["low", "medium", "high", "xhigh"]),
        ComposerModelOption(id: "gpt-5.4", displayName: "GPT-5.4", defaultEffort: "medium", reasoningEfforts: ["low", "medium", "high", "xhigh"]),
        ComposerModelOption(id: "gpt-5.4-mini", displayName: "GPT-5.4 Mini", defaultEffort: "medium", reasoningEfforts: ["low", "medium", "high", "xhigh"]),
        ComposerModelOption(id: "gpt-5.3-codex", displayName: "GPT-5.3 Codex", defaultEffort: "medium", reasoningEfforts: ["low", "medium", "high", "xhigh"]),
        ComposerModelOption(id: "gpt-5.3-codex-spark", displayName: "GPT-5.3 Codex Spark", defaultEffort: "high", reasoningEfforts: ["low", "medium", "high", "xhigh"]),
        ComposerModelOption(id: "gpt-5.2", displayName: "GPT-5.2", defaultEffort: "medium", reasoningEfforts: ["low", "medium", "high", "xhigh"])
    ]

    static func options(from models: [Components.Schemas.ModelSummary]) -> [ComposerModelOption] {
        let visible = models
            .filter { !$0.hidden }
            .map {
                ComposerModelOption(
                    id: $0.id,
                    displayName: $0.displayName,
                    defaultEffort: $0.defaultReasoningEffort,
                    reasoningEfforts: $0.supportedReasoningEfforts.map(\.reasoningEffort)
                )
            }
        return visible.isEmpty ? fallbackOptions : visible
    }
}

struct ThreadComposerBar: View {
    @Binding var text: String
    @Binding var selectedPhotoItem: PhotosPickerItem?
    let isComposerFocused: FocusState<Bool>.Binding
    let modelOptions: [ComposerModelOption]
    let localImagePaths: [String]
    let isBusy: Bool
    let showStopAction: Bool
    let settings: ComposerRunSettings
    let permissionsPreset: String?
    let onSettingsChange: (ComposerRunSettings) async -> Void
    let onSend: () async -> Void
    let onStop: () async -> Void

    var body: some View {
        KodexBottomComposerShell {
            VStack(alignment: .leading, spacing: 8) {
                if !localImagePaths.isEmpty {
                    Label("\(localImagePaths.count) image attachment\(localImagePaths.count == 1 ? "" : "s")", systemImage: "photo")
                        .font(.caption)
                        .foregroundStyle(KodexTheme.secondaryText)
                }
                HStack(alignment: .center, spacing: 8) {
                    attachmentButton
                    TextField("", text: $text, prompt: Text("type clever thing here"), axis: .vertical)
                        .lineLimit(1...4)
                        .font(.body)
                        .kodexComposerInput()
                        .focused(isComposerFocused)
                        .accessibilityLabel("Message Kodex")
                        .accessibilityIdentifier("ComposerInput")
                    primaryActionButton
                }
                HStack(spacing: 8) {
                    permissionsMenu
                    modelMenu
                    Spacer(minLength: 4)
                }
                .font(.caption.weight(.semibold))
            }
        }
    }

    private var attachmentButton: some View {
        PhotosPicker(selection: $selectedPhotoItem, matching: .images) {
            KodexComposerIconLabel(systemName: "plus")
        }
        .kodexComposerGlassControl()
        .frame(minWidth: 44, minHeight: 44)
        .accessibilityLabel("Add Attachment")
    }

    private var permissionsMenu: some View {
        Menu {
            Picker("Approvals", selection: Binding(
                get: { settings.approvalPolicy ?? "" },
                set: { value in
                    Task {
                        await onSettingsChange(settingsWithApprovalPolicy(value.nilIfEmpty))
                    }
                }
            )) {
                Text("Default").tag("")
                ForEach(Self.approvalPolicyOptions) { option in
                    Text(option.label).tag(option.value)
                }
            }
            Picker("Sandbox", selection: Binding(
                get: { selectedSandboxValue },
                set: { value in
                    guard let option = Self.sandboxOptions.first(where: { $0.value == value }) else {
                        return
                    }
                    Task {
                        await onSettingsChange(settings.with(sandboxPolicy: option.policy))
                    }
                }
            )) {
                ForEach(Self.sandboxOptions) { option in
                    Text(option.label).tag(option.value)
                }
            }
        } label: {
            KodexComposerIconLabel(systemName: "lock.shield")
        }
        .kodexComposerGlassControl()
        .accessibilityLabel("Permissions")
        .accessibilityValue("Approvals \(settings.approvalPolicy ?? "default"), sandbox \(permissionsPreset ?? settings.sandboxDisplay)")
        .accessibilityIdentifier("PermissionsMenu")
        .frame(minWidth: 44, minHeight: 44)
    }

    private var modelMenu: some View {
        Menu {
            Picker("Model", selection: Binding(
                get: { settings.model ?? "" },
                set: { value in
                    guard let model = resolvedModelOptions.first(where: { $0.id == value }) else {
                        return
                    }
                    Task {
                        let nextEffort = model.reasoningEfforts.contains(settings.effort ?? "") ? (settings.effort ?? model.defaultEffort) : model.defaultEffort
                        await onSettingsChange(settings.with(model: model.id, effort: nextEffort))
                    }
                }
            )) {
                ForEach(resolvedModelOptions) { model in
                    Text(model.displayName)
                        .tag(model.id)
                        .accessibilityIdentifier("ModelOption-\(model.id)")
                }
            }
            Picker("Reasoning", selection: Binding(
                get: { settings.effort ?? "" },
                set: { effort in
                    Task {
                        await onSettingsChange(settings.with(effort: effort))
                    }
                }
            )) {
                ForEach(currentEffortOptions, id: \.self) { effort in
                    Text(effort.capitalized)
                        .tag(effort)
                        .accessibilityIdentifier("ReasoningOption-\(effort)")
                }
            }
        } label: {
            KodexComposerIconLabel(systemName: "cpu")
        }
        .kodexComposerGlassControl()
        .accessibilityLabel("Composer Options")
        .accessibilityValue("Model \(settings.model ?? "default"), reasoning \(settings.effort ?? "default"), approvals \(settings.approvalPolicy ?? "default"), permissions \(permissionsPreset ?? settings.sandboxDisplay)")
        .accessibilityIdentifier("ComposerOptionsMenu")
        .frame(minWidth: 44, minHeight: 44)
    }

    private var selectedSandboxValue: String {
        if let permissionsPreset, let option = Self.sandboxOptions.first(where: { $0.label == permissionsPreset || $0.value == permissionsPreset }) {
            return option.value
        }
        if let option = Self.sandboxOptions.first(where: { $0.value == settings.sandboxDisplay }) {
            return option.value
        }
        return "workspaceWrite"
    }

    private func settingsWithApprovalPolicy(_ approvalPolicy: String?) -> ComposerRunSettings {
        ComposerRunSettings(
            model: settings.model,
            effort: settings.effort,
            serviceTier: settings.serviceTier,
            approvalPolicy: approvalPolicy,
            sandboxPolicy: settings.sandboxPolicy
        )
    }

    @ViewBuilder
    private var primaryActionButton: some View {
        if showStopAction && !hasDraftText {
            stopButton
        } else {
            sendButton
        }
    }

    private var stopButton: some View {
        KodexComposerRoundButton(systemName: "stop.fill", label: "Stop", role: .destructive) {
            Task {
                await onStop()
            }
        }
        .frame(minWidth: 44, minHeight: 44)
        .disabled(isBusy)
    }

    private var sendButton: some View {
        KodexComposerRoundButton(systemName: "arrow.up", label: "Send", isProminent: true) {
            Task {
                await onSend()
            }
        }
        .frame(minWidth: 44, minHeight: 44)
        .disabled(isBusy || !hasDraftText)
    }

    private var hasDraftText: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var resolvedModelOptions: [ComposerModelOption] {
        modelOptions.isEmpty ? ComposerModelOption.fallbackOptions : modelOptions
    }

    private var currentEffortOptions: [String] {
        if let selectedModel = resolvedModelOptions.first(where: { $0.id == (settings.model ?? "") }) {
            return selectedModel.reasoningEfforts
        }
        return ["low", "medium", "high", "xhigh"]
    }

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
