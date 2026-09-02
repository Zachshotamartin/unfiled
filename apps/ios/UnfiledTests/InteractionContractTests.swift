import Foundation
import XCTest
@testable import Unfiled

final class InteractionContractTests: XCTestCase {
    override func tearDown() {
        APIURLProtocolStub.reset()
        super.tearDown()
    }

    func testActiveNoteMembershipCannotResurrectRemovedNotes() {
        let removed = "note_00000000000000000000000000"
        let survivor = "note_11111111111111111111111111"

        var afterDelete = ActiveNoteMembership()
        afterDelete.replace(with: [removed, survivor])
        afterDelete.update(noteID: removed, isActive: false)
        afterDelete.update(noteID: survivor, isActive: true)
        XCTAssertEqual(afterDelete.ids, [survivor])

        var afterAuthoritativeRefresh = ActiveNoteMembership()
        afterAuthoritativeRefresh.replace(with: [removed, survivor])
        afterAuthoritativeRefresh.replace(with: [survivor])
        afterAuthoritativeRefresh.update(noteID: survivor, isActive: true)
        XCTAssertEqual(afterAuthoritativeRefresh.ids, [survivor])
    }

    func testReviewQueueGenerationRejectsSupersededAndInvalidatedResults() {
        var generation = ReviewQueueGeneration()

        let firstRefresh = generation.beginRequest()
        XCTAssertTrue(generation.accepts(firstRefresh))

        let newerRefresh = generation.beginRequest()
        XCTAssertFalse(generation.accepts(firstRefresh))
        XCTAssertTrue(generation.accepts(newerRefresh))

        generation.invalidate()
        XCTAssertFalse(generation.accepts(newerRefresh))

        let postMutationRefresh = generation.beginRequest()
        XCTAssertTrue(generation.accepts(postMutationRefresh))
    }

    func testReviewGeneratedBlockHydrationCannotCommitOutOfOrder() {
        var generation = ReviewQueueGeneration()
        let olderRefresh = generation.beginRequest()
        let newerRefresh = generation.beginRequest()
        var committedBlocks = ["block": "initial"]

        if let newerBlocks = generation.accepted(
            ["block": "newer"],
            for: newerRefresh
        ) {
            committedBlocks = newerBlocks
        }
        if let staleBlocks = generation.accepted(
            ["block": "stale"],
            for: olderRefresh
        ) {
            committedBlocks = staleBlocks
        }

        XCTAssertEqual(committedBlocks, ["block": "newer"])
    }

    func testBatchUndoFocusesReviewOnlyForPersistedConflict() {
        XCTAssertTrue(
            AppModel.shouldFocusReviewAfterUndo(
                status: 409,
                code: .conflictRequiresReview
            )
        )

        for status in [400, 408, 425, 500] {
            XCTAssertFalse(
                AppModel.shouldFocusReviewAfterUndo(
                    status: status,
                    code: .conflictRequiresReview
                )
            )
        }

        for code in [APIErrorCode.staleRevision, .structureConflict] {
            XCTAssertFalse(AppModel.shouldFocusReviewAfterUndo(status: 409, code: code))
            let message = AppModel.interactionFailureMessage(
                APIClientError.http(
                    status: 409,
                    code: code,
                    requestId: "req-e1-regression",
                    retryAfterSeconds: nil
                ),
                fallback: "fallback"
            )
            XCTAssertTrue(message.localizedCaseInsensitiveContains("refresh"))
            XCTAssertFalse(message.localizedCaseInsensitiveContains("review"))
            XCTAssertFalse(message.localizedCaseInsensitiveContains("saved"))
        }
    }

    func testBatchUndoRefreshesTheAnchorRevisionSoLaterEditsReachReview() {
        XCTAssertEqual(
            AppModel.undoRequestExpectedRevision(
                receiptExpectedRevision: 2,
                currentRevision: 2
            ),
            2
        )
        XCTAssertEqual(
            AppModel.undoRequestExpectedRevision(
                receiptExpectedRevision: 2,
                currentRevision: 5
            ),
            5,
            "A later note edit must be sent as the current CAS revision so the server can save a focused Review"
        )
        XCTAssertNil(
            AppModel.undoRequestExpectedRevision(
                receiptExpectedRevision: 5,
                currentRevision: 2
            )
        )
    }

    func testBatchUndoReviewFocusComesOnlyFromExactAuthoritativeReceipt() {
        let captureID = "cap_00000000000000000000000000"
        let reviewID = "rvw_00000000000000000000000000"

        func receipt(
            id: String = "cap_00000000000000000000000000",
            outcome: CaptureReceiptOutcome? = .needsReview,
            reviewItemID: String? = "rvw_00000000000000000000000000",
            actions: [ReceiptActionPresentation] = []
        ) -> ReceiptPresentation {
            ReceiptPresentation(
                id: id,
                category: "REVIEW",
                time: "NOW",
                headline: "Needs review",
                original: "captured text",
                outcome: outcome,
                destinationNoteID: nil,
                destinationTitle: nil,
                reviewItemID: reviewItemID,
                insertedContent: [],
                actions: actions,
                pending: false,
                retryable: false
            )
        }

        XCTAssertEqual(
            AppModel.authoritativeReviewFocusID(
                captureID: captureID,
                refreshedReceipt: receipt()
            ),
            reviewID
        )
        XCTAssertNil(
            AppModel.authoritativeReviewFocusID(
                captureID: captureID,
                refreshedReceipt: receipt(id: "cap_11111111111111111111111111")
            )
        )
        XCTAssertNil(
            AppModel.authoritativeReviewFocusID(
                captureID: captureID,
                refreshedReceipt: receipt(outcome: .addedToNote)
            )
        )
        XCTAssertNil(
            AppModel.authoritativeReviewFocusID(
                captureID: captureID,
                refreshedReceipt: receipt(reviewItemID: nil)
            )
        )
        XCTAssertNil(
            AppModel.authoritativeReviewFocusID(
                captureID: captureID,
                refreshedReceipt: receipt(reviewItemID: "rvw_invalid")
            )
        )
        XCTAssertNil(
            AppModel.authoritativeReviewFocusID(
                captureID: captureID,
                refreshedReceipt: receipt(
                    actions: [.open(noteID: "note_00000000000000000000000000")]
                )
            )
        )
        XCTAssertNil(
            AppModel.authoritativeReviewFocusID(
                captureID: captureID,
                refreshedReceipt: nil
            )
        )
    }

