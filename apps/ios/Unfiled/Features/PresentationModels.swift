import Foundation

struct ReceiptPresentation: Equatable, Identifiable, Sendable {
    let id: String
    let category: String
    let time: String
    let headline: String
    let original: String
    let destinationNoteID: String?
    let undoMutationID: String?
    let expectedRevision: Int?
    let pending: Bool
    let retryable: Bool
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
    let archived: Bool
    let deleted: Bool
    let pinned: Bool
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
    let provenance: String?
}

struct ChecklistItemPresentation: Equatable, Identifiable, Sendable {
    let id: String
    let text: String
    let checked: Bool
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

struct ReviewPresentation: Equatable, Identifiable, Sendable {
    let id: String
    let original: String
    let proposedDestination: String
    let actionSummary: String
    let captureID: String?
    let noteID: String?
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
    case today = "Today"
    case notes = "Notes"
    case review = "Review"
    case search = "Search"

    var id: String { rawValue }

    var systemImage: String {
        switch self {
        case .today: "calendar"
        case .notes: "note.text"
        case .review: "checkmark.circle"
        case .search: "magnifyingglass"
        }
    }
}
