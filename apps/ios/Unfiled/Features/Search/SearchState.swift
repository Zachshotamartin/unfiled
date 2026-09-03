import Foundation

enum SearchInputRules {
    static let maximumQueryUTF16Units = 200

    static func bounded(_ value: String) -> String {
        guard value.utf16.count > maximumQueryUTF16Units else { return value }
        var result = ""
        result.reserveCapacity(min(value.count, maximumQueryUTF16Units))
        var units = 0
        for character in value {
            let width = String(character).utf16.count
            guard units <= maximumQueryUTF16Units - width else { break }
            result.append(character)
            units += width
        }
        return result
    }
}

struct SearchRequest: Hashable, Sendable {
    let query: String
    let includesArchived: Bool

    init(query: String, includesArchived: Bool) {
        self.query = SearchInputRules.bounded(
            query.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        self.includesArchived = includesArchived
    }

    var hasQuery: Bool { !query.isEmpty }
    var archive: ArchiveFilter { includesArchived ? .include : .exclude }

    func apiRequest(cursor: String? = nil, limit: Int = 50) -> SearchNotesRequest {
        SearchNotesRequest(
            query: query,
            archive: archive,
            privacy: nil,
            cursor: cursor,
            limit: limit
        )
    }
}

enum SearchFailure: Equatable, Sendable {
    case offline
    case unavailable

    var title: String {
        switch self {
        case .offline: "You’re offline"
        case .unavailable: "Search is unavailable"
        }
    }

    var message: String {
        switch self {
        case .offline: "Reconnect to search your private notes."
        case .unavailable: "Your notes are unchanged. Try this search again."
        }
    }

    var glyph: UnfiledGlyph { .warning }
}

enum SearchPaginationError: Error, Equatable, Sendable {
    case duplicateResult
    case inconsistentPageInfo
    case pageLimitExceeded
    case unexpectedPage
}

struct SearchPaginationState: Equatable, Sendable {
    static let maximumPageCount = 20
    static let maximumItemCount = 1_000
    static let displayLimitMessage =
        "Showing the first 1,000 results. Refine your search to see a narrower set."

    let request: SearchRequest
    let pageLimit: Int
    private(set) var items: [SearchNoteResult] = []
    private(set) var nextCursor: String?
    private(set) var pageCount = 0
    private var seenResultIDs = Set<String>()
    private var seenCursors = Set<String>()

    init(first page: SearchNotesResponse, request: SearchRequest, pageLimit: Int = 50) throws {
        guard request.hasQuery, (1 ... 100).contains(pageLimit) else {
            throw SearchPaginationError.unexpectedPage
        }
        self.request = request
        self.pageLimit = pageLimit
        try append(page, after: nil)
    }

    var canLoadMore: Bool {
        nextCursor != nil && pageCount < Self.maximumPageCount
    }

    var reachedDisplayLimit: Bool {
        nextCursor != nil && pageCount >= Self.maximumPageCount
    }

    mutating func append(_ page: SearchNotesResponse, after requestedCursor: String?) throws {
        guard pageCount < Self.maximumPageCount,
              page.items.count <= pageLimit,
              items.count <= Self.maximumItemCount - page.items.count else {
            throw SearchPaginationError.pageLimitExceeded
        }
        guard (pageCount == 0 && requestedCursor == nil) ||
              (pageCount > 0 && requestedCursor != nil && requestedCursor == nextCursor) else {
            throw SearchPaginationError.unexpectedPage
        }

        let identifiers = page.items.map(\.noteId.rawValue)
        let pageIDs = Set(identifiers)
        guard pageIDs.count == identifiers.count,
              seenResultIDs.isDisjoint(with: pageIDs) else {
            throw SearchPaginationError.duplicateResult
        }

        let acceptedCursor: String?
        if page.pageInfo.hasMore {
            guard !page.items.isEmpty,
                  let cursor = page.pageInfo.nextCursor,
                  !cursor.isEmpty,
                  seenCursors.insert(cursor).inserted else {
                throw SearchPaginationError.inconsistentPageInfo
            }
            acceptedCursor = cursor
        } else {
            guard page.pageInfo.nextCursor == nil else {
                throw SearchPaginationError.inconsistentPageInfo
            }
            acceptedCursor = nil
        }

        items.append(contentsOf: page.items)
        seenResultIDs.formUnion(pageIDs)
        nextCursor = acceptedCursor
        pageCount += 1
    }
}
