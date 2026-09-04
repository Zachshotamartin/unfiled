import Foundation
import XCTest
@testable import Unfiled

/// The rules the code-entry screen follows: what counts as a code, when another one may be asked
/// for, what a refusal says, and what survives the app being backgrounded.
final class AuthVerificationRulesTests: XCTestCase {
    private let sentAt = Date(timeIntervalSince1970: 1_800_000_000)

    func testACodeIsSixDigitsAndNothingElseSurvivesTheField() {
        XCTAssertEqual(AuthVerificationRules.codeLength, 6)
        XCTAssertEqual(AuthVerificationRules.sanitizedCode("123456"), "123456")
        XCTAssertEqual(AuthVerificationRules.sanitizedCode(" 12 34-56 "), "123456")
        XCTAssertEqual(AuthVerificationRules.sanitizedCode("Your code is 123456."), "123456")
        XCTAssertEqual(AuthVerificationRules.sanitizedCode("1234567890"), "123456")
        XCTAssertEqual(AuthVerificationRules.sanitizedCode("١٢٣٤٥٦"), "")
        XCTAssertEqual(AuthVerificationRules.sanitizedCode(""), "")

        XCTAssertTrue(AuthVerificationRules.isCompleteCode("000000"))
        XCTAssertFalse(AuthVerificationRules.isCompleteCode("12345"))
        XCTAssertFalse(AuthVerificationRules.isCompleteCode("1234567"))
        XCTAssertFalse(AuthVerificationRules.isCompleteCode("12a456"))
    }

    func testSubmissionNeedsAFullCodeAndNoRequestInFlight() {
        XCTAssertTrue(AuthVerificationRules.canSubmitCode(code: "123456", isSubmitting: false))
        XCTAssertFalse(AuthVerificationRules.canSubmitCode(code: "12345", isSubmitting: false))
        XCTAssertFalse(AuthVerificationRules.canSubmitCode(code: "123456", isSubmitting: true))
    }

    func testTheResendWaitCountsDownAndSurvivesAClockThatMovedBackwards() {
        XCTAssertEqual(AuthVerificationRules.resendWait, 60)
        XCTAssertEqual(
            AuthVerificationRules.resendWaitRemaining(codeSentAt: nil, now: sentAt),
            0
        )
        XCTAssertEqual(
            AuthVerificationRules.resendWaitRemaining(codeSentAt: sentAt, now: sentAt),
            60
        )
        XCTAssertEqual(
            AuthVerificationRules.resendWaitRemaining(
                codeSentAt: sentAt,
                now: sentAt.addingTimeInterval(30)
            ),
            30
        )
        XCTAssertEqual(
            AuthVerificationRules.resendWaitRemaining(
                codeSentAt: sentAt,
                now: sentAt.addingTimeInterval(59.2)
            ),
            1
        )
        XCTAssertEqual(
            AuthVerificationRules.resendWaitRemaining(
                codeSentAt: sentAt,
                now: sentAt.addingTimeInterval(60)
            ),
            0
        )
        // A send stamped in the future can only mean the device clock moved; the whole wait applies
        // rather than a difference that would let the button be tapped immediately.
        XCTAssertEqual(
            AuthVerificationRules.resendWaitRemaining(
                codeSentAt: sentAt,
                now: sentAt.addingTimeInterval(-3_600)
            ),
            60
        )
    }

    func testAnotherCodeCannotBeAskedForDuringTheWaitOrWhileWorkIsInFlight() {
        XCTAssertFalse(
            AuthVerificationRules.canResend(
                codeSentAt: sentAt,
                now: sentAt.addingTimeInterval(1),
                isSubmitting: false,
                isResending: false
            )
        )
        XCTAssertTrue(
            AuthVerificationRules.canResend(
                codeSentAt: sentAt,
                now: sentAt.addingTimeInterval(60),
                isSubmitting: false,
                isResending: false
            )
        )
        XCTAssertFalse(
            AuthVerificationRules.canResend(
                codeSentAt: sentAt,
                now: sentAt.addingTimeInterval(600),
                isSubmitting: true,
                isResending: false
            )
        )
        XCTAssertFalse(
            AuthVerificationRules.canResend(
                codeSentAt: sentAt,
                now: sentAt.addingTimeInterval(600),
                isSubmitting: false,
                isResending: true
            )
        )
    }

