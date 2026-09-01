import Foundation

public struct NoteLinkValue: Codable, Equatable, Sendable {
    public let toNoteId: NoteID
    public let linkType: LinkType

    public init(toNoteId: NoteID, linkType: LinkType) {
        self.toNoteId = toNoteId
        self.linkType = linkType
    }
}

public struct ListItem: Codable, Equatable, Sendable {
    public let id: ItemID
    public let text: String
    public let checked: Bool
    public let ordinal: Int
    @RequiredNullable public var section: String?
}

public enum LogFieldValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let string = try? container.decode(String.self) { self = .string(string) }
        else {
            let number = try container.decode(Double.self)
            guard number.isFinite else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Non-finite log value")
            }
            self = .number(number)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .string(value): try container.encode(value)
        case let .number(value):
            guard value.isFinite else {
                throw EncodingError.invalidValue(value, .init(codingPath: encoder.codingPath, debugDescription: "Non-finite log value"))
            }
            try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

public struct LogEntry: Codable, Equatable, Sendable {
    public let id: EntryID
    public let occurredAt: Date
    public let fields: [String: LogFieldValue]
}

public struct ProjectChecklistItem: Codable, Equatable, Sendable {
    public let id: ItemID
    public let text: String
    public let checked: Bool
    public let ordinal: Int
    public let lineIndex: Int
}

public enum NoteStructuredData: Codable, Equatable, Sendable {
    case list(items: [ListItem])
    case log(entries: [LogEntry])
    case project(checklistItems: [ProjectChecklistItem])
    case plain

    private enum CodingKeys: String, CodingKey { case schemaVersion, items, entries, checklistItems }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let version = try container.decode(Int.self, forKey: .schemaVersion)
        guard version == 1 else {
            throw DecodingError.dataCorruptedError(forKey: .schemaVersion, in: container, debugDescription: "Unsupported structured-data version")
        }
        if container.contains(.items) {
            self = .list(items: try container.decode([ListItem].self, forKey: .items))
        } else if container.contains(.entries) {
            self = .log(entries: try container.decode([LogEntry].self, forKey: .entries))
        } else if container.contains(.checklistItems) {
            self = .project(checklistItems: try container.decode([ProjectChecklistItem].self, forKey: .checklistItems))
        } else {
            self = .plain
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(1, forKey: .schemaVersion)
        switch self {
        case let .list(items): try container.encode(items, forKey: .items)
        case let .log(entries): try container.encode(entries, forKey: .entries)
        case let .project(items): try container.encode(items, forKey: .checklistItems)
        case .plain: break
        }
    }
}

public struct NoteSnapshot: Codable, Equatable, Sendable {
    @RequiredNullable public var spaceId: SpaceID?
    public let type: NoteType
    public let title: String
    public let bodyMarkdown: String
    public let structuredData: NoteStructuredData
    public let isOpen: Bool
    @RequiredNullable public var pinnedAt: Date?
    public let privacy: PrivacyMode
    @RequiredNullable public var archivedAt: Date?
    @RequiredNullable public var deletedAt: Date?
    public let tagIds: [TagID]
    public let links: [NoteLinkValue]
}

public struct Note: Codable, Equatable, Sendable {
    @RequiredNullable public var spaceId: SpaceID?
    public let type: NoteType
    public let title: String
    public let bodyMarkdown: String
    public let structuredData: NoteStructuredData
    public let isOpen: Bool
    @RequiredNullable public var pinnedAt: Date?
    public let privacy: PrivacyMode
    @RequiredNullable public var archivedAt: Date?
    @RequiredNullable public var deletedAt: Date?
    public let tagIds: [TagID]
    public let links: [NoteLinkValue]
    public let id: NoteID
    public let currentRevision: Int
    public let createdAt: Date
    public let updatedAt: Date
}

