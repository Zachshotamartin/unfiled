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
