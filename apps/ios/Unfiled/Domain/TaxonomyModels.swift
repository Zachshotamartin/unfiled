import Foundation

public struct Space: Codable, Equatable, Sendable {
    public let id: SpaceID; @RequiredNullable public var parentId: SpaceID?; public let name: String
    public let slug: String; public let sortKey: String; public let currentRevision: Int
    @RequiredNullable public var archivedAt: Date?; public let createdAt: Date; public let updatedAt: Date
}
public struct SpaceDetailResponse: Codable, Equatable, Sendable { public let space: Space }
public struct SpaceListResponse: Codable, Equatable, Sendable {
    public let items: [Space]; public let pageInfo: PageInfo
}
public struct SpaceListQuery: Equatable, Sendable {
    public let cursor: String?; public let limit: Int; public let includeArchived: Bool
    public init(cursor: String? = nil, limit: Int = 30, includeArchived: Bool = false) {
        self.cursor = cursor; self.limit = limit; self.includeArchived = includeArchived
    }
}
public struct SpaceCreateRequest: Codable, Equatable, Sendable {
    public let idempotencyKey: String; public let name: String; public let parentId: SpaceID?
    public let sortKey: String?
    public init(idempotencyKey: String, name: String, parentId: SpaceID? = nil, sortKey: String? = nil) {
        self.idempotencyKey = idempotencyKey; self.name = name; self.parentId = parentId; self.sortKey = sortKey
    }
}
public struct SpaceUpdateRequest: Encodable, Sendable {
    public let expectedRevision: Int; public let idempotencyKey: String
    public let name: PatchField<String>; public let parentId: PatchField<SpaceID>
    public let sortKey: PatchField<String>
    public init(expectedRevision: Int, idempotencyKey: String,
                name: PatchField<String> = .unchanged,
                parentId: PatchField<SpaceID> = .unchanged,
                sortKey: PatchField<String> = .unchanged) throws {
        guard name.isChanged || parentId.isChanged || sortKey.isChanged else {
            throw DomainValidationError.invalidValue("At least one space field is required")
        }
        self.expectedRevision = expectedRevision; self.idempotencyKey = idempotencyKey
        self.name = name; self.parentId = parentId; self.sortKey = sortKey
    }
    private enum CodingKeys: String, CodingKey { case expectedRevision, idempotencyKey, name, parentId, sortKey }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(expectedRevision, forKey: .expectedRevision); try c.encode(idempotencyKey, forKey: .idempotencyKey)
        try c.encodePatch(name, forKey: .name); try c.encodePatch(parentId, forKey: .parentId)
        try c.encodePatch(sortKey, forKey: .sortKey)
    }
}
public struct SpaceArchiveRequest: Codable, Equatable, Sendable {
    public let expectedRevision: Int; public let idempotencyKey: String; public let archived: Bool
    public init(expectedRevision: Int, idempotencyKey: String, archived: Bool = true) {
        self.expectedRevision = expectedRevision; self.idempotencyKey = idempotencyKey; self.archived = archived
    }
}
public struct SpaceMutationResult: Codable, Equatable, Sendable { public let space: Space; public let replayed: Bool }

public struct Tag: Codable, Equatable, Sendable {
    public let id: TagID; public let name: String; public let currentRevision: Int; public let createdAt: Date
}
public struct TagListResponse: Codable, Equatable, Sendable { public let items: [Tag]; public let pageInfo: PageInfo }
public struct TagListQuery: Equatable, Sendable {
    public let cursor: String?; public let limit: Int
    public init(cursor: String? = nil, limit: Int = 30) { self.cursor = cursor; self.limit = limit }
}
public struct TagCreateRequest: Codable, Equatable, Sendable {
    public let idempotencyKey: String; public let name: String
    public init(idempotencyKey: String, name: String) { self.idempotencyKey = idempotencyKey; self.name = name }
}
public struct TagUpdateRequest: Codable, Equatable, Sendable {
    public let expectedRevision: Int; public let idempotencyKey: String; public let name: String
    public init(expectedRevision: Int, idempotencyKey: String, name: String) {
        self.expectedRevision = expectedRevision; self.idempotencyKey = idempotencyKey; self.name = name
    }
}
public typealias TagDeleteRequest = RevisionMutationRequest
public struct TagMutationResult: Codable, Equatable, Sendable { public let tag: Tag; public let replayed: Bool }
public struct DeleteMutationResult: Codable, Equatable, Sendable { public let deletedId: String; public let replayed: Bool }

