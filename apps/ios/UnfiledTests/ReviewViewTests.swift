import XCTest
@testable import Unfiled

@MainActor
final class ReviewViewTests: XCTestCase {
    private let item = ReviewPresentation(
        id: "rvw_00000000000000000000000000",
        type: .lowConfidence,
        original: "Roosevelt method: tell people you can do it, then figure it out.",
        proposedDestination: "Mindset / Principles",
        actionSummary: "Low-confidence destination",
        captureID: "cap_00000000000000000000000000",
        noteID: "note_00000000000000000000000000",
        suggestedDestinations: [
            ReviewDestinationPresentation(
                id: "note_00000000000000000000000000",
                title: "Mindset / Principles",
                revision: 2
            )
        ],
        suggestedNewNote: ReviewNewNotePresentation(
            title: "Mindset",
            noteType: .generic,
            spaceID: nil
        ),
        relatedNotes: [],
        allowedActions: [.route, .create, .keepInbox, .dismiss]
    )

    func testQueueSummaryUsesReadableCounts() {
        XCTAssertEqual(ReviewQueueSummary(count: 0).label, "Nothing awaiting review")
        XCTAssertEqual(ReviewQueueSummary(count: 1).label, "1 item awaiting review")
        XCTAssertEqual(ReviewQueueSummary(count: 4).label, "4 items awaiting review")
    }

    func testOpenNavigationHasStableAccessibilityIdentifier() {
        XCTAssertEqual(
            ReviewNavigation.identifier(for: item.id),
            "review.openNote.rvw_00000000000000000000000000"
        )
        XCTAssertEqual(
            ReviewAccessibilityIdentifier.choice(
                reviewID: item.id,
                noteID: "note_00000000000000000000000000"
            ),
            "review.choice.rvw_00000000000000000000000000.note_00000000000000000000000000"
        )
    }

    func testReviewViewCanBeConstructedWithActionCallbacks() {
        var openedNoteIDs: [String] = []
        var actions: [(String, ReviewUserAction)] = []
        _ = ReviewView(
            items: [item],
            isLoading: false,
            onOpenRelatedNote: { openedNoteIDs.append($0) },
            onAction: { actions.append(($0, $1)) }
        )
        XCTAssertTrue(openedNoteIDs.isEmpty)
        XCTAssertTrue(actions.isEmpty)
    }

