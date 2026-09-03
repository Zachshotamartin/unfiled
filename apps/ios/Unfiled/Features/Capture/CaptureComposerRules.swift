import Foundation

/// What the composer allows and what it sends when the owner attached photos. Speaking a capture
/// is the keyboard's dictation key, which puts the words straight into the text.
enum CaptureComposerRules {
    static let maximumPhotos = 4
    static let maximumCharacters = 10_000

    /// Words or photos are enough to send; too many characters never are.
    static func canSend(content: String, attachmentCount: Int) -> Bool {
        guard content.utf16.count <= maximumCharacters else { return false }
        let words = content.trimmingCharacters(in: .whitespacesAndNewlines)
        return !words.isEmpty || attachmentCount > 0
    }

    /// The owner's words, or a plain placeholder when they typed nothing, so a capture always
    /// has text the organizer and the Inbox can show.
    static func rawContent(content: String, kinds: [LocalAttachmentKind]) -> String {
        let words = content.trimmingCharacters(in: .whitespacesAndNewlines)
        if !words.isEmpty { return words }
        switch kinds.filter({ $0 == .image }).count {
        case 0: return ""
        case 1: return "Photo"
        default: return "Photos"
        }
    }

    static func canAdd(_ kind: LocalAttachmentKind, to kinds: [LocalAttachmentKind]) -> Bool {
        switch kind {
        case .image: return kinds.filter { $0 == .image }.count < maximumPhotos
        case .audio: return false
        }
    }

    static func remainingPhotos(given kinds: [LocalAttachmentKind]) -> Int {
        max(0, maximumPhotos - kinds.filter { $0 == .image }.count)
    }
}
