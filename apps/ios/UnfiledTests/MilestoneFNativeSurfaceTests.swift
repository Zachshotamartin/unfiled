import Foundation
import XCTest
@testable import Unfiled

final class MilestoneFNativeSurfaceTests: XCTestCase {
    override func tearDown() {
        APIURLProtocolStub.reset()
        super.tearDown()
    }

    func testSearchInputUsesServerUTF16LimitWithoutSplittingCharacters() {
        let oversized = String(repeating: "🙂", count: 101)
        let bounded = SearchInputRules.bounded(oversized)

        XCTAssertEqual(bounded, String(repeating: "🙂", count: 100))
        XCTAssertEqual(bounded.utf16.count, SearchInputRules.maximumQueryUTF16Units)
        XCTAssertEqual(
            SearchRequest(query: "  \(oversized)  ", includesArchived: false).query,
            bounded
        )
    }

    /// One search, no scope: exact text across every note, so the request never carries a
    /// privacy filter and the query never reaches the semantic search service.
    func testSearchRequestIsExactTextAcrossEveryNote() throws {
        let lexical = SearchRequest(query: "  Roosevelt method  ", includesArchived: false)
        let lexicalBody = try jsonObject(lexical.apiRequest())

        XCTAssertEqual(Set(lexicalBody.keys), ["query", "archive", "limit"])
        XCTAssertEqual(lexicalBody["query"] as? String, "Roosevelt method")
        XCTAssertEqual(lexicalBody["archive"] as? String, "exclude")
        XCTAssertEqual(lexicalBody["limit"] as? Int, 50)
        XCTAssertNil(lexicalBody["privacy"])

        let archived = SearchRequest(query: "workout progress", includesArchived: true)
        let archivedBody = try jsonObject(archived.apiRequest(cursor: "opaque-page-two", limit: 25))

        XCTAssertEqual(Set(archivedBody.keys), ["query", "archive", "cursor", "limit"])
        XCTAssertEqual(archivedBody["archive"] as? String, "include")
        XCTAssertEqual(archivedBody["cursor"] as? String, "opaque-page-two")
        XCTAssertEqual(archivedBody["limit"] as? Int, 25)
        XCTAssertNil(archivedBody["privacy"])
    }

    func testSearchPaginationMergesExactCursorPagesWithoutDuplicates() throws {
        let request = SearchRequest(query: "training", includesArchived: false)
        let first = try searchPage(indices: [1, 2], nextCursor: "opaque-page-two")
        let second = try searchPage(indices: [3], nextCursor: nil)
        var state = try SearchPaginationState(first: first, request: request, pageLimit: 2)

        try state.append(second, after: "opaque-page-two")

        XCTAssertEqual(state.items.map(\.noteId.rawValue), [noteID(1), noteID(2), noteID(3)])
        XCTAssertEqual(state.pageCount, 2)
        XCTAssertNil(state.nextCursor)
        XCTAssertFalse(state.canLoadMore)
    }

    func testSearchPaginationRejectsDuplicateWrongCursorAndInconsistentPageInfo() throws {
        let request = SearchRequest(query: "training", includesArchived: false)
        let first = try searchPage(indices: [1, 2], nextCursor: "opaque-page-two")
        let duplicate = try searchPage(indices: [2], nextCursor: nil)
        var state = try SearchPaginationState(first: first, request: request, pageLimit: 2)

        XCTAssertThrowsError(try state.append(duplicate, after: "wrong")) { error in
            XCTAssertEqual(error as? SearchPaginationError, .unexpectedPage)
        }
        XCTAssertThrowsError(try state.append(duplicate, after: "opaque-page-two")) { error in
            XCTAssertEqual(error as? SearchPaginationError, .duplicateResult)
        }
        XCTAssertEqual(state.items.count, 2)
        XCTAssertEqual(state.pageCount, 1)

        let inconsistent = try searchPage(indices: [], nextCursor: "empty-next")
        XCTAssertThrowsError(
            try SearchPaginationState(first: inconsistent, request: request, pageLimit: 2)
        ) { error in
            XCTAssertEqual(error as? SearchPaginationError, .inconsistentPageInfo)
        }
    }

    func testSearchPaginationStopsAtDisplayCapEvenWhenServerOffersAnotherCursor() throws {
        let request = SearchRequest(query: "training", includesArchived: false)
        var state = try SearchPaginationState(
            first: searchPage(indices: [1], nextCursor: "cursor-2"),
            request: request,
            pageLimit: 1
        )
        for index in 2 ... SearchPaginationState.maximumPageCount {
            try state.append(
                searchPage(indices: [index], nextCursor: "cursor-\(index + 1)"),
                after: "cursor-\(index)"
            )
        }

        XCTAssertEqual(state.pageCount, SearchPaginationState.maximumPageCount)
        XCTAssertFalse(state.canLoadMore)
        XCTAssertTrue(state.reachedDisplayLimit)
        XCTAssertEqual(state.items.count, SearchPaginationState.maximumPageCount)
    }

