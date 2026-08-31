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
            path: value.spacePath.isEmpty ? "Unfiled" : value.spacePath.joined(separator: " / "),
            updatedLabel: relativeDate(value.updatedAt, now: now)
        )
    }

    static func review(_ value: ReviewItem) -> ReviewPresentation {
        let choiceText = value.choices.compactMap(choiceLabel)
        return ReviewPresentation(
            id: value.id.rawValue,
            original: choiceText.first ?? "A capture needs a destination decision.",
            proposedDestination: choiceText.dropFirst().first ?? "Unfiled",
            actionSummary: reviewTypeLabel(value.type),
            captureID: value.captureId?.rawValue,
            noteID: value.noteId?.rawValue
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
        let undo = receipt?.actions.compactMap { action -> (String, Int)? in
            if case let .undo(mutationID, expectedRevision) = action {
                return (mutationID.rawValue, expectedRevision)
            }
            return nil
        }.first
        return ReceiptPresentation(
            id: value.id.rawValue,
            category: captureStatusLabel(value.status),
            time: relativeDate(value.receivedAt, now: now),
            headline: receipt?.headline ?? captureHeadline(value.status),
            original: value.rawContent,
            destinationNoteID: receipt?.destination?.noteId.rawValue,
            undoMutationID: undo?.0,
            expectedRevision: undo?.1,
            pending: value.status == .queued || value.status == .processing,
            retryable: false
        )
    }

    static func receipt(_ value: CaptureSummary, now: Date = Date()) -> ReceiptPresentation {
        ReceiptPresentation(
            id: value.id.rawValue,
            category: captureStatusLabel(value.status),
            time: relativeDate(value.receivedAt, now: now),
            headline: captureHeadline(value.status),
            original: value.rawContentPreview,
            destinationNoteID: nil,
            undoMutationID: nil,
            expectedRevision: nil,
            pending: value.status == .queued || value.status == .processing,
            retryable: false
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
            destinationNoteID: nil,
            undoMutationID: nil,
            expectedRevision: nil,
            pending: value.state != .synced && value.state != .failed,
            retryable: value.state == .failed
        )
    }

    private static func preview(_ markdown: String) -> String {
        let collapsed = markdown
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

    private static func spacePath(_ id: SpaceID?, spaces: [Space]) -> String {
        guard var cursor = id else { return "Unfiled" }
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

    private static func choiceLabel(_ value: JSONValue) -> String? {
        switch value {
        case let .string(text): return text
        case let .object(object):
            for key in ["title", "label", "name", "reason", "summary"] {
                if case let .string(text)? = object[key], !text.isEmpty { return text }
            }
            return nil
        case .array, .number, .bool, .null: return nil
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
