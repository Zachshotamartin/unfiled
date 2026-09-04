import Foundation
import XCTest
@testable import Unfiled

final class LocalDatabaseTests: XCTestCase {
    private let profileA = "11111111-1111-4111-8111-111111111111"
    private let profileB = "22222222-2222-4222-8222-222222222222"
    private let timestamp = "2026-08-31T12:00:00.000Z"

    func testSQLCipherRoundTripAndFilesDoNotContainPlaintext() async throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let marker = "plaintext-marker-f6a5f3d2-shopping-oat-milk"
        let database = try LocalDatabase.open(
            bundleIdentifier: "com.unfiled.tests.encryption",
            keyProvider: FixedDatabaseKeyProvider(byte: 0x11),
            directoryURL: directory
        )

        try await database.enqueue(
            capture(id: "cap_01ARZ3NDEKTSV4RRFFQ69G5FAV", profileID: profileA, content: marker),
            now: timestamp
        )
        let composerSession = try await database.beginComposerDraftSession(
            profileID: profileA,
            source: .mobile
        )
        let savedDraft = try await database.saveComposerDraft(
            ComposerDraft(
                profileID: profileA,
                source: .mobile,
                rawContent: "draft-\(marker)",
                privacy: .privateManual,
                updatedAt: timestamp
            ),
            generation: composerSession.generation
        )
        XCTAssertTrue(savedDraft)

        let entries = try await database.outboxEntries(profileID: profileA)
        XCTAssertEqual(entries.map(\.draft.rawContent), [marker])
        let draft = try await database.composerDraft(
            profileID: profileA,
            source: .mobile
        )
        XCTAssertEqual(draft?.rawContent, "draft-\(marker)")

        let storedFiles = try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil
        ).filter { $0.lastPathComponent.hasPrefix("unfiled-private.sqlite") }
        XCTAssertFalse(storedFiles.isEmpty)
        let markerData = Data(marker.utf8)
        let sqliteHeader = Data("SQLite format 3\0".utf8)
#if !targetEnvironment(simulator)
        let directoryAttributes = try FileManager.default.attributesOfItem(atPath: directory.path)
        XCTAssertEqual(
            directoryAttributes[.protectionKey] as? FileProtectionType,
            .complete
        )
