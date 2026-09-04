import Foundation

/// The title a capture's own words suggest, used when a review resolution creates a note from
/// the capture in front of the owner: the name the owner gave a list in the capture itself
/// ("todo list, x, y" is a list called "Todo list"), or else its first non-empty line, bounded.
enum CaptureTitle {
    static let maximumLength = 200

    private static let labelWordLimit = 5
    private static let labelCharacterLimit = 60
    private static let listKinds: Set<String> = [
        "agenda", "backlog", "checklist", "chores", "errands", "groceries", "grocery", "ideas",
        "packing", "reading", "reminders", "shopping", "task", "tasks", "to do", "to dos",
        "to-do", "to-dos", "todo", "todos", "watchlist", "wishlist"
    ]

    static func from(_ content: String) -> String {
        if let label = listLabel(in: content) { return label }
        let firstLine = content
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty } ?? ""
        guard !firstLine.isEmpty else { return "Untitled" }
        return String(firstLine.prefix(maximumLength))
    }

    /// The owner's own name for a list, written before its items. Before a colon it may be any
    /// short phrase ("weekend plans: hike, brunch"); before a comma or a line break it has to
    /// name a kind of list, or the first item of a plain list would be mistaken for its name.
    /// Mirrors `parseListLabel` in `@unfiled/ai-routing`, so the phone suggests the title the
    /// organizer would have chosen.
    static func listLabel(in content: String) -> String? {
        let text = content.precomposedStringWithCompatibilityMapping
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let characters = Array(text)
        guard let split = characters.indices.first(where: { index in
            let character = characters[index]
            if character == "," || character.isNewline { return true }
            guard character == ":" else { return false }
            let next = index + 1
            return next == characters.endIndex || characters[next].isWhitespace
        }), split > 0 else { return nil }

        let delimiter = characters[split]
        let head = String(characters[..<split]).trimmingCharacters(in: .whitespaces)
        let remainder = String(characters[(split + 1)...]).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !head.isEmpty, !remainder.isEmpty, head.count <= labelCharacterLimit,
              head.split(whereSeparator: \.isWhitespace).count <= labelWordLimit,
              head.allSatisfy(isLabelCharacter),
              !(head.first?.isWhitespace ?? true)
        else { return nil }
        if delimiter != ":" && !namesAKindOfList(head) { return nil }
        return head.prefix(1).uppercased() + head.dropFirst()
    }

    private static func isLabelCharacter(_ character: Character) -> Bool {
        character.isLetter || character.isNumber || character == " " || character == "'"
            || character == "\u{2019}" || character == "&" || character == "-"
    }

    private static func namesAKindOfList(_ head: String) -> Bool {
        let lowered = head.lowercased()
        if listKinds.contains(lowered) { return true }
        return lowered == "list" || lowered == "lists"
            || lowered.hasSuffix(" list") || lowered.hasSuffix(" lists")
    }
}
