import SwiftUI
import KodexAPI
import KodexCore

struct ThreadLoadingView: View {
    let title: String

    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
                .controlSize(.regular)
            Text(title)
                .font(.headline.weight(.semibold))
                .lineLimit(1)
        }
        .foregroundStyle(KodexTheme.secondaryText)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(KodexTheme.background.ignoresSafeArea())
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("ThreadLoadingView")
    }
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
        .kodexStatusCard(tone: .warning)
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
        .kodexStatusCard(tone: .neutral)
        .accessibilityIdentifier("QueuedInputCard")
    }
}
