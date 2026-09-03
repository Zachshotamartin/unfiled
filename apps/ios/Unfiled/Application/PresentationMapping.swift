import Foundation

enum PresentationMapping {
    static func note(_ value: Note, now: Date = Date()) -> NotePresentation {
        NotePresentation(
            id: value.id.rawValue,
            title: value.title,
            type: value.type.rawValue,
            preview: preview(value.bodyMarkdown),
            updatedLabel: relativeDate(value.updatedAt, now: now),
            updatedAt: APIJSON.dateString(value.updatedAt),
            spaceID: value.spaceId?.rawValue,
            currentRevision: value.currentRevision,
            isOpen: value.isOpen,
            privacy: value.privacy,
            archived: value.archivedAt != nil,
            deleted: value.deletedAt != nil,
            pinned: value.pinnedAt != nil
        )
    }

    static func note(_ value: NoteSummary, now: Date = Date()) -> NotePresentation {
        NotePresentation(
            id: value.id.rawValue,
            title: value.title,
            type: value.type.rawValue,
            preview: "Revision \(value.currentRevision)",
            updatedLabel: relativeDate(value.updatedAt, now: now),
            updatedAt: APIJSON.dateString(value.updatedAt),
            spaceID: value.spaceId?.rawValue,
            currentRevision: value.currentRevision,
            isOpen: value.isOpen,
            privacy: value.privacy,
            archived: value.archivedAt != nil,
            deleted: value.deletedAt != nil,
            pinned: value.pinnedAt != nil
        )
    }

    static func detail(_ value: Note, spaces: [Space]) -> NoteDetailPresentation {
        NoteDetailPresentation(
            id: value.id.rawValue,
            title: value.title,
            bodyMarkdown: value.bodyMarkdown,
            type: value.type.rawValue,
            privacy: value.privacy.rawValue,
            spacePath: spacePath(value.spaceId, spaces: spaces),
            currentRevision: value.currentRevision,
            checklistItems: checklist(value.structuredData),
            logEntries: logEntries(value.structuredData),
            provenance: nil
        )
    }

    static func detail(_ value: NoteRevision, spaces: [Space]) -> NoteDetailPresentation {
        NoteDetailPresentation(
            id: value.noteId.rawValue,
            title: value.title,
            bodyMarkdown: value.bodyMarkdown,
            type: value.type.rawValue,
            privacy: value.privacy.rawValue,
            spacePath: spacePath(value.spaceId, spaces: spaces),
            currentRevision: value.revision,
            checklistItems: checklist(value.structuredData),
            logEntries: logEntries(value.structuredData),
            provenance: "Read-only revision snapshot"
        )
    }

    static func space(_ value: Space, noteCount: Int) -> SpacePresentation {
        SpacePresentation(
            id: value.id.rawValue,
            name: value.name,
            parentID: value.parentId?.rawValue,
            noteCount: noteCount
        )
    }

    static func search(_ value: SearchNoteResult, now: Date = Date()) -> SearchResultPresentation {
        SearchResultPresentation(
            id: value.noteId.rawValue,
            title: value.title,
            snippet: value.snippet,
            type: value.type.rawValue,
            path: value.spacePath.joined(separator: " / "),
            updatedLabel: relativeDate(value.updatedAt, now: now)
        )
    }

    static func review(
        _ value: ReviewItem,
        notesByID: [String: Note] = [:],
        capturesByID: [String: CaptureDetail] = [:],
        generatedBlocksByID: [String: GeneratedBlock] = [:]
    ) -> ReviewPresentation {
        let capture = value.captureId.flatMap { capturesByID[$0.rawValue] }
        let generatedBlock: GeneratedBlock? = {
            guard case let .generatedBlock(blockID) = value.proposal,
                  let noteID = value.noteId,
                  let block = generatedBlocksByID[blockID.rawValue],
                  block.id == blockID,
                  block.noteId == noteID else { return nil }
            return block
        }()
        let summary = reviewProposalSummary(
            value.proposal,
            capture: capture,
            notesByID: notesByID
        )
        let suggestedDestinations = reviewSuggestedDestinations(
            value.proposal,
            notesByID: notesByID
        )
        let relatedNotes = reviewRelatedNotes(value.proposal, notesByID: notesByID)
        return ReviewPresentation(
            id: value.id.rawValue,
            type: value.type,
            original: summary.original,
            proposedDestination: summary.destination,
            actionSummary: reviewTypeLabel(value.type),
            captureID: value.captureId?.rawValue,
            noteID: value.noteId?.rawValue,
            duplicateExplanation: reviewDuplicateExplanation(value.proposal),
            generatedBlock: generatedBlock.map(PresentationMapping.generatedBlock),
            suggestedDestinations: suggestedDestinations,
            suggestedNewNote: reviewSuggestedNewNote(value.proposal),
            relatedNotes: relatedNotes,
            allowedActions: reviewAllowedActions(
                for: value,
                capture: capture,
                generatedBlock: generatedBlock
            ),
            attachments: attachmentPresentations(capture?.attachments ?? [])
        )
    }

