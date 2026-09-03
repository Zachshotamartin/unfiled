import Foundation
import XCTest
@testable import Unfiled

/// The API client sends a photo as raw bytes with its description in headers and reads it
/// back only under private, no-store caching.
final class CaptureAttachmentAPITests: XCTestCase {
    private let photoID = "att_01ARZ3NDEKTSV4RRFFQ69G5FAZ"
    private let captureID = "cap_01ARZ3NDEKTSV4RRFFQ69G5FAV"

    override func tearDown() {
        APIURLProtocolStub.reset()
        super.tearDown()
    }

    func testUploadSendsRawBytesWithTheDescriptionInHeaders() async throws {
        let bytes = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])
        APIURLProtocolStub.install { [photoID, captureID] request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/v1/captures/attachments")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "image/jpeg")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), photoID)
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Unfiled-Capture-Id"), captureID)
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Unfiled-Privacy"), "ai_assisted")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Unfiled-Width"), "1568")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Unfiled-Height"), "1044")
            XCTAssertNil(request.value(forHTTPHeaderField: "X-Unfiled-Duration-Ms"))
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-a")
            XCTAssertEqual(try apiRequestBody(request), bytes)
            return apiResponse(for: request, status: 201, json: """
            {"id":"\(photoID)","kind":"image","mediaType":"image/jpeg","byteLength":6,
             "width":1568,"height":1044,"durationMs":null,"createdAt":"2026-09-03T10:00:00.000Z"}
            """)
        }
        let upload = CaptureAttachmentUpload(
            attachmentId: photoID, captureId: captureID, kind: .image, mediaType: "image/jpeg",
            privacy: .aiAssisted, width: 1568, height: 1044, durationMs: nil, bytes: bytes
        )
        let stored = try await makeStubbedAPIClient().uploadCaptureAttachment(upload, accessToken: "token-a")
        XCTAssertEqual(stored.id, photoID)
        XCTAssertEqual(stored.kind, .image)
        XCTAssertEqual(stored.byteLength, 6)
        XCTAssertEqual(stored.width, 1568)
        XCTAssertNil(stored.durationMs)
    }

    func testFetchReturnsBytesOnlyUnderPrivateNoStore() async throws {
        let bytes = Data([0xFF, 0xD8, 0xFF, 0xE0])
        APIURLProtocolStub.install { [photoID] request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/v1/captures/attachments/\(photoID)")
            let response = HTTPURLResponse(
                url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "image/jpeg", "Cache-Control": "private, no-store", "Pragma": "no-cache"]
            )!
            return (response, bytes)
        }
        let provider = APITokenProviderStub()
        let read = try await makeStubbedAPIClient(tokenProvider: provider).captureAttachment(id: photoID)
        XCTAssertEqual(read.bytes, bytes)
        XCTAssertEqual(read.mediaType, "image/jpeg")

        APIURLProtocolStub.install { request in
            let response = HTTPURLResponse(
                url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "image/jpeg"]
            )!
            return (response, bytes)
        }
        await assertThrowsAsync(
            try await makeStubbedAPIClient(tokenProvider: provider).captureAttachment(id: photoID)
        )
        await assertThrowsAsync(
            try await makeStubbedAPIClient(tokenProvider: provider).captureAttachment(id: "nope")
        )
    }
}

private func assertThrowsAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        _ = try await expression()
        XCTFail("Expected the operation to throw", file: file, line: line)
    } catch {}
}