    func testEveryReviewProposalVariantDecodesStrictly() throws {
        let decoder = APIJSON.makeDecoder()
        let noteA = "note_00000000000000000000000000"
        let noteB = "note_11111111111111111111111111"
        let plan = #"{"schemaVersion":1,"captureKind":"list_items","decision":"create_note","destination":{"candidateId":null,"newNote":{"title":"Groceries","noteType":"list","spaceCandidateId":null}},"operations":[{"type":"append_list_items","section":null,"items":["oat milk"]}],"generatedExpansion":null,"alternatives":[],"reasonCodes":["explicit_shopping_intent"]}"#
        let fixtures = [
            #"{"type":"route_capture","plan":\#(plan)}"#,
            #"{"type":"generated_block","blockId":"blk_00000000000000000000000000"}"#,
            #"{"type":"duplicate_notes","notes":[{"noteId":"\#(noteA)","revision":1},{"noteId":"\#(noteB)","revision":2}],"explanation":"These notes describe the same weekly plan."}"#,
            #"{"type":"conflict","reason":"candidate_eligibility"}"#,
            #"{"type":"failed_job","errorCode":"provider_unavailable"}"#
        ]

        for fixture in fixtures {
            XCTAssertNoThrow(
                try decoder.decode(ReviewProposal.self, from: Data(fixture.utf8)),
                fixture
            )
        }

        let duplicate = try decoder.decode(ReviewProposal.self, from: Data(fixtures[2].utf8))
        guard case let .duplicateNotes(notes, explanation) = duplicate else {
            return XCTFail("Expected duplicate-note proposal")
        }
        XCTAssertEqual(notes.count, 2)
        XCTAssertEqual(explanation, "These notes describe the same weekly plan.")
        XCTAssertEqual(
            try decoder.decode(
                ReviewProposal.self,
                from: APIJSON.makeEncoder().encode(duplicate)
            ),
            duplicate
        )

        let duplicateID = #"{"type":"duplicate_notes","notes":[{"noteId":"\#(noteA)","revision":1},{"noteId":"\#(noteA)","revision":2}],"explanation":"Same note twice."}"#
        let oneNote = #"{"type":"duplicate_notes","notes":[{"noteId":"\#(noteA)","revision":1}],"explanation":"Only one note."}"#
        let zeroRevision = #"{"type":"duplicate_notes","notes":[{"noteId":"\#(noteA)","revision":0},{"noteId":"\#(noteB)","revision":2}],"explanation":"Invalid revision."}"#
        let missingExplanation = #"{"type":"duplicate_notes","notes":[{"noteId":"\#(noteA)","revision":1},{"noteId":"\#(noteB)","revision":2}]}"#
        let blankExplanation = #"{"type":"duplicate_notes","notes":[{"noteId":"\#(noteA)","revision":1},{"noteId":"\#(noteB)","revision":2}],"explanation":"   "}"#
        let unknownKey = #"{"type":"conflict","reason":"structure","rawModelOutput":"secret"}"#
        for invalid in [
            duplicateID,
            oneNote,
            zeroRevision,
            missingExplanation,
            blankExplanation,
            unknownKey
        ] {
            XCTAssertThrowsError(
                try decoder.decode(ReviewProposal.self, from: Data(invalid.utf8)),
                invalid
            )
        }

        let longExplanation = String(repeating: "x", count: 601)
        let overlong = #"{"type":"duplicate_notes","notes":[{"noteId":"\#(noteA)","revision":1},{"noteId":"\#(noteB)","revision":2}],"explanation":"\#(longExplanation)"}"#
        XCTAssertThrowsError(
            try decoder.decode(ReviewProposal.self, from: Data(overlong.utf8))
        )
    }

    func testReviewResolutionVariantsRoundTripAndRejectLooseShapes() throws {
        let decoder = APIJSON.makeDecoder()
        let encoder = APIJSON.makeEncoder()
        let fixtures = [
            #"{"type":"route","noteId":"note_00000000000000000000000000","expectedRevision":4}"#,
            #"{"type":"create","title":"Training Log","noteType":"log","spaceId":null}"#,
            #"{"type":"keep_inbox"}"#,
            #"{"type":"dismiss"}"#,
            #"{"type":"keep_both"}"#,
            #"{"type":"accept_expansion"}"#,
            #"{"type":"reject_expansion"}"#
        ]

        for fixture in fixtures {
            let resolution = try decoder.decode(ReviewResolution.self, from: Data(fixture.utf8))
            XCTAssertEqual(
                try decoder.decode(ReviewResolution.self, from: encoder.encode(resolution)),
                resolution
            )
        }

        for invalid in [
            #"{"type":"route","noteId":"note_00000000000000000000000000","expectedRevision":0}"#,
            #"{"type":"create","title":"Training Log","noteType":"log"}"#,
            #"{"type":"dismiss","reason":"unused"}"#,
            #"{"type":"unknown"}"#
        ] {
            XCTAssertThrowsError(
                try decoder.decode(ReviewResolution.self, from: Data(invalid.utf8)),
                invalid
            )
        }

        let normalized = try decoder.decode(
            ReviewResolution.self,
            from: Data(
                #"{"type":"create","title":"  Training Log  ","noteType":"log","spaceId":null}"#.utf8
            )
        )
        XCTAssertEqual(
            normalized,
            .create(title: "Training Log", noteType: .log, spaceId: nil)
        )
    }