    static func generatedBlock(_ value: GeneratedBlock) -> GeneratedBlockPresentation {
        GeneratedBlockPresentation(
            id: value.id.rawValue,
            noteID: value.noteId.rawValue,
            kind: value.kind,
            content: value.content,
            state: value.state,
            stateRevision: value.stateRevision,
            modelID: value.modelId,
            promptVersion: value.promptVersion
        )
    }

    static func revision(_ value: NoteRevision, now: Date = Date()) -> RevisionPresentation {
        RevisionPresentation(
            id: value.id.rawValue,
            revision: value.revision,
            source: value.source.rawValue,
            createdLabel: relativeDate(value.createdAt, now: now),
            title: value.title
        )
    }

    static func receipt(_ value: CaptureDetail, now: Date = Date()) -> ReceiptPresentation {
        let receipt = value.receipt
        return ReceiptPresentation(
            id: value.id.rawValue,
            category: captureStatusLabel(value.status),
            time: relativeDate(value.receivedAt, now: now),
            headline: receipt?.headline ?? captureHeadline(value.status),
            original: value.rawContent,
            outcome: receipt?.outcome,
            destinationNoteID: receipt?.destination?.noteId.rawValue,
            destinationTitle: receipt?.destination?.title,
            reviewItemID: receipt?.reviewItemId?.rawValue,
            insertedContent: receipt.map(receiptContent).map(ReceiptContentPresentation.collapsingRepeatedCaptures) ?? [],
            actions: receipt?.actions.map(receiptAction) ?? [],
            pending: value.status == .queued || value.status == .processing,
            retryable: value.status == .failed,
            attachments: attachmentPresentations(value.attachments)
        )
    }

    static func attachmentPresentations(_ attachments: [CaptureAttachment]) -> [ReceiptAttachmentPresentation] {
        attachments.map {
            ReceiptAttachmentPresentation(id: $0.id, kind: $0.kind == .image ? .image : .audio)
        }
    }

    static func receipt(_ value: CaptureSummary, now: Date = Date()) -> ReceiptPresentation {
        ReceiptPresentation(
            id: value.id.rawValue,
            category: captureStatusLabel(value.status),
            time: relativeDate(value.receivedAt, now: now),
            headline: captureHeadline(value.status),
            original: value.rawContentPreview,
            outcome: nil,
            destinationNoteID: nil,
            destinationTitle: nil,
            reviewItemID: nil,
            insertedContent: [],
            actions: [],
            pending: value.status == .queued || value.status == .processing,
            retryable: value.status == .failed
        )
    }

    static func receipt(_ value: CaptureOutboxEntry, now: Date = Date()) -> ReceiptPresentation {
        let timestamp = APIJSON.parseDate(value.draft.clientCreatedAt) ?? now
        return ReceiptPresentation(
            id: value.id,
            category: localCaptureStatusLabel(value.state),
            time: relativeDate(timestamp, now: now),
            headline: localCaptureHeadline(value.state),
            original: value.draft.rawContent,
            outcome: nil,
            destinationNoteID: nil,
            destinationTitle: nil,
            reviewItemID: nil,
            insertedContent: [],
            actions: [],
            pending: value.state != .synced && value.state != .failed,
            retryable: value.state == .failed
        )
    }