public struct NoteSummary: Codable, Equatable, Sendable {
    public let id: NoteID
    @RequiredNullable public var spaceId: SpaceID?
    public let type: NoteType
    public let title: String
    public let currentRevision: Int
    public let isOpen: Bool
    @RequiredNullable public var pinnedAt: Date?
    public let privacy: PrivacyMode
    @RequiredNullable public var archivedAt: Date?
    @RequiredNullable public var deletedAt: Date?
    public let updatedAt: Date
}

public struct NoteDetailResponse: Codable, Equatable, Sendable { public let note: Note }
public struct NoteListResponse: Codable, Equatable, Sendable {
    public let items: [NoteSummary]
    public let pageInfo: PageInfo
}

public struct NoteListQuery: Equatable, Sendable {
    public let cursor: String?
    public let limit: Int
    public let spaceId: SpaceID?
    public let restrictToSpace: Bool
    public let type: NoteType?
    public let archive: ArchiveFilter
    public let deleted: DeletedFilter

    public init(cursor: String? = nil, limit: Int = 30, spaceId: SpaceID? = nil,
                restrictToSpace: Bool = false, type: NoteType? = nil,
                archive: ArchiveFilter = .exclude, deleted: DeletedFilter = .exclude) {
        self.cursor = cursor; self.limit = limit; self.spaceId = spaceId
        self.restrictToSpace = restrictToSpace; self.type = type
        self.archive = archive; self.deleted = deleted
    }
}

public struct NoteCreateRequest: Codable, Equatable, Sendable {
    public let idempotencyKey: String
    public let title: String
    public let type: NoteType
    public let spaceId: SpaceID?
    public let privacy: PrivacyMode
    public let bodyMarkdown: String
    public let tagIds: [TagID]
    public let links: [NoteLinkValue]

    public init(idempotencyKey: String, title: String, type: NoteType, spaceId: SpaceID? = nil,
                privacy: PrivacyMode = .aiAssisted, bodyMarkdown: String = "",
                tagIds: [TagID] = [], links: [NoteLinkValue] = []) {
        self.idempotencyKey = idempotencyKey; self.title = title; self.type = type
        self.spaceId = spaceId; self.privacy = privacy; self.bodyMarkdown = bodyMarkdown
        self.tagIds = tagIds; self.links = links
    }
}

public struct NoteUpdateRequest: Encodable, Sendable {
    public let expectedRevision: Int
    public let idempotencyKey: String
    public let title: PatchField<String>
    public let bodyMarkdown: PatchField<String>
    public let privacy: PatchField<PrivacyMode>
    public let spaceId: PatchField<SpaceID>
    public let tagIds: PatchField<[TagID]>
    public let links: PatchField<[NoteLinkValue]>

    public init(expectedRevision: Int, idempotencyKey: String,
                title: PatchField<String> = .unchanged,
                bodyMarkdown: PatchField<String> = .unchanged,
                privacy: PatchField<PrivacyMode> = .unchanged,
                spaceId: PatchField<SpaceID> = .unchanged,
                tagIds: PatchField<[TagID]> = .unchanged,
                links: PatchField<[NoteLinkValue]> = .unchanged) throws {
        guard [title.isChanged, bodyMarkdown.isChanged, privacy.isChanged, spaceId.isChanged,
               tagIds.isChanged, links.isChanged].contains(true) else {
            throw DomainValidationError.invalidValue("At least one note field is required")
        }
        self.expectedRevision = expectedRevision; self.idempotencyKey = idempotencyKey
        self.title = title; self.bodyMarkdown = bodyMarkdown; self.privacy = privacy
        self.spaceId = spaceId; self.tagIds = tagIds; self.links = links
    }

    private enum CodingKeys: String, CodingKey {
        case expectedRevision, idempotencyKey, title, bodyMarkdown, privacy, spaceId, tagIds, links
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(expectedRevision, forKey: .expectedRevision)
        try c.encode(idempotencyKey, forKey: .idempotencyKey)
        try c.encodePatch(title, forKey: .title); try c.encodePatch(bodyMarkdown, forKey: .bodyMarkdown)
        try c.encodePatch(privacy, forKey: .privacy); try c.encodePatch(spaceId, forKey: .spaceId)
        try c.encodePatch(tagIds, forKey: .tagIds); try c.encodePatch(links, forKey: .links)
    }
}