public enum SearchSpaceFilter: Equatable, Sendable {
    case any
    case root
    case space(SpaceID)
}

public struct SearchNotesRequest: Encodable, Equatable, Sendable {
    public let query: String
    public let archive: ArchiveFilter
    public let type: NoteType?
    public let space: SearchSpaceFilter
    public let tagIds: [TagID]
    public let updatedFrom: Date?
    public let updatedTo: Date?
    public let privacy: PrivacyMode?
    public let cursor: String?
    public let limit: Int

    private enum CodingKeys: String, CodingKey {
        case query, archive, type, spaceId, tagIds, updatedFrom, updatedTo, privacy, cursor, limit
    }

    public init(
        query: String,
        archive: ArchiveFilter = .exclude,
        type: NoteType? = nil,
        space: SearchSpaceFilter = .any,
        tagIds: [TagID] = [],
        updatedFrom: Date? = nil,
        updatedTo: Date? = nil,
        privacy: PrivacyMode? = nil,
        cursor: String? = nil,
        limit: Int = 30
    ) {
        self.query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        self.archive = archive
        self.type = type
        self.space = space
        self.tagIds = tagIds
        self.updatedFrom = updatedFrom
        self.updatedTo = updatedTo
        self.privacy = privacy
        self.cursor = cursor
        self.limit = limit
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(query, forKey: .query)
        try container.encode(archive, forKey: .archive)
        try container.encodeIfPresent(type, forKey: .type)
        switch space {
        case .any: break
        case .root: try container.encodeNil(forKey: .spaceId)
        case let .space(id): try container.encode(id, forKey: .spaceId)
        }
        if !tagIds.isEmpty { try container.encode(tagIds, forKey: .tagIds) }
        try container.encodeIfPresent(updatedFrom, forKey: .updatedFrom)
        try container.encodeIfPresent(updatedTo, forKey: .updatedTo)
        try container.encodeIfPresent(privacy, forKey: .privacy)
        try container.encodeIfPresent(cursor, forKey: .cursor)
        try container.encode(limit, forKey: .limit)
    }
}
public struct SearchNoteResult: Codable, Equatable, Sendable {
    public let noteId: NoteID; public let title: String; public let type: NoteType; public let snippet: String
    public let spacePath: [String]; public let updatedAt: Date; @RequiredNullable public var archivedAt: Date?

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case noteId, title, type, snippet, spacePath, updatedAt, archivedAt
    }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        noteId = try container.decode(NoteID.self, forKey: .noteId)
        title = try container.decode(String.self, forKey: .title)
        type = try container.decode(NoteType.self, forKey: .type)
        snippet = try container.decode(String.self, forKey: .snippet)
        spacePath = try container.decode([String].self, forKey: .spacePath)
        updatedAt = try container.decode(Date.self, forKey: .updatedAt)
        _archivedAt = try container.decode(RequiredNullable<Date>.self, forKey: .archivedAt)
        guard (1 ... 200).contains(title.utf16.count),
              snippet.utf16.count <= 500,
              spacePath.count <= 2,
              spacePath.allSatisfy({ (1 ... 60).contains($0.utf16.count) }) else {
            throw DecodingError.dataCorruptedError(
                forKey: .spacePath,
                in: container,
                debugDescription: "Search result violates the API contract"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(noteId, forKey: .noteId)
        try container.encode(title, forKey: .title)
        try container.encode(type, forKey: .type)
        try container.encode(snippet, forKey: .snippet)
        try container.encode(spacePath, forKey: .spacePath)
        try container.encode(updatedAt, forKey: .updatedAt)
        try container.encode(_archivedAt, forKey: .archivedAt)
    }
}
public struct SearchNotesResponse: Codable, Equatable, Sendable {
    public let items: [SearchNoteResult]; public let pageInfo: PageInfo

    private enum CodingKeys: String, CodingKey, CaseIterable { case items, pageInfo }
    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        items = try container.decode([SearchNoteResult].self, forKey: .items)
        pageInfo = try container.decode(PageInfo.self, forKey: .pageInfo)
    }
}