    private static func receiptContent(_ receipt: CaptureReceipt) -> [ReceiptContentPresentation] {
        receipt.insertedContent.enumerated().map { index, value in
            switch value {
            case let .captured(itemID, content):
                return ReceiptContentPresentation(
                    id: itemID.map(capturedItemID) ?? "captured-\(index)",
                    kind: .captured,
                    content: content
                )
            case let .aiGenerated(blockID, content):
                return ReceiptContentPresentation(
                    id: blockID.rawValue,
                    kind: .aiGenerated,
                    content: content
                )
            }
        }
    }

    private static func capturedItemID(_ value: CapturedItemID) -> String {
        switch value {
        case let .item(id): id.rawValue
        case let .entry(id): id.rawValue
        }
    }

    private static func receiptAction(_ action: CaptureReceiptAction) -> ReceiptActionPresentation {
        switch action {
        case let .open(noteID): .open(noteID: noteID.rawValue)
        case let .move(noteID, decisionID):
            .move(noteID: noteID.rawValue, decisionID: decisionID.rawValue)
        case let .undo(mutationID, expectedRevision):
            .undo(mutationID: mutationID.rawValue, expectedRevision: expectedRevision)
        }
    }

    /// The Library preview reads like prose: checklist markers and the server's "Completed"
    /// heading are projection, not content, so they never show.
    static func preview(_ markdown: String) -> String {
        let lines = markdown
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> String in
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if trimmed.hasPrefix("#"), trimmed.drop(while: { $0 == "#" }).trimmingCharacters(in: .whitespaces) == "Completed" {
                    return ""
                }
                return trimmed.replacingOccurrences(
                    of: #"^[-*+]\s+\[[ xX]\]\s*"#,
                    with: "",
                    options: .regularExpression
                )
            }
        let collapsed = lines.joined(separator: " ")
            .replacingOccurrences(of: #"[#>*_`\[\]()-]+"#, with: " ", options: .regularExpression)
            .split(whereSeparator: \Character.isWhitespace)
            .joined(separator: " ")
        if collapsed.isEmpty { return "Empty note" }
        return String(collapsed.prefix(180))
    }

    private static func checklist(_ structuredData: NoteStructuredData) -> [ChecklistItemPresentation] {
        switch structuredData {
        case let .list(items):
            return items.sorted { $0.ordinal < $1.ordinal }.map {
                ChecklistItemPresentation(id: $0.id.rawValue, text: $0.text, checked: $0.checked)
            }
        case let .project(items):
            return items.sorted { $0.ordinal < $1.ordinal }.map {
                ChecklistItemPresentation(id: $0.id.rawValue, text: $0.text, checked: $0.checked)
            }
        case .log, .plain:
            return []
        }
    }

    private static func logEntries(_ structuredData: NoteStructuredData) -> [LogEntryPresentation] {
        guard case let .log(entries) = structuredData else { return [] }
        return entries.sorted {
            if $0.occurredAt != $1.occurredAt { return $0.occurredAt > $1.occurredAt }
            return $0.id.rawValue > $1.id.rawValue
        }.map { entry in
            let fields = entry.fields.keys.sorted().compactMap { key -> LogFieldPresentation? in
                guard let value = entry.fields[key] else { return nil }
                return LogFieldPresentation(
                    id: key,
                    path: [key],
                    label: key.replacingOccurrences(of: "_", with: " ").capitalized,
                    value: value
                )
            }
            return LogEntryPresentation(
                id: entry.id.rawValue,
                occurredAt: entry.occurredAt,
                fields: fields
            )
        }
    }

    private static func spacePath(_ id: SpaceID?, spaces: [Space]) -> String {
        guard var cursor = id else { return "" }
        let byID = Dictionary(uniqueKeysWithValues: spaces.map { ($0.id, $0) })
        var names: [String] = []
        var visited: Set<SpaceID> = []
        while let space = byID[cursor], visited.insert(cursor).inserted {
            names.append(space.name)
            guard let parent = space.parentId else { break }
            cursor = parent
        }
        return names.reversed().joined(separator: " / ")
    }

