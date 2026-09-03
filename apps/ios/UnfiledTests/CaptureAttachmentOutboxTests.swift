import Foundation
import XCTest
@testable import Unfiled

/// Photos and recordings wait in the encrypted outbox beside their capture, upload before it,
/// and travel to the capture request only as identifiers.
final class CaptureAttachmentOutboxTests: XCTestCase {
    private let profileID = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
    private let timestamp = "2026-09-03T12:00:00.000Z"
    private let captureID = "cap_01ARZ3NDEKTSV4RRFFQ69G5FAV"
    private let photoID = "att_01ARZ3NDEKTSV4RRFFQ69G5FAZ"
    private let recordingID = "att_01ARZ3NDEKTSV4RRFFQ69G5FAY"

    override func setUp() {
        super.setUp()
        APIURLProtocolStub.reset()
    }

    override func tearDown() {
        APIURLProtocolStub.reset()
        super.tearDown()
    }

    func testStoresAttachmentBytesBesideTheCaptureAndRemovesThemWithTheProfile() async throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let database = try LocalDatabase.open(
            bundleIdentifier: "com.unfiled.tests.attachments",
            keyProvider: ConstantDatabaseKeyProvider(byte: 0x71),
            directoryURL: directory
        )
        let photo = photoDraft()
        let recording = CaptureAttachmentDraft(
            id: recordingID, kind: .audio, mediaType: "audio/mp4",
            bytes: Data([0, 0, 0, 24, 102, 116, 121, 112]), width: nil, height: nil, durationMs: 4200
        )

        try await database.enqueue(capture(content: "Photo"), attachments: [photo, recording], now: timestamp)

        let profile = profileID.uuidString.lowercased()
        let stored = try await database.attachments(profileID: profile, captureID: captureID)
        XCTAssertEqual(stored.map { $0.draft }, [photo, recording])
        XCTAssertEqual(stored.map { $0.uploadedAt }, [nil, nil])

        try await database.markAttachmentUploaded(profileID: profile, attachmentID: photoID, now: timestamp)
        let afterUpload = try await database.attachments(profileID: profile, captureID: captureID)
        XCTAssertEqual(afterUpload.map { $0.uploadedAt }, [timestamp, nil])