public struct RevisionMutationRequest: Codable, Equatable, Sendable {
    public let expectedRevision: Int
    public let idempotencyKey: String
    public init(expectedRevision: Int, idempotencyKey: String) {
        self.expectedRevision = expectedRevision; self.idempotencyKey = idempotencyKey
    }
}

public struct NoteMoveRequest: Codable, Equatable, Sendable {
    public let expectedRevision: Int; public let idempotencyKey: String; public let spaceId: SpaceID?
    public init(expectedRevision: Int, idempotencyKey: String, spaceId: SpaceID?) {
        self.expectedRevision = expectedRevision; self.idempotencyKey = idempotencyKey; self.spaceId = spaceId
    }
}

public struct NoteArchiveRequest: Codable, Equatable, Sendable {
    public let expectedRevision: Int; public let idempotencyKey: String; public let archived: Bool
    public init(expectedRevision: Int, idempotencyKey: String, archived: Bool = true) {
        self.expectedRevision = expectedRevision; self.idempotencyKey = idempotencyKey; self.archived = archived
    }
}

public typealias NoteSoftDeleteRequest = RevisionMutationRequest
public typealias NoteRestoreDeletedRequest = RevisionMutationRequest

public struct MutationUndoRequest: Codable, Equatable, Sendable {
    public let expectedRevision: Int
    public let idempotencyKey: String

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case expectedRevision, idempotencyKey
    }

    public init(expectedRevision: Int, idempotencyKey: String) throws {
        guard expectedRevision > 0, IdempotencyKeyContract.isValid(idempotencyKey) else {
            throw DomainValidationError.invalidValue("Mutation undo request violates the API contract")
        }
        self.expectedRevision = expectedRevision
        self.idempotencyKey = idempotencyKey
    }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let expectedRevision = try container.decode(Int.self, forKey: .expectedRevision)
        let idempotencyKey = try container.decode(String.self, forKey: .idempotencyKey)
        guard expectedRevision > 0, IdempotencyKeyContract.isValid(idempotencyKey) else {
            throw DecodingError.dataCorruptedError(
                forKey: .expectedRevision,
                in: container,
                debugDescription: "Mutation undo request violates the API contract"
            )
        }
        self.expectedRevision = expectedRevision
        self.idempotencyKey = idempotencyKey
    }

    public func encode(to encoder: Encoder) throws {
        guard expectedRevision > 0, IdempotencyKeyContract.isValid(idempotencyKey) else {
            throw EncodingError.invalidValue(
                expectedRevision,
                .init(
                    codingPath: encoder.codingPath,
                    debugDescription: "Mutation undo request violates the API contract"
                )
            )
        }
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(expectedRevision, forKey: .expectedRevision)
        try container.encode(idempotencyKey, forKey: .idempotencyKey)
    }
}

public struct ToggleItemCheckedOperation: Codable, Equatable, Sendable {
    public let type: String
    public let itemId: ItemID
    public let checked: Bool
    public init(itemId: ItemID, checked: Bool) { type = "toggle_item_checked"; self.itemId = itemId; self.checked = checked }
    private enum CodingKeys: String, CodingKey { case type, itemId, checked }
    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(["type", "itemId", "checked"], from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard try c.decode(String.self, forKey: .type) == "toggle_item_checked" else {
            throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "Unknown operation")
        }
        type = "toggle_item_checked"; itemId = try c.decode(ItemID.self, forKey: .itemId)
        checked = try c.decode(Bool.self, forKey: .checked)
    }
}

public struct UpdateLogFieldOperation: Codable, Equatable, Sendable {
    public let type: String
    public let entryId: EntryID
    public let fieldPath: [String]
    public let value: LogFieldValue

    private enum CodingKeys: String, CodingKey { case type, entryId, fieldPath, value }