    func testSearchFailureCopyIsContentFreeAndDistinguishesOffline() {
        XCTAssertEqual(SearchFailure.offline.glyph, .warning)
        XCTAssertEqual(SearchFailure.offline.message, "Reconnect to search your private notes.")
        XCTAssertEqual(
            SearchFailure.unavailable.message,
            "Your notes are unchanged. Try this search again."
        )
        XCTAssertEqual(
            SearchPaginationState.displayLimitMessage,
            "Showing the first 1,000 results. Refine your search to see a narrower set."
        )
    }

    func testSearchAndDeletionRejectCacheablePrivateResponses() async throws {
        let provider = APITokenProviderStub()
        APIURLProtocolStub.install { request in
            apiResponse(
                for: request,
                json: #"{"items":[],"pageInfo":{"hasMore":false,"nextCursor":null}}"#
            )
        }
        do {
            _ = try await makeStubbedAPIClient(tokenProvider: provider).searchNotes(
                .init(query: "private phrase")
            )
            XCTFail("Expected a cacheable search response to be rejected")
        } catch {
            XCTAssertEqual(error as? APIClientError, .malformedResponse(status: 200))
        }

        APIURLProtocolStub.install { request in
            apiResponse(
                for: request,
                json: Self.deletionReceiptJSON(replayed: true)
            )
        }
        let token = try AccountDeletionToken(
            validating: "delete_\(String(repeating: "A", count: 43))"
        )
        do {
            _ = try await makeStubbedAPIClient().replayAccountDeletionReceipt(
                .init(idempotencyKey: token)
            )
            XCTFail("Expected a cacheable deletion receipt to be rejected")
        } catch {
            XCTAssertEqual(error as? APIClientError, .malformedResponse(status: 200))
        }
    }

    func testLogFieldDraftPreservesPriorValueAndNumericControls() {
        var draft = LogFieldEditDraft(priorValue: .number(12.5))

        XCTAssertTrue(draft.isNumeric)
        XCTAssertEqual(draft.placeholder, "Previous: 12.5")
        XCTAssertNil(draft.proposedValue)

        let separator = Locale.current.decimalSeparator ?? "."
        draft.input = "12\(separator)5"
        XCTAssertEqual(draft.proposedValue, .number(12.5))
        draft.step(by: 1)
        XCTAssertEqual(draft.proposedValue, .number(13.5))
        draft.step(by: -1)
        XCTAssertEqual(draft.proposedValue, .number(12.5))

        var empty = LogFieldEditDraft(priorValue: .null)
        XCTAssertEqual(empty.placeholder, "No prior value")
        empty.step(by: 1)
        XCTAssertEqual(empty.proposedValue, .number(1))
    }

    func testLogFieldDraftEnforcesTextContractAndIntentIdentityIsUnambiguous() throws {
        var text = LogFieldEditDraft(priorValue: .string("easy"))
        XCTAssertFalse(text.isNumeric)
        XCTAssertEqual(text.placeholder, "Previous: easy")
        text.updateInput(String(repeating: "x", count: 500))
        XCTAssertEqual(text.proposedValue, .string(text.input))
        text.updateInput(text.input + "🙂")
        XCTAssertEqual(text.input.utf16.count, LogFieldEditDraft.maximumTextInputUTF16Units)
        XCTAssertEqual(text.proposedValue, .string(String(repeating: "x", count: 500)))

        var numeric = LogFieldEditDraft(priorValue: .number(1))
        numeric.updateInput(String(repeating: "9", count: 80))
        XCTAssertEqual(
            numeric.input.utf16.count,
            LogFieldEditDraft.maximumNumericInputUTF16Units
        )

        let note = try NoteID(validating: noteID(1))
        let entry = try EntryID(validating: "ent_\(identifierSuffix(1))")
        let left = AppModel.logFieldIntentID(
            noteID: note,
            entryID: entry,
            fieldPath: ["a", "bc"]
        )
        let right = AppModel.logFieldIntentID(
            noteID: note,
            entryID: entry,
            fieldPath: ["ab", "c"]
        )
        XCTAssertNotEqual(left, right)
        XCTAssertFalse(left.contains("12.5"), "Intent coordinates must never include a field value")
    }

