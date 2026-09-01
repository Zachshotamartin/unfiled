import Foundation

enum AppPhase: Equatable {
    case booting
    case signedOut
    case signedIn
    case failed(String)
}

enum AuthStep: Equatable {
    case email
    case code(email: String, retryAfterSeconds: Int)
}

enum AppRoute: Hashable {
    case note(String)
    case capture(String)
    case revisions(String)
    case revisionPreview(noteID: String, revisionID: String)
    case archive
    case deleted
    case settings
    case routingRules
}

struct CaptureSheet: Equatable, Identifiable {
    let source: LocalCaptureSource
    let composerGeneration: Int
    let initialContent: String
    let initialPrivacy: LocalPrivacyMode
    let restoredDraft: Bool

    var id: String { source.rawValue }
}

struct EditorSheet: Equatable, Identifiable {
    let draft: NoteEditorDraft
    let currentRevision: Int?

    var id: String { draft.noteID ?? "new-note" }
}

enum DestinationPickerPurpose: Equatable, Sendable {
    case correction(captureID: String, decisionID: String, sourceNoteID: String)
    case review(reviewID: String)

    var operationID: String {
        switch self {
        case let .correction(_, decisionID, _): "correction.\(decisionID)"
        case let .review(reviewID): "review.\(reviewID)"
        }
    }
}

enum DestinationPickerMode: String, CaseIterable, Identifiable, Sendable {
    case existing = "Existing note"
    case newNote = "New note"

    var id: String { rawValue }
}

struct DestinationPickerSheet: Equatable, Identifiable {
    let purpose: DestinationPickerPurpose
    let initialMode: DestinationPickerMode
    let suggestedTitle: String
    let suggestedType: NoteType
    let suggestedSpaceID: String?

    var id: String { purpose.operationID }
}

enum DestinationChoice: Sendable {
    case existing(noteID: String)
    case newNote(title: String, noteType: NoteType, spaceID: String?)
}

enum AsyncLoadResult<Value: Sendable>: Sendable {
    case value(Value)
    case unavailable
}