public enum ReviewType: String, Codable, CaseIterable, Sendable {
    case lowConfidence = "low_confidence", revisionConflict = "revision_conflict"
    case failedJob = "failed_job", duplicateSuggestion = "duplicate_suggestion"
    case pendingExpansion = "pending_expansion", structureConflict = "structure_conflict"
}
public enum ReviewState: String, Codable, CaseIterable, Sendable { case open, resolved, dismissed }
public struct ReviewItem: Codable, Equatable, Sendable {
    public let id: ReviewID
    @RequiredNullable public var captureId: CaptureID?
    @RequiredNullable public var noteId: NoteID?
    public let type: ReviewType
    public let proposal: ReviewProposal
    public let state: ReviewState
    @RequiredNullable public var resolution: ReviewResolution?
    public let createdAt: Date
    @RequiredNullable public var resolvedAt: Date?

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case id, captureId, noteId, type, proposal, state, resolution, createdAt, resolvedAt
    }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(ReviewID.self, forKey: .id)
        _captureId = try container.decode(RequiredNullable<CaptureID>.self, forKey: .captureId)
        _noteId = try container.decode(RequiredNullable<NoteID>.self, forKey: .noteId)
        type = try container.decode(ReviewType.self, forKey: .type)
        proposal = try container.decode(ReviewProposal.self, forKey: .proposal)
        state = try container.decode(ReviewState.self, forKey: .state)
        _resolution = try container.decode(
            RequiredNullable<ReviewResolution>.self,
            forKey: .resolution
        )
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        _resolvedAt = try container.decode(RequiredNullable<Date>.self, forKey: .resolvedAt)

        let validState = switch state {
        case .open:
            resolution == nil && resolvedAt == nil
        case .resolved:
            resolution != nil && resolution?.isDismissal == false && resolvedAt != nil
        case .dismissed:
            resolution?.isDismissal == true && resolvedAt != nil
        }
        guard Self.proposalMatches(type: type, proposal: proposal),
              Self.resolutionMatches(type: type, proposal: proposal, resolution: resolution),
              validState else {
            throw DecodingError.dataCorruptedError(
                forKey: .resolution,
                in: container,
                debugDescription: "Review type, proposal, state, and resolution do not agree"
            )
        }
    }

    private static func proposalMatches(type: ReviewType, proposal: ReviewProposal) -> Bool {
        switch (type, proposal) {
        case (.lowConfidence, .routeCapture):
            true
        case (.revisionConflict, .conflict(reason: .revision)):
            true
        case (.failedJob, .failedJob):
            true
        case (.duplicateSuggestion, .duplicateNotes):
            true
        case (.pendingExpansion, .generatedBlock),
             (.pendingExpansion, .conflict(reason: .consentControls)):
            true
        case (.structureConflict, .conflict(reason: .candidateEligibility)),
             (.structureConflict, .conflict(reason: .structure)):
            true
        default:
            false
        }
    }

    private static func resolutionMatches(
        type: ReviewType,
        proposal: ReviewProposal,
        resolution: ReviewResolution?
    ) -> Bool {
        guard let resolution else { return true }
        if case .dismiss = resolution { return true }

        switch (type, resolution) {
        case (.duplicateSuggestion, .keepBoth):
            return true
        case (.pendingExpansion, .acceptExpansion),
             (.pendingExpansion, .rejectExpansion):
            if case .generatedBlock = proposal { return true }
            return false
        case (.lowConfidence, .route),
             (.lowConfidence, .create),
             (.lowConfidence, .keepInbox),
             (.revisionConflict, .route),
             (.revisionConflict, .create),
             (.revisionConflict, .keepInbox),
             (.failedJob, .keepInbox),
             (.structureConflict, .route),
             (.structureConflict, .create),
             (.structureConflict, .keepInbox):
            return true
        default:
            return false
        }
    }
}
public struct ReviewItemListQuery: Equatable, Sendable {
    public let state: ReviewState; public let cursor: String?; public let limit: Int
    public init(state: ReviewState = .open, cursor: String? = nil, limit: Int = 30) {
        self.state = state; self.cursor = cursor; self.limit = limit
    }
}
public struct ListReviewItemsResponse: Codable, Equatable, Sendable {
    public let items: [ReviewItem]
    public let pageInfo: PageInfo

    private enum CodingKeys: String, CodingKey, CaseIterable { case items, pageInfo }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        items = try container.decode([ReviewItem].self, forKey: .items)
        pageInfo = try container.decode(PageInfo.self, forKey: .pageInfo)
    }
}

public typealias ReviewItemDto = ReviewItem
