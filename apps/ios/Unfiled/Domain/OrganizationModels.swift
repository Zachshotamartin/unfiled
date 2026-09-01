import Foundation

public enum CaptureKind: String, Codable, CaseIterable, Sendable {
    case listItems = "list_items"
    case logEntry = "log_entry"
    case principle
    case projectUpdate = "project_update"
    case freeform
}

public enum OrganizationDecision: String, Codable, CaseIterable, Sendable {
    case appendToNote = "append_to_note"
    case createNote = "create_note"
    case addToInbox = "add_to_inbox"
    case needsReview = "needs_review"
}

public enum OrganizationReasonCode: String, Codable, CaseIterable, Sendable {
    case explicitShoppingIntent = "explicit_shopping_intent"
    case explicitDestination = "explicit_destination"
    case openDailyList = "open_daily_list"
    case sameDayLog = "same_day_log"
    case aliasMatch = "alias_match"
    case semanticMatch = "semantic_match"
    case recentDestination = "recent_destination"
    case typeMatch = "type_match"
    case noCandidateFit = "no_candidate_fit"
    case ambiguousIntent = "ambiguous_intent"
    case duplicateSuspected = "duplicate_suspected"
    case lowInformation = "low_information"
    case parserOverride = "parser_override"
}

public struct OrganizationNewNote: Codable, Equatable, Sendable {
    public let title: String
    public let noteType: NoteType
    @RequiredNullable public var spaceCandidateId: SpaceID?

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case title, noteType, spaceCandidateId
    }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        title = try container.decode(String.self, forKey: .title)
        noteType = try container.decode(NoteType.self, forKey: .noteType)
        _spaceCandidateId = try container.decode(
            RequiredNullable<SpaceID>.self,
            forKey: .spaceCandidateId
        )
        guard (1 ... 60).contains(title.utf16.count) else {
            throw DecodingError.dataCorruptedError(
                forKey: .title,
                in: container,
                debugDescription: "Organization note title violates the API contract"
            )
        }
    }
}

public struct OrganizationDestination: Codable, Equatable, Sendable {
    @RequiredNullable public var candidateId: NoteID?
    @RequiredNullable public var newNote: OrganizationNewNote?

    private enum CodingKeys: String, CodingKey, CaseIterable { case candidateId, newNote }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        _candidateId = try container.decode(RequiredNullable<NoteID>.self, forKey: .candidateId)
        _newNote = try container.decode(
            RequiredNullable<OrganizationNewNote>.self,
            forKey: .newNote
        )
    }
}

public enum OrganizationModelOperation: Codable, Equatable, Sendable {
    case appendRaw(content: String)
    case appendParagraphs(paragraphs: [String])
    case appendListItems(section: String?, items: [String])
    case appendLogEntry(entry: [String: JSONValue])
    case updateStructuredData(patch: [String: JSONValue])
    case addTags(tagIds: [TagID])
    case addRelation(toCandidateId: NoteID, linkType: LinkType)