    public init(entryId: EntryID, fieldPath: [String], value: LogFieldValue) throws {
        guard (1 ... 8).contains(fieldPath.count), fieldPath.allSatisfy(Self.validPathComponent),
              Self.valid(value) else {
            throw DomainValidationError.invalidValue("Log-field update violates the API contract")
        }
        type = "update_log_field"
        self.entryId = entryId
        self.fieldPath = fieldPath
        self.value = value
    }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(["type", "entryId", "fieldPath", "value"], from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard try container.decode(String.self, forKey: .type) == "update_log_field" else {
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unknown interactive operation"
            )
        }
        entryId = try container.decode(EntryID.self, forKey: .entryId)
        fieldPath = try container.decode([String].self, forKey: .fieldPath)
        value = try container.decode(LogFieldValue.self, forKey: .value)
        type = "update_log_field"
        guard (1 ... 8).contains(fieldPath.count), fieldPath.allSatisfy(Self.validPathComponent),
              Self.valid(value) else {
            throw DecodingError.dataCorruptedError(
                forKey: .fieldPath,
                in: container,
                debugDescription: "Log-field update violates the API contract"
            )
        }
    }

    private static func validPathComponent(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return (1 ... 80).contains(trimmed.utf16.count)
    }

    private static func valid(_ value: LogFieldValue) -> Bool {
        if case let .string(text) = value { return text.utf16.count <= 500 }
        return true
    }
}

public enum InteractiveOperation: Codable, Equatable, Sendable {
    case toggleItemChecked(ToggleItemCheckedOperation)
    case updateLogField(UpdateLogFieldOperation)

    private enum CodingKeys: String, CodingKey { case type }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "toggle_item_checked":
            self = .toggleItemChecked(try ToggleItemCheckedOperation(from: decoder))
        case "update_log_field":
            self = .updateLogField(try UpdateLogFieldOperation(from: decoder))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unknown interactive operation"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case let .toggleItemChecked(operation): try operation.encode(to: encoder)
        case let .updateLogField(operation): try operation.encode(to: encoder)
        }
    }
}

public struct InteractiveOperationsRequest: Codable, Equatable, Sendable {
    public let expectedRevision: Int; public let idempotencyKey: String
    public let operations: [InteractiveOperation]
    public init(expectedRevision: Int, idempotencyKey: String, operations: [InteractiveOperation]) {
        self.expectedRevision = expectedRevision; self.idempotencyKey = idempotencyKey; self.operations = operations
    }
    public init(expectedRevision: Int, idempotencyKey: String, operations: [ToggleItemCheckedOperation]) {
        self.init(
            expectedRevision: expectedRevision,
            idempotencyKey: idempotencyKey,
            operations: operations.map(InteractiveOperation.toggleItemChecked)
        )
    }
}

public struct NoteRevision: Codable, Equatable, Sendable {
    @RequiredNullable public var spaceId: SpaceID?; public let type: NoteType; public let title: String
    public let bodyMarkdown: String; public let structuredData: NoteStructuredData
    public let isOpen: Bool; @RequiredNullable public var pinnedAt: Date?; public let privacy: PrivacyMode
    @RequiredNullable public var archivedAt: Date?; @RequiredNullable public var deletedAt: Date?; public let tagIds: [TagID]
    public let links: [NoteLinkValue]; public let id: RevisionID; public let noteId: NoteID
    public let revision: Int; public let source: RevisionSource; public let contentHash: String
    public let actor: String; public let createdAt: Date
}

public struct NoteRevisionListResponse: Codable, Equatable, Sendable {
    public let items: [NoteRevision]; public let pageInfo: PageInfo
}

public struct NoteRevisionListQuery: Equatable, Sendable {
    public let cursor: String?; public let limit: Int
    public init(cursor: String? = nil, limit: Int = 30) { self.cursor = cursor; self.limit = limit }
}

