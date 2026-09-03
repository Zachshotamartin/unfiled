import Foundation

/// What the composer allows and what it sends when the owner attached photos or a recording.
enum CaptureComposerRules {
    static let maximumPhotos = 4
    static let maximumRecordings = 1
    static let maximumCharacters = 10_000

    /// Words or attachments are enough to send; too many characters never are.
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
        let photos = kinds.filter { $0 == .image }.count
        let recordings = kinds.count - photos
        switch (photos, recordings) {
        case (0, 0): return ""
        case (0, _): return "Voice note"
        case (1, 0): return "Photo"
        case (_, 0): return "Photos"
        case (1, _): return "Photo and voice note"
        default: return "Photos and voice note"
        }
    }

    static func canAdd(_ kind: LocalAttachmentKind, to kinds: [LocalAttachmentKind]) -> Bool {
        switch kind {
        case .image: return kinds.filter { $0 == .image }.count < maximumPhotos
        case .audio: return kinds.filter { $0 == .audio }.count < maximumRecordings
        }
    }

    static func remainingPhotos(given kinds: [LocalAttachmentKind]) -> Int {
        max(0, maximumPhotos - kinds.filter { $0 == .image }.count)
    }
}
