import SwiftUI

@MainActor
struct PasswordSignInView: View {
    typealias SubmitAction = @MainActor (AuthPasswordRequest, AuthMode) async throws -> AuthSession
    typealias SignedInAction = @MainActor (AuthSession) -> Void

    @Binding private var mode: AuthMode
    @State private var email: String
    @State private var password = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?
    @State private var submitTask: Task<Void, Never>?
    @FocusState private var focusedField: Field?

    private enum Field { case email, password }

    private let onSubmit: SubmitAction
    private let onSignedIn: SignedInAction

    init(
        mode: Binding<AuthMode>,
        initialEmail: String = "",
        onSubmit: @escaping SubmitAction,
        onSignedIn: @escaping SignedInAction
    ) {
        _mode = mode
        _email = State(initialValue: initialEmail)
        self.onSubmit = onSubmit
        self.onSignedIn = onSignedIn
    }

    private var isSignUp: Bool { mode == .signUp }

    var body: some View {
        AuthScreenLayout(
            eyebrow: "Capture first",
            title: isSignUp ? "Create your account" : "Sign in to Unfiled",
            message: isSignUp
                ? "Choose the email address and password you will use on every device."
                : "Enter the email address and password for your account.",
            accessibilityIdentifier: AuthAccessibilityIdentifier.emailScreen
        ) {
            VStack(alignment: .leading, spacing: 0) {
                AuthFieldLabel(text: "Email address")
                credentialField(isFocused: focusedField == .email) {
                    TextField(
                        "Email address",
                        text: $email,
                        prompt: Text("you@example.com").foregroundStyle(UnfiledTheme.fog)
                    )
                    .textInputAutocapitalization(.never)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .autocorrectionDisabled()
                    .submitLabel(.next)
                    .focused($focusedField, equals: .email)
                    .onSubmit { focusedField = .password }
                    .accessibilityLabel("Email address")
                    .accessibilityIdentifier(AuthAccessibilityIdentifier.emailField)
                }
                .padding(.top, 9)

                AuthFieldLabel(text: "Password")
                    .padding(.top, 20)
                credentialField(isFocused: focusedField == .password) {
                    SecureField(
                        "Password",
                        text: $password,
                        prompt: Text(isSignUp ? "At least 8 characters" : "Your password")
                            .foregroundStyle(UnfiledTheme.fog)
                    )
                    .textContentType(isSignUp ? .newPassword : .password)
                    .submitLabel(.go)
                    .focused($focusedField, equals: .password)
                    .onSubmit(submit)
                    .accessibilityLabel("Password")
                    .accessibilityIdentifier(AuthAccessibilityIdentifier.passwordField)
                }
                .padding(.top, 9)

                if let errorMessage {
                    AuthInlineMessage(
                        message: errorMessage,
                        kind: .error,
                        accessibilityIdentifier: AuthAccessibilityIdentifier.emailError
                    )
                    .padding(.top, UnfiledTheme.controlStackSpacing)
                }

                AuthPrimaryButton(
                    title: isSignUp ? "Create account" : "Sign in",
                    loadingTitle: isSignUp ? "Creating account…" : "Signing in…",
                    isLoading: isSubmitting,
                    isDisabled: !AuthFormRules.canSubmitCredentials(
                        email: email,
                        password: password,
                        isSubmitting: isSubmitting
                    ),
                    accessibilityIdentifier: AuthAccessibilityIdentifier.emailSubmit,
                    action: submit
                )
                .padding(.top, UnfiledTheme.formActionSpacing)

                Button {
                    mode = isSignUp ? .signIn : .signUp
                    errorMessage = nil
                } label: {
                    Text(isSignUp ? "Have an account? Sign in" : "New here? Create an account")
                        .font(UnfiledType.secondaryStrong)
                        .foregroundStyle(UnfiledTheme.paper)
                        .frame(maxWidth: .infinity, minHeight: UnfiledTheme.minimumTouchTarget)
                }
                .buttonStyle(.plain)
                .disabled(isSubmitting)
                .accessibilityIdentifier(AuthAccessibilityIdentifier.modeToggle)
                .padding(.top, 12)

                Text("We use your email address only to identify your account. Passwords are never stored on this device.")
                    .font(UnfiledType.secondary)
                    .foregroundStyle(UnfiledTheme.fog)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 15)
            }
        }
        .task {
            await Task.yield()
            guard !Task.isCancelled else { return }
            focusedField = .email
        }
        .onDisappear {
            submitTask?.cancel()
            submitTask = nil
        }
    }

    private func credentialField<Content: View>(
        isFocused: Bool,
        @ViewBuilder content: () -> Content
    ) -> some View {
        HStack(spacing: 8) {
            content()
                .font(UnfiledType.body)
                .foregroundStyle(UnfiledTheme.paper)
                .tint(UnfiledTheme.persimmon)
        }
        .padding(.horizontal, UnfiledTheme.fieldPadding)
        .frame(minHeight: UnfiledTheme.controlHeight)
        .background(UnfiledTheme.graphite)
        .overlay {
            RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius)
                .stroke(isFocused ? UnfiledTheme.persimmon : UnfiledTheme.border, lineWidth: isFocused ? 2 : 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
    }

    private func submit() {
        guard AuthFormRules.canSubmitCredentials(email: email, password: password, isSubmitting: isSubmitting) else {
            return
        }
        let request: AuthPasswordRequest
        do {
            request = try AuthPasswordRequest(email: email, password: password)
        } catch {
            errorMessage = "Enter a valid email address and a password of at least 8 characters."
            return
        }
        let submittedMode = mode
        isSubmitting = true
        errorMessage = nil
        submitTask?.cancel()
        submitTask = Task { @MainActor in
            defer { isSubmitting = false }
            do {
                let session = try await onSubmit(request, submittedMode)
                guard !Task.isCancelled else { return }
                password = ""
                onSignedIn(session)
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                errorMessage = AuthFormRules.credentialsMessage(for: error, mode: submittedMode)
            }
        }
    }
}