    func testLogPresentationSortsEntriesAndProducesStableFieldPaths() throws {
        let noteJSON = """
        {"spaceId":null,"type":"log","title":"Training log","bodyMarkdown":"","structuredData":{"schemaVersion":1,"entries":[{"id":"ent_\(identifierSuffix(1))","occurredAt":"2026-09-01T12:00:00Z","fields":{"total_sets":4,"mood":"steady"}},{"id":"ent_\(identifierSuffix(2))","occurredAt":"2026-09-02T12:00:00Z","fields":{"duration_minutes":45}}]},"isOpen":true,"pinnedAt":null,"privacy":"private_manual","archivedAt":null,"deletedAt":null,"tagIds":[],"links":[],"id":"\(noteID(1))","currentRevision":7,"createdAt":"2026-09-01T12:00:00Z","updatedAt":"2026-09-02T12:00:00Z"}
        """
        let note = try APIJSON.makeDecoder().decode(Note.self, from: Data(noteJSON.utf8))

        let detail = PresentationMapping.detail(note, spaces: [])

        XCTAssertEqual(detail.logEntries.map(\.id), [
            "ent_\(identifierSuffix(2))",
            "ent_\(identifierSuffix(1))"
        ])
        XCTAssertEqual(detail.logEntries[1].fields.map(\.id), ["mood", "total_sets"])
        XCTAssertEqual(detail.logEntries[1].fields.last?.label, "Total Sets")
        XCTAssertEqual(detail.logEntries[1].fields.last?.path, ["total_sets"])
    }

