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
    case revisions(String)
    case revisionPreview(noteID: String, revisionID: String)
    case archive
    case deleted
    case settings
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

enum AsyncLoadResult<Value: Sendable>: Sendable {
    case value(Value)
    case unavailable
}
