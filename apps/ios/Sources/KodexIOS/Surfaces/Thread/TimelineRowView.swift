import SwiftUI
import KodexCore

struct TimelineRowView: View {
    let row: TimelineRow

    var body: some View {
        HStack(alignment: .bottom) {
            if isUserMessage {
                Spacer(minLength: 46)
                userBubble
            } else if isAssistantMessage {
                assistantMessage
            } else {
                statusContent
                Spacer(minLength: isStatusRow ? 28 : 46)
            }
        }
        .accessibilityIdentifier("TimelineRow-\(row.kind.rawValue)")
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    private var userBubble: some View {
        Text(row.body)
            .font(.body)
            .lineSpacing(3)
            .foregroundStyle(KodexTheme.primaryText.opacity(0.94))
            .textSelection(.enabled)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .kodexTimelineBubble(background: KodexTheme.bubbleBackground, cornerRadius: 26)
            .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var assistantMessage: some View {
        Text(row.body)
            .font(.body)
            .lineSpacing(3)
            .foregroundStyle(KodexTheme.primaryText.opacity(0.94))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 6)
    }

    private var statusContent: some View {
        Group {
            if isThoughtRow {
                Label(row.body, systemImage: statusSystemImage)
                    .labelStyle(.titleAndIcon)
                    .font(.callout)
                    .foregroundStyle(KodexTheme.mutedText)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 4)
            } else {
                Label {
                    Text(row.body)
                        .lineSpacing(3)
                        .textSelection(.enabled)
                } icon: {
                    statusIcon
                }
                .labelStyle(.titleAndIcon)
                .font(isStatusRow ? .callout : .body)
                .foregroundStyle(KodexTheme.primaryText.opacity(isStatusRow ? 0.78 : 0.94))
                .padding(.horizontal, isStatusRow ? 12 : 16)
                .padding(.vertical, isStatusRow ? 8 : 12)
                .kodexTimelineBubble(background: bubbleBackground, cornerRadius: bubbleRadius, showsHairline: isStatusRow)
            }
        }
    }

    private var isUserMessage: Bool {
        row.speaker == .user && row.kind == .message
    }

    private var isAssistantMessage: Bool {
        row.kind == .message
    }

    private var isStatusRow: Bool {
        row.kind != .message
    }

    private var isThoughtRow: Bool {
        row.kind == .work || row.kind == .activity
    }

    private var bubbleRadius: CGFloat {
        isStatusRow ? 16 : 26
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
        default:
            return KodexTheme.panelBackground.opacity(0.42)
        }
    }

    private var statusIcon: some View {
        Group {
            if isRunningStatus {
                ProgressView()
                    .controlSize(.small)
            } else {
                Image(systemName: statusSystemImage)
            }
        }
    }

    private var statusSystemImage: String {
        switch row.kind {
        case .work, .activity:
            return "chevron.right"
        case .tool:
            return "terminal"
        case .fileChange:
            return "doc.text"
        case .image:
            return "photo"
        case .warning:
            return "exclamationmark.triangle"
        case .error:
            return "xmark.octagon"
        case .unknown:
            return "info.circle"
        case .message:
            return "text.bubble"
        }
    }

    private var isRunningStatus: Bool {
        let normalized = row.status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized == "running" || normalized == "streaming" || normalized == "in_progress"
    }

    private var accessibilityLabel: String {
        let prefix: String
        if isUserMessage {
            prefix = "You"
        } else if isAssistantMessage {
            prefix = "Kodex"
        } else {
            prefix = row.title
        }
        return "\(prefix): \(row.body)"
    }
}
