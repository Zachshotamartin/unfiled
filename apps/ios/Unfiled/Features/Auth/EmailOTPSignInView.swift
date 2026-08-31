import SwiftUI

@MainActor
struct EmailOTPSignInView: View {
    typealias RequestCodeAction = @MainActor (AuthOTPRequest) async throws -> AuthOTPAcceptedResponse
    typealias CodeRequestedAction = @MainActor (String, AuthOTPAcceptedResponse) -> Void

    @State private var email: String
    @State private var isSubmitting = false
    @State private var errorMessage: String?
    @State private var requestTask: Task<Void, Never>?
    @FocusState private var isEmailFocused: Bool

    private let onRequestCode: RequestCodeAction
    private let onCodeRequested: CodeRequestedAction

    init(
        initialEmail: String = "",
        onRequestCode: @escaping RequestCodeAction,
        onCodeRequested: @escaping CodeRequestedAction
    ) {
        _email = State(initialValue: initialEmail)
        self.onRequestCode = onRequestCode
        self.onCodeRequested = onCodeRequested
    }

    var body: some View {
        AuthScreenLayout(
            eyebrow: "Capture first",
            title: "Sign in to Unfiled",
            message: "Enter your email and we’ll send a six-digit code. No password to remember.",
            accessibilityIdentifier: AuthAccessibilityIdentifier.emailScreen
        ) {
            VStack(alignment: .leading, spacing: 0) {
                AuthFieldLabel(text: "Email address")

                HStack(spacing: 8) {
                    TextField(
                        "Email address",
                        text: $email,
                        prompt: Text("you@example.com").foregroundStyle(UnfiledTheme.fog)
                    )
                        .font(.system(.body))
                        .foregroundStyle(UnfiledTheme.paper)
                        .tint(UnfiledTheme.persimmon)
                        .textInputAutocapitalization(.never)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .autocorrectionDisabled()
                        .submitLabel(.continue)
                        .focused($isEmailFocused)
                        .onSubmit(requestCode)
                        .accessibilityLabel("Email address")
                        .accessibilityIdentifier(AuthAccessibilityIdentifier.emailField)

                    if !email.isEmpty {
                        Button {
                            email = ""
                            errorMessage = nil
                            isEmailFocused = true
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 18))
                                .foregroundStyle(UnfiledTheme.fog)
                                .frame(width: UnfiledTheme.minimumTouchTarget, height: UnfiledTheme.minimumTouchTarget)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Clear email address")
                    }
                }
                .padding(.leading, 16)
                .padding(.trailing, 6)
                .frame(minHeight: 56)
                .background(UnfiledTheme.graphite)
                .overlay {
                    RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius)
                        .stroke(
                            isEmailFocused ? UnfiledTheme.persimmon : UnfiledTheme.border,
                            lineWidth: isEmailFocused ? 2 : 1
                        )
                }
                .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
                .padding(.top, 9)

                Group {
                    if let errorMessage {
                        AuthInlineMessage(
                            message: errorMessage,
                            kind: .error,
                            accessibilityIdentifier: AuthAccessibilityIdentifier.emailError
                        )
                    }
                }
                .frame(minHeight: 54, alignment: .leading)

                AuthPrimaryButton(
                    title: "Send sign-in code",
                    loadingTitle: "Sending code…",
                    isLoading: isSubmitting,
                    isDisabled: !AuthFormRules.canRequestCode(email: email, isSubmitting: isSubmitting),
                    accessibilityIdentifier: AuthAccessibilityIdentifier.emailSubmit,
                    action: requestCode
                )

                Text("We use this address only to sign you in and identify your account.")
                    .font(.system(.footnote))
                    .foregroundStyle(UnfiledTheme.fog)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 15)
            }
        }
        .task {
            await Task.yield()
            guard !Task.isCancelled else { return }
            isEmailFocused = true
        }
        .onDisappear {
            requestTask?.cancel()
            requestTask = nil
        }
    }

    private func requestCode() {
        guard AuthFormRules.canRequestCode(email: email, isSubmitting: isSubmitting) else { return }

        let normalizedEmail = AuthFormRules.normalizedEmail(email)
        guard AuthFormRules.isValidEmail(normalizedEmail) else {
            errorMessage = "Enter a valid email address."
            isEmailFocused = true
            return
        }

        isEmailFocused = false
        isSubmitting = true
        errorMessage = nil
        requestTask?.cancel()
        requestTask = Task { @MainActor in
            defer {
                isSubmitting = false
                requestTask = nil
            }

            do {
                let response = try await onRequestCode(AuthOTPRequest(email: normalizedEmail))
                guard !Task.isCancelled else { return }
                onCodeRequested(normalizedEmail, response)
            } catch {
                guard !Task.isCancelled else { return }
                errorMessage = AuthFormRules.displayMessage(
                    for: error,
                    fallback: "The sign-in code could not be sent. Try again."
                )
                isEmailFocused = true
            }
        }
    }
}
