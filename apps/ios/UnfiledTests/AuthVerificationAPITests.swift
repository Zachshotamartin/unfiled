import Foundation
import XCTest
@testable import Unfiled

/// A deployment that confirms nothing and one that emails a code are both answered by the same
/// build, so sign-up is read as a union and the two follow-up calls are held to the settled shape.
final class AuthVerificationAPITests: XCTestCase {
    override func tearDown() {
        APIURLProtocolStub.reset()
        super.tearDown()
    }

    func testSignUpReadsASessionAsTheSignedInOutcome() async throws {
        APIURLProtocolStub.install { request in
            XCTAssertEqual(request.url?.path, "/api/v1/auth/sign-up")
            return apiResponse(for: request, status: 200, json: """
            {"accessToken":"access","refreshToken":"refresh","expiresAt":"2030-01-01T00:00:00Z",
             "user":{"id":"00000000-0000-4000-8000-000000000001","email":"person@example.com"}}
            """)
        }
        let outcome = try await makeStubbedAPIClient()
            .signUp(email: "person@example.com", password: "correct horse battery")
        guard case let .session(session) = outcome else {
            return XCTFail("Expected a session, got \(outcome)")
        }
        XCTAssertEqual(session.refreshToken, "refresh")
        XCTAssertEqual(session.user.email, "person@example.com")
    }

    func testSignUpReadsAWithheldSessionAsAConfirmationStep() async throws {
        APIURLProtocolStub.install { request in
            apiResponse(for: request, status: 200, json: """
            {"verificationRequired":true,"email":"person@example.com"}
            """)
        }
        let outcome = try await makeStubbedAPIClient()
            .signUp(email: " Person@Example.COM ", password: "correct horse battery")
        XCTAssertEqual(outcome, .verificationRequired(email: "person@example.com"))
    }

    func testSignUpRefusesAConfirmationStepThatIsNotDiscriminatedOrNormalized() async throws {
        APIURLProtocolStub.install { request in
            apiResponse(for: request, status: 200, json: """
            {"verificationRequired":false,"email":"person@example.com"}
            """)
        }
        await XCTAssertThrowsErrorAsync(
            try await makeStubbedAPIClient()
                .signUp(email: "person@example.com", password: "correct horse battery")
        ) {
            XCTAssertEqual($0 as? APIClientError, .malformedResponse(status: 200))
        }

        APIURLProtocolStub.install { request in
            apiResponse(for: request, status: 200, json: """
            {"verificationRequired":true,"email":"Person@Example.com"}
            """)
        }
        await XCTAssertThrowsErrorAsync(
            try await makeStubbedAPIClient()
                .signUp(email: "person@example.com", password: "correct horse battery")
        ) {
            XCTAssertEqual($0 as? APIClientError, .malformedResponse(status: 200))
        }
    }

    func testSignUpStillRejectsAShortPasswordBeforeTheRequest() async {
        APIURLProtocolStub.install { _ in
            XCTFail("A locally invalid password must never reach the service")
            throw URLError(.badServerResponse)
        }
        await XCTAssertThrowsErrorAsync(
            try await makeStubbedAPIClient().signUp(email: "person@example.com", password: "short")
        ) {
            XCTAssertEqual($0 as? APIClientError, .invalidRequest)
        }
    }

    func testVerifyPostsTheAddressAndCodeAndReadsTheSession() async throws {
        APIURLProtocolStub.install { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/v1/auth/verify")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            let object = try JSONSerialization.jsonObject(with: apiRequestBody(request)) as? [String: String]
            XCTAssertEqual(object?["email"], "person@example.com")
            XCTAssertEqual(object?["code"], "123456")
            return apiResponse(for: request, status: 200, json: """
            {"accessToken":"access","refreshToken":"refresh","expiresAt":"2030-01-01T00:00:00Z",
             "user":{"id":"00000000-0000-4000-8000-000000000001","email":"person@example.com"}}
            """)
        }
        let session = try await makeStubbedAPIClient()
            .verifyEmail(email: " Person@Example.COM ", code: " 123456 ")
        XCTAssertEqual(session.accessToken, "access")
    }

    func testVerifyRefusesACodeThatIsNotSixDigitsWithoutSpendingAnAttempt() async throws {
        APIURLProtocolStub.install { _ in
            XCTFail("An impossible code must never reach the service")
            throw URLError(.badServerResponse)
        }
        let client = try makeStubbedAPIClient()
        for code in ["12345", "1234567", "12a456", "", "١٢٣٤٥٦"] {
            await XCTAssertThrowsErrorAsync(
                try await client.verifyEmail(email: "person@example.com", code: code)
            ) {
                XCTAssertEqual($0 as? APIClientError, .invalidRequest, "code: \(code)")
            }
        }
    }

    func testResendPostsOnlyTheAddressAndRequiresAnAcceptedReply() async throws {
        APIURLProtocolStub.install { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/v1/auth/resend")
            let object = try JSONSerialization.jsonObject(with: apiRequestBody(request)) as? [String: String]
            XCTAssertEqual(object, ["email": "person@example.com"])
            return apiResponse(for: request, status: 200, json: #"{"sent":true}"#)
        }
        try await makeStubbedAPIClient().resendVerification(email: "Person@Example.com")

        APIURLProtocolStub.install { request in
            apiResponse(for: request, status: 200, json: #"{"sent":false}"#)
        }
        await XCTAssertThrowsErrorAsync(
            try await makeStubbedAPIClient().resendVerification(email: "person@example.com")
        ) {
            XCTAssertEqual($0 as? APIClientError, .malformedResponse(status: 200))
        }
    }

    func testAWrongCodeSurfacesTheServiceCodeRatherThanItsMessage() async {
        APIURLProtocolStub.install { request in
            apiResponse(for: request, status: 401, json: """
            {"code":"unauthorized","message":"That code is wrong or has expired.","requestId":"r1"}
            """)
        }
        await XCTAssertThrowsErrorAsync(
            try await makeStubbedAPIClient().verifyEmail(email: "person@example.com", code: "123456")
        ) { error in
            XCTAssertEqual(
                error as? APIClientError,
                .http(status: 401, code: .unauthorized, requestId: "r1", retryAfterSeconds: nil)
            )
        }
    }
}
