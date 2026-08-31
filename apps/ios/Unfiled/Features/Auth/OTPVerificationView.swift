import SwiftUI

@MainActor
struct OTPVerificationView: View {
    typealias VerifyCodeAction = @MainActor (AuthOTPVerifyRequest) async throws -> AuthSession
    typealias ResendCodeAction = @MainActor (AuthOTPRequest) async throws -> AuthOTPAcceptedResponse
    typealias VerifiedAction = @MainActor (AuthSession) -> Void
    typealias CorrectEmailAction = @MainActor (String) -> Void

    private enum ActiveRequest {
        case verifying
        case resending
    }

    let email: String

    @State private var code = ""
    @State private var activeRequest: ActiveRequest?
    @State private var errorMessage: String?
    @State private var deliveryMessage = "Code sent. It may take a moment to arrive."
    @State private var resendAvailableAt: Date
    @State private var actionTask: Task<Void, Never>?
    @FocusState private var isCodeFocused: Bool

    private let resendDelaySeconds: Int
    private let onVerifyCode: VerifyCodeAction
    private let onResendCode: ResendCodeAction
    private let onVerified: VerifiedAction
    private let onCorrectEmail: CorrectEmailAction

    init(
        email: String,
        resendDelaySeconds: Int = 60,
        onVerifyCode: @escaping VerifyCodeAction,
        onResendCode: @escaping ResendCodeAction,
        onVerified: @escaping VerifiedAction,
        onCorrectEmail: @escaping CorrectEmailAction
    ) {
        let normalizedEmail = AuthFormRules.normalizedEmail(email)
        let boundedDelay = AuthFormRules.boundedCooldown(resendDelaySeconds)
        self.email = normalizedEmail
        self.resendDelaySeconds = boundedDelay
        self.onVerifyCode = onVerifyCode
        self.onResendCode = onResendCode
        self.onVerified = onVerified
        self.onCorrectEmail = onCorrectEmail
        _resendAvailableAt = State(initialValue: Date().addingTimeInterval(TimeInterval(boundedDelay)))
    }

