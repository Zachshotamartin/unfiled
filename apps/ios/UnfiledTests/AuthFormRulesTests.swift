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

    func testEmailSubmissionAllowsVisibleValidationAndPreventsDuplicateWork() {
        XCTAssertFalse(AuthFormRules.canRequestCode(email: "   ", isSubmitting: false))
        XCTAssertTrue(AuthFormRules.canRequestCode(email: "not-yet-valid", isSubmitting: false))
        XCTAssertFalse(
            AuthFormRules.canRequestCode(email: "person@example.com", isSubmitting: true)
        )
    }

    func testCodeSanitizationKeepsOnlySixASCIIDigits() {
        XCTAssertEqual(AuthFormRules.sanitizedCode("12a 34-567"), "123456")
        XCTAssertEqual(AuthFormRules.sanitizedCode("１２3456"), "3456")
        XCTAssertEqual(AuthFormRules.sanitizedCode("98\n76"), "9876")
    }

    func testVerificationRequiresSixDigitsAndAnIdleRequest() {
        XCTAssertFalse(AuthFormRules.canVerifyCode(code: "12345", isSubmitting: false))
        XCTAssertTrue(AuthFormRules.canVerifyCode(code: "123456", isSubmitting: false))
        XCTAssertFalse(AuthFormRules.canVerifyCode(code: "123456", isSubmitting: true))
    }

    func testCooldownIsBoundedAndRoundsUpPartialSeconds() {
        XCTAssertEqual(AuthFormRules.boundedCooldown(-1), 0)
        XCTAssertEqual(AuthFormRules.boundedCooldown(60), 60)
        XCTAssertEqual(AuthFormRules.boundedCooldown(8_000), 3_600)

        let now = Date(timeIntervalSince1970: 100)
        XCTAssertEqual(
            AuthFormRules.resendSecondsRemaining(
                availableAt: Date(timeIntervalSince1970: 105.01),
                now: now
            ),
            6
        )
        XCTAssertEqual(
            AuthFormRules.resendSecondsRemaining(
                availableAt: Date(timeIntervalSince1970: 99),
                now: now
            ),
            0
        )
    }

    func testAccessibilityIdentifiersRemainUnique() {
        let identifiers = [
            AuthAccessibilityIdentifier.emailScreen,
            AuthAccessibilityIdentifier.emailField,
            AuthAccessibilityIdentifier.emailError,
            AuthAccessibilityIdentifier.emailSubmit,
            AuthAccessibilityIdentifier.codeScreen,
            AuthAccessibilityIdentifier.codeField,
            AuthAccessibilityIdentifier.codeError,
            AuthAccessibilityIdentifier.codeSubmit,
            AuthAccessibilityIdentifier.codeResend,
            AuthAccessibilityIdentifier.codeDeliveryStatus,
            AuthAccessibilityIdentifier.correctEmail
        ]

        XCTAssertEqual(Set(identifiers).count, identifiers.count)
    }

    func testSignInActionUsesAVisiblySeparateControlGap() {
        XCTAssertGreaterThan(UnfiledTheme.formActionSpacing, UnfiledTheme.controlStackSpacing)
        XCTAssertGreaterThanOrEqual(UnfiledTheme.minimumTouchTarget, 44)
    }
}