    private enum CodingKeys: String, CodingKey {
        case type, content, paragraphs, section, items, entry, patch, tagIds, toCandidateId, linkType
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "append_raw":
            try StrictJSONKey.requireExactKeys(["type", "content"], from: decoder)
            let content = try container.decode(String.self, forKey: .content)
            guard (1 ... 10_000).contains(content.utf16.count) else {
                throw Self.invalid(.content, in: container)
            }
            self = .appendRaw(content: content)
        case "append_paragraphs":
            try StrictJSONKey.requireExactKeys(["type", "paragraphs"], from: decoder)
            let paragraphs = try container.decode([String].self, forKey: .paragraphs)
            guard (1 ... 20).contains(paragraphs.count), paragraphs.allSatisfy(Self.validLine) else {
                throw Self.invalid(.paragraphs, in: container)
            }
            self = .appendParagraphs(paragraphs: paragraphs)
        case "append_list_items":
            try StrictJSONKey.requireExactKeys(["type", "section", "items"], from: decoder)
            let section = try container.decode(RequiredNullable<String>.self, forKey: .section).wrappedValue
            let items = try container.decode([String].self, forKey: .items)
            guard section.map({ $0.utf16.count <= 100 }) ?? true,
                  (1 ... 50).contains(items.count),
                  items.allSatisfy(Self.validLine) else {
                throw Self.invalid(.items, in: container)
            }
            self = .appendListItems(section: section, items: items)
        case "append_log_entry":
            try StrictJSONKey.requireExactKeys(["type", "entry"], from: decoder)
            self = .appendLogEntry(
                entry: try container.decode([String: JSONValue].self, forKey: .entry)
            )
        case "update_structured_data":
            try StrictJSONKey.requireExactKeys(["type", "patch"], from: decoder)
            self = .updateStructuredData(
                patch: try container.decode([String: JSONValue].self, forKey: .patch)
            )
        case "add_tags":
            try StrictJSONKey.requireExactKeys(["type", "tagIds"], from: decoder)
            let tagIds = try container.decode([TagID].self, forKey: .tagIds)
            guard (1 ... 5).contains(tagIds.count) else {
                throw Self.invalid(.tagIds, in: container)
            }
            self = .addTags(tagIds: tagIds)
        case "add_relation":
            try StrictJSONKey.requireExactKeys(["type", "toCandidateId", "linkType"], from: decoder)
            self = .addRelation(
                toCandidateId: try container.decode(NoteID.self, forKey: .toCandidateId),
                linkType: try container.decode(LinkType.self, forKey: .linkType)
            )
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unknown organization operation"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .appendRaw(content):
            try container.encode("append_raw", forKey: .type)
            try container.encode(content, forKey: .content)
        case let .appendParagraphs(paragraphs):
            try container.encode("append_paragraphs", forKey: .type)
            try container.encode(paragraphs, forKey: .paragraphs)
        case let .appendListItems(section, items):
            try container.encode("append_list_items", forKey: .type)
            try container.encodeIfPresent(section, forKey: .section)
            if section == nil { try container.encodeNil(forKey: .section) }
            try container.encode(items, forKey: .items)
        case let .appendLogEntry(entry):
            try container.encode("append_log_entry", forKey: .type)
            try container.encode(entry, forKey: .entry)
        case let .updateStructuredData(patch):
            try container.encode("update_structured_data", forKey: .type)
            try container.encode(patch, forKey: .patch)
        case let .addTags(tagIds):
            try container.encode("add_tags", forKey: .type)
            try container.encode(tagIds, forKey: .tagIds)
        case let .addRelation(noteId, linkType):
            try container.encode("add_relation", forKey: .type)
            try container.encode(noteId, forKey: .toCandidateId)
            try container.encode(linkType, forKey: .linkType)
        }
    }

    private static func validLine(_ value: String) -> Bool {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return (1 ... 500).contains(normalized.utf16.count)
            && !normalized.contains("\n")
            && !normalized.contains("\r")
    }

    private static func invalid(
        _ key: CodingKeys,
        in container: KeyedDecodingContainer<CodingKeys>
    ) -> DecodingError {
        DecodingError.dataCorruptedError(
            forKey: key,
            in: container,
            debugDescription: "Organization operation violates the API contract"
        )
    }
}

public struct GeneratedExpansionProposal: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, CaseIterable, Sendable {
        case summary, interpretation, suggestion, label
    }

    public let kind: Kind
    public let text: String

    private enum CodingKeys: String, CodingKey, CaseIterable { case kind, text }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decode(Kind.self, forKey: .kind)
        text = try container.decode(String.self, forKey: .text)
        guard (1 ... 600).contains(text.utf16.count) else {
            throw DecodingError.dataCorruptedError(
                forKey: .text,
                in: container,
                debugDescription: "Generated expansion violates the API contract"
            )
        }
    }
}

public struct OrganizationPlan: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let captureKind: CaptureKind
    public let decision: OrganizationDecision
    public let destination: OrganizationDestination
    public let operations: [OrganizationModelOperation]
    @RequiredNullable public var generatedExpansion: GeneratedExpansionProposal?
    public let alternatives: [NoteID]
    public let reasonCodes: [OrganizationReasonCode]

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case schemaVersion, captureKind, decision, destination, operations
        case generatedExpansion, alternatives, reasonCodes
    }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        captureKind = try container.decode(CaptureKind.self, forKey: .captureKind)
        decision = try container.decode(OrganizationDecision.self, forKey: .decision)
        destination = try container.decode(OrganizationDestination.self, forKey: .destination)
        operations = try container.decode([OrganizationModelOperation].self, forKey: .operations)
        _generatedExpansion = try container.decode(
            RequiredNullable<GeneratedExpansionProposal>.self,
            forKey: .generatedExpansion
        )
        alternatives = try container.decode([NoteID].self, forKey: .alternatives)
        reasonCodes = try container.decode([OrganizationReasonCode].self, forKey: .reasonCodes)
        guard schemaVersion == 1,
              operations.count <= 5,
              alternatives.count <= 2,
              reasonCodes.count <= 5 else {
            throw DecodingError.dataCorruptedError(
                forKey: .schemaVersion,
                in: container,
                debugDescription: "Organization plan violates the API contract"
            )
        }
    }
}
