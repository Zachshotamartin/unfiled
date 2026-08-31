import SwiftUI

enum UnfiledTheme {
    static let ink = Color(red: 11 / 255, green: 12 / 255, blue: 14 / 255)
    static let graphite = Color(red: 24 / 255, green: 27 / 255, blue: 31 / 255)
    static let raised = Color(red: 34 / 255, green: 38 / 255, blue: 42 / 255)
    static let paper = Color(red: 242 / 255, green: 239 / 255, blue: 232 / 255)
    static let persimmon = Color(red: 238 / 255, green: 111 / 255, blue: 85 / 255)
    static let fog = Color(red: 157 / 255, green: 163 / 255, blue: 166 / 255)
    static let border = paper.opacity(0.14)

    static let screenPadding: CGFloat = 22
    static let controlRadius: CGFloat = 13
    static let minimumTouchTarget: CGFloat = 44
}
extension View {
    func unfiledScreen() -> some View {
        foregroundStyle(UnfiledTheme.paper)
            .background(UnfiledTheme.ink.ignoresSafeArea())
            .tint(UnfiledTheme.persimmon)
            .preferredColorScheme(.dark)
    }
}

struct SectionRule: View {
    var body: some View {
        Rectangle()
            .fill(UnfiledTheme.border)
            .frame(height: 1)
            .accessibilityHidden(true)
    }
}

struct EditorialEyebrow: View {
    let text: String

    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 12, weight: .medium, design: .monospaced))
            .tracking(1.1)
            .foregroundStyle(UnfiledTheme.fog)
    }
}

struct PrimaryActionButton: View {
    let title: String
    var systemImage: String?
    var disabled = false
    let action: @MainActor () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 15, weight: .semibold))
                }
                Text(title)
                    .font(.system(size: 16, weight: .semibold))
            }
            .frame(maxWidth: .infinity, minHeight: 52)
            .foregroundStyle(UnfiledTheme.ink)
            .background(disabled ? UnfiledTheme.fog : UnfiledTheme.persimmon)
            .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityAddTraits(.isButton)
    }
}

struct EmptyLedgerView: View {
    let title: String
    let message: String
    var actionTitle: String?
    var action: (@MainActor () -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            UnfiledMark(size: 34)
            Text(title)
                .font(.system(size: 22, weight: .semibold))
            Text(message)
                .font(.system(size: 15))
                .foregroundStyle(UnfiledTheme.fog)
                .fixedSize(horizontal: false, vertical: true)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(UnfiledTheme.persimmon)
                    .frame(minHeight: UnfiledTheme.minimumTouchTarget)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 36)
    }
}