    func testTheResendControlSaysWhyItIsUnavailable() {
        XCTAssertEqual(AuthVerificationRules.resendTitle(waitRemaining: 0), "Send a new code")
        XCTAssertEqual(AuthVerificationRules.resendTitle(waitRemaining: 45), "Send a new code in 45s")
        XCTAssertEqual(
            AuthVerificationRules.codeSentConfirmation,
            "A new code is on its way. It can take a minute to arrive."
        )
    }

    func testARefusedCodeSaysWhatHappenedAndWhatToDoAboutIt() {
        let refused = APIClientError.http(
            status: 401,
            code: .unauthorized,
            requestId: "r1",
            retryAfterSeconds: nil
        )
        XCTAssertEqual(
            AuthVerificationRules.verificationMessage(for: refused),
            "That code is wrong or has expired. Ask for a new one."
        )
        let malformed = APIClientError.http(
            status: 400,
            code: .validationFailed,
            requestId: nil,
            retryAfterSeconds: nil
        )
        XCTAssertEqual(
            AuthVerificationRules.verificationMessage(for: malformed),
            "Enter the six digits from the email."
        )
        let limited = APIClientError.http(
            status: 429,
            code: .rateLimited,
            requestId: nil,
            retryAfterSeconds: 60
        )
        XCTAssertEqual(
            AuthVerificationRules.verificationMessage(for: limited),
            "Too many attempts. Wait a few minutes and try again."
        )
        let outage = APIClientError.http(
            status: 503,
            code: .providerUnavailable,
            requestId: nil,
            retryAfterSeconds: nil
        )
        XCTAssertEqual(
            AuthVerificationRules.verificationMessage(for: outage),
            "Unfiled is temporarily unavailable. Try again shortly."
        )
        let unnamedOutage = APIClientError.http(
            status: 500,
            code: nil,
            requestId: nil,
            retryAfterSeconds: nil
        )
        XCTAssertEqual(
            AuthVerificationRules.verificationMessage(for: unnamedOutage),
            "Unfiled is temporarily unavailable. Try again shortly."
        )
        let unknown = APIClientError.http(
            status: 404,
            code: .notFound,
            requestId: nil,
            retryAfterSeconds: nil
        )
        XCTAssertEqual(
            AuthVerificationRules.verificationMessage(for: unknown),
            "The code could not be checked. Try again."
        )
        XCTAssertEqual(
            AuthVerificationRules.verificationMessage(for: APIClientError.transportFailure),
            "The service could not be reached."
        )
    }

    func testARefusedResendPointsAtTheCodeAlreadySentRatherThanStartingOver() {
        let limited = APIClientError.http(
            status: 429,
            code: .rateLimited,
            requestId: nil,
            retryAfterSeconds: 120
        )
        XCTAssertEqual(
            AuthVerificationRules.resendMessage(for: limited),
            "Too many requests for a new code. Wait a few minutes and try the code you have."
        )
        let outage = APIClientError.http(
            status: 502,
            code: nil,
            requestId: nil,
            retryAfterSeconds: nil
        )
        XCTAssertEqual(
            AuthVerificationRules.resendMessage(for: outage),
            "Unfiled is temporarily unavailable. Try again shortly."
        )
        let unknown = APIClientError.http(
            status: 404,
            code: .notFound,
            requestId: nil,
            retryAfterSeconds: nil
        )
        XCTAssertEqual(
            AuthVerificationRules.resendMessage(for: unknown),
            "A new code could not be sent. Try again."
        )
    }

