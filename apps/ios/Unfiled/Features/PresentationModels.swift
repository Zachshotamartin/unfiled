import Foundation

enum ReceiptContentKind: String, Equatable, Sendable {
    case captured
    case aiGenerated
}

struct ReceiptContentPresentation: Equatable, Identifiable, Sendable {
    let id: String
    let kind: ReceiptContentKind
    let content: String

    var provenanceLabel: String? {
        kind == .aiGenerated ? "AI-generated proposal" : nil
    }

    /// Captured references all resolve to the whole capture text (receipts never decrypt the
    /// note), so repeats of the same captured content collapse to the first one.
    static func collapsingRepeatedCaptures(
        _ content: [ReceiptContentPresentation]
    ) -> [ReceiptContentPresentation] {
        var seenCaptured: Set<String> = []
        return content.filter { item in
            guard item.kind == .captured else { return true }
            return seenCaptured.insert(item.content).inserted
        }
    }
}

enum ReceiptActionPresentation: Equatable, Identifiable, Sendable {
    case open(noteID: String)
    case move(noteID: String, decisionID: String)
    case undo(mutationID: String, expectedRevision: Int)

    var id: String {
        switch self {
        case .open: "open"
        case .move: "move"
        case .undo: "undo"
        }
    }
}

/// A photo or recording that travels with a capture, enough to show a thumbnail.
struct ReceiptAttachmentPresentation: Equatable, Identifiable, Sendable {
    let id: String
    let kind: LocalAttachmentKind
}

struct ReceiptPresentation: Equatable, Identifiable, Sendable {
    let id: String
    let category: String
    let time: String
    let headline: String
    let original: String
    let outcome: CaptureReceiptOutcome?
    let destinationNoteID: String?
    let destinationTitle: String?
    let reviewItemID: String?
    let insertedContent: [ReceiptContentPresentation]
    let actions: [ReceiptActionPresentation]
    let pending: Bool
    let retryable: Bool
    /// The organizer's reason codes for the outcome, for the "why it stopped" copy.
    var reasonCodes: [String] = []
    var attachments: [ReceiptAttachmentPresentation] = []

    /// A capture that is waiting on a retry or a review can still have its text changed; the
    /// change becomes a new capture and this one is removed.
    var canEditText: Bool {
        !pending && (retryable || outcome == .needsReview)
    }
    /// A capture that stopped short of a note can be organized again, with the owner's directions.
    var canOrganizeAgain: Bool {
        !pending && (retryable || outcome == .needsReview)
    }
    /// The plain-language reasons the organizer stopped, in the order the codes arrived.
    var reasons: [String] { ReviewReasonCopy.sentences(for: reasonCodes) }

    /// The row as it reads the moment a retry is asked for, before the server replies.
    func retrying() -> ReceiptPresentation {
        ReceiptPresentation(
            id: id, category: "Organizing", time: time, headline: "Organizing again",
            original: original, outcome: nil, destinationNoteID: nil, destinationTitle: nil,
            reviewItemID: nil, insertedContent: [], actions: [], pending: true, retryable: false
        )
    }

    /// The row as it reads the moment an undo is asked for: the undo is no longer offered.
    func undoing() -> ReceiptPresentation {
        ReceiptPresentation(
            id: id, category: category, time: time, headline: "Undoing the organized change",
            original: original, outcome: outcome, destinationNoteID: destinationNoteID,
            destinationTitle: destinationTitle, reviewItemID: reviewItemID,
            insertedContent: insertedContent, actions: [], pending: pending, retryable: false
        )
    }
}

struct NotePresentation: Equatable, Identifiable, Sendable {
    let id: String
    let title: String
    let type: String
    let preview: String
    let updatedLabel: String
    let updatedAt: String
    let spaceID: String?
    let currentRevision: Int
    let isOpen: Bool
    let privacy: PrivacyMode
    let archived: Bool
    let deleted: Bool
    let pinned: Bool

    var isRoutableRoutingRuleDestination: Bool {
        privacy == .aiAssisted && isOpen && !archived && !deleted
    }
}

struct NoteDetailPresentation: Equatable, Identifiable, Sendable {
    let id: String
    let title: String
    let bodyMarkdown: String
    let type: String
    let privacy: String
    let spacePath: String
    let currentRevision: Int
    var checklistItems: [ChecklistItemPresentation]
    let logEntries: [LogEntryPresentation]
    let provenance: String?
}

