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

    /// A capture that is waiting on a retry or a review can still have its text changed; the
    /// change becomes a new capture and this one is removed.
    var canEditText: Bool {
        !pending && (retryable || outcome == .needsReview)
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
    let checklistItems: [ChecklistItemPresentation]
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
