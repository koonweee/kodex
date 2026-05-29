import SwiftUI

struct KodexMenuRow: View {
    let title: String
    let subtitle: String?
    let systemImage: String
    var isDestructive = false

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                if let subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        } icon: {
            Image(systemName: systemImage)
                .foregroundStyle(isDestructive ? KodexTheme.destructive : .primary)
        }
    }
}
