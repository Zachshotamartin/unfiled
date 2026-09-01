import Foundation

public struct NoteContextListQuery: Equatable, Sendable {
    public let cursor: String?
    public let limit: Int

    public init(cursor: String? = nil, limit: Int = 30) {
        self.cursor = cursor
        self.limit = limit
    }
}

public typealias NoteSourcesQuery = NoteContextListQuery
public typealias NoteBacklinksQuery = NoteContextListQuery

public enum NoteSourceRelation: String, Codable, CaseIterable, Sendable {
    case routed
    case sourceRemoved = "source_removed"
}

public struct NoteSource: Codable, Equatable, Sendable {
    public let captureId: CaptureID
    public let mutationId: MutationID
    public let relation: NoteSourceRelation
    public let rawContent: String
    public let source: CaptureSource
    public let clientCreatedAt: Date
    public let insertedItemIds: [CapturedItemID]
    public let createdAt: Date

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case captureId, mutationId, relation, rawContent, source
        case clientCreatedAt, insertedItemIds, createdAt
    }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        captureId = try container.decode(CaptureID.self, forKey: .captureId)
        mutationId = try container.decode(MutationID.self, forKey: .mutationId)
        relation = try container.decode(NoteSourceRelation.self, forKey: .relation)
        rawContent = try container.decode(String.self, forKey: .rawContent)
        source = try container.decode(CaptureSource.self, forKey: .source)
        clientCreatedAt = try container.decode(Date.self, forKey: .clientCreatedAt)
        insertedItemIds = try container.decode([CapturedItemID].self, forKey: .insertedItemIds)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        guard (1 ... 10_000).contains(rawContent.utf16.count),
              !rawContent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              insertedItemIds.count <= 500 else {
            throw DecodingError.dataCorruptedError(
                forKey: .rawContent,
                in: container,
                debugDescription: "Note source violates the API contract"
            )
        }
    }
}

public struct NoteSourcesResponse: Codable, Equatable, Sendable {
    public let items: [NoteSource]
    public let pageInfo: PageInfo

    private enum CodingKeys: String, CodingKey, CaseIterable { case items, pageInfo }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        items = try container.decode([NoteSource].self, forKey: .items)
        pageInfo = try container.decode(PageInfo.self, forKey: .pageInfo)
    }
}

public struct NoteBacklink: Codable, Equatable, Sendable {
    public let linkId: LinkID
    public let fromNoteId: NoteID
    public let fromTitle: String
    public let linkType: LinkType
    public let createdAt: Date

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case linkId, fromNoteId, fromTitle, linkType, createdAt
    }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        linkId = try container.decode(LinkID.self, forKey: .linkId)
        fromNoteId = try container.decode(NoteID.self, forKey: .fromNoteId)
        fromTitle = try container.decode(String.self, forKey: .fromTitle)
        linkType = try container.decode(LinkType.self, forKey: .linkType)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        guard (1 ... 200).contains(fromTitle.utf16.count) else {
            throw DecodingError.dataCorruptedError(
                forKey: .fromTitle,
                in: container,
                debugDescription: "Backlink title violates the API contract"
            )
        }
    }
}

public struct NoteBacklinksResponse: Codable, Equatable, Sendable {
    public let items: [NoteBacklink]
    public let pageInfo: PageInfo

    private enum CodingKeys: String, CodingKey, CaseIterable { case items, pageInfo }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        items = try container.decode([NoteBacklink].self, forKey: .items)
        pageInfo = try container.decode(PageInfo.self, forKey: .pageInfo)
    }
}