    func testTheVerificationScreenIdentifiersAreDistinctFromTheCredentialsScreen() {
        let identifiers = [
            AuthAccessibilityIdentifier.emailScreen,
            AuthAccessibilityIdentifier.emailField,
            AuthAccessibilityIdentifier.emailError,
            AuthAccessibilityIdentifier.emailSubmit,
            AuthAccessibilityIdentifier.passwordField,
            AuthAccessibilityIdentifier.modeToggle,
            AuthAccessibilityIdentifier.verifyScreen,
            AuthAccessibilityIdentifier.verifyField,
            AuthAccessibilityIdentifier.verifyError,
            AuthAccessibilityIdentifier.verifyNotice,
            AuthAccessibilityIdentifier.verifySubmit,
            AuthAccessibilityIdentifier.verifyResend,
            AuthAccessibilityIdentifier.verifyCancel
        ]

        XCTAssertEqual(Set(identifiers).count, identifiers.count)
    }
}

/// A code entry in progress must outlive the app being backgrounded or relaunched, and must never
/// leave the owner on a screen the app can no longer explain.
final class PendingVerificationStoreTests: XCTestCase {
    private let sentAt = Date(timeIntervalSince1970: 1_800_000_000)
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUpWithError() throws {
        try super.setUpWithError()
        suiteName = "pending-verification-tests-\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    }

    override func tearDownWithError() throws {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        try super.tearDownWithError()
    }

    private func makeStore() -> PendingVerificationStore {
        PendingVerificationStore(defaults: defaults, key: "pending.test")
    }

    func testAPendingEntryComesBackAfterARelaunch() {
        let store = makeStore()
        XCTAssertNil(store.load(now: sentAt))

        let pending = PendingVerification(email: "person@example.com", codeSentAt: sentAt)
        XCTAssertTrue(store.save(pending))

        // A separate instance is what the next launch builds; the value must come from defaults.
        XCTAssertEqual(makeStore().load(now: sentAt.addingTimeInterval(90)), pending)
    }

    func testTheRemainingWaitIsMeasuredFromTheStoredSendNotFromTheRelaunch() {
        let store = makeStore()
        store.save(PendingVerification(email: "person@example.com", codeSentAt: sentAt))
        let restored = makeStore().load(now: sentAt.addingTimeInterval(20))

        XCTAssertEqual(
            AuthVerificationRules.resendWaitRemaining(
                codeSentAt: restored?.codeSentAt,
                now: sentAt.addingTimeInterval(20)
            ),
            40
        )
    }

    func testAnotherCodeReplacesTheStampWithoutChangingTheAddress() {
        let pending = PendingVerification(email: "person@example.com", codeSentAt: sentAt)
        let resent = pending.sending(at: sentAt.addingTimeInterval(120))

        XCTAssertEqual(resent.email, pending.email)
        XCTAssertEqual(resent.codeSentAt, sentAt.addingTimeInterval(120))
        XCTAssertEqual(pending.codeSentAt, sentAt, "the earlier value is not mutated")
    }

    func testAnEntryOlderThanADayIsDroppedRatherThanReopened() {
        let store = makeStore()
        store.save(PendingVerification(email: "person@example.com", codeSentAt: sentAt))

        XCTAssertNil(store.load(now: sentAt.addingTimeInterval(PendingVerification.lifetime)))
        XCTAssertNil(defaults.data(forKey: "pending.test"), "a dead entry is cleared, not kept")
    }

    func testAnEntryTheAppCannotReadIsClearedInsteadOfStranding() {
        defaults.set(Data("not json".utf8), forKey: "pending.test")

        XCTAssertNil(makeStore().load(now: sentAt))
        XCTAssertNil(defaults.data(forKey: "pending.test"))
    }

    func testAnEntryWhoseAddressIsNotTheServiceFormIsRefused() {
        // Stamped at exactly `sentAt`, so only the address can be what this entry is refused for.
        let stamp = APIJSON.dateString(sentAt)
        XCTAssertEqual(stamp, "2027-01-15T08:00:00.000Z")
        defaults.set(
            Data(#"{"email":"Person@Example.com","codeSentAt":"\#(stamp)"}"#.utf8),
            forKey: "pending.test"
        )

        XCTAssertNil(makeStore().load(now: sentAt))
        XCTAssertNil(defaults.data(forKey: "pending.test"))
    }

    func testClearingLeavesNothingToRestore() {
        let store = makeStore()
        store.save(PendingVerification(email: "person@example.com", codeSentAt: sentAt))
        store.clear()

        XCTAssertNil(makeStore().load(now: sentAt))
    }
}