    func testReviewRequestConstructionRejectsInvalidRevisionsAndTitles() throws {
        let note = try NoteID(validating: "note_00000000000000000000000000")

        for idempotencyKey in ["", " bad key", String(repeating: "a", count: 81)] {
            XCTAssertThrowsError(
                try ReviewResolveRequest(
                    idempotencyKey: idempotencyKey,
                    resolution: .dismiss
                )
            )
        }

        for revision in [0, -1] {
            XCTAssertThrowsError(
                try ReviewProposalNote(noteId: note, revision: revision)
            )
            XCTAssertThrowsError(
                try ReviewResolveRequest(
                    idempotencyKey: "review-resolution-\(revision)",
                    resolution: .route(noteId: note, expectedRevision: revision)
                )
            )
            XCTAssertThrowsError(
                try APIJSON.makeEncoder().encode(
                    ReviewResolution.route(noteId: note, expectedRevision: revision)
                )
            )
        }

        for title in ["   \n", String(repeating: "a", count: 201)] {
            XCTAssertThrowsError(
                try ReviewResolveRequest(
                    idempotencyKey: "review-create-invalid-title",
                    resolution: .create(title: title, noteType: .generic, spaceId: nil)
                )
            )
            XCTAssertThrowsError(
                try APIJSON.makeEncoder().encode(
                    ReviewResolution.create(title: title, noteType: .generic, spaceId: nil)
                )
            )
        }

        XCTAssertNoThrow(
            try ReviewResolveRequest(
                idempotencyKey: "review-create-valid",
                resolution: .create(
                    title: String(repeating: "a", count: 200),
                    noteType: .generic,
                    spaceId: nil
                )
            )
        )

        for expansionResolution in [
            ReviewResolution.acceptExpansion,
            ReviewResolution.rejectExpansion
        ] {
            XCTAssertThrowsError(
                try ReviewResolveRequest(
                    idempotencyKey: "review-expansion-must-use-block-endpoint",
                    resolution: expansionResolution
                )
            )
        }

        let normalizedRequest = try ReviewResolveRequest(
            idempotencyKey: "review-create-trimmed",
            resolution: .create(title: "  Training Log  ", noteType: .log, spaceId: nil)
        )
        XCTAssertEqual(
            normalizedRequest.resolution,
            .create(title: "Training Log", noteType: .log, spaceId: nil)
        )
        let normalizedObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: APIJSON.makeEncoder().encode(normalizedRequest))
                as? [String: Any]
        )
        let normalizedResolution = try XCTUnwrap(
            normalizedObject["resolution"] as? [String: Any]
        )
        XCTAssertEqual(normalizedResolution["title"] as? String, "Training Log")

        let decoder = APIJSON.makeDecoder()
        for invalid in [
            #"{"idempotencyKey":"bad key","resolution":{"type":"dismiss"}}"#,
            #"{"idempotencyKey":"review-dismiss","resolution":{"type":"dismiss"},"extra":true}"#,
            #"{"idempotencyKey":"review-expansion","resolution":{"type":"accept_expansion"}}"#,
            #"{"idempotencyKey":"review-expansion","resolution":{"type":"reject_expansion"}}"#
        ] {
            XCTAssertThrowsError(
                try decoder.decode(ReviewResolveRequest.self, from: Data(invalid.utf8)),
                invalid
            )
        }

        let proposalNote = try ReviewProposalNote(noteId: note, revision: 1)
        XCTAssertThrowsError(
            try APIJSON.makeEncoder().encode(
                ReviewProposal.duplicateNotes(notes: [proposalNote], explanation: "Possible match")
            )
        )
    }

    func testReviewItemRequiresStateResolutionAndTimestampConsistency() throws {
        let decoder = APIJSON.makeDecoder()
        let base = #"{"id":"rvw_00000000000000000000000000","captureId":null,"noteId":"note_00000000000000000000000000","type":"structure_conflict","proposal":{"type":"conflict","reason":"structure"},"state":"STATE","resolution":RESOLUTION,"createdAt":"2026-09-01T12:00:00Z","resolvedAt":RESOLVED_AT}"#
        let valid = [
            base.replacingOccurrences(of: "STATE", with: "open")
                .replacingOccurrences(of: "RESOLUTION", with: "null")
                .replacingOccurrences(of: "RESOLVED_AT", with: "null"),
            base.replacingOccurrences(of: "STATE", with: "resolved")
                .replacingOccurrences(of: "RESOLUTION", with: #"{"type":"keep_inbox"}"#)
                .replacingOccurrences(of: "RESOLVED_AT", with: #""2026-09-01T12:01:00Z""#),
            base.replacingOccurrences(of: "STATE", with: "dismissed")
                .replacingOccurrences(of: "RESOLUTION", with: #"{"type":"dismiss"}"#)
                .replacingOccurrences(of: "RESOLVED_AT", with: #""2026-09-01T12:01:00Z""#)
        ]
        for fixture in valid {
            XCTAssertNoThrow(try decoder.decode(ReviewItem.self, from: Data(fixture.utf8)))
        }

        let invalid = [
            base.replacingOccurrences(of: "STATE", with: "open")
                .replacingOccurrences(of: "RESOLUTION", with: #"{"type":"keep_inbox"}"#)
                .replacingOccurrences(of: "RESOLVED_AT", with: "null"),
            base.replacingOccurrences(of: "STATE", with: "resolved")
                .replacingOccurrences(of: "RESOLUTION", with: #"{"type":"dismiss"}"#)
                .replacingOccurrences(of: "RESOLVED_AT", with: #""2026-09-01T12:01:00Z""#),
            base.replacingOccurrences(of: "STATE", with: "dismissed")
                .replacingOccurrences(of: "RESOLUTION", with: "null")
                .replacingOccurrences(of: "RESOLVED_AT", with: #""2026-09-01T12:01:00Z""#)
        ]
        for fixture in invalid {
            XCTAssertThrowsError(try decoder.decode(ReviewItem.self, from: Data(fixture.utf8)))
        }
    }

    func testCorrectionContractRejectsSameDestinationAndUnboundResult() throws {
        let note = try NoteID(validating: "note_00000000000000000000000000")
        let source = try CorrectionSource(noteId: note, expectedRevision: 2)
        XCTAssertThrowsError(
            try DecisionCorrectionRequest(
                idempotencyKey: "correction-1",
                source: source,
                destination: .existingNote(noteId: note, expectedRevision: 2)
            )
        )

        let invalidResult = #"{"outcome":"applied","decisionId":"dec_00000000000000000000000000","source":{"noteId":"note_00000000000000000000000000","currentRevision":3,"mutationId":"mut_00000000000000000000000000"},"destination":{"type":"new_note","noteId":"note_11111111111111111111111111","currentRevision":1,"mutationId":"mut_00000000000000000000000000"},"replayed":false}"#
        XCTAssertThrowsError(
            try APIJSON.makeDecoder().decode(
                DecisionCorrectionResponse.self,
                from: Data(invalidResult.utf8)
            )
        )
    }

    func testCorrectionResponseDiscriminatesAppliedAndNeedsReviewStrictly() throws {
        let decoder = APIJSON.makeDecoder()
        guard case let .applied(applied) = try decoder.decode(
            DecisionCorrectionResponse.self,
            from: Data(Self.correctionResponseJSON.utf8)
        ) else {
            return XCTFail("Expected applied correction outcome")
        }
        XCTAssertEqual(applied.destination.note.currentRevision, 5)

        let needsReview = #"{"outcome":"needs_review","decisionId":"dec_00000000000000000000000000","reviewItemId":"rvw_00000000000000000000000000","reasonCode":"exact_inverse_unavailable","replayed":false}"#
        guard case let .needsReview(review) = try decoder.decode(
            DecisionCorrectionResponse.self,
            from: Data(needsReview.utf8)
        ) else {
            return XCTFail("Expected needs-review correction outcome")
        }
        XCTAssertEqual(review.reasonCode, .exactInverseUnavailable)

        for invalid in [
            needsReview.replacingOccurrences(
                of: "exact_inverse_unavailable",
                with: "revision_conflict"
            ),
            needsReview.replacingOccurrences(
                of: #","replayed":false"#,
                with: #","source":{},"replayed":false"#
            ),
            Self.correctionResponseJSON.replacingOccurrences(of: "applied", with: "unknown")
        ] {
            XCTAssertThrowsError(
                try decoder.decode(DecisionCorrectionResponse.self, from: Data(invalid.utf8))
            )
        }
    }

    func testBatchUndoResponseIsBoundedUniqueAndOmitsNestedReplay() throws {
        let decoder = APIJSON.makeDecoder()
        let valid = #"{"members":[\#(Self.batchUndoMemberJSON)],"replayed":false}"#
        let response = try decoder.decode(MutationBatchUndoResponse.self, from: Data(valid.utf8))
        XCTAssertEqual(response.members.count, 1)

        let duplicate = #"{"members":[\#(Self.batchUndoMemberJSON),\#(Self.batchUndoMemberJSON)],"replayed":false}"#
        let nestedReplay = Self.batchUndoMemberJSON.replacingOccurrences(
            of: #","undo":"#,
            with: #","replayed":false,"undo":"#
        )
        let wrongRevisionNote = Self.batchUndoMemberJSON.replacingOccurrences(
            of: #""noteId":"note_00000000000000000000000000""#,
            with: #""noteId":"note_11111111111111111111111111""#
        )
        let staleRevision = Self.batchUndoMemberJSON.replacingOccurrences(
            of: #""revision":5,"source""#,
            with: #""revision":4,"source""#
        )
        let recursivelyEligible = Self.batchUndoMemberJSON.replacingOccurrences(
            of: #""eligible":false"#,
            with: #""eligible":true"#
        )
        let recursiveExpiry = Self.batchUndoMemberJSON.replacingOccurrences(
            of: #""expiresAt":null"#,
            with: #""expiresAt":"2026-09-01T12:06:00Z""#
        )
        for invalid in [
            #"{"members":[],"replayed":false}"#,
            duplicate,
            #"{"members":[\#(nestedReplay)],"replayed":false}"#,
            #"{"members":[\#(wrongRevisionNote)],"replayed":false}"#,
            #"{"members":[\#(staleRevision)],"replayed":false}"#,
            #"{"members":[\#(recursivelyEligible)],"replayed":false}"#,
            #"{"members":[\#(recursiveExpiry)],"replayed":false}"#
        ] {
            XCTAssertThrowsError(
                try decoder.decode(MutationBatchUndoResponse.self, from: Data(invalid.utf8)),
                invalid
            )
        }
    }

    func testReviewSemanticMatrixRejectsMismatchedProposalsAndResolutions() throws {
        let decoder = APIJSON.makeDecoder()
        let plan = #"{"schemaVersion":1,"captureKind":"list_items","decision":"create_note","destination":{"candidateId":null,"newNote":{"title":"Groceries","noteType":"list","spaceCandidateId":null}},"operations":[{"type":"append_list_items","section":null,"items":["oat milk"]}],"generatedExpansion":null,"alternatives":[],"reasonCodes":["explicit_shopping_intent"]}"#
        let route = #"{"type":"route_capture","plan":\#(plan)}"#
        let revisionConflict = #"{"type":"conflict","reason":"revision"}"#
        let failed = #"{"type":"failed_job","errorCode":"provider_unavailable"}"#
        let duplicates = #"{"type":"duplicate_notes","notes":[{"noteId":"note_00000000000000000000000000","revision":1},{"noteId":"note_11111111111111111111111111","revision":2}],"explanation":"These notes describe the same weekly plan."}"#
        let generated = #"{"type":"generated_block","blockId":"blk_00000000000000000000000000"}"#
        let consentHold = #"{"type":"conflict","reason":"consent_controls"}"#
        let structure = #"{"type":"conflict","reason":"structure"}"#

        func fixture(
            type: String,
            proposal: String,
            state: String = "open",
            resolution: String = "null",
            resolvedAt: String = "null"
        ) -> String {
            #"{"id":"rvw_00000000000000000000000000","captureId":null,"noteId":null,"type":"\#(type)","proposal":\#(proposal),"state":"\#(state)","resolution":\#(resolution),"createdAt":"2026-09-01T12:00:00Z","resolvedAt":\#(resolvedAt)}"#
        }

        for valid in [
            fixture(type: "low_confidence", proposal: route),
            fixture(type: "revision_conflict", proposal: revisionConflict),
            fixture(type: "failed_job", proposal: failed),
            fixture(type: "duplicate_suggestion", proposal: duplicates),
            fixture(type: "pending_expansion", proposal: generated),
            fixture(type: "pending_expansion", proposal: consentHold),
            fixture(type: "structure_conflict", proposal: structure),
            fixture(
                type: "duplicate_suggestion",
                proposal: duplicates,
                state: "resolved",
                resolution: #"{"type":"keep_both"}"#,
                resolvedAt: #""2026-09-01T12:01:00Z""#
            ),
            fixture(
                type: "pending_expansion",
                proposal: generated,
                state: "resolved",
                resolution: #"{"type":"accept_expansion"}"#,
                resolvedAt: #""2026-09-01T12:01:00Z""#
            ),
            fixture(
                type: "failed_job",
                proposal: failed,
                state: "resolved",
                resolution: #"{"type":"keep_inbox"}"#,
                resolvedAt: #""2026-09-01T12:01:00Z""#
            )
        ] {
            XCTAssertNoThrow(try decoder.decode(ReviewItem.self, from: Data(valid.utf8)), valid)
        }

        for invalid in [
            fixture(type: "low_confidence", proposal: structure),
            fixture(type: "duplicate_suggestion", proposal: route),
            fixture(
                type: "duplicate_suggestion",
                proposal: duplicates,
                state: "resolved",
                resolution: #"{"type":"keep_inbox"}"#,
                resolvedAt: #""2026-09-01T12:01:00Z""#
            ),
            fixture(
                type: "pending_expansion",
                proposal: consentHold,
                state: "resolved",
                resolution: #"{"type":"accept_expansion"}"#,
                resolvedAt: #""2026-09-01T12:01:00Z""#
            ),
            fixture(
                type: "pending_expansion",
                proposal: generated,
                state: "dismissed",
                resolution: #"{"type":"dismiss"}"#,
                resolvedAt: #""2026-09-01T12:01:00Z""#
            ),
            fixture(
                type: "failed_job",
                proposal: failed,
                state: "resolved",
                resolution: #"{"type":"keep_both"}"#,
                resolvedAt: #""2026-09-01T12:01:00Z""#
            ),
            fixture(
                type: "failed_job",
                proposal: failed,
                state: "resolved",
                resolution: #"{"type":"route","noteId":"note_00000000000000000000000000","expectedRevision":1}"#,
                resolvedAt: #""2026-09-01T12:01:00Z""#
            ),
            fixture(
                type: "failed_job",
                proposal: failed,
                state: "resolved",
                resolution: #"{"type":"create","title":"Retry","noteType":"generic","spaceId":null}"#,
                resolvedAt: #""2026-09-01T12:01:00Z""#
            )
        ] {
            XCTAssertThrowsError(try decoder.decode(ReviewItem.self, from: Data(invalid.utf8)), invalid)
        }
    }

    func testCorrectionRequestConstructionRejectsInvalidDestinationValues() throws {
        let sourceNote = try NoteID(validating: "note_00000000000000000000000000")
        let destinationNote = try NoteID(validating: "note_11111111111111111111111111")
        let source = try CorrectionSource(noteId: sourceNote, expectedRevision: 1)
        XCTAssertThrowsError(try CorrectionSource(noteId: sourceNote, expectedRevision: 0))
        XCTAssertThrowsError(
            try DecisionCorrectionRequest(
                idempotencyKey: "bad key",
                source: source,
                destination: .existingNote(noteId: destinationNote, expectedRevision: 1)
            )
        )

        for revision in [0, -1] {
            let destination = CorrectionDestination.existingNote(
                noteId: destinationNote,
                expectedRevision: revision
            )
            XCTAssertThrowsError(
                try DecisionCorrectionRequest(
                    idempotencyKey: "correction-invalid-revision-\(revision)",
                    source: source,
                    destination: destination
                )
            )
            XCTAssertThrowsError(try APIJSON.makeEncoder().encode(destination))
        }

        for title in [" \t\n ", String(repeating: "a", count: 201)] {
            let destination = CorrectionDestination.newNote(
                title: title,
                noteType: .generic,
                spaceId: nil
            )
            XCTAssertThrowsError(
                try DecisionCorrectionRequest(
                    idempotencyKey: "correction-invalid-title",
                    source: source,
                    destination: destination
                )
            )
            XCTAssertThrowsError(try APIJSON.makeEncoder().encode(destination))
        }

        let normalized = try DecisionCorrectionRequest(
            idempotencyKey: "correction-valid-title",
            source: source,
            destination: .newNote(
                title: "  \(String(repeating: "a", count: 200))  ",
                noteType: .generic,
                spaceId: nil
            )
        )
        let encoded = try XCTUnwrap(
            JSONSerialization.jsonObject(with: APIJSON.makeEncoder().encode(normalized))
                as? [String: Any]
        )
        let destination = try XCTUnwrap(encoded["destination"] as? [String: Any])
        XCTAssertEqual(destination["title"] as? String, String(repeating: "a", count: 200))

        let invalidFixtures = [
            #"{"idempotencyKey":"correction-decode-1","source":{"noteId":"note_00000000000000000000000000","expectedRevision":0},"destination":{"type":"existing_note","noteId":"note_11111111111111111111111111","expectedRevision":1}}"#,
            #"{"idempotencyKey":"correction-decode-2","source":{"noteId":"note_00000000000000000000000000","expectedRevision":1},"destination":{"type":"existing_note","noteId":"note_00000000000000000000000000","expectedRevision":1}}"#,
            #"{"idempotencyKey":"correction-decode-3","source":{"noteId":"note_00000000000000000000000000","expectedRevision":1},"destination":{"type":"new_note","title":"   ","noteType":"generic","spaceId":null}}"#,
            #"{"idempotencyKey":"correction-decode-4","source":{"noteId":"note_00000000000000000000000000","expectedRevision":1,"extra":true},"destination":{"type":"existing_note","noteId":"note_11111111111111111111111111","expectedRevision":1}}"#
        ]
        for fixture in invalidFixtures {
            XCTAssertThrowsError(
                try APIJSON.makeDecoder().decode(
                    DecisionCorrectionRequest.self,
                    from: Data(fixture.utf8)
                ),
                fixture
            )
        }
    }

    func testMutationUndoRequestFailsClosedAndBothRoutesUseValidatedBody() async throws {
        for revision in [0, -1] {
            XCTAssertThrowsError(
                try MutationUndoRequest(
                    expectedRevision: revision,
                    idempotencyKey: "undo-invalid-\(revision)"
                )
            )
        }
        XCTAssertThrowsError(
            try MutationUndoRequest(expectedRevision: 1, idempotencyKey: "bad key")
        )
        for invalid in [
            #"{"expectedRevision":0,"idempotencyKey":"undo-decode-1"}"#,
            #"{"expectedRevision":1,"idempotencyKey":"bad key"}"#,
            #"{"expectedRevision":1,"idempotencyKey":"undo-decode-2","extra":true}"#
        ] {
            XCTAssertThrowsError(
                try APIJSON.makeDecoder().decode(
                    MutationUndoRequest.self,
                    from: Data(invalid.utf8)
                )
            )
        }

        let provider = APITokenProviderStub()
        let client = try makeStubbedAPIClient(tokenProvider: provider)
        let mutation = try MutationID(validating: "mut_00000000000000000000000000")
        let request = try MutationUndoRequest(
            expectedRevision: 5,
            idempotencyKey: "undo-validated-1"
        )

        APIURLProtocolStub.install { urlRequest in
            XCTAssertEqual(urlRequest.url?.path, "/api/v1/mutations/\(mutation.rawValue)/undo")
            XCTAssertEqual(urlRequest.value(forHTTPHeaderField: "Idempotency-Key"), "undo-validated-1")
            return apiResponse(for: urlRequest, json: Self.mutationResultJSON)
        }
        _ = try await client.undoMutation(mutation, request: request)

        APIURLProtocolStub.install { urlRequest in
            XCTAssertEqual(
                urlRequest.url?.path,
                "/api/v1/mutation-batches/\(mutation.rawValue)/undo"
            )
            XCTAssertEqual(urlRequest.value(forHTTPHeaderField: "Idempotency-Key"), "undo-validated-1")
            return apiResponse(
                for: urlRequest,
                json: #"{"members":[\#(Self.batchUndoMemberJSON)],"replayed":false}"#
            )
        }
        _ = try await client.undoMutationBatch(mutation, request: request)
    }

    func testRoutingAndGeneratedBlockModelsFailClosed() throws {
        let decoder = APIJSON.makeDecoder()
        let rule = #"{"id":"rule_00000000000000000000000000","revision":1,"enabled":true,"ruleType":"prefix","condition":"gym:","destination":{"type":"note","noteId":"note_00000000000000000000000000"},"priority":10,"normalizedCondition":"gym","aliases":[],"source":"explicit","proposalState":null,"destinationStatus":"active","lastFiredAt":null,"createdAt":"2026-09-01T12:00:00Z","updatedAt":"2026-09-01T12:00:00Z"}"#
        XCTAssertNoThrow(try decoder.decode(RoutingRule.self, from: Data(rule.utf8)))
        XCTAssertThrowsError(
            try decoder.decode(
                RoutingRule.self,
                from: Data((rule.dropLast() + #", "plaintextCondition":"gym"}"#).utf8)
            )
        )

        let proposed = Self.generatedBlockJSON(
            state: "proposed",
            stateRevision: 1,
            resolvedAt: "null"
        )
        let accepted = Self.generatedBlockJSON(
            state: "accepted",
            stateRevision: 2,
            resolvedAt: #""2026-09-01T12:01:00Z""#
        )
        XCTAssertNoThrow(try decoder.decode(GeneratedBlock.self, from: Data(proposed.utf8)))
        XCTAssertNoThrow(try decoder.decode(GeneratedBlock.self, from: Data(accepted.utf8)))
        XCTAssertThrowsError(
            try decoder.decode(
                GeneratedBlock.self,
                from: Data(
                    Self.generatedBlockJSON(
                        state: "accepted",
                        stateRevision: 2,
                        resolvedAt: "null"
                    ).utf8
                )
            )
        )
        XCTAssertThrowsError(
            try decoder.decode(
                GeneratedBlock.self,
                from: Data(
                    Self.generatedBlockJSON(
                        state: "accepted",
                        stateRevision: 1,
                        resolvedAt: #""2026-09-01T12:01:00Z""#
                    ).utf8
                )
            )
        )
        XCTAssertThrowsError(
            try decoder.decode(
                GeneratedBlock.self,
                from: Data(
                    Self.generatedBlockJSON(
                        state: "accepted",
                        stateRevision: 2,
                        resolvedAt: #""2026-09-01T11:59:59Z""#
                    ).utf8
                )
            )
        )

        let duplicateList = #"{"items":[\#(proposed),\#(proposed)],"pageInfo":{"hasMore":false,"nextCursor":null}}"#
        XCTAssertThrowsError(
            try decoder.decode(
                GeneratedBlockListResponse.self,
                from: Data(duplicateList.utf8)
            )
        )
        for key in ["", " bad key", String(repeating: "a", count: 81)] {
            XCTAssertThrowsError(
                try GeneratedBlockResolveRequest(
                    expectedStateRevision: 1,
                    idempotencyKey: key,
                    resolution: .accept
                )
            )
        }
    }

    func testGeneratedBlockReadResponsesRejectHiddenLifecycleState() throws {
        let decoder = APIJSON.makeDecoder()
        let rejected = Self.generatedBlockJSON(
            state: "rejected",
            stateRevision: 2,
            resolvedAt: #""2026-09-01T12:01:00Z""#
        )

        XCTAssertThrowsError(
            try decoder.decode(
                GeneratedBlockListResponse.self,
                from: Data(
                    #"{"items":[\#(rejected)],"pageInfo":{"hasMore":false,"nextCursor":null}}"#.utf8
                )
            )
        )
        XCTAssertThrowsError(
            try decoder.decode(
                GeneratedBlockDetailResponse.self,
                from: Data(#"{"block":\#(rejected)}"#.utf8)
            )
        )

        let resolve = try decoder.decode(
            GeneratedBlockResolveResponse.self,
            from: Data(#"{"block":\#(rejected),"replayed":true}"#.utf8)
        )
        XCTAssertEqual(resolve.block.state, .rejected)
        XCTAssertTrue(resolve.replayed)
    }

    func testGeneratedBlockClientRejectsCrossNoteListsAndSubstitutedResolveResults() async throws {
        let provider = APITokenProviderStub()
        let client = try makeStubbedAPIClient(tokenProvider: provider)
        let noteID = try NoteID(validating: "note_00000000000000000000000000")
        let otherNoteID = "note_11111111111111111111111111"
        let proposed = Self.generatedBlockJSON(
            state: "proposed",
            stateRevision: 1,
            resolvedAt: "null"
        )
        let crossNote = proposed.replacingOccurrences(
            of: noteID.rawValue,
            with: otherNoteID
        )
        APIURLProtocolStub.install { request in
            XCTAssertEqual(
                request.url?.path,
                "/api/v1/notes/\(noteID.rawValue)/generated-blocks"
            )
            return apiResponse(
                for: request,
                json: #"{"items":[\#(crossNote)],"pageInfo":{"hasMore":false,"nextCursor":null}}"#
            )
        }
        do {
            _ = try await client.listGeneratedBlocks(noteId: noteID)
            XCTFail("Expected the client to reject a cross-note block list")
        } catch {
            XCTAssertEqual(error as? APIClientError, .malformedResponse(status: 200))
        }

        let blockID = try BlockID(validating: "blk_00000000000000000000000000")
        let request = try GeneratedBlockResolveRequest(
            expectedStateRevision: 1,
            idempotencyKey: "block-binding-1",
            resolution: .accept
        )
        APIURLProtocolStub.install { urlRequest in
            let rejected = Self.generatedBlockJSON(
                state: "rejected",
                stateRevision: 2,
                resolvedAt: #""2026-09-01T12:01:00Z""#
            )
            return apiResponse(
                for: urlRequest,
                json: #"{"block":\#(rejected),"replayed":false}"#
            )
        }
        do {
            _ = try await client.resolveGeneratedBlock(blockID, request: request)
            XCTFail("Expected the client to reject the wrong terminal state")
        } catch {
            XCTAssertEqual(error as? APIClientError, .malformedResponse(status: 200))
        }
    }

    func testGeneratedBlockPagesRequireExactBoundedCursorContract() throws {
        let decoder = APIJSON.makeDecoder()
        let firstPageJSON = Self.generatedBlockPageJSON(range: 0 ..< 50, hasMore: true)
        let firstPage = try decoder.decode(
            GeneratedBlockListResponse.self,
            from: Data(firstPageJSON.utf8)
        )
        XCTAssertEqual(firstPage.items.count, 50)
        XCTAssertEqual(firstPage.pageInfo.nextCursor, Self.generatedBlockID(49))

        let shortContinuingPage = Self.generatedBlockPageJSON(range: 0 ..< 1, hasMore: true)
        XCTAssertThrowsError(
            try decoder.decode(
                GeneratedBlockListResponse.self,
                from: Data(shortContinuingPage.utf8)
            )
        )

        let descendingItems = [
            Self.generatedBlockJSON(
                id: Self.generatedBlockID(2),
                state: "proposed",
                stateRevision: 1,
                resolvedAt: "null"
            ),
            Self.generatedBlockJSON(
                id: Self.generatedBlockID(1),
                state: "proposed",
                stateRevision: 1,
                resolvedAt: "null"
            )
        ].joined(separator: ",")
        XCTAssertThrowsError(
            try decoder.decode(
                GeneratedBlockListResponse.self,
                from: Data(
                    #"{"items":[\#(descendingItems)],"pageInfo":{"hasMore":false,"nextCursor":null}}"#.utf8
                )
            )
        )

        let wrongCursor = firstPageJSON.replacingOccurrences(
            of: Self.generatedBlockID(49),
            with: Self.generatedBlockID(48),
            options: [],
            range: firstPageJSON.range(of: Self.generatedBlockID(49), options: .backwards)
        )
        XCTAssertThrowsError(
            try decoder.decode(
                GeneratedBlockListResponse.self,
                from: Data(wrongCursor.utf8)
            )
        )

        let block = Self.generatedBlockJSON(
            state: "proposed",
            stateRevision: 1,
            resolvedAt: "null"
        )
        XCTAssertNoThrow(
            try decoder.decode(
                GeneratedBlockDetailResponse.self,
                from: Data(#"{"block":\#(block)}"#.utf8)
            )
        )
        XCTAssertThrowsError(
            try decoder.decode(
                GeneratedBlockDetailResponse.self,
                from: Data(#"{"block":\#(block),"unexpected":true}"#.utf8)
            )
        )
    }

    func testGeneratedBlockClientBuildsCursorQueryAndBindsExactReviewLookup() async throws {
        let provider = APITokenProviderStub()
        let client = try makeStubbedAPIClient(tokenProvider: provider)
        let noteID = try NoteID(validating: "note_00000000000000000000000000")
        let cursor = Self.generatedBlockID(49)
        let nextBlockID = try BlockID(validating: Self.generatedBlockID(50))
        let nextBlock = Self.generatedBlockJSON(
            id: nextBlockID.rawValue,
            state: "proposed",
            stateRevision: 1,
            resolvedAt: "null"
        )

        APIURLProtocolStub.install { request in
            XCTAssertEqual(
                request.url?.path,
                "/api/v1/notes/\(noteID.rawValue)/generated-blocks"
            )
            XCTAssertEqual(
                URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?
                    .queryItems,
                [URLQueryItem(name: "cursor", value: cursor)]
            )
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cache-Control"), "no-store")
            return apiResponse(
                for: request,
                json: #"{"items":[\#(nextBlock)],"pageInfo":{"hasMore":false,"nextCursor":null}}"#
            )
        }
        let page = try await client.listGeneratedBlocks(noteId: noteID, after: cursor)
        XCTAssertEqual(page.items.map(\.id), [nextBlockID])

        let reviewBlockID = try BlockID(validating: Self.generatedBlockID(1_001))
        let reviewBlock = Self.generatedBlockJSON(
            id: reviewBlockID.rawValue,
            state: "proposed",
            stateRevision: 1,
            resolvedAt: "null"
        )
        APIURLProtocolStub.install { request in
            XCTAssertEqual(
                request.url?.path,
                "/api/v1/generated-blocks/\(reviewBlockID.rawValue)"
            )
            XCTAssertEqual(request.url?.query, nil)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cache-Control"), "no-store")
            return apiResponse(for: request, json: #"{"block":\#(reviewBlock)}"#)
        }
        let detail = try await client.getGeneratedBlock(
            reviewBlockID,
            expectedNoteId: noteID
        )
        XCTAssertEqual(detail.block.id, reviewBlockID)

        APIURLProtocolStub.install { request in
            let rejected = Self.generatedBlockJSON(
                id: reviewBlockID.rawValue,
                state: "rejected",
                stateRevision: 2,
                resolvedAt: #""2026-09-01T12:01:00Z""#
            )
            return apiResponse(for: request, json: #"{"block":\#(rejected)}"#)
        }
        do {
            _ = try await client.getGeneratedBlock(reviewBlockID, expectedNoteId: noteID)
            XCTFail("Expected exact read to reject a hidden lifecycle state")
        } catch {
            XCTAssertEqual(error as? APIClientError, .malformedResponse(status: 200))
        }

        let otherNoteID = "note_11111111111111111111111111"
        APIURLProtocolStub.install { request in
            let substituted = reviewBlock.replacingOccurrences(
                of: noteID.rawValue,
                with: otherNoteID
            )
            return apiResponse(for: request, json: #"{"block":\#(substituted)}"#)
        }
        do {
            _ = try await client.getGeneratedBlock(reviewBlockID, expectedNoteId: noteID)
            XCTFail("Expected the exact lookup to reject a cross-note block")
        } catch {
            XCTAssertEqual(error as? APIClientError, .malformedResponse(status: 200))
        }

        APIURLProtocolStub.install { request in
            let substituted = reviewBlock.replacingOccurrences(
                of: reviewBlockID.rawValue,
                with: Self.generatedBlockID(1_002)
            )
            return apiResponse(for: request, json: #"{"block":\#(substituted)}"#)
        }
        do {
            _ = try await client.getGeneratedBlock(reviewBlockID, expectedNoteId: noteID)
            XCTFail("Expected the exact lookup to reject a substituted block ID")
        } catch {
            XCTAssertEqual(error as? APIClientError, .malformedResponse(status: 200))
        }

        do {
            _ = try await client.listGeneratedBlocks(noteId: noteID, after: "blk_invalid")
            XCTFail("Expected an invalid cursor to fail before transport")
        } catch {
            XCTAssertEqual(error as? APIClientError, .invalidRequest)
        }
    }

    func testGeneratedBlockAppModelPaginationMergesPagesAndRejectsReplay() throws {
        let decoder = APIJSON.makeDecoder()
        let first = try decoder.decode(
            GeneratedBlockListResponse.self,
            from: Data(Self.generatedBlockPageJSON(range: 0 ..< 50, hasMore: true).utf8)
        )
        let second = try decoder.decode(
            GeneratedBlockListResponse.self,
            from: Data(Self.generatedBlockPageJSON(range: 50 ..< 52, hasMore: false).utf8)
        )
        var state = try GeneratedBlockPaginationState(first: first)
        try state.append(second, after: Self.generatedBlockID(49))
        XCTAssertEqual(state.items.count, 52)
        XCTAssertEqual(state.pageCount, 2)
        XCTAssertNil(state.nextCursor)
        XCTAssertEqual(GeneratedBlockPaginationState.maximumItemCount, 1_000)
        XCTAssertEqual(GeneratedBlockPaginationState.maximumPageCount, 20)

        var replayState = try GeneratedBlockPaginationState(first: first)
        XCTAssertThrowsError(
            try replayState.append(first, after: Self.generatedBlockID(49))
        )
        XCTAssertEqual(replayState.items.count, 50)
        XCTAssertEqual(replayState.pageCount, 1)
        XCTAssertEqual(replayState.nextCursor, Self.generatedBlockID(49))
    }

    func testGeneratedBlockDisplayLimitRetainsOneThousandAndStillAppliesResolution() throws {
        let decoder = APIJSON.makeDecoder()
        let first = try decoder.decode(
            GeneratedBlockListResponse.self,
            from: Data(Self.generatedBlockPageJSON(range: 0 ..< 50, hasMore: true).utf8)
        )
        var state = try GeneratedBlockPaginationState(first: first)
        for pageIndex in 1 ..< GeneratedBlockPaginationState.maximumPageCount {
            let start = pageIndex * 50
            let page = try decoder.decode(
                GeneratedBlockListResponse.self,
                from: Data(
                    Self.generatedBlockPageJSON(
                        range: start ..< (start + 50),
                        hasMore: true
                    ).utf8
                )
            )
            try state.append(page, after: state.nextCursor)
        }

        XCTAssertEqual(state.items.count, 1_000)
        XCTAssertEqual(state.pageCount, 20)
        XCTAssertFalse(state.canLoadMore)
        XCTAssertTrue(state.reachedDisplayLimit)

        let pageTwentyOne = try decoder.decode(
            GeneratedBlockListResponse.self,
            from: Data(
                Self.generatedBlockPageJSON(range: 1_000 ..< 1_050, hasMore: false).utf8
            )
        )
        XCTAssertThrowsError(try state.append(pageTwentyOne, after: state.nextCursor))
        XCTAssertEqual(state.items.count, 1_000)

        let accepted = try decoder.decode(
            GeneratedBlock.self,
            from: Data(
                Self.generatedBlockJSON(
                    id: Self.generatedBlockID(999),
                    state: "accepted",
                    stateRevision: 2,
                    resolvedAt: #""2026-09-01T12:01:00Z""#
                ).utf8
            )
        )
        state.replace(accepted)
        XCTAssertEqual(state.items.count, 1_000)
        XCTAssertEqual(state.items.last?.state, .accepted)
        XCTAssertTrue(state.reachedDisplayLimit)
    }

    func testGeneratedBlockResolutionValidationPreservesImmutableContentAndLineage() throws {
        let decoder = APIJSON.makeDecoder()
        let current = try decoder.decode(
            GeneratedBlock.self,
            from: Data(
                Self.generatedBlockJSON(
                    state: "proposed",
                    stateRevision: 1,
                    resolvedAt: "null"
                ).utf8
            )
        )
        let request = try GeneratedBlockResolveRequest(
            expectedStateRevision: 1,
            idempotencyKey: "block-validation-1",
            resolution: .accept
        )
        let acceptedJSON = Self.generatedBlockJSON(
            state: "accepted",
            stateRevision: 2,
            resolvedAt: #""2026-09-01T12:01:00Z""#
        )
        let response = try decoder.decode(
            GeneratedBlockResolveResponse.self,
            from: Data(#"{"block":\#(acceptedJSON),"replayed":false}"#.utf8)
        )
        XCTAssertTrue(
            AppModel.generatedBlockResolutionResponse(
                response,
                matches: current,
                request: request
            )
        )

        let changedContent = acceptedJSON.replacingOccurrences(
            of: "A safe summary",
            with: "Different server content"
        )
        let substituted = try decoder.decode(
            GeneratedBlockResolveResponse.self,
            from: Data(#"{"block":\#(changedContent),"replayed":false}"#.utf8)
        )
        XCTAssertFalse(
            AppModel.generatedBlockResolutionResponse(
                substituted,
                matches: current,
                request: request
            )
        )
    }

    func testReplayedGeneratedBlockRejectAppliesTerminalResponseAndHidesProposal() throws {
        let decoder = APIJSON.makeDecoder()
        let current = try decoder.decode(
            GeneratedBlock.self,
            from: Data(
                Self.generatedBlockJSON(
                    state: "proposed",
                    stateRevision: 1,
                    resolvedAt: "null"
                ).utf8
            )
        )
        let request = try GeneratedBlockResolveRequest(
            expectedStateRevision: 1,
            idempotencyKey: "block-replayed-reject-1",
            resolution: .reject
        )
        let rejectedJSON = Self.generatedBlockJSON(
            state: "rejected",
            stateRevision: 2,
            resolvedAt: #""2026-09-01T12:01:00Z""#
        )
        let response = try decoder.decode(
            GeneratedBlockResolveResponse.self,
            from: Data(#"{"block":\#(rejectedJSON),"replayed":true}"#.utf8)
        )

        XCTAssertTrue(response.replayed)
        let resolved = try XCTUnwrap(
            AppModel.generatedBlockResolutionResult(
                response,
                matches: current,
                request: request
            )
        )
        XCTAssertEqual(resolved.state, .rejected)
        XCTAssertEqual(resolved.stateRevision, 2)

        let first = try decoder.decode(
            GeneratedBlockListResponse.self,
            from: Data(
                #"{"items":[\#(Self.generatedBlockJSON(state: "proposed", stateRevision: 1, resolvedAt: "null"))],"pageInfo":{"hasMore":false,"nextCursor":null}}"#.utf8
            )
        )
        var state = try GeneratedBlockPaginationState(first: first)
        state.replace(resolved)

        XCTAssertEqual(state.items.count, 1)
        XCTAssertEqual(state.items.first?.state, .rejected)
        XCTAssertTrue(
            GeneratedBlockVisibility.visible(
                state.items.map(PresentationMapping.generatedBlock)
            ).isEmpty
        )
    }

    func testStaleGeneratedBlockExact404RemovesThePendingLocalAction() throws {
        let notFound = APIClientError.http(
            status: 404,
            code: .notFound,
            requestId: "req-block-hidden",
            retryAfterSeconds: nil
        )
        XCTAssertTrue(AppModel.isGeneratedBlockVisibilityNotFound(notFound))
        XCTAssertFalse(
            AppModel.isGeneratedBlockVisibilityNotFound(
                APIClientError.http(
                    status: 403,
                    code: .forbidden,
                    requestId: "req-block-forbidden",
                    retryAfterSeconds: nil
                )
            )
        )

        let decoder = APIJSON.makeDecoder()
        let page = try decoder.decode(
            GeneratedBlockListResponse.self,
            from: Data(
                #"{"items":[\#(Self.generatedBlockJSON(state: "proposed", stateRevision: 1, resolvedAt: "null"))],"pageInfo":{"hasMore":false,"nextCursor":null}}"#.utf8
            )
        )
        var state = try GeneratedBlockPaginationState(first: page)
        let blockID = try XCTUnwrap(state.items.first?.id)

        XCTAssertTrue(state.remove(blockID))
        XCTAssertTrue(state.items.isEmpty)
        XCTAssertFalse(state.remove(blockID))
        XCTAssertTrue(
            GeneratedBlockVisibility.visible(
                state.items.map(PresentationMapping.generatedBlock)
            ).isEmpty
        )
    }

    func testCorrectionRoutingAndGeneratedBlockAPIRoutesCarryAuthAndIdempotency() async throws {
        let provider = APITokenProviderStub()
        let client = try makeStubbedAPIClient(tokenProvider: provider)
        let sourceNote = try NoteID(validating: "note_00000000000000000000000000")
        let destinationNote = try NoteID(validating: "note_11111111111111111111111111")
        let decision = try DecisionID(validating: "dec_00000000000000000000000000")
        let correction = try DecisionCorrectionRequest(
            idempotencyKey: "correction-1",
            source: try CorrectionSource(noteId: sourceNote, expectedRevision: 2),
            destination: .existingNote(noteId: destinationNote, expectedRevision: 4)
        )
        APIURLProtocolStub.install { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/v1/decisions/\(decision.rawValue)/correct")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer old-token")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), "correction-1")
            return apiResponse(for: request, json: Self.correctionResponseJSON)
        }
        let corrected = try await client.correctDecision(decision, request: correction)
        guard case let .applied(applied) = corrected else {
            return XCTFail("Expected applied correction response")
        }
        XCTAssertEqual(applied.destination.note.noteId, destinationNote)

        let batch = try MutationID(validating: "mut_22222222222222222222222222")
        APIURLProtocolStub.install { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/v1/mutation-batches/\(batch.rawValue)/undo")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), "batch-undo-1")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cache-Control"), "no-store")
            return apiResponse(
                for: request,
                json: #"{"members":[\#(Self.batchUndoMemberJSON)],"replayed":false}"#
            )
        }
        let batchResult = try await client.undoMutationBatch(
            batch,
            request: try MutationUndoRequest(
                expectedRevision: 5,
                idempotencyKey: "batch-undo-1"
            )
        )
        XCTAssertEqual(batchResult.members.count, 1)

        let ruleRequest = try RoutingRuleCreateRequest(
            idempotencyKey: "rule-create-1",
            enabled: true,
            ruleType: .prefix,
            condition: "gym:",
            destination: .note(destinationNote),
            priority: 10
        )
        APIURLProtocolStub.install { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/v1/routing-rules")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), "rule-create-1")
            return apiResponse(for: request, json: #"{"rule":\#(Self.routingRuleJSON),"replayed":false}"#)
        }
        _ = try await client.createRoutingRule(ruleRequest)

        let block = try BlockID(validating: "blk_00000000000000000000000000")
        let resolution = try GeneratedBlockResolveRequest(
            expectedStateRevision: 1,
            idempotencyKey: "block-resolve-1",
            resolution: .accept
        )
        APIURLProtocolStub.install { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/v1/generated-blocks/\(block.rawValue)/resolve")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), "block-resolve-1")
            return apiResponse(
                for: request,
                json: #"{"block":\#(Self.generatedBlockJSON(state: "accepted", stateRevision: 2, resolvedAt: #""2026-09-01T12:01:00Z""#)),"replayed":false}"#
            )
        }
        let resolved = try await client.resolveGeneratedBlock(block, request: resolution)
        XCTAssertEqual(resolved.block.state, .accepted)
    }

    private static let routingRuleJSON = #"{"id":"rule_00000000000000000000000000","revision":1,"enabled":true,"ruleType":"prefix","condition":"gym:","destination":{"type":"note","noteId":"note_11111111111111111111111111"},"priority":10,"normalizedCondition":"gym","aliases":[],"source":"explicit","proposalState":null,"destinationStatus":"active","lastFiredAt":null,"createdAt":"2026-09-01T12:00:00Z","updatedAt":"2026-09-01T12:00:00Z"}"#

    private static let correctionResponseJSON = #"{"outcome":"applied","decisionId":"dec_00000000000000000000000000","source":{"noteId":"note_00000000000000000000000000","currentRevision":3,"mutationId":"mut_00000000000000000000000000"},"destination":{"type":"existing_note","noteId":"note_11111111111111111111111111","currentRevision":5,"mutationId":"mut_11111111111111111111111111"},"replayed":false}"#

    private static let batchUndoMemberJSON = #"{"note":{"spaceId":null,"type":"generic","title":"Restored note","bodyMarkdown":"Body","structuredData":{"schemaVersion":1},"isOpen":true,"pinnedAt":null,"privacy":"ai_assisted","archivedAt":null,"deletedAt":null,"tagIds":[],"links":[],"id":"note_00000000000000000000000000","currentRevision":5,"createdAt":"2026-09-01T12:00:00Z","updatedAt":"2026-09-01T12:01:00Z"},"revision":{"spaceId":null,"type":"generic","title":"Restored note","bodyMarkdown":"Body","structuredData":{"schemaVersion":1},"isOpen":true,"pinnedAt":null,"privacy":"ai_assisted","archivedAt":null,"deletedAt":null,"tagIds":[],"links":[],"id":"rev_00000000000000000000000000","noteId":"note_00000000000000000000000000","revision":5,"source":"undo","contentHash":"0000000000000000000000000000000000000000000000000000000000000000","actor":"user","createdAt":"2026-09-01T12:01:00Z"},"mutationId":"mut_00000000000000000000000000","undo":{"eligible":false,"expiresAt":null}}"#

    private static var mutationResultJSON: String {
        batchUndoMemberJSON.replacingOccurrences(
            of: #","undo":"#,
            with: #","replayed":false,"undo":"#
        )
    }

    private static func generatedBlockJSON(
        id: String = "blk_00000000000000000000000000",
        noteID: String = "note_00000000000000000000000000",
        state: String,
        stateRevision: Int,
        resolvedAt: String
    ) -> String {
        #"{"id":"\#(id)","noteId":"\#(noteID)","decisionId":"dec_00000000000000000000000000","kind":"summary","content":"A safe summary","state":"\#(state)","stateRevision":\#(stateRevision),"modelId":"gpt-test","promptVersion":"v1","createdAt":"2026-09-01T12:00:00Z","resolvedAt":\#(resolvedAt)}"#
    }

    private static func generatedBlockID(_ value: Int) -> String {
        "blk_\(String(format: "%026d", value))"
    }

    private static func generatedBlockPageJSON(
        range: Range<Int>,
        hasMore: Bool
    ) -> String {
        let items = range.map { value in
            generatedBlockJSON(
                id: generatedBlockID(value),
                state: "proposed",
                stateRevision: 1,
                resolvedAt: "null"
            )
        }.joined(separator: ",")
        let nextCursor = hasMore
            ? #""\#(generatedBlockID(range.last ?? 0))""#
            : "null"
        return #"{"items":[\#(items)],"pageInfo":{"hasMore":\#(hasMore),"nextCursor":\#(nextCursor)}}"#
    }
}
