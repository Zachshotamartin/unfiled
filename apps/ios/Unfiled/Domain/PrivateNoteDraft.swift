import Foundation

/// A capture written in Private mode becomes a private note directly: the first line is the
/// title, the whole text is the body, and it lives in the Unfiled space.
enum PrivateNoteDraft {
    static let maximumTitleLength = 200

    static func title(from content: String) -> String {
        let firstLine = content
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty } ?? ""
        guard !firstLine.isEmpty else { return "Untitled" }
        return String(firstLine.prefix(maximumTitleLength))
    }

    static func request(content: String, idempotencyKey: String) -> NoteCreateRequest {
        NoteCreateRequest(
            idempotencyKey: idempotencyKey,
            title: title(from: content),
            type: .generic,
            spaceId: nil,
            privacy: .privateManual,
            bodyMarkdown: content
        )
    }
}