struct ChecklistItemPresentation: Equatable, Identifiable, Sendable {
    let id: String
    let text: String
    let checked: Bool
}

struct LogEntryPresentation: Equatable, Identifiable, Sendable {
    let id: String
    let occurredAt: Date
    let fields: [LogFieldPresentation]
}

struct LogFieldPresentation: Equatable, Identifiable, Sendable {
    let id: String
    let path: [String]
    let label: String
    let value: LogFieldValue
}

struct SpacePresentation: Equatable, Identifiable, Sendable {
    let id: String
    let name: String
    let parentID: String?
    let noteCount: Int
}

struct SearchResultPresentation: Equatable, Identifiable, Sendable {
    let id: String
    let title: String
    let snippet: String
    let type: String
    let path: String
    let updatedLabel: String
}

enum ReviewActionKind: String, Equatable, Sendable {
    case route
    case create
    case keepInbox
    case dismiss
    case keepBoth
    case acceptExpansion
    case rejectExpansion
}

struct GeneratedBlockPresentation: Equatable, Identifiable, Sendable {
    let id: String
    let noteID: String
    let kind: GeneratedBlockKind
    let content: String
    let state: GeneratedBlockState
    let stateRevision: Int
    let modelID: String
    let promptVersion: String

    var isVisibleInNote: Bool { state != .rejected }
    var isActionable: Bool { state == .proposed }
    var operationID: String { "generated-block.\(id)" }
    var provenanceLabel: String { "Model \(modelID) · Prompt \(promptVersion)" }

    var reviewAccessibilityLabel: String {
        "AI-generated \(kindLabel.lowercased()), \(stateLabel.lowercased()). " +
            "Model \(modelID). Prompt \(promptVersion). Content: \(content)"
    }

    var kindLabel: String {
        switch kind {
        case .summary: "Summary"
        case .interpretation: "Interpretation"
        case .suggestion: "Suggestion"
        case .label: "Label"
        }
    }

    var stateLabel: String {
        switch state {
        case .proposed: "Proposed"
        case .accepted: "Accepted"
        case .rejected: "Rejected"
        }
    }
}

struct ReviewDestinationPresentation: Equatable, Identifiable, Sendable {
    let id: String
    let title: String
    let revision: Int
}

struct ReviewNewNotePresentation: Equatable, Sendable {
    let title: String
    let noteType: NoteType
    let spaceID: String?
}

struct ReviewPresentation: Equatable, Identifiable, Sendable {
    let id: String
    let type: ReviewType
    let original: String
    let proposedDestination: String
    let actionSummary: String
    let captureID: String?
    let noteID: String?
    let duplicateExplanation: String?
    let generatedBlock: GeneratedBlockPresentation?
    let suggestedDestinations: [ReviewDestinationPresentation]
    let suggestedNewNote: ReviewNewNotePresentation?
    let relatedNotes: [ReviewDestinationPresentation]
    let allowedActions: [ReviewActionKind]
    /// Why Unfiled could not file it, in plain language, from the receipt's reason codes.
    var reasons: [String] = []
    var attachments: [ReceiptAttachmentPresentation] = []

    func allows(_ action: ReviewActionKind) -> Bool {
        allowedActions.contains(action)
    }
}

enum ReviewUserAction: Sendable {
    case route(noteID: String)
    case chooseDestination
    case createNote
    case keepInbox
    case dismiss
    case keepBoth
    case acceptExpansion
    case rejectExpansion
    /// Change the capture's text; the edit becomes a new capture and this one is removed.
    case editText
    /// Organize the capture again, with the owner's directions attached; this review closes.
    case organizeAgain(guidance: String?)
    /// Remove the capture entirely; nothing was filed.
    case deleteCapture
    /// Take the organizer's own suggestion, or start a note of the kind it detected.
    case decide
}

struct RevisionPresentation: Equatable, Identifiable, Sendable {
    let id: String
    let revision: Int
    let source: String
    let createdLabel: String
    let title: String
}

enum LibraryFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case spaces = "Spaces"

    var id: String { rawValue }
}

enum MainTab: String, CaseIterable, Identifiable {
    case inbox = "Inbox"
    case library = "Library"

    var id: String { rawValue }

    var glyph: UnfiledGlyph {
        switch self {
        case .inbox: .organize
        case .library: .notes
        }
    }
}