    func testSecureExportWriterStreamsToAnExactProtectedTemporaryArtifact() async throws {
        let fileManager = FileManager.default
        let base = fileManager.temporaryDirectory
            .appendingPathComponent("unfiled-export-test-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: base, withIntermediateDirectories: true)
        defer { try? fileManager.removeItem(at: base) }
        let stream = AsyncThrowingStream<Data, any Error> { continuation in
            continuation.yield(Data([0x1F]))
            continuation.yield(Data([0x8B, 0x08, 0x00, 0x01, 0x02]))
            continuation.finish()
        }

        let artifact = try await SecureAccountExportWriter.write(
            stream,
            baseDirectory: base,
            fileManager: fileManager
        )

        XCTAssertEqual(artifact.fileURL.lastPathComponent, "unfiled-export.tar.gz")
        XCTAssertTrue(artifact.directoryURL.path.hasPrefix(base.path + "/"))
        XCTAssertEqual(
            try Data(contentsOf: artifact.fileURL),
            Data([0x1F, 0x8B, 0x08, 0x00, 0x01, 0x02])
        )
        XCTAssertTrue(fileManager.fileExists(atPath: artifact.fileURL.path))

        SecureAccountExportWriter.remove(artifact, fileManager: fileManager)
        XCTAssertFalse(fileManager.fileExists(atPath: artifact.directoryURL.path))

        let staleRoot = base.appendingPathComponent("unfiled-secure-exports", isDirectory: true)
        try fileManager.createDirectory(at: staleRoot, withIntermediateDirectories: true)
        let staleFile = staleRoot.appendingPathComponent("stale.tar.gz")
        XCTAssertTrue(fileManager.createFile(atPath: staleFile.path, contents: Data([0x1F])))
        SecureAccountExportWriter.removeStaleArtifacts(
            baseDirectory: base,
            fileManager: fileManager
        )
        XCTAssertFalse(fileManager.fileExists(atPath: staleRoot.path))
    }

    func testSecureExportWriterRejectsInvalidArchiveAndCleansPartialFile() async throws {
        let fileManager = FileManager.default
        let base = fileManager.temporaryDirectory
            .appendingPathComponent("unfiled-export-invalid-test-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: base, withIntermediateDirectories: true)
        defer { try? fileManager.removeItem(at: base) }
        let stream = AsyncThrowingStream<Data, any Error> { continuation in
            continuation.yield(Data("not a gzip archive".utf8))
            continuation.finish()
        }

        do {
            _ = try await SecureAccountExportWriter.write(
                stream,
                baseDirectory: base,
                fileManager: fileManager
            )
            XCTFail("Expected invalid archive rejection")
        } catch {
            XCTAssertEqual(error as? AccountDataSecurityError, .invalidExport)
        }

        let root = base.appendingPathComponent("unfiled-secure-exports", isDirectory: true)
        let remaining = (try? fileManager.contentsOfDirectory(atPath: root.path)) ?? []
        XCTAssertTrue(remaining.isEmpty)
    }

    func testDeletionRecoveryUsesDeviceOnlyKeychainAndRoundTripsConfirmedReceipt() throws {
        let memory = AuthMemorySecureDataStore()
        let store = KeychainAccountDeletionRecoveryStore(
            store: memory,
            service: "app.unfiled.tests.account-deletion"
        )
        let token = try AccountDeletionToken(
            validating: "delete_\(String(repeating: "A", count: 43))"
        )
        let owner = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
        let createdAt = try XCTUnwrap(APIJSON.parseDate("2026-09-01T12:00:00Z"))
        let record = AccountDeletionRecoveryRecord(
            ownerID: owner,
            capability: token,
            createdAt: createdAt
        )

        try store.save(record)
        XCTAssertEqual(memory.lastAccessibility, .whenUnlockedThisDeviceOnly)
        XCTAssertEqual(try store.load(), record)
        XCTAssertFalse(token.description.contains(token.rawValue))

        let confirmed = record.confirming(try accountDeletionReceipt(replayed: true))
        try store.save(confirmed)
        XCTAssertEqual(try store.load(), confirmed)
        try store.clear()
        XCTAssertNil(try store.load())
    }

    func testDeletionRecoveryRejectsFutureOrOversizedRecords() throws {
        let memory = AuthMemorySecureDataStore()
        let store = KeychainAccountDeletionRecoveryStore(
            store: memory,
            service: "app.unfiled.tests.account-deletion"
        )
        let token = try AccountDeletionToken(
            validating: "delete_\(String(repeating: "A", count: 43))"
        )
        let future = AccountDeletionRecoveryRecord(
            ownerID: UUID(),
            capability: token,
            createdAt: Date().addingTimeInterval(10 * 60)
        )
        memory.seed(try APIJSON.makeEncoder().encode(future))
        XCTAssertThrowsError(try store.load()) { error in
            XCTAssertEqual(error as? AccountDataSecurityError, .invalidRecoveryRecord)
        }

        memory.seed(Data(repeating: 0, count: KeychainAccountDeletionRecoveryStore.maximumRecordBytes + 1))
        XCTAssertThrowsError(try store.load()) { error in
            XCTAssertEqual(error as? AccountDataSecurityError, .invalidRecoveryRecord)
        }
    }

    func testAccountDeletionPresentationRequiresExactDeliberateConfirmation() throws {
        XCTAssertTrue(AccountDataPresentation.deletionConfirmationIsExact("DELETE"))
        XCTAssertFalse(AccountDataPresentation.deletionConfirmationIsExact("delete"))
        XCTAssertFalse(AccountDataPresentation.deletionConfirmationIsExact(" DELETE "))
        XCTAssertEqual(AccountDataAccessibilityIdentifier.deleteCommit, "settings.account.delete.commit")
        XCTAssertEqual(AccountDataAccessibilityIdentifier.receipt, "account.delete.receipt")

        let presentation = AccountDeletionReceiptPresentation(
            receipt: try accountDeletionReceipt(replayed: false),
            localDataRemoved: true,
            localSessionCleared: true,
            recoveryRecordCleared: true
        )
        XCTAssertEqual(presentation.deletedRecordCount, 19)
        XCTAssertTrue(presentation.localCleanupComplete)
    }

    private func jsonObject<Value: Encodable>(_ value: Value) throws -> [String: Any] {
        try XCTUnwrap(
            JSONSerialization.jsonObject(with: APIJSON.makeEncoder().encode(value))
                as? [String: Any]
        )
    }

    private func searchPage(
        indices: [Int],
        nextCursor: String?,
        hasMore: Bool? = nil
    ) throws -> SearchNotesResponse {
        let items = indices.map { index in
            [
                "noteId": noteID(index),
                "title": "Result \(index)",
                "type": "generic",
                "snippet": "Private result \(index)",
                "spacePath": ["Notes"],
                "updatedAt": "2026-09-01T12:00:00Z",
                "archivedAt": NSNull()
            ] as [String: Any]
        }
        let object: [String: Any] = [
            "items": items,
            "pageInfo": [
                "hasMore": hasMore ?? (nextCursor != nil),
                "nextCursor": nextCursor.map { $0 as Any } ?? NSNull()
            ]
        ]
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        return try APIJSON.makeDecoder().decode(SearchNotesResponse.self, from: data)
    }

    private func accountDeletionReceipt(replayed: Bool) throws -> AccountDeletionReceipt {
        let json = Self.deletionReceiptJSON(replayed: replayed)
        return try APIJSON.makeDecoder().decode(AccountDeletionReceipt.self, from: Data(json.utf8))
    }

    private static func deletionReceiptJSON(replayed: Bool) -> String {
        """
        {"backupExpiresAt":"2026-09-30T20:00:00.000Z","backupRetentionDays":30,"deletedAt":"2026-08-31T20:00:00.000Z","deletedRecordCounts":{"auth.sessions":2,"public.notes":17},"liveDataDeleted":true,"receiptExpiresAt":"2026-10-01T20:00:00.000Z","reRegistrationStartsFresh":true,"replayed":\(replayed),"schemaVersion":1,"sessionsRevoked":true}
        """
    }

    private func noteID(_ index: Int) -> String {
        "note_\(identifierSuffix(index))"
    }

    private func identifierSuffix(_ index: Int) -> String {
        String(repeating: "0", count: 24) + String(format: "%02d", index)
    }
}