#endif
        for file in storedFiles {
            let bytes = try Data(contentsOf: file)
            XCTAssertNil(bytes.range(of: markerData), "Plaintext leaked into \(file.lastPathComponent)")
#if !targetEnvironment(simulator)
            let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
            XCTAssertEqual(
                attributes[.protectionKey] as? FileProtectionType,
                .complete,
                "Protected database sidecars must inherit complete file protection"
            )
#endif
            if file.pathExtension == "sqlite" {
                XCTAssertGreaterThan(bytes.count, 16)
                XCTAssertFalse(bytes.starts(with: sqliteHeader), "Database has an unencrypted SQLite header")
            }
        }
    }

    func testWrongKeyCannotOpenExistingDatabase() async throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        try await createEncryptedStore(in: directory, keyByte: 0x21)

        XCTAssertThrowsError(
            try LocalDatabase.open(
                bundleIdentifier: "com.unfiled.tests.wrong-key",
                keyProvider: FixedDatabaseKeyProvider(byte: 0x22),
                directoryURL: directory
            )
        )
    }

    func testCaptureAndComposerBoundsUseServerUTF16Units() async throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let database = try LocalDatabase.open(
            bundleIdentifier: "com.unfiled.tests.utf16-bounds",
            keyProvider: FixedDatabaseKeyProvider(byte: 0x2A),
            directoryURL: directory
        )
        let emoji = "\u{1F642}"
        let exactBoundary = String(repeating: emoji, count: 5_000)
        let overBoundary = String(repeating: emoji, count: 5_001)
        XCTAssertEqual(exactBoundary.utf16.count, 10_000)
        XCTAssertEqual(overBoundary.utf16.count, 10_002)

        try await database.enqueue(
            capture(
                id: "cap_01ARZ3NDEKTSV4RRFFQ69G5FAV",
                profileID: profileA,
                content: exactBoundary
            ),
            now: timestamp
        )
        do {
            try await database.enqueue(
                capture(
                    id: "cap_01BX5ZZKBKACTAV9WEVGEMMVRZ",
                    profileID: profileA,
                    content: overBoundary
                ),
                now: timestamp
            )
            XCTFail("A capture over the server's UTF-16 limit must not be persisted")
        } catch {
            XCTAssertEqual(error as? LocalDatabaseError, .invalidCapture)
        }
        let entries = try await database.outboxEntries(profileID: profileA)
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries.first?.draft.rawContent, exactBoundary)

        let session = try await database.beginComposerDraftSession(
            profileID: profileA,
            source: .mobile
        )
        let exactSaved = try await database.saveComposerDraft(
            ComposerDraft(
                profileID: profileA,
                source: .mobile,
                rawContent: exactBoundary,
                privacy: .privateManual,
                updatedAt: timestamp
            ),
            generation: session.generation
        )
        XCTAssertTrue(exactSaved)
        do {
            _ = try await database.saveComposerDraft(
                ComposerDraft(
                    profileID: profileA,
                    source: .mobile,
                    rawContent: overBoundary,
                    privacy: .privateManual,
                    updatedAt: timestamp
                ),
                generation: session.generation
            )
            XCTFail("An oversized composer draft must not replace the valid protected draft")
        } catch {
            XCTAssertEqual(error as? LocalDatabaseError, .invalidCapture)
        }
        let restored = try await database.composerDraft(
            profileID: profileA,
            source: .mobile
        )
        XCTAssertEqual(restored?.rawContent, exactBoundary)
    }

    func testProfilesAreIsolatedAndRemovalIsScoped() async throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let database = try LocalDatabase.open(
            bundleIdentifier: "com.unfiled.tests.isolation",
            keyProvider: FixedDatabaseKeyProvider(byte: 0x31),
            directoryURL: directory
        )
        try await database.enqueue(
            capture(id: "cap_01ARZ3NDEKTSV4RRFFQ69G5FAV", profileID: profileA, content: "alpha"),
            now: timestamp
        )
        try await database.enqueue(
            capture(id: "cap_01BX5ZZKBKACTAV9WEVGEMMVRZ", profileID: profileB, content: "bravo"),
            now: timestamp
        )
        try await database.cacheNote(
            CachedNote(
                id: "note_01ARZ3NDEKTSV4RRFFQ69G5FAV",
                profileID: profileB,
                currentRevision: 1,
                payload: Data("encrypted-payload-input".utf8),
                cachedAt: timestamp
            )
        )

        let profileAEntries = try await database.outboxEntries(profileID: profileA)
        let profileBEntries = try await database.outboxEntries(profileID: profileB)
        XCTAssertEqual(profileAEntries.map(\.draft.rawContent), ["alpha"])
        XCTAssertEqual(profileBEntries.map(\.draft.rawContent), ["bravo"])

        try await database.removeProfile(profileID: profileA)

        let removedProfileEntries = try await database.outboxEntries(profileID: profileA)
        let remainingProfileEntries = try await database.outboxEntries(profileID: profileB)
        let remainingProfileNotes = try await database.cachedNotes(profileID: profileB)
        XCTAssertTrue(removedProfileEntries.isEmpty)
        XCTAssertEqual(remainingProfileEntries.map(\.draft.rawContent), ["bravo"])
        XCTAssertEqual(remainingProfileNotes.count, 1)
    }

    func testCachedNotePruningUsesAuthoritativeIDsAndRemainsProfileScoped() async throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let database = try LocalDatabase.open(
            bundleIdentifier: "com.unfiled.tests.note-cache-pruning",
            keyProvider: FixedDatabaseKeyProvider(byte: 0x32),
            directoryURL: directory
        )
        let removed = "note_01ARZ3NDEKTSV4RRFFQ69G5FAV"
        let retained = "note_01BX5ZZKBKACTAV9WEVGEMMVRZ"

        for noteID in [removed, retained] {
            try await database.cacheNote(
                CachedNote(
                    id: noteID,
                    profileID: profileA,
                    currentRevision: 1,
                    payload: Data("profile-a-\(noteID)".utf8),
                    cachedAt: timestamp
                )
            )
        }
        try await database.cacheNote(
            CachedNote(
                id: removed,
                profileID: profileB,
                currentRevision: 1,
                payload: Data("profile-b-retained".utf8),
                cachedAt: timestamp
            )
        )

        try await database.pruneCachedNotes(profileID: profileA, retaining: [retained])

        let profileANotes = try await database.cachedNotes(profileID: profileA)
        let profileBNotes = try await database.cachedNotes(profileID: profileB)
        XCTAssertEqual(profileANotes.map(\.id), [retained])
        XCTAssertEqual(profileBNotes.map(\.id), [removed])
    }

    func testLeaseMustMatchBeforeStateTransition() async throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let database = try LocalDatabase.open(
            bundleIdentifier: "com.unfiled.tests.leases",
            keyProvider: FixedDatabaseKeyProvider(byte: 0x41),
            directoryURL: directory
        )
        let captureID = "cap_01ARZ3NDEKTSV4RRFFQ69G5FAV"
        try await database.enqueue(
            capture(id: captureID, profileID: profileA, content: "lease me"),
            now: timestamp
        )
        let leaseToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        let claimed = try await database.claimNext(
            profileID: profileA,
            now: timestamp,
            leaseExpiresAt: "2026-08-31T12:01:00.000Z",
            leaseToken: leaseToken
        )
        XCTAssertEqual(claimed?.state, .leased)

        do {
            try await database.markSynced(
                profileID: profileA,
                captureID: captureID,
                leaseToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                acknowledgement: CaptureSyncAcknowledgement(
                    captureID: captureID,
                    jobID: "job_01ARZ3NDEKTSV4RRFFQ69G5FAV",
                    acknowledgedAt: timestamp
                ),
                now: timestamp
            )
            XCTFail("A mismatched lease token must not mutate the outbox row")
        } catch {
            XCTAssertEqual(error as? LocalDatabaseError, .invalidStateTransition)
        }
        let entries = try await database.outboxEntries(profileID: profileA)
        XCTAssertEqual(entries.first?.state, .leased)
    }

    func testAtomicEnqueueDeletesDraftAndRejectsStaleAutosaveResurrection() async throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let database = try LocalDatabase.open(
            bundleIdentifier: "com.unfiled.tests.atomic-capture",
            keyProvider: FixedDatabaseKeyProvider(byte: 0x51),
            directoryURL: directory
        )
        let session = try await database.beginComposerDraftSession(
            profileID: profileA,
            source: .mobile
        )
        let composerDraft = ComposerDraft(
            profileID: profileA,
            source: .mobile,
            rawContent: "single durable capture",
            privacy: .aiAssisted,
            updatedAt: timestamp
        )
        let initiallySaved = try await database.saveComposerDraft(
            composerDraft,
            generation: session.generation
        )
        XCTAssertTrue(initiallySaved)

        let durableCapture = capture(
            id: "cap_01BX5ZZKBKACTAV9WEVGEMMVRZ",
            profileID: profileA,
            content: composerDraft.rawContent
        )
        try await database.enqueue(
            durableCapture,
            removingComposerDraftFor: .mobile,
            composerGeneration: session.generation,
            now: timestamp
        )

        let stored = try await database.outboxEntries(profileID: profileA)
        XCTAssertEqual(stored.map(\.draft.id), [durableCapture.id])
        let draftAfterEnqueue = try await database.composerDraft(
            profileID: profileA,
            source: .mobile
        )
        XCTAssertNil(draftAfterEnqueue)
        let staleSaveAccepted = try await database.saveComposerDraft(
            composerDraft,
            generation: session.generation
        )
        XCTAssertFalse(
            staleSaveAccepted,
            "A delayed autosave from the submitted composer must be ignored"
        )
        let draftAfterStaleSave = try await database.composerDraft(
            profileID: profileA,
            source: .mobile
        )
        XCTAssertNil(draftAfterStaleSave)
    }

    func testAtomicEnqueueRollsBackWhenComposerGenerationDoesNotMatch() async throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let database = try LocalDatabase.open(
            bundleIdentifier: "com.unfiled.tests.atomic-rollback",
            keyProvider: FixedDatabaseKeyProvider(byte: 0x61),
            directoryURL: directory
        )
        let session = try await database.beginComposerDraftSession(
            profileID: profileA,
            source: .mobile
        )
        do {
            try await database.enqueue(
                capture(
                    id: "cap_01BX5ZZKBKACTAV9WEVGEMMVRZ",
                    profileID: profileA,
                    content: "must roll back"
                ),
                removingComposerDraftFor: .mobile,
                composerGeneration: session.generation + 1,
                now: timestamp
            )
            XCTFail("A stale or forged composer generation must fail the transaction")
        } catch {
            XCTAssertEqual(error as? LocalDatabaseError, .invalidStateTransition)
        }
        let entries = try await database.outboxEntries(profileID: profileA)
        XCTAssertTrue(entries.isEmpty)
    }

    func testAtomicEnqueueRollsBackDraftDeletionOnCaptureConflict() async throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let database = try LocalDatabase.open(
            bundleIdentifier: "com.unfiled.tests.composer-rollback",
            keyProvider: FixedDatabaseKeyProvider(byte: 0x52),
            directoryURL: directory
        )
        let captureID = "cap_01ARZ3NDEKTSV4RRFFQ69G5FAV"
        try await database.enqueue(
            capture(id: captureID, profileID: profileA, content: "existing payload"),
            now: timestamp
        )
        let session = try await database.beginComposerDraftSession(
            profileID: profileA,
            source: .mobile
        )
        let protectedDraft = ComposerDraft(
            profileID: profileA,
            source: .mobile,
            rawContent: "do not delete this draft",
            privacy: .privateManual,
            updatedAt: timestamp
        )
        let initiallySaved = try await database.saveComposerDraft(
            protectedDraft,
            generation: session.generation
        )
        XCTAssertTrue(initiallySaved)

        do {
            try await database.enqueue(
                capture(id: captureID, profileID: profileA, content: "conflicting payload"),
                removingComposerDraftFor: .mobile,
                composerGeneration: session.generation,
                now: timestamp
            )
            XCTFail("A conflicting idempotency key must roll back the whole composer transaction")
        } catch {
            XCTAssertEqual(error as? LocalDatabaseError, .invalidStateTransition)
        }

        let retainedDraft = try await database.composerDraft(
            profileID: profileA,
            source: .mobile
        )
        XCTAssertEqual(retainedDraft, protectedDraft)
        let generationStillUsable = try await database.saveComposerDraft(
            protectedDraft,
            generation: session.generation
        )
        XCTAssertTrue(
            generationStillUsable,
            "A rolled-back enqueue must leave the composer generation usable"
        )
    }

    func testAutomaticAttemptsCapAndExplicitRetryStartsANewBoundedCycle() async throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let database = try LocalDatabase.open(
            bundleIdentifier: "com.unfiled.tests.retry-cap",
            keyProvider: FixedDatabaseKeyProvider(byte: 0x53),
            directoryURL: directory
        )
        let captureID = "cap_01ARZ3NDEKTSV4RRFFQ69G5FAV"
        try await database.enqueue(
            capture(id: captureID, profileID: profileA, content: "retry safely"),
            now: timestamp
        )

        for attempt in 1 ... 3 {
            let leaseToken = UUID().uuidString.lowercased()
            let claimed = try await database.claimNext(
                profileID: profileA,
                now: timestamp,
                leaseExpiresAt: "2026-08-31T12:01:00.000Z",
                leaseToken: leaseToken,
                maximumAttempts: 3
            )
            XCTAssertEqual(claimed?.attemptCount, attempt)
            let state = try await database.markRetry(
                profileID: profileA,
                captureID: captureID,
                leaseToken: leaseToken,
                errorCode: "network_unavailable",
                nextAttemptAt: timestamp,
                now: timestamp,
                maximumAttempts: 3
            )
            XCTAssertEqual(state, attempt == 3 ? .failed : .retry)
        }

        let claimAfterCap = try await database.claimNext(
            profileID: profileA,
            now: timestamp,
            leaseExpiresAt: "2026-08-31T12:01:00.000Z",
            leaseToken: UUID().uuidString.lowercased(),
            maximumAttempts: 3
        )
        XCTAssertNil(claimAfterCap)
        var entries = try await database.outboxEntries(profileID: profileA)
        var entry = try XCTUnwrap(entries.first)
        XCTAssertEqual(entry.state, .failed)
        XCTAssertEqual(entry.attemptCount, 3)
        XCTAssertEqual(entry.lastErrorCode, "retry_limit_reached")
        XCTAssertTrue(PresentationMapping.receipt(entry).retryable)

        try await database.retryFailed(profileID: profileA, captureID: captureID, now: timestamp)
        entries = try await database.outboxEntries(profileID: profileA)
        entry = try XCTUnwrap(entries.first)
        XCTAssertEqual(entry.state, .retry)
        XCTAssertEqual(entry.attemptCount, 0)
        let manualRetryClaim = try await database.claimNext(
            profileID: profileA,
            now: timestamp,
            leaseExpiresAt: "2026-08-31T12:01:00.000Z",
            leaseToken: UUID().uuidString.lowercased(),
            maximumAttempts: 3
        )
        XCTAssertNotNil(manualRetryClaim)
    }

    private func createEncryptedStore(in directory: URL, keyByte: UInt8) async throws {
        let database = try LocalDatabase.open(
            bundleIdentifier: "com.unfiled.tests.seed",
            keyProvider: FixedDatabaseKeyProvider(byte: keyByte),
            directoryURL: directory
        )
        try await database.enqueue(
            capture(
                id: "cap_01ARZ3NDEKTSV4RRFFQ69G5FAV",
                profileID: profileA,
                content: "wrong-key-sentinel"
            ),
            now: timestamp
        )
    }

    private func capture(id: String, profileID: String, content: String) -> CaptureDraft {
        CaptureDraft(
            id: id,
            profileID: profileID,
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
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "unfiled-local-database-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
}

private struct FixedDatabaseKeyProvider: DatabaseKeyProviding {
    let key: Data

    init(byte: UInt8) {
        key = Data(repeating: byte, count: 32)
    }

    func loadOrCreateKey() throws -> Data { key }
}

final class CaptureSyncEngineTests: XCTestCase {
    private let profileID = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
    private let timestamp = "2026-08-31T12:00:00.000Z"
    private let captureID = "cap_01ARZ3NDEKTSV4RRFFQ69G5FAV"

    override func setUp() {
        super.setUp()
        APIURLProtocolStub.reset()
    }

    override func tearDown() {
        APIURLProtocolStub.reset()
        super.tearDown()
    }

    func testAccountSwitchAfterClaimStopsBeforePlaintextSubmission() async throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let database = try LocalDatabase.open(
            bundleIdentifier: "com.unfiled.tests.sync-account-boundary",
            keyProvider: FixedDatabaseKeyProvider(byte: 0x61),
            directoryURL: directory
        )
        try await database.enqueue(capture(content: "profile A private plaintext"), now: timestamp)

        let requests = LockedRequestRecorder()
        APIURLProtocolStub.install { request in
            requests.record(request)
            throw URLError(.cannotConnectToHost)
        }
        let engine = CaptureSyncEngine(
            database: database,
            api: try makeStubbedAPIClient(),
            profileAuthorizer: SequencedCaptureProfileAuthorizer(
                profileID: profileID,
                decisions: [true, true, true, false]
            ),
            retryPollInterval: .seconds(60)
        )

        await engine.activate(profileID: profileID)
        await engine.deactivate(profileID: profileID)

        let entries = try await database.outboxEntries(
            profileID: profileID.uuidString.lowercased()
        )
        let entry = try XCTUnwrap(entries.first)
        XCTAssertEqual(entry.state, .waitingForSignIn)
        XCTAssertEqual(entry.attemptCount, 1)
        XCTAssertEqual(requests.count, 0, "Profile A plaintext must never use profile B's session")
    }

    func testActiveRetrySchedulerResubmitsAfterConnectivityReturns() async throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let database = try LocalDatabase.open(
            bundleIdentifier: "com.unfiled.tests.sync-scheduler",
            keyProvider: FixedDatabaseKeyProvider(byte: 0x62),
            directoryURL: directory
        )
        try await database.enqueue(capture(content: "eventually sync me"), now: timestamp)

        let requests = LockedRequestRecorder()
        APIURLProtocolStub.install { [captureID, timestamp] request in
            requests.record(request)
            if requests.count == 1 {
                throw URLError(.notConnectedToInternet)
            }
            return apiResponse(
                for: request,
                status: 201,
                json: """
                {
                  "capture": {
                    "id": "\(captureID)",
                    "rawContent": "eventually sync me",
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
                """
            )
        }
        let engine = CaptureSyncEngine(
            database: database,
            api: try makeStubbedAPIClient(),
            profileAuthorizer: StaticCaptureProfileAuthorizer(
                profileID: profileID,
                token: "profile-a-token"
            ),
            retryPollInterval: .milliseconds(10),
            retryDelay: { _ in 0.05 }
        )

        await engine.activate(profileID: profileID)
        var entry: CaptureOutboxEntry?
        for _ in 0 ..< 50 {
            entry = try await database.outboxEntries(
                profileID: profileID.uuidString.lowercased()
            ).first
            if entry?.state == .synced { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        await engine.deactivate(profileID: profileID)

        XCTAssertEqual(entry?.state, .synced)
        // One attempt, not two: the first send failed because the phone had no connection, which
        // says nothing about the capture and must not spend one of the owner's five attempts.
        XCTAssertEqual(entry?.attemptCount, 1)
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests.authorizationHeaders, [
            "Bearer profile-a-token",
            "Bearer profile-a-token"
        ])
    }

    func testCaptureStaysRetryableWhileThePhoneHasNoConnection() async throws {
        // A phone offline for a while used to burn all five attempts on the backoff schedule and
        // park the capture in failed, where only a manual Retry could reach it. Being offline is
        // not the capture's fault, so it stays retryable however long the outage lasts.
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let database = try LocalDatabase.open(
            bundleIdentifier: "com.unfiled.tests.sync-offline",
            keyProvider: FixedDatabaseKeyProvider(byte: 0x63),
            directoryURL: directory
        )
        try await database.enqueue(capture(content: "wait for signal"), now: timestamp)

        let requests = LockedRequestRecorder()
        APIURLProtocolStub.install { request in
            requests.record(request)
            throw URLError(.notConnectedToInternet)
        }
        let engine = CaptureSyncEngine(
            database: database,
            api: try makeStubbedAPIClient(),
            profileAuthorizer: StaticCaptureProfileAuthorizer(
                profileID: profileID,
                token: "profile-a-token"
            ),
            retryPollInterval: .milliseconds(10),
            retryDelay: { _ in 0.01 }
        )

        await engine.activate(profileID: profileID)
        for _ in 0 ..< 40 {
            if requests.count > LocalDatabase.maximumAutomaticCaptureAttempts + 2 { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        await engine.deactivate(profileID: profileID)

        let entry = try await database.outboxEntries(
            profileID: profileID.uuidString.lowercased()
        ).first
        XCTAssertGreaterThan(requests.count, LocalDatabase.maximumAutomaticCaptureAttempts)
        XCTAssertNotEqual(entry?.state, .failed)
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
            path: "unfiled-capture-sync-tests-\(UUID().uuidString)",
            directoryHint: .isDirectory
        )
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
}

private struct StaticCaptureProfileAuthorizer: CaptureProfileAuthorizing {
    let profileID: UUID
    let token: String

    func authorizesCaptureProfile(_ profileID: UUID) async -> Bool {
        self.profileID == profileID
    }

    func captureAccessToken(for profileID: UUID) async throws -> String {
        guard self.profileID == profileID else { throw AuthenticationError.signedOut }
        return token
    }

    func refreshCaptureAccessToken(
        for profileID: UUID,
        rejectedToken _: String
    ) async throws -> String {
        guard self.profileID == profileID else { throw AuthenticationError.signedOut }
        return token
    }
}

private actor SequencedCaptureProfileAuthorizer: CaptureProfileAuthorizing {
    let profileID: UUID
    private var decisions: [Bool]

    init(profileID: UUID, decisions: [Bool]) {
        self.profileID = profileID
        self.decisions = decisions
    }

    func authorizesCaptureProfile(_ profileID: UUID) -> Bool {
        guard self.profileID == profileID, !decisions.isEmpty else { return false }
        return decisions.removeFirst()
    }

    func captureAccessToken(for _: UUID) throws -> String {
        throw AuthenticationError.signedOut
    }

    func refreshCaptureAccessToken(for _: UUID, rejectedToken _: String) throws -> String {
        throw AuthenticationError.signedOut
    }
}

private final class LockedRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [URLRequest] = []

    var count: Int { lock.withLock { requests.count } }
    var authorizationHeaders: [String] {
        lock.withLock { requests.compactMap { $0.value(forHTTPHeaderField: "Authorization") } }
    }

    func record(_ request: URLRequest) {
        lock.withLock { requests.append(request) }
    }
}