        try await database.removeProfile(profileID: profile)
        let afterRemoval = try await database.attachments(profileID: profile, captureID: captureID)
        XCTAssertEqual(afterRemoval, [])
    }

    func testRefusesAttachmentsAboveTheByteCapOrBeyondTheCounts() async throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let database = try LocalDatabase.open(
            bundleIdentifier: "com.unfiled.tests.attachments-limits",
            keyProvider: ConstantDatabaseKeyProvider(byte: 0x72),
            directoryURL: directory
        )
        let oversized = CaptureAttachmentDraft(
            id: photoID, kind: .image, mediaType: "image/jpeg",
            bytes: Data(count: 700_001), width: 4, height: 3, durationMs: nil
        )
        await assertThrowsAsync(
            try await database.enqueue(capture(content: "Photo"), attachments: [oversized], now: timestamp)
        )
        let five = (0 ..< 5).map { index in
            CaptureAttachmentDraft(
                id: "att_01ARZ3NDEKTSV4RRFFQ69G5FA\(index)", kind: .image, mediaType: "image/jpeg",
                bytes: Data([0xFF, 0xD8]), width: 4, height: 3, durationMs: nil
            )
        }
        await assertThrowsAsync(
            try await database.enqueue(capture(content: "Photos"), attachments: five, now: timestamp)
        )
        let entries = try await database.outboxEntries(profileID: profileID.uuidString.lowercased())
        XCTAssertEqual(entries, [])
    }

    func testUploadsAttachmentsBeforeTheCaptureAndSendsOnlyTheirIdentifiers() async throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let database = try LocalDatabase.open(
            bundleIdentifier: "com.unfiled.tests.attachments-sync",
            keyProvider: ConstantDatabaseKeyProvider(byte: 0x73),
            directoryURL: directory
        )
        let photo = photoDraft()
        try await database.enqueue(capture(content: "Photo"), attachments: [photo], now: timestamp)

        let requests = LockedRequestLog()
        APIURLProtocolStub.install { [captureID, photoID, timestamp] request in
            requests.record(request)
            if request.url?.path == "/api/v1/captures/attachments" {
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "image/jpeg")
                XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), photoID)
                XCTAssertEqual(request.value(forHTTPHeaderField: "X-Unfiled-Capture-Id"), captureID)
                XCTAssertEqual(request.value(forHTTPHeaderField: "X-Unfiled-Privacy"), "private_manual")
                XCTAssertEqual(request.value(forHTTPHeaderField: "X-Unfiled-Width"), "4")
                XCTAssertEqual(request.value(forHTTPHeaderField: "X-Unfiled-Height"), "3")
                XCTAssertEqual(try apiRequestBody(request), photo.bytes)
                return apiResponse(for: request, status: 201, json: """
                {"id":"\(photoID)","kind":"image","mediaType":"image/jpeg","byteLength":4,
                 "width":4,"height":3,"durationMs":null,"createdAt":"\(timestamp)"}
                """)
            }
            XCTAssertEqual(request.url?.path, "/api/v1/captures")
            let body = try JSONSerialization.jsonObject(with: apiRequestBody(request)) as? [String: Any]
            XCTAssertEqual(body?["attachmentIds"] as? [String], [photoID])
            XCTAssertEqual(body?["rawContent"] as? String, "Photo")
            return apiResponse(for: request, status: 201, json: """
            {
              "capture": {
                "id": "\(captureID)",
                "rawContent": "Photo",
                "source": "mobile",
                "deviceId": "test-device",
                "privacy": "private_manual",
                "explicitDestinationNoteId": null,
                "expansionDisabled": true,
                "clientCreatedAt": "\(timestamp)",
                "clientTimezone": "America/Los_Angeles",
                "receivedAt": "\(timestamp)",
                "status": "queued",
                "lastErrorCode": null
              },
              "jobId": "job_01ARZ3NDEKTSV4RRFFQ69G5FAV",
              "replayed": false
            }
            """)
        }
        let engine = CaptureSyncEngine(
            database: database,
            api: try makeStubbedAPIClient(),
            profileAuthorizer: FixedCaptureProfileAuthorizer(profileID: profileID, token: "profile-a-token"),
            retryPollInterval: .milliseconds(10),
            retryDelay: { _ in 0.05 }
        )

        await engine.activate(profileID: profileID)
        var entry: CaptureOutboxEntry?
        for _ in 0 ..< 50 {
            entry = try await database.outboxEntries(profileID: profileID.uuidString.lowercased()).first
            if entry?.state == .synced { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        await engine.deactivate(profileID: profileID)

        XCTAssertEqual(entry?.state, .synced)
        XCTAssertEqual(requests.paths, ["/api/v1/captures/attachments", "/api/v1/captures"])
        let stored = try await database.attachments(
            profileID: profileID.uuidString.lowercased(), captureID: captureID
        )
        XCTAssertEqual(stored.compactMap { $0.uploadedAt }.count, 1)
    }

    private func photoDraft() -> CaptureAttachmentDraft {
        CaptureAttachmentDraft(
            id: photoID, kind: .image, mediaType: "image/jpeg",
            bytes: Data([0xFF, 0xD8, 0xFF, 0xE0]), width: 4, height: 3, durationMs: nil
        )
    }

    private func capture(content: String) -> CaptureDraft {
        CaptureDraft(
            id: captureID,
            profileID: profileID.uuidString.lowercased(),
            rawContent: content,
            source: .mobile,
            deviceID: "test-device",
            clientCreatedAt: timestamp,
            clientTimezone: "America/Los_Angeles",
            privacy: .privateManual,
            explicitDestinationNoteID: nil,
            expansionDisabled: true
        )
    }

    private func makeTemporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appending(
            path: "unfiled-attachments-\(UUID().uuidString)", directoryHint: .isDirectory
        )
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
}

private final class LockedRequestLog: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [URLRequest] = []

    var paths: [String] { lock.withLock { requests.compactMap { $0.url?.path } } }

    func record(_ request: URLRequest) {
        lock.withLock { requests.append(request) }
    }
}

private struct ConstantDatabaseKeyProvider: DatabaseKeyProviding {
    let key: Data

    init(byte: UInt8) {
        key = Data(repeating: byte, count: 32)
    }

    func loadOrCreateKey() throws -> Data { key }
}

private struct FixedCaptureProfileAuthorizer: CaptureProfileAuthorizing {
    let profileID: UUID
    let token: String

    func authorizesCaptureProfile(_ candidate: UUID) async -> Bool { candidate == profileID }

    func captureAccessToken(for candidate: UUID) async throws -> String {
        guard candidate == profileID else { throw CaptureSyncEngineError.invalidProfile }
        return token
    }

    func refreshCaptureAccessToken(for candidate: UUID, rejectedToken _: String) async throws -> String {
        try await captureAccessToken(for: candidate)
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
