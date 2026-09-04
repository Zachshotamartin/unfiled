import SwiftUI

/// The step between creating an account and using it, on a deployment that confirms addresses. The
/// account already exists when this screen appears, so nothing here is a point of no return: the
/// owner can ask for another code, or leave for the sign-in screen and finish later.
@MainActor
struct VerifyEmailView: View {
    typealias VerifyAction = @MainActor (String) async throws -> AuthSession
    typealias ResendAction = @MainActor () async throws -> Void
    typealias LeaveAction = @MainActor () -> Void
    typealias SignedInAction = @MainActor (AuthSession) -> Void

    @State private var code = ""
    @State private var isSubmitting = false
    @State private var isResending = false
    @State private var errorMessage: String?
    @State private var noticeMessage: String?
    @State private var now = Date()
    @State private var submitTask: Task<Void, Never>?
    @State private var resendTask: Task<Void, Never>?
    @FocusState private var isFieldFocused: Bool

    private let pending: PendingVerification
    private let onVerify: VerifyAction
    private let onResend: ResendAction
    private let onLeave: LeaveAction
    private let onSignedIn: SignedInAction

    init(
        pending: PendingVerification,
        onVerify: @escaping VerifyAction,
        onResend: @escaping ResendAction,
        onLeave: @escaping LeaveAction,
        onSignedIn: @escaping SignedInAction
    ) {
        self.pending = pending
        self.onVerify = onVerify
        self.onResend = onResend
        self.onLeave = onLeave
        self.onSignedIn = onSignedIn
    }

    private var waitRemaining: Int {
        AuthVerificationRules.resendWaitRemaining(codeSentAt: pending.codeSentAt, now: now)
    }

    private var canResend: Bool {
        AuthVerificationRules.canResend(
            codeSentAt: pending.codeSentAt,
            now: now,
            isSubmitting: isSubmitting,
            isResending: isResending
        )
    }

    var body: some View {
        AuthScreenLayout(
            eyebrow: "One more step",
            title: "Enter your code",
            message: "We emailed six digits to \(pending.email). Enter them to finish creating your account.",
            accessibilityIdentifier: AuthAccessibilityIdentifier.verifyScreen
        ) {
            VStack(alignment: .leading, spacing: 0) {
                AuthFieldLabel(text: "Six-digit code")

                AuthFieldContainer(isFocused: isFieldFocused) {
                    // No placeholder text: greyed digits in a code field read as a value already
                    // entered, and the label above the field already says what belongs here. The
                    // field carries its name for VoiceOver instead.
                    TextField("", text: $code)
                    // Monospaced digits inside the scale's serif title, so the six characters sit on
                    // an even rhythm as they are typed rather than shifting under the caret.
                    .font(UnfiledType.title.monospacedDigit())
                    .tracking(8)
                    .multilineTextAlignment(.center)
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($isFieldFocused)
                    .accessibilityLabel("Six-digit code")
                    .accessibilityIdentifier(AuthAccessibilityIdentifier.verifyField)
                }
                .padding(.top, 9)

                if let errorMessage {
                    AuthInlineMessage(
                        message: errorMessage,
                        kind: .error,
                        accessibilityIdentifier: AuthAccessibilityIdentifier.verifyError
                    )
                    .padding(.top, UnfiledTheme.controlStackSpacing)
                } else if let noticeMessage {
                    AuthInlineMessage(
                        message: noticeMessage,
                        kind: .confirmation,
                        accessibilityIdentifier: AuthAccessibilityIdentifier.verifyNotice
                    )
                    .padding(.top, UnfiledTheme.controlStackSpacing)
                }

                AuthPrimaryButton(
                    title: "Confirm email",
                    loadingTitle: "Confirming…",
                    isLoading: isSubmitting,
                    isDisabled: !AuthVerificationRules.canSubmitCode(
                        code: code,
                        isSubmitting: isSubmitting
                    ),
                    accessibilityIdentifier: AuthAccessibilityIdentifier.verifySubmit,
                    action: submit
                )
                .padding(.top, UnfiledTheme.formActionSpacing)

                AuthSecondaryButton(
                    title: isResending
                        ? "Sending a new code…"
                        : AuthVerificationRules.resendTitle(waitRemaining: waitRemaining),
                    isDisabled: !canResend,
                    accessibilityIdentifier: AuthAccessibilityIdentifier.verifyResend,
                    action: resend
                )
                .padding(.top, 12)

                AuthSecondaryButton(
                    title: "Use a different email address",
                    emphasis: .quiet,
                    isDisabled: isSubmitting || isResending,
                    accessibilityIdentifier: AuthAccessibilityIdentifier.verifyCancel,
                    action: leave
                )

                Text("Your account already exists. If the code does not arrive, ask for a new one, or sign in once you have confirmed the address.")
                    .font(UnfiledType.secondary)
                    .foregroundStyle(UnfiledTheme.fog)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 15)
            }
        }
        .onChange(of: code) { _, newValue in
            let digits = AuthVerificationRules.sanitizedCode(newValue)
            if digits != newValue { code = digits }
            // Six digits is the whole answer, so asking for a separate tap only adds a step. A
            // refused attempt clears the field, so this cannot resubmit the same code in a loop.
            if AuthVerificationRules.canSubmitCode(code: digits, isSubmitting: isSubmitting) {
                submit()
            }
        }
        .task(id: pending.codeSentAt) {
            // Only ticks while a wait is actually counting down, so a settled screen does no work.
            while !Task.isCancelled,
                  AuthVerificationRules.resendWaitRemaining(
                      codeSentAt: pending.codeSentAt,
                      now: now
                  ) > 0 {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled else { return }
                now = Date()
            }
        }
        .task {
            await Task.yield()
            guard !Task.isCancelled else { return }
            isFieldFocused = true
        }
        .onDisappear {
            submitTask?.cancel()
            submitTask = nil
            resendTask?.cancel()
            resendTask = nil
        }
    }

    private func submit() {
        guard AuthVerificationRules.canSubmitCode(code: code, isSubmitting: isSubmitting) else {
            return
        }
        let submittedCode = code
        isSubmitting = true
        errorMessage = nil
        noticeMessage = nil
        submitTask?.cancel()
        submitTask = Task { @MainActor in
            defer { isSubmitting = false }
            do {
                let session = try await onVerify(submittedCode)
                guard !Task.isCancelled else { return }
                code = ""
                onSignedIn(session)
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                // The refused digits are cleared so the field is ready for the next attempt and the
                // automatic submission does not fire again on the value that was just rejected.
                code = ""
                errorMessage = AuthVerificationRules.verificationMessage(for: error)
                isFieldFocused = true
            }
        }
    }

    private func resend() {
        guard canResend else { return }
        isResending = true
        errorMessage = nil
        noticeMessage = nil
        resendTask?.cancel()
        resendTask = Task { @MainActor in
            defer { isResending = false }
            do {
                try await onResend()
                guard !Task.isCancelled else { return }
                now = Date()
                noticeMessage = AuthVerificationRules.codeSentConfirmation
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                errorMessage = AuthVerificationRules.resendMessage(for: error)
            }
        }
    }

    private func leave() {
        submitTask?.cancel()
        submitTask = nil
        resendTask?.cancel()
        resendTask = nil
        onLeave()
    }
}
