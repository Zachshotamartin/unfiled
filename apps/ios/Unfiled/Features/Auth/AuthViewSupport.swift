import Foundation
import SwiftUI

enum AuthAccessibilityIdentifier {
    static let emailScreen = "auth.email.screen"
    static let emailField = "auth.email.field"
    static let emailError = "auth.email.error"
    static let emailSubmit = "auth.email.submit"

    static let passwordField = "auth.password.field"
    static let modeToggle = "auth.mode.toggle"
}

enum AuthFormRules {
    static let minimumPasswordLength = AuthPasswordRequest.minimumPasswordLength
    static let maximumPasswordLength = AuthPasswordRequest.maximumPasswordLength
    static let maximumEmailByteCount = 254

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

    static func isValidPassword(_ password: String) -> Bool {
        (minimumPasswordLength ... maximumPasswordLength).contains(password.utf8.count)
    }

    /// Submission needs a plausible email, a bounded password, and no request in flight.
    static func canSubmitCredentials(email: String, password: String, isSubmitting: Bool) -> Bool {
        !isSubmitting && isValidEmail(email) && isValidPassword(password)
    }

    /// Maps the content-free service codes to sign-in guidance. Server message text is never
    /// shown; only the code decides the copy, so upstream detail cannot reach the screen.
    static func credentialsMessage(for error: Error, mode: AuthMode) -> String {
        let fallback = mode == .signUp
            ? "The account could not be created. Try again."
            : "Sign-in failed. Check your email and password."
        guard case let APIClientError.http(status, code, _, _) = error else {
            return displayMessage(for: error, fallback: fallback)
        }
        switch code {
        case .accountExists:
            return "An account with this email already exists. Sign in instead."
        case .unauthorized:
            return "Wrong email or password."
        case .validationFailed:
            return mode == .signUp
                ? "Check the email address and use a password of 8 to 72 characters."
                : "Check your email and password."
        case .rateLimited:
            return "Too many attempts. Wait a few minutes and try again."
        case .providerUnavailable:
            return "Unfiled is temporarily unavailable. Try again shortly."
        default:
            return (500 ... 599).contains(status)
                ? "Unfiled is temporarily unavailable. Try again shortly."
                : fallback
        }
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
                        .font(UnfiledType.display)
                        .tracking(-0.8)
                        .accessibilityAddTraits(.isHeader)
                        .padding(.top, 12)

                    Text(message)
                        .font(UnfiledType.body)
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
                            .font(UnfiledType.label)
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
                .font(UnfiledType.title)
                .tracking(-0.25)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Unfiled")
    }
}

struct AuthFieldLabel: View {
    let text: String

    var body: some View {
        EditorialEyebrow(text: text)
    }
}

struct AuthInlineMessage: View {
    enum Kind: Equatable {
        case error
        case confirmation

        var glyph: UnfiledGlyph {
            switch self {
            case .error: .warning
            case .confirmation: .checkCircle
            }
        }
    }

    let message: String
    let kind: Kind
    let accessibilityIdentifier: String

    var body: some View {
        GlyphLabel(message, glyph: kind.glyph)
            .font(UnfiledType.secondary)
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
                    .font(UnfiledType.heading)

                if !isLoading {
                    GlyphView(glyph: .arrow, size: 18, weight: 2.3)
                }
            }
            .frame(maxWidth: .infinity, minHeight: UnfiledTheme.controlHeight)
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