    private static func reviewProposalSummary(
        _ proposal: ReviewProposal,
        capture: CaptureDetail?,
        notesByID: [String: Note]
    ) -> (original: String, destination: String) {
        let capturedText = capture?.rawContent
        switch proposal {
        case let .routeCapture(plan):
            let candidateTitle = plan.destination.candidateId
                .flatMap { notesByID[$0.rawValue]?.title }
            let destination = plan.destination.newNote?.title
                ?? candidateTitle
                ?? "Unfiled"
            return (capturedText ?? "A capture needs a destination decision.", destination)
        case .generatedBlock:
            return (
                capturedText ?? "An AI-generated proposal is waiting for your decision.",
                "AI-generated proposal"
            )
        case let .duplicateNotes(notes, _):
            return (
                "These notes may overlap. Unfiled will not merge, delete, archive, or rewrite either note.",
                "Compare \(notes.count) notes without changing them"
            )
        case let .conflict(reason):
            return (
                capturedText ?? "A safe automatic change could not be completed.",
                conflictLabel(reason)
            )
        case .failedJob:
            return (capturedText ?? "The capture remains safe and unfiled.", "Choose what happens next")
        }
    }

    private static func reviewSuggestedDestinations(
        _ proposal: ReviewProposal,
        notesByID: [String: Note]
    ) -> [ReviewDestinationPresentation] {
        guard case let .routeCapture(plan) = proposal else { return [] }
        var seen = Set<String>()
        let ids = ([plan.destination.candidateId].compactMap { $0 } + plan.alternatives)
            .filter { seen.insert($0.rawValue).inserted }
            .prefix(3)
        return ids.compactMap { id in
            guard let note = notesByID[id.rawValue], reviewDestinationIsEligible(note) else {
                return nil
            }
            return ReviewDestinationPresentation(
                id: id.rawValue,
                title: note.title,
                revision: note.currentRevision
            )
        }
    }

    static func reviewDestinationIsEligible(_ note: Note) -> Bool {
        note.isOpen && note.archivedAt == nil && note.deletedAt == nil
    }

    private static func reviewSuggestedNewNote(
        _ proposal: ReviewProposal
    ) -> ReviewNewNotePresentation? {
        guard case let .routeCapture(plan) = proposal,
              let newNote = plan.destination.newNote else { return nil }
        return ReviewNewNotePresentation(
            title: newNote.title,
            noteType: newNote.noteType,
            spaceID: newNote.spaceCandidateId?.rawValue
        )
    }

    private static func reviewRelatedNotes(
        _ proposal: ReviewProposal,
        notesByID: [String: Note]
    ) -> [ReviewDestinationPresentation] {
        guard case let .duplicateNotes(notes, _) = proposal else { return [] }
        return notes.map { reference in
            ReviewDestinationPresentation(
                id: reference.noteId.rawValue,
                title: notesByID[reference.noteId.rawValue]?.title ?? "Unavailable note",
                revision: reference.revision
            )
        }
    }

    private static func reviewDuplicateExplanation(_ proposal: ReviewProposal) -> String? {
        guard case let .duplicateNotes(_, explanation) = proposal else { return nil }
        return explanation
    }

    static func reviewAllowedActions(
        for item: ReviewItem,
        capture: CaptureDetail?,
        generatedBlock: GeneratedBlock? = nil
    ) -> [ReviewActionKind] {
        guard item.state == .open else { return [] }
        let boundReceipt: CaptureReceipt? = {
            guard let captureID = item.captureId,
                  let capture,
                  capture.id == captureID,
                  let receipt = capture.receipt,
                  receipt.captureId == captureID,
                  receipt.reviewItemId == item.id else { return nil }
            return receipt
        }()
        return reviewAllowedActions(
            type: item.type,
            proposal: item.proposal,
            hasBoundReceipt: boundReceipt != nil,
            hasBoundDecision: boundReceipt?.decisionId != nil,
            receiptReasonCodes: boundReceipt?.reasonCodes ?? [],
            generatedBlock: generatedBlock,
            expectedNoteID: item.noteId
        )
    }

