import Foundation

/// The title a capture's own words suggest: its first non-empty line, bounded. Used when a
/// review resolution creates a note from the capture in front of the owner.
enum CaptureTitle {
    static let maximumLength = 200

    static func from(_ content: String) -> String {
        let firstLine = content
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty } ?? ""
        guard !firstLine.isEmpty else { return "Untitled" }
        return String(firstLine.prefix(maximumLength))
    }
}