public struct NoteRestoreRequest: Codable, Equatable, Sendable {
    public let expectedRevision: Int; public let idempotencyKey: String; public let revisionId: RevisionID
    public init(expectedRevision: Int, idempotencyKey: String, revisionId: RevisionID) {
        self.expectedRevision = expectedRevision; self.idempotencyKey = idempotencyKey; self.revisionId = revisionId
    }
}

public struct UndoEligibility: Codable, Equatable, Sendable {
    public let eligible: Bool; @RequiredNullable public var expiresAt: Date?
}

public struct MutationResult: Codable, Equatable, Sendable {
    public let note: Note; public let revision: NoteRevision; public let mutationId: MutationID
    public let replayed: Bool; public let undo: UndoEligibility
}

public struct MutationBatchUndoMember: Codable, Equatable, Sendable {
    public let note: Note
    public let revision: NoteRevision
    public let mutationId: MutationID
    public let undo: UndoEligibility

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case note, revision, mutationId, undo
    }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        note = try container.decode(Note.self, forKey: .note)
        revision = try container.decode(NoteRevision.self, forKey: .revision)
        mutationId = try container.decode(MutationID.self, forKey: .mutationId)
        undo = try container.decode(UndoEligibility.self, forKey: .undo)
        guard note.id == revision.noteId,
              note.currentRevision == revision.revision else {
            throw DecodingError.dataCorruptedError(
                forKey: .revision,
                in: container,
                debugDescription: "Batch undo revision must be the returned note's current revision"
            )
        }
        guard !undo.eligible, undo.expiresAt == nil else {
            throw DecodingError.dataCorruptedError(
                forKey: .undo,
                in: container,
                debugDescription: "A batch undo result cannot itself be eligible for undo"
            )
        }
    }
}

public struct MutationBatchUndoResponse: Codable, Equatable, Sendable {
    public let members: [MutationBatchUndoMember]
    public let replayed: Bool

    private enum CodingKeys: String, CodingKey, CaseIterable { case members, replayed }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        members = try container.decode([MutationBatchUndoMember].self, forKey: .members)
        replayed = try container.decode(Bool.self, forKey: .replayed)
        guard (1 ... 16).contains(members.count),
              Set(members.map(\.note.id)).count == members.count,
              Set(members.map(\.mutationId)).count == members.count else {
            throw DecodingError.dataCorruptedError(
                forKey: .members,
                in: container,
                debugDescription: "Batch undo requires one to sixteen distinct notes and mutations"
            )
        }
    }
}

public struct NoteLink: Codable, Equatable, Sendable {
    public let id: LinkID; public let fromNoteId: NoteID; public let toNoteId: NoteID
    public let linkType: LinkType; public let targetTitle: String
}
public struct NoteLinkListResponse: Codable, Equatable, Sendable { public let items: [NoteLink] }

public struct NoteLinkMutationRequest: Codable, Equatable, Sendable {
    public let expectedRevision: Int; public let idempotencyKey: String
    public let toNoteId: NoteID; public let linkType: LinkType
    public init(expectedRevision: Int, idempotencyKey: String, toNoteId: NoteID, linkType: LinkType) {
        self.expectedRevision = expectedRevision; self.idempotencyKey = idempotencyKey
        self.toNoteId = toNoteId; self.linkType = linkType
    }
}

public struct NoteTagLinkRequest: Codable, Equatable, Sendable {
    public let expectedRevision: Int; public let idempotencyKey: String; public let tagId: TagID
    public init(expectedRevision: Int, idempotencyKey: String, tagId: TagID) {
        self.expectedRevision = expectedRevision; self.idempotencyKey = idempotencyKey; self.tagId = tagId
    }
}

public typealias NoteDetail = Note
public typealias NoteRevisionDto = NoteRevision
public typealias NoteLinkCreateRequest = NoteLinkMutationRequest
public typealias NoteLinkDeleteRequest = NoteLinkMutationRequest
public typealias NoteTagUnlinkRequest = RevisionMutationRequest
public typealias NoteRelationMutationResponse = MutationResult
public typealias OperationsRequest = InteractiveOperationsRequest