    static func reviewAllowedActions(
        type: ReviewType,
        proposal: ReviewProposal,
        hasBoundReceipt: Bool,
        hasBoundDecision: Bool,
        receiptReasonCodes: [String] = [],
        generatedBlock: GeneratedBlock? = nil,
        expectedNoteID: NoteID? = nil
    ) -> [ReviewActionKind] {
        switch (type, proposal) {
        case (.lowConfidence, .routeCapture):
            var actions: [ReviewActionKind] = []
            if hasBoundReceipt && hasBoundDecision {
                actions.append(contentsOf: [.route, .create])
            }
            if hasBoundReceipt { actions.append(.keepInbox) }
            actions.append(.dismiss)
            return actions
        case (.revisionConflict, .conflict(reason: .revision)),
             (.structureConflict, .conflict(reason: .candidateEligibility)),
             (.structureConflict, .conflict(reason: .structure)):
            var actions: [ReviewActionKind] = []
            let isAcknowledgementOnly = receiptReasonCodes.contains(
                APIErrorCode.conflictRequiresReview.rawValue
            )
            if hasBoundReceipt && hasBoundDecision && !isAcknowledgementOnly {
                actions.append(contentsOf: [.route, .create])
            }
            if hasBoundReceipt { actions.append(.keepInbox) }
            actions.append(.dismiss)
            return actions
        case (.failedJob, .failedJob):
            return hasBoundReceipt ? [.keepInbox, .dismiss] : [.dismiss]
        case (.duplicateSuggestion, .duplicateNotes):
            return [.keepBoth, .dismiss]
        case let (.pendingExpansion, .generatedBlock(blockID)):
            guard let generatedBlock,
                  generatedBlock.id == blockID,
                  expectedNoteID == generatedBlock.noteId,
                  generatedBlock.state == .proposed else { return [] }
            return [.acceptExpansion, .rejectExpansion]
        case (.pendingExpansion, .conflict(reason: .consentControls)):
            // Preserve the legacy consent hold: it has no persisted generated block to resolve.
            return [.dismiss]
        default:
            return []
        }
    }

    private static func conflictLabel(_ reason: ReviewConflictReason) -> String {
        switch reason {
        case .revision: "The destination changed"
        case .candidateEligibility: "The destination is unavailable"
        case .consentControls: "Your settings require confirmation"
        case .structure: "The note structure needs attention"
        }
    }

    private static func reviewTypeLabel(_ type: ReviewType) -> String {
        switch type {
        case .lowConfidence: "Low-confidence destination"
        case .revisionConflict: "The note changed while filing"
        case .failedJob: "Organization needs another attempt"
        case .duplicateSuggestion: "Possible duplicate note"
        case .pendingExpansion: "Expansion needs approval"
        case .structureConflict: "Structured note conflict"
        }
    }

    private static func captureStatusLabel(_ status: CaptureProcessingState) -> String {
        switch status {
        case .queued: "Queued"
        case .processing: "Organizing"
        case .done: "Filed"
        case .needsReview: "Review"
        case .failed: "Needs retry"
        case .inbox: "Inbox"
        }
    }

    private static func captureHeadline(_ status: CaptureProcessingState) -> String {
        switch status {
        case .queued: "Saved and waiting to organize"
        case .processing: "Finding the right note"
        case .done: "Filed safely"
        case .needsReview: "Choose where this belongs"
        case .failed: "Saved, but not organized yet"
        case .inbox: "Kept in the inbox"
        }
    }

    private static func localCaptureStatusLabel(_ status: CaptureOutboxState) -> String {
        switch status {
        case .pending: "Saved"
        case .leased: "Syncing"
        case .retry: "Offline"
        case .waitingForSignIn: "Sign in"
        case .failed: "Needs retry"
        case .synced: "Synced"
        }
    }

    private static func localCaptureHeadline(_ status: CaptureOutboxState) -> String {
        switch status {
        case .pending, .leased: "Saved encrypted on this device"
        case .retry: "Safe on this device; waiting for a connection"
        case .waitingForSignIn: "Safe on this device; waiting for sign-in"
        case .failed: "Safe on this device; review before retrying"
        case .synced: "Sent safely"
        }
    }

    private static func relativeDate(_ date: Date, now: Date) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        if seconds < 60 { return "NOW" }
        if seconds < 3_600 { return "\(Int(seconds / 60))M" }
        if seconds < 86_400 { return "\(Int(seconds / 3_600))H" }
        if seconds < 604_800 { return "\(Int(seconds / 86_400))D" }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}