    func testReviewActionMatrixMatchesE1AndExcludesExpansionAcceptance() throws {
        let route = try proposal(Self.routeProposalJSON)
        let revision = try proposal(#"{"type":"conflict","reason":"revision"}"#)
        let failed = try proposal(#"{"type":"failed_job","errorCode":"provider_unavailable"}"#)
        let candidate = try proposal(#"{"type":"conflict","reason":"candidate_eligibility"}"#)
        let structure = try proposal(#"{"type":"conflict","reason":"structure"}"#)
        let duplicate = try proposal(Self.duplicateProposalJSON)
        let generated = try proposal(
            #"{"type":"generated_block","blockId":"blk_00000000000000000000000000"}"#
        )
        let consent = try proposal(#"{"type":"conflict","reason":"consent_controls"}"#)
        let filingActions: [ReviewActionKind] = [.route, .create, .keepInbox, .dismiss]

        XCTAssertEqual(
            PresentationMapping.reviewAllowedActions(
                type: .lowConfidence,
                proposal: route,
                hasBoundReceipt: true,
                hasBoundDecision: true
            ),
            filingActions
        )
        XCTAssertEqual(
            PresentationMapping.reviewAllowedActions(
                type: .revisionConflict,
                proposal: revision,
                hasBoundReceipt: true,
                hasBoundDecision: true
            ),
            filingActions
        )
        XCTAssertEqual(
            PresentationMapping.reviewAllowedActions(
                type: .failedJob,
                proposal: failed,
                hasBoundReceipt: true,
                hasBoundDecision: true
            ),
            [.keepInbox, .dismiss]
        )
        XCTAssertEqual(
            PresentationMapping.reviewAllowedActions(
                type: .structureConflict,
                proposal: candidate,
                hasBoundReceipt: true,
                hasBoundDecision: true
            ),
            filingActions
        )
        XCTAssertEqual(
            PresentationMapping.reviewAllowedActions(
                type: .structureConflict,
                proposal: structure,
                hasBoundReceipt: true,
                hasBoundDecision: true
            ),
            filingActions
        )
        XCTAssertEqual(
            PresentationMapping.reviewAllowedActions(
                type: .duplicateSuggestion,
                proposal: duplicate,
                hasBoundReceipt: false,
                hasBoundDecision: false
            ),
            [.keepBoth, .dismiss]
        )
        XCTAssertEqual(
            PresentationMapping.reviewAllowedActions(
                type: .pendingExpansion,
                proposal: generated,
                hasBoundReceipt: false,
                hasBoundDecision: false
            ),
            [.dismiss]
        )
        XCTAssertEqual(
            PresentationMapping.reviewAllowedActions(
                type: .pendingExpansion,
                proposal: consent,
                hasBoundReceipt: false,
                hasBoundDecision: false
            ),
            [.dismiss]
        )
    }

    func testFilingActionsFailClosedWithoutAuthenticatedReceiptAndDecisionLineage() throws {
        let route = try proposal(Self.routeProposalJSON)
        XCTAssertEqual(
            PresentationMapping.reviewAllowedActions(
                type: .lowConfidence,
                proposal: route,
                hasBoundReceipt: false,
                hasBoundDecision: false
            ),
            [.dismiss]
        )
        XCTAssertEqual(
            PresentationMapping.reviewAllowedActions(
                type: .lowConfidence,
                proposal: route,
                hasBoundReceipt: true,
                hasBoundDecision: false
            ),
            [.keepInbox, .dismiss]
        )
    }

    func testFilingActionsRequireAnExactReviewReceiptBinding() throws {
        let review = try lowConfidenceReview()
        XCTAssertEqual(
            PresentationMapping.reviewAllowedActions(
                for: review,
                capture: try reviewCapture()
            ),
            [.route, .create, .keepInbox, .dismiss]
        )
        XCTAssertEqual(
            PresentationMapping.reviewAllowedActions(
                for: review,
                capture: try reviewCapture(
                    reviewID: "rvw_11111111111111111111111111"
                )
            ),
            [.dismiss]
        )
        XCTAssertEqual(
            PresentationMapping.reviewAllowedActions(
                for: review,
                capture: try reviewCapture(decisionID: nil)
            ),
            [.keepInbox, .dismiss]
        )
    }

    func testBatchUndoConflictReceiptOnlyAllowsAcknowledgementActions() throws {
        let review = try revisionConflictReview()
        XCTAssertEqual(
            PresentationMapping.reviewAllowedActions(
                for: review,
                capture: try reviewCapture(reasonCodes: ["conflict_requires_review"])
            ),
            [.keepInbox, .dismiss]
        )
        XCTAssertEqual(
            PresentationMapping.reviewAllowedActions(
                for: review,
                capture: try reviewCapture(reasonCodes: ["exact_inverse_unavailable"])
            ),
            [.route, .create, .keepInbox, .dismiss]
        )
    }

    func testTerminalReviewItemsNeverAdvertiseActions() throws {
        let capture = try reviewCapture()
        XCTAssertEqual(
            PresentationMapping.reviewAllowedActions(
                for: try lowConfidenceReview(
                    state: "resolved",
                    resolution: #"{"type":"keep_inbox"}"#,
                    resolvedAt: #""2026-09-01T12:01:00Z""#
                ),
                capture: capture
            ),
            []
        )
        XCTAssertEqual(
            PresentationMapping.reviewAllowedActions(
                for: try lowConfidenceReview(
                    state: "dismissed",
                    resolution: #"{"type":"dismiss"}"#,
                    resolvedAt: #""2026-09-01T12:01:00Z""#
                ),
                capture: capture
            ),
            []
        )
    }

    func testMismatchedReviewTypeAndProposalFailClosed() throws {
        let structure = try proposal(#"{"type":"conflict","reason":"structure"}"#)
        XCTAssertEqual(
            PresentationMapping.reviewAllowedActions(
                type: .lowConfidence,
                proposal: structure,
                hasBoundReceipt: true,
                hasBoundDecision: true
            ),
            []
        )
    }

    func testDestinationPickerPurposeHasStableScopedOperationID() {
        XCTAssertEqual(
            DestinationPickerPurpose.correction(
                captureID: "cap_00000000000000000000000000",
                decisionID: "dec_00000000000000000000000000",
                sourceNoteID: "note_00000000000000000000000000"
            ).operationID,
            "correction.dec_00000000000000000000000000"
        )
        XCTAssertEqual(
            DestinationPickerPurpose.review(
                reviewID: "rvw_00000000000000000000000000"
            ).operationID,
            "review.rvw_00000000000000000000000000"
        )
    }

    func testSuggestedDestinationEligibilityRejectsClosedArchivedAndDeletedNotes() throws {
        let open = try note(id: "note_11111111111111111111111111")
        let closed = try note(id: "note_22222222222222222222222222", isOpen: false)
        let archived = try note(
            id: "note_33333333333333333333333333",
            archivedAt: "2026-09-01T12:01:00Z"
        )
        let deleted = try note(
            id: "note_44444444444444444444444444",
            deletedAt: "2026-09-01T12:01:00Z"
        )

        XCTAssertTrue(PresentationMapping.reviewDestinationIsEligible(open))
        XCTAssertFalse(PresentationMapping.reviewDestinationIsEligible(closed))
        XCTAssertFalse(PresentationMapping.reviewDestinationIsEligible(archived))
        XCTAssertFalse(PresentationMapping.reviewDestinationIsEligible(deleted))
    }

    func testCorrectionDestinationFetchCannotSubstituteAnotherNote() throws {
        let requested = try NoteID(validating: "note_11111111111111111111111111")
        XCTAssertFalse(
            AppModel.fetchedNote(
                try note(id: "note_22222222222222222222222222"),
                matches: requested
            )
        )
    }

    func testCorrectionDestinationEligibilityRejectsClosedArchivedAndDeletedNotes() throws {
        let requested = try NoteID(validating: "note_11111111111111111111111111")
        XCTAssertEqual(
            try AppModel.validatedCorrectionDestination(
                note(id: requested.rawValue),
                matches: requested
            ),
            .existingNote(noteId: requested, expectedRevision: 2)
        )
        let ineligible = [
            try note(id: requested.rawValue, isOpen: false),
            try note(id: requested.rawValue, archivedAt: "2026-09-01T12:01:00Z"),
            try note(id: requested.rawValue, deletedAt: "2026-09-01T12:01:00Z")
        ]
        for destination in ineligible {
            XCTAssertThrowsError(
                try AppModel.validatedCorrectionDestination(destination, matches: requested)
            ) { error in
                XCTAssertEqual(error as? APIClientError, .invalidRequest)
            }
        }
    }

    func testReviewDestinationFetchCannotSubstituteAnotherNote() throws {
        let requested = try NoteID(validating: "note_33333333333333333333333333")
        XCTAssertTrue(
            AppModel.fetchedNote(
                try note(id: requested.rawValue),
                matches: requested
            )
        )
        XCTAssertFalse(
            AppModel.fetchedNote(
                try note(id: "note_44444444444444444444444444"),
                matches: requested
            )
        )
    }

    func testDestinationPickerInitialSelectionUsesVisibleEligibilityRules() {
        let closed = notePresentation(
            id: "note_11111111111111111111111111",
            isOpen: false
        )
        let archived = notePresentation(
            id: "note_22222222222222222222222222",
            archived: true
        )
        let eligible = notePresentation(id: "note_33333333333333333333333333")

        XCTAssertEqual(
            DestinationPickerView.initialSelectionID(
                notes: [closed, archived, eligible],
                purpose: .review(reviewID: item.id)
            ),
            eligible.id
        )
    }

    private func proposal(_ json: String) throws -> ReviewProposal {
        try APIJSON.makeDecoder().decode(ReviewProposal.self, from: Data(json.utf8))
    }

    private func lowConfidenceReview(
        state: String = "open",
        resolution: String = "null",
        resolvedAt: String = "null"
    ) throws -> ReviewItem {
        let json = #"{"id":"rvw_00000000000000000000000000","captureId":"cap_00000000000000000000000000","noteId":null,"type":"low_confidence","proposal":\#(Self.routeProposalJSON),"state":"\#(state)","resolution":\#(resolution),"createdAt":"2026-09-01T12:00:00Z","resolvedAt":\#(resolvedAt)}"#
        return try APIJSON.makeDecoder().decode(ReviewItem.self, from: Data(json.utf8))
    }

    private func revisionConflictReview() throws -> ReviewItem {
        let json = #"{"id":"rvw_00000000000000000000000000","captureId":"cap_00000000000000000000000000","noteId":null,"type":"revision_conflict","proposal":{"type":"conflict","reason":"revision"},"state":"open","resolution":null,"createdAt":"2026-09-01T12:00:00Z","resolvedAt":null}"#
        return try APIJSON.makeDecoder().decode(ReviewItem.self, from: Data(json.utf8))
    }

    private func reviewCapture(
        reviewID: String = "rvw_00000000000000000000000000",
        decisionID: String? = "dec_00000000000000000000000000",
        reasonCodes: [String] = ["low_confidence"]
    ) throws -> CaptureDetail {
        let encodedDecision = decisionID.map { #""\#($0)""# } ?? "null"
        let encodedReasonCodes = String(
            decoding: try JSONEncoder().encode(reasonCodes),
            as: UTF8.self
        )
        let json = #"{"id":"cap_00000000000000000000000000","rawContent":"oat milk","source":"mobile","deviceId":"device-1","privacy":"ai_assisted","explicitDestinationNoteId":null,"expansionDisabled":false,"clientCreatedAt":"2026-09-01T12:00:00Z","clientTimezone":"UTC","receivedAt":"2026-09-01T12:00:01Z","status":"needs_review","lastErrorCode":null,"jobId":"job_00000000000000000000000000","receipt":{"schemaVersion":1,"captureId":"cap_00000000000000000000000000","jobId":"job_00000000000000000000000000","decisionId":\#(encodedDecision),"reviewItemId":"\#(reviewID)","mutationId":null,"outcome":"needs_review","headline":"Needs review","destination":null,"insertedContent":[],"actions":[],"reasonCodes":\#(encodedReasonCodes),"createdAt":"2026-09-01T12:00:01Z"}}"#
        return try APIJSON.makeDecoder().decode(CaptureDetail.self, from: Data(json.utf8))
    }

    private func note(
        id: String,
        isOpen: Bool = true,
        archivedAt: String? = nil,
        deletedAt: String? = nil
    ) throws -> Note {
        let archived = archivedAt.map { #""\#($0)""# } ?? "null"
        let deleted = deletedAt.map { #""\#($0)""# } ?? "null"
        let json = #"{"spaceId":null,"type":"generic","title":"Destination","bodyMarkdown":"Body","structuredData":{"schemaVersion":1},"isOpen":\#(isOpen),"pinnedAt":null,"privacy":"ai_assisted","archivedAt":\#(archived),"deletedAt":\#(deleted),"tagIds":[],"links":[],"id":"\#(id)","currentRevision":2,"createdAt":"2026-09-01T12:00:00Z","updatedAt":"2026-09-01T12:00:00Z"}"#
        return try APIJSON.makeDecoder().decode(Note.self, from: Data(json.utf8))
    }

    private func notePresentation(
        id: String,
        isOpen: Bool = true,
        archived: Bool = false,
        deleted: Bool = false
    ) -> NotePresentation {
        NotePresentation(
            id: id,
            title: "Destination",
            type: "generic",
            preview: "Body",
            updatedLabel: "Now",
            updatedAt: "2026-09-01T12:00:00Z",
            spaceID: nil,
            currentRevision: 2,
            isOpen: isOpen,
            privacy: .aiAssisted,
            archived: archived,
            deleted: deleted,
            pinned: false
        )
    }

    private static let routePlanJSON = #"{"schemaVersion":1,"captureKind":"list_items","decision":"create_note","destination":{"candidateId":null,"newNote":{"title":"Groceries","noteType":"list","spaceCandidateId":null}},"operations":[{"type":"append_list_items","section":null,"items":["oat milk"]}],"generatedExpansion":null,"alternatives":[],"reasonCodes":["explicit_shopping_intent"]}"#

    private static let routeProposalJSON = #"{"type":"route_capture","plan":\#(routePlanJSON)}"#

    private static let duplicateProposalJSON = #"{"type":"duplicate_notes","notes":[{"noteId":"note_00000000000000000000000000","revision":1},{"noteId":"note_11111111111111111111111111","revision":2}]}"#
}
