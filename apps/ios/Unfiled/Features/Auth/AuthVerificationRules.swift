import Foundation

/// The rules the code-entry screen follows, kept out of the view so each one can be checked on its
/// own: what counts as a code, when another one may be asked for, and what the owner is told.
enum AuthVerificationRules {
    static let codeLength = AuthVerificationCodeContract.length

    /// The service limits how often it will email a code, and each new code retires the one before
    /// it. The screen keeps a minute between requests so a tapped-twice button cannot spend that
    /// budget, and so a code already in flight has time to arrive before it is invalidated.
    static let resendWait: TimeInterval = 60

    /// Keeps only the digits, so the field can never hold a value the service would reject.
    static func sanitizedCode(_ rawValue: String) -> String {
        AuthVerificationCodeContract.digits(rawValue)
    }

    static func isCompleteCode(_ value: String) -> Bool {
        AuthVerificationCodeContract.isComplete(value)
    }

    /// Submission needs a full code and no request in flight. The screen submits the moment the
    /// sixth digit lands, so this also decides whether that automatic submission may proceed.
    static func canSubmitCode(code: String, isSubmitting: Bool) -> Bool {
        !isSubmitting && isCompleteCode(code)
    }

    /// Whole seconds left before another code may be asked for. A send stamped in the future means
    /// the device clock moved; the whole wait is applied rather than trusting the difference.
    static func resendWaitRemaining(codeSentAt: Date?, now: Date) -> Int {
        guard let codeSentAt else { return 0 }
        let elapsed = now.timeIntervalSince(codeSentAt)
        guard elapsed >= 0 else { return Int(resendWait.rounded(.up)) }
        let remaining = resendWait - elapsed
        return remaining <= 0 ? 0 : Int(remaining.rounded(.up))
    }

    static func canResend(
        codeSentAt: Date?,
        now: Date,
        isSubmitting: Bool,
        isResending: Bool
    ) -> Bool {
        !isSubmitting && !isResending
            && resendWaitRemaining(codeSentAt: codeSentAt, now: now) == 0
    }

    /// Says why the button is unavailable instead of leaving a dimmed control unexplained.
    static func resendTitle(waitRemaining: Int) -> String {
        waitRemaining > 0 ? "Send a new code in \(waitRemaining)s" : "Send a new code"
    }

    static let codeSentConfirmation = "A new code is on its way. It can take a minute to arrive."

    /// Maps the content-free service codes to guidance, the same way the credentials screen does:
    /// the server's own message text never reaches the screen, so upstream detail cannot leak
    /// through it. A refused code says both what happened and what to do next, because "wrong" and
    /// "expired" are indistinguishable to the owner and have the same remedy.
    static func verificationMessage(for error: Error) -> String {
        let fallback = "The code could not be checked. Try again."
        guard case let APIClientError.http(status, code, _, _) = error else {
            return AuthFormRules.displayMessage(for: error, fallback: fallback)
        }
        switch code {
        case .unauthorized:
            return "That code is wrong or has expired. Ask for a new one."
        case .validationFailed:
            return "Enter the six digits from the email."
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

    /// A refused resend is its own situation: the code already sent may still work, so the guidance
    /// is to wait rather than to start again.
    static func resendMessage(for error: Error) -> String {
        let fallback = "A new code could not be sent. Try again."
        guard case let APIClientError.http(status, code, _, _) = error else {
            return AuthFormRules.displayMessage(for: error, fallback: fallback)
        }
        switch code {
        case .rateLimited:
            return "Too many requests for a new code. Wait a few minutes and try the code you have."
        case .providerUnavailable:
            return "Unfiled is temporarily unavailable. Try again shortly."
        default:
            return (500 ... 599).contains(status)
                ? "Unfiled is temporarily unavailable. Try again shortly."
                : fallback
        }
    }
}
