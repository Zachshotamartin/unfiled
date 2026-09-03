import Foundation

/// A note body split into the owner's words and the photos and recordings the organizer placed
/// among them. A reference is a whole line of the form
/// `![Photo](unfiled-attachment:att_…)` or `[Recording](unfiled-attachment:att_…)`.
enum NoteBodySegment: Equatable {
    case text(String)
    case image(attachmentID: String)
    case recording(attachmentID: String)

    static let referenceScheme = "unfiled-attachment:"

    private static let referencePattern =
        #"^\s*(!?)\[(Photo|Recording)\]\(unfiled-attachment:(att_[0-9A-HJKMNP-TV-Z]{26})\)\s*$"#
    private static let reference = try? NSRegularExpression(pattern: referencePattern)

    static func segments(of body: String) -> [NoteBodySegment] {
        var result: [NoteBodySegment] = []
        var pending: [String] = []
        func flush() {
            let text = pending.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { result.append(.text(text)) }
            pending = []
        }
        for line in body.split(separator: "\n", omittingEmptySubsequences: false) {
            if let placed = referenceSegment(String(line)) {
                flush()
                result.append(placed)
            } else {
                pending.append(String(line))
            }
        }
        flush()
        return result
    }

    static func referenceSegment(_ line: String) -> NoteBodySegment? {
        guard let reference,
              let match = reference.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
              let markerRange = Range(match.range(at: 1), in: line),
              let idRange = Range(match.range(at: 3), in: line) else { return nil }
        let attachmentID = String(line[idRange])
        return line[markerRange] == "!" ? .image(attachmentID: attachmentID) : .recording(attachmentID: attachmentID)
    }
}
