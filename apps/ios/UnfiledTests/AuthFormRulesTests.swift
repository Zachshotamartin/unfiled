import XCTest
@testable import Unfiled

final class AuthFormRulesTests: XCTestCase {
    func testEmailValuesNormalizeAndRejectMalformedAddresses() {
        XCTAssertEqual(
            AuthFormRules.normalizedEmail("  Person@Example.COM\n"),
            "person@example.com"
        )
        XCTAssertTrue(AuthFormRules.isValidEmail("person@example.com"))
        XCTAssertTrue(AuthFormRules.isValidEmail("reader+notes@sub.example.com"))

        XCTAssertFalse(AuthFormRules.isValidEmail(""))
        XCTAssertFalse(AuthFormRules.isValidEmail("missing-at.example.com"))
        XCTAssertFalse(AuthFormRules.isValidEmail("two@@example.com"))
        XCTAssertFalse(AuthFormRules.isValidEmail("person @example.com"))
        XCTAssertFalse(AuthFormRules.isValidEmail(".person@example.com"))
        XCTAssertFalse(AuthFormRules.isValidEmail("person@example..com"))
    }

    func testPasswordsAreBoundedByLengthOnly() {
        XCTAssertFalse(AuthFormRules.isValidPassword("short"))
        XCTAssertTrue(AuthFormRules.isValidPassword("eightch."))
        XCTAssertTrue(AuthFormRules.isValidPassword(String(repeating: "x", count: 72)))
        XCTAssertFalse(AuthFormRules.isValidPassword(String(repeating: "x", count: 73)))
    }

    func testSubmissionRequiresValidCredentialsAndAnIdleRequest() {
        XCTAssertTrue(
            AuthFormRules.canSubmitCredentials(email: "person@example.com", password: "correct horse", isSubmitting: false)
        )
        XCTAssertFalse(
            AuthFormRules.canSubmitCredentials(email: "not-an-email", password: "correct horse", isSubmitting: false)
        )
        XCTAssertFalse(
            AuthFormRules.canSubmitCredentials(email: "person@example.com", password: "short", isSubmitting: false)
        )
        XCTAssertFalse(
            AuthFormRules.canSubmitCredentials(email: "person@example.com", password: "correct horse", isSubmitting: true)
        )
    }


    func testCredentialsMessagesMapServiceCodesToGuidance() {
        let conflict = APIClientError.http(status: 409, code: .accountExists, requestId: "r", retryAfterSeconds: nil)
        XCTAssertEqual(
            AuthFormRules.credentialsMessage(for: conflict, mode: .signUp),
            "An account with this email already exists. Sign in instead."
        )
        let wrong = APIClientError.http(status: 401, code: .unauthorized, requestId: nil, retryAfterSeconds: nil)
        XCTAssertEqual(AuthFormRules.credentialsMessage(for: wrong, mode: .signIn), "Wrong email or password.")
        let invalid = APIClientError.http(status: 400, code: .validationFailed, requestId: nil, retryAfterSeconds: nil)
        XCTAssertEqual(
            AuthFormRules.credentialsMessage(for: invalid, mode: .signUp),
            "Check the email address and use a password of 8 to 72 characters."
        )
        XCTAssertEqual(AuthFormRules.credentialsMessage(for: invalid, mode: .signIn), "Check your email and password.")
        let limited = APIClientError.http(status: 429, code: .rateLimited, requestId: nil, retryAfterSeconds: 60)
        XCTAssertEqual(
            AuthFormRules.credentialsMessage(for: limited, mode: .signIn),
            "Too many attempts. Wait a few minutes and try again."
        )
        let outage = APIClientError.http(status: 503, code: nil, requestId: nil, retryAfterSeconds: nil)
        XCTAssertEqual(
            AuthFormRules.credentialsMessage(for: outage, mode: .signUp),
            "Unfiled is temporarily unavailable. Try again shortly."
        )
        let unknown = APIClientError.http(status: 404, code: .notFound, requestId: nil, retryAfterSeconds: nil)
        XCTAssertEqual(
            AuthFormRules.credentialsMessage(for: unknown, mode: .signUp),
            "The account could not be created. Try again."
        )
        XCTAssertEqual(
            AuthFormRules.credentialsMessage(for: APIClientError.transportFailure, mode: .signIn),
            "The service could not be reached."
        )
    }

    func testAccessibilityIdentifiersRemainUnique() {
        let identifiers = [
            AuthAccessibilityIdentifier.emailScreen,
            AuthAccessibilityIdentifier.emailField,
            AuthAccessibilityIdentifier.emailError,
            AuthAccessibilityIdentifier.emailSubmit,
            AuthAccessibilityIdentifier.passwordField,
            AuthAccessibilityIdentifier.modeToggle
        ]

        XCTAssertEqual(Set(identifiers).count, identifiers.count)
    }

    func testSignInActionUsesAVisiblySeparateControlGap() {
        XCTAssertGreaterThan(UnfiledTheme.formActionSpacing, UnfiledTheme.controlStackSpacing)
        XCTAssertGreaterThanOrEqual(UnfiledTheme.minimumTouchTarget, 44)
    }
}
