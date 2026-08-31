import Foundation
import XCTest
@testable import Unfiled

final class APIModelsTests: XCTestCase {
    func testAuthSessionDecodesOffsetTimestampAndStrictUUID() throws {
        let data = Data(#"{"accessToken":"a","refreshToken":"r","expiresAt":"2026-08-31T12:30:45.123-07:00","user":{"id":"11111111-1111-1111-1111-111111111111","email":"p@example.com"}}"#.utf8)
        let session = try APIJSON.makeDecoder().decode(AuthSession.self, from: data)
        XCTAssertEqual(session.user.id.uuidString.lowercased(), "11111111-1111-1111-1111-111111111111")
        XCTAssertEqual(session.expiresAt.timeIntervalSince1970, 1_788_204_645.123, accuracy: 0.001)
    }

    func testStructuredDataDiscriminatesEveryVersionOneShape() throws {
        let decoder = APIJSON.makeDecoder()
        let item = "itm_00000000000000000000000000"
        let entry = "ent_00000000000000000000000000"
        let list = try decoder.decode(NoteStructuredData.self, from: Data(#"{"schemaVersion":1,"items":[{"id":"\#(item)","text":"One","checked":false,"ordinal":0,"section":null}]}"#.utf8))
        let log = try decoder.decode(NoteStructuredData.self, from: Data(#"{"schemaVersion":1,"entries":[{"id":"\#(entry)","occurredAt":"2026-08-31T00:00:00Z","fields":{"value":1}}]}"#.utf8))
        let project = try decoder.decode(NoteStructuredData.self, from: Data(#"{"schemaVersion":1,"checklistItems":[{"id":"\#(item)","text":"One","checked":false,"ordinal":0,"lineIndex":3}]}"#.utf8))
        let plain = try decoder.decode(NoteStructuredData.self, from: Data(#"{"schemaVersion":1}"#.utf8))
        if case .list = list {} else { XCTFail("Expected list") }
        if case .log = log {} else { XCTFail("Expected log") }
        if case .project = project {} else { XCTFail("Expected project") }
        XCTAssertEqual(plain, .plain)
        XCTAssertThrowsError(try decoder.decode(NoteStructuredData.self, from: Data(#"{"schemaVersion":2}"#.utf8)))
    }

    func testNullablePatchFieldEncodesNullWhileUnchangedIsOmitted() throws {
        let request = try NoteUpdateRequest(expectedRevision: 2, idempotencyKey: "abcdefgh",
                                            title: .value("New"), spaceId: .null)
        let object = try JSONSerialization.jsonObject(with: APIJSON.makeEncoder().encode(request)) as! [String: Any]
        XCTAssertEqual(Set(object.keys), ["expectedRevision", "idempotencyKey", "title", "spaceId"])
        XCTAssertEqual(object["title"] as? String, "New")
        XCTAssertTrue(object["spaceId"] is NSNull)
    }

    func testReceiptDiscriminatedUnionsRoundTrip() throws {
        let note = try NoteID(validating: "note_00000000000000000000000000")
        let decision = try DecisionID(validating: "dec_00000000000000000000000000")
        let action = CaptureReceiptAction.move(noteId: note, decisionId: decision)
        let encoded = try APIJSON.makeEncoder().encode(action)
        XCTAssertEqual(try APIJSON.makeDecoder().decode(CaptureReceiptAction.self, from: encoded), action)
        let object = try JSONSerialization.jsonObject(with: encoded) as! [String: String]
        XCTAssertEqual(object["type"], "move")
    }

    func testUnknownEnumsAndWrongPrefixesFailDecoding() throws {
        XCTAssertThrowsError(try APIJSON.makeDecoder().decode(NoteType.self, from: Data(#""unknown""#.utf8)))
        XCTAssertThrowsError(try APIJSON.makeDecoder().decode(NoteID.self, from: Data(#""tag_00000000000000000000000000""#.utf8)))
    }

    func testRequiredNullableAndLiteralFieldsFailClosed() throws {
        let decoder = APIJSON.makeDecoder()
        XCTAssertThrowsError(try decoder.decode(PageInfo.self, from: Data(#"{"hasMore":false}"#.utf8)))
        XCTAssertNoThrow(try decoder.decode(PageInfo.self, from: Data(#"{"hasMore":false,"nextCursor":null}"#.utf8)))
        XCTAssertThrowsError(try decoder.decode(PageInfo.self,
                                                from: Data(#"{"hasMore":false,"nextCursor":null,"extra":true}"#.utf8)))
        let oversizedCursor = String(repeating: "c", count: 513)
        XCTAssertThrowsError(try decoder.decode(PageInfo.self,
                                                from: Data(#"{"hasMore":true,"nextCursor":"\#(oversizedCursor)"}"#.utf8)))
        XCTAssertThrowsError(try decoder.decode(AuthOTPAcceptedResponse.self,
                                                from: Data(#"{"accepted":false,"retryAfterSeconds":30}"#.utf8)))
        XCTAssertThrowsError(try decoder.decode(ToggleItemCheckedOperation.self,
                                                from: Data(#"{"type":"remove_item","itemId":"itm_00000000000000000000000000","checked":true}"#.utf8)))
    }

    func testOTPRequiresExactlySixDecimalDigits() throws {
        XCTAssertNoThrow(try AuthOTPVerifyRequest(email: "A@Example.COM", code: "123456"))
        XCTAssertThrowsError(try AuthOTPVerifyRequest(email: "a@example.com", code: "12345"))
        XCTAssertThrowsError(try AuthOTPVerifyRequest(email: "a@example.com", code: "12345x"))
        XCTAssertThrowsError(try AuthOTPVerifyRequest(email: "a@example.com", code: "١٢٣٤٥٦"))
    }

    func testCaptureCreateResponseRequiresCleanQueuedAcknowledgementAndExactKeys() throws {
        let decoder = APIJSON.makeDecoder()
        let queued = #"{"capture":{"id":"cap_00000000000000000000000000","rawContent":"buy oat milk","source":"mobile","deviceId":"device-1","privacy":"ai_assisted","explicitDestinationNoteId":null,"expansionDisabled":false,"clientCreatedAt":"2026-08-31T12:00:00Z","clientTimezone":"UTC","receivedAt":"2026-08-31T12:00:01Z","status":"queued","lastErrorCode":null},"jobId":"job_00000000000000000000000000","replayed":false}"#
        XCTAssertNoThrow(try decoder.decode(CaptureCreateResponse.self, from: Data(queued.utf8)))

        let completed = queued.replacingOccurrences(of: #""status":"queued""#, with: #""status":"done""#)
        XCTAssertThrowsError(
            try decoder.decode(CaptureCreateResponse.self, from: Data(completed.utf8))
        )

        let extraTopLevelKey = queued.dropLast() + #", "unexpected":true}"#
        XCTAssertThrowsError(
            try decoder.decode(CaptureCreateResponse.self, from: Data(extraTopLevelKey.utf8))
        )

        let extraCaptureKey = queued.replacingOccurrences(
            of: #""lastErrorCode":null}"#,
            with: #""lastErrorCode":null,"unexpected":true}"#
        )
        XCTAssertThrowsError(
            try decoder.decode(CaptureCreateResponse.self, from: Data(extraCaptureKey.utf8))
        )
    }

    func testCaptureSummaryRequiresBoundedPreviewAndTerminalReceiptAvailability() throws {
        let decoder = APIJSON.makeDecoder()
        let valid = #"{"id":"cap_00000000000000000000000000","jobId":"job_00000000000000000000000000","rawContentPreview":"buy oat milk","source":"mobile","privacy":"ai_assisted","clientCreatedAt":"2026-08-31T12:00:00Z","receivedAt":"2026-08-31T12:00:01Z","status":"done","lastErrorCode":null,"receiptAvailable":true}"#
        XCTAssertNoThrow(try decoder.decode(CaptureSummary.self, from: Data(valid.utf8)))
        XCTAssertThrowsError(
            try decoder.decode(
                CaptureSummary.self,
                from: Data(valid.replacingOccurrences(of: #""receiptAvailable":true"#,
                                                       with: #""receiptAvailable":false"#).utf8)
            )
        )
        XCTAssertThrowsError(
            try decoder.decode(
                CaptureSummary.self,
                from: Data(valid.replacingOccurrences(of: #""rawContentPreview":"buy oat milk""#,
                                                       with: #""rawContentPreview":"   ""#).utf8)
            )
        )
    }

    func testCaptureReceiptRejectsUnboundActionsAndStateMismatch() throws {
        let decoder = APIJSON.makeDecoder()
        let valid = Self.validCaptureDetailJSON
        XCTAssertNoThrow(try decoder.decode(CaptureDetail.self, from: Data(valid.utf8)))

        let wrongMutation = valid.replacingOccurrences(
            of: #""mutationId":"mut_00000000000000000000000000","expectedRevision":4"#,
            with: #""mutationId":"mut_11111111111111111111111111","expectedRevision":4"#
        )
        XCTAssertThrowsError(try decoder.decode(CaptureDetail.self, from: Data(wrongMutation.utf8)))

        let wrongCapture = valid.replacingOccurrences(
            of: #""captureId":"cap_00000000000000000000000000""#,
            with: #""captureId":"cap_11111111111111111111111111""#
        )
        XCTAssertThrowsError(try decoder.decode(CaptureDetail.self, from: Data(wrongCapture.utf8)))

        let wrongState = valid.replacingOccurrences(of: #""status":"done""#,
                                                    with: #""status":"processing""#)
        XCTAssertThrowsError(try decoder.decode(CaptureDetail.self, from: Data(wrongState.utf8)))

        let nonPositiveRevision = valid.replacingOccurrences(of: #""expectedRevision":4"#,
                                                              with: #""expectedRevision":0"#)
        XCTAssertThrowsError(try decoder.decode(CaptureDetail.self, from: Data(nonPositiveRevision.utf8)))
    }

    func testCaptureReceiptVariantsAndEnvelopeRejectUnknownKeys() throws {
        let decoder = APIJSON.makeDecoder()
        let contentWithUnknownKey = #"{"type":"captured","itemId":null,"content":"saved","unknown":true}"#
        XCTAssertThrowsError(
            try decoder.decode(CaptureReceiptContent.self, from: Data(contentWithUnknownKey.utf8))
        )

        let detailWithUnknownKey = Self.validCaptureDetailJSON.dropLast() + #", "unknown":true}"#
        XCTAssertThrowsError(
            try decoder.decode(CaptureDetail.self, from: Data(detailWithUnknownKey.utf8))
        )

        let invalidReason = Self.validCaptureDetailJSON.replacingOccurrences(
            of: #""reasonCodes":["user_match"]"#,
            with: #""reasonCodes":["Not-Snake"]"#
        )
        XCTAssertThrowsError(try decoder.decode(CaptureDetail.self, from: Data(invalidReason.utf8)))

        let oversizedUTF16Content = String(repeating: "\u{1F642}", count: 5_001)
        let oversizedInsertedContent = Self.validCaptureDetailJSON.replacingOccurrences(
            of: #""content":"buy oat milk""#,
            with: #""content":"\#(oversizedUTF16Content)""#
        )
        XCTAssertThrowsError(
            try decoder.decode(CaptureDetail.self, from: Data(oversizedInsertedContent.utf8))
        )
    }

    func testSearchResultRequiresStrictBoundedContractShape() throws {
        let decoder = APIJSON.makeDecoder()
        let valid = #"{"noteId":"note_00000000000000000000000000","title":"Groceries","type":"list","snippet":"Oat milk","spacePath":["Life","Shopping"],"updatedAt":"2026-08-31T12:00:00Z","archivedAt":null}"#
        XCTAssertNoThrow(try decoder.decode(SearchNoteResult.self, from: Data(valid.utf8)))

        let tooDeep = valid.replacingOccurrences(of: #"["Life","Shopping"]"#,
                                                 with: #"["Life","Shopping","Weekly"]"#)
        XCTAssertThrowsError(try decoder.decode(SearchNoteResult.self, from: Data(tooDeep.utf8)))

        let oversizedSnippet = String(repeating: "s", count: 501)
        let tooLong = valid.replacingOccurrences(of: #""snippet":"Oat milk""#,
                                                 with: #""snippet":"\#(oversizedSnippet)""#)
        XCTAssertThrowsError(try decoder.decode(SearchNoteResult.self, from: Data(tooLong.utf8)))

        let unknownKey = valid.dropLast() + #", "score":0.99}"#
        XCTAssertThrowsError(try decoder.decode(SearchNoteResult.self, from: Data(unknownKey.utf8)))
    }

    private static let validCaptureDetailJSON = #"{"id":"cap_00000000000000000000000000","rawContent":"buy oat milk","source":"mobile","deviceId":"device-1","privacy":"ai_assisted","explicitDestinationNoteId":null,"expansionDisabled":false,"clientCreatedAt":"2026-08-31T12:00:00Z","clientTimezone":"UTC","receivedAt":"2026-08-31T12:00:01Z","status":"done","lastErrorCode":null,"jobId":"job_00000000000000000000000000","receipt":{"schemaVersion":1,"captureId":"cap_00000000000000000000000000","jobId":"job_00000000000000000000000000","decisionId":"dec_00000000000000000000000000","reviewItemId":null,"mutationId":"mut_00000000000000000000000000","outcome":"added_to_note","headline":"Added to Groceries","destination":{"noteId":"note_00000000000000000000000000","title":"Groceries"},"insertedContent":[{"type":"captured","itemId":null,"content":"buy oat milk"}],"actions":[{"type":"open","noteId":"note_00000000000000000000000000"},{"type":"move","noteId":"note_00000000000000000000000000","decisionId":"dec_00000000000000000000000000"},{"type":"undo","mutationId":"mut_00000000000000000000000000","expectedRevision":4}],"reasonCodes":["user_match"],"createdAt":"2026-08-31T12:00:02Z"}}"#
}
