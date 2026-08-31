import Foundation
import SwiftUI

enum AuthAccessibilityIdentifier {
    static let emailScreen = "auth.email.screen"
    static let emailField = "auth.email.field"
    static let emailError = "auth.email.error"
    static let emailSubmit = "auth.email.submit"

    static let codeScreen = "auth.code.screen"
    static let codeField = "auth.code.field"
    static let codeError = "auth.code.error"
    static let codeSubmit = "auth.code.submit"
    static let codeResend = "auth.code.resend"
    static let codeDeliveryStatus = "auth.code.delivery-status"
    static let correctEmail = "auth.code.correct-email"
}

enum AuthFormRules {
    static let codeLength = 6
    static let maximumEmailByteCount = 254
    static let maximumCooldownSeconds = 3_600

    static func normalizedEmail(_ rawValue: String) -> String {
        rawValue
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
    }

    static func isValidEmail(_ rawValue: String) -> Bool {
        let email = normalizedEmail(rawValue)
        guard !email.isEmpty,
              email.utf8.count <= maximumEmailByteCount,
              email.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
              email.rangeOfCharacter(from: .controlCharacters) == nil
        else {
            return false
        }

        let components = email.split(separator: "@", omittingEmptySubsequences: false)
        guard components.count == 2 else { return false }

        let localPart = components[0]
        let domain = components[1]
        guard !localPart.isEmpty,
              localPart.utf8.count <= 64,
              !domain.isEmpty,
              !localPart.hasPrefix("."),
              !localPart.hasSuffix("."),
              !domain.hasPrefix("."),
              !domain.hasSuffix("."),
              !localPart.contains(".."),
              !domain.contains("..")
        else {
            return false
        }

        return true
    }

    static func sanitizedCode(_ rawValue: String) -> String {
        let digits = rawValue.filter { character in
            guard character.unicodeScalars.count == 1,
                  let scalar = character.unicodeScalars.first
            else {
                return false
            }
            return (48 ... 57).contains(scalar.value)
        }
        return String(digits.prefix(codeLength))
    }

    static func canRequestCode(email: String, isSubmitting: Bool) -> Bool {
        !isSubmitting && !normalizedEmail(email).isEmpty
    }

    static func canVerifyCode(code: String, isSubmitting: Bool) -> Bool {
        !isSubmitting && sanitizedCode(code).count == codeLength
    }

    static func boundedCooldown(_ seconds: Int) -> Int {
        min(max(seconds, 0), maximumCooldownSeconds)
    }

    static func resendSecondsRemaining(availableAt: Date, now: Date) -> Int {
        max(0, Int(ceil(availableAt.timeIntervalSince(now))))
    }

    static func displayMessage(for error: Error, fallback: String) -> String {
        guard let localizedError = error as? LocalizedError,
              let description = localizedError.errorDescription?
                .trimmingCharacters(in: .whitespacesAndNewlines),
              !description.isEmpty
        else {
            return fallback
        }
        return description
    }
}

struct AuthScreenLayout<Content: View>: View {
    let eyebrow: String
    let title: String
    let message: String
    let accessibilityIdentifier: String
    let content: Content

    init(
        eyebrow: String,
        title: String,
        message: String,
        accessibilityIdentifier: String,
        @ViewBuilder content: () -> Content
    ) {
        self.eyebrow = eyebrow
        self.title = title
        self.message = message
        self.accessibilityIdentifier = accessibilityIdentifier
        self.content = content()
    }

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    AuthWordmark()

                    Spacer(minLength: 54)

                    EditorialEyebrow(text: eyebrow)

                    Text(title)
                        .font(.system(.largeTitle, design: .default, weight: .bold))
                        .tracking(-0.8)
                        .accessibilityAddTraits(.isHeader)
                        .padding(.top, 12)

                    Text(message)
                        .font(.system(.body))
                        .foregroundStyle(UnfiledTheme.fog)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 13)

                    content
                        .padding(.top, 36)

                    Spacer(minLength: 44)

                    HStack(spacing: 9) {
                        Rectangle()
                            .fill(UnfiledTheme.persimmon)
                            .frame(width: 16, height: 3)
                            .accessibilityHidden(true)
                        Text("Write without deciding where it belongs.")
                            .font(.system(.caption, design: .monospaced, weight: .medium))
                            .foregroundStyle(UnfiledTheme.fog)
                    }
                }
                .frame(maxWidth: 520, minHeight: max(geometry.size.height - 32, 0), alignment: .top)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, UnfiledTheme.screenPadding)
                .padding(.top, 16)
                .padding(.bottom, 16)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .accessibilityIdentifier(accessibilityIdentifier)
        .unfiledScreen()
    }
}

struct AuthWordmark: View {
    var body: some View {
        HStack(spacing: 11) {
            UnfiledMark(size: 34)
            Text("unfiled")
                .font(.system(size: 20, weight: .bold))
                .tracking(-0.25)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Unfiled")
    }
}

struct AuthFieldLabel: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(.caption, design: .monospaced, weight: .medium))
            .tracking(0.8)
            .foregroundStyle(UnfiledTheme.fog)
            .textCase(.uppercase)
    }
}

struct AuthInlineMessage: View {
    enum Kind: Equatable {
        case error
        case confirmation

        var systemImage: String {
            switch self {
            case .error: "exclamationmark.circle.fill"
            case .confirmation: "checkmark.circle.fill"
            }
        }
    }

    let message: String
    let kind: Kind
    let accessibilityIdentifier: String

    var body: some View {
        Label(message, systemImage: kind.systemImage)
            .font(.system(.footnote))
            .foregroundStyle(kind == .error ? UnfiledTheme.paper : UnfiledTheme.fog)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier(accessibilityIdentifier)
    }
}

struct AuthPrimaryButton: View {
    let title: String
    let loadingTitle: String
    let isLoading: Bool
    let isDisabled: Bool
    let accessibilityIdentifier: String
    let action: @MainActor () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 9) {
                if isLoading {
                    ProgressView()
                        .controlSize(.small)
                        .tint(UnfiledTheme.ink)
                        .accessibilityHidden(true)
                }

                Text(isLoading ? loadingTitle : title)
                    .font(.system(.body, weight: .semibold))

                if !isLoading {
                    Image(systemName: "arrow.right")
                        .font(.system(size: 14, weight: .bold))
                        .accessibilityHidden(true)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 54)
            .foregroundStyle(UnfiledTheme.ink)
            .background(isDisabled ? UnfiledTheme.fog : UnfiledTheme.persimmon)
            .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .accessibilityIdentifier(accessibilityIdentifier)
        .accessibilityLabel(isLoading ? loadingTitle : title)
        .accessibilityValue(isLoading ? "In progress" : "")
    }
}