    var body: some View {
        AuthScreenLayout(
            eyebrow: "Code sent",
            title: "Check your email",
            message: "Enter the six-digit code we sent to your email address.",
            accessibilityIdentifier: AuthAccessibilityIdentifier.codeScreen
        ) {
            VStack(alignment: .leading, spacing: 0) {
                correctEmailButton

                AuthFieldLabel(text: "Six-digit code")
                    .padding(.top, 28)

                TextField("000000", text: $code)
                    .font(.system(.title, design: .monospaced, weight: .semibold))
                    .tracking(6)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(UnfiledTheme.paper)
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                    .focused($isCodeFocused)
                    .padding(.horizontal, 16)
                    .frame(minHeight: 64)
                    .background(UnfiledTheme.graphite)
                    .overlay {
                        RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius)
                            .stroke(
                                isCodeFocused ? UnfiledTheme.persimmon : UnfiledTheme.border,
                                lineWidth: isCodeFocused ? 2 : 1
                            )
                    }
                    .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
                    .padding(.top, 9)
                    .onChange(of: code) { _, newValue in
                        let sanitized = AuthFormRules.sanitizedCode(newValue)
                        if sanitized != newValue {
                            code = sanitized
                        }
                        if errorMessage != nil {
                            errorMessage = nil
                        }
                    }
                    .accessibilityLabel("Six-digit sign-in code")
                    .accessibilityValue("\(code.count) of \(AuthFormRules.codeLength) digits entered")
                    .accessibilityHint("The code is in the email from Unfiled")
                    .accessibilityIdentifier(AuthAccessibilityIdentifier.codeField)

                messageRegion

                AuthPrimaryButton(
                    title: "Open Unfiled",
                    loadingTitle: "Checking code…",
                    isLoading: activeRequest == .verifying,
                    isDisabled: !AuthFormRules.canVerifyCode(
                        code: code,
                        isSubmitting: activeRequest != nil
                    ),
                    accessibilityIdentifier: AuthAccessibilityIdentifier.codeSubmit,
                    action: verifyCode
                )

                resendButton
                    .padding(.top, 8)
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") {
                    isCodeFocused = false
                }
            }
        }
        .task {
            await Task.yield()
            guard !Task.isCancelled else { return }
            isCodeFocused = true
        }
        .onDisappear {
            actionTask?.cancel()
            actionTask = nil
        }
    }

    private var correctEmailButton: some View {
        Button {
            guard activeRequest == nil else { return }
            isCodeFocused = false
            onCorrectEmail(email)
        } label: {
            HStack(spacing: 11) {
                Image(systemName: "arrow.left")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(UnfiledTheme.persimmon)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Change email")
                        .font(.system(.footnote, weight: .semibold))
                        .foregroundStyle(UnfiledTheme.paper)
                    Text(email)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(UnfiledTheme.fog)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }

                Spacer(minLength: 8)
            }
            .frame(maxWidth: .infinity, minHeight: UnfiledTheme.minimumTouchTarget, alignment: .leading)
        }
        .buttonStyle(.plain)
        .disabled(activeRequest != nil)
        .accessibilityLabel("Change email address")
        .accessibilityValue(email)
        .accessibilityHint("Returns to email entry")
        .accessibilityIdentifier(AuthAccessibilityIdentifier.correctEmail)
    }

    @ViewBuilder
    private var messageRegion: some View {
        Group {
            if let errorMessage {
                AuthInlineMessage(
                    message: errorMessage,
                    kind: .error,
                    accessibilityIdentifier: AuthAccessibilityIdentifier.codeError
                )
            } else {
                AuthInlineMessage(
                    message: deliveryMessage,
                    kind: .confirmation,
                    accessibilityIdentifier: AuthAccessibilityIdentifier.codeDeliveryStatus
                )
            }
        }
        .frame(minHeight: 58, alignment: .leading)
    }

    private var resendButton: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let secondsRemaining = AuthFormRules.resendSecondsRemaining(
                availableAt: resendAvailableAt,
                now: context.date
            )
            let isResending = activeRequest == .resending
            let isDisabled = activeRequest != nil || secondsRemaining > 0
            let title = resendTitle(isResending: isResending, secondsRemaining: secondsRemaining)

            Button(action: resendCode) {
                HStack(spacing: 8) {
                    if isResending {
                        ProgressView()
                            .controlSize(.small)
                            .tint(UnfiledTheme.fog)
                            .accessibilityHidden(true)
                    }
                    Text(title)
                        .font(.system(.footnote, weight: .semibold))
                }
                .foregroundStyle(isDisabled ? UnfiledTheme.fog.opacity(0.55) : UnfiledTheme.paper)
                .frame(maxWidth: .infinity, minHeight: UnfiledTheme.minimumTouchTarget)
                .overlay {
                    RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius)
                        .stroke(UnfiledTheme.border, lineWidth: 1)
                }
            }
            .buttonStyle(.plain)
            .disabled(isDisabled)
            .accessibilityLabel(title)
            .accessibilityValue(isResending ? "In progress" : "")
            .accessibilityIdentifier(AuthAccessibilityIdentifier.codeResend)
        }
    }

    private func resendTitle(isResending: Bool, secondsRemaining: Int) -> String {
        if isResending {
            return "Sending another code…"
        }
        if secondsRemaining > 0 {
            return "Send another code in \(secondsRemaining)s"
        }
        return "Send another code"
    }

    private func verifyCode() {
        guard AuthFormRules.canVerifyCode(code: code, isSubmitting: activeRequest != nil) else { return }

        let request: AuthOTPVerifyRequest
        do {
            request = try AuthOTPVerifyRequest(email: email, code: code)
        } catch {
            errorMessage = "Enter the complete six-digit code."
            isCodeFocused = true
            return
        }

        isCodeFocused = false
        activeRequest = .verifying
        errorMessage = nil
        actionTask?.cancel()
        actionTask = Task { @MainActor in
            defer {
                activeRequest = nil
                actionTask = nil
            }

            do {
                let session = try await onVerifyCode(request)
                guard !Task.isCancelled else { return }
                onVerified(session)
            } catch {
                guard !Task.isCancelled else { return }
                errorMessage = AuthFormRules.displayMessage(
                    for: error,
                    fallback: "That code could not be verified. Check it and try again."
                )
                isCodeFocused = true
            }
        }
    }

    private func resendCode() {
        guard activeRequest == nil,
              AuthFormRules.resendSecondsRemaining(availableAt: resendAvailableAt, now: Date()) == 0
        else {
            return
        }

        isCodeFocused = false
        activeRequest = .resending
        errorMessage = nil
        actionTask?.cancel()
        actionTask = Task { @MainActor in
            defer {
                activeRequest = nil
                actionTask = nil
            }

            do {
                let response = try await onResendCode(AuthOTPRequest(email: email))
                guard !Task.isCancelled else { return }
                let nextDelay = AuthFormRules.boundedCooldown(response.retryAfterSeconds)
                resendAvailableAt = Date().addingTimeInterval(TimeInterval(nextDelay))
                deliveryMessage = "A new code was sent. Use the most recent email."
                isCodeFocused = true
            } catch {
                guard !Task.isCancelled else { return }
                errorMessage = AuthFormRules.displayMessage(
                    for: error,
                    fallback: "Another code could not be sent. Try again."
                )
                isCodeFocused = true
            }
        }
    }
}
