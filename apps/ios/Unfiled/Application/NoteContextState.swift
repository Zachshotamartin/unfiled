import Foundation

enum NoteContextFailure: Equatable, Sendable {
    case deleted
    case offline
    case stale
    case unavailable

    var title: String {
        switch self {
        case .deleted: "This note is no longer available"
        case .offline: "Context is unavailable offline"
        case .stale: "This note changed"
        case .unavailable: "Context could not be loaded"
        }
    }

    var message: String {
        switch self {
        case .deleted:
            "Sources and backlinks were removed from this screen."
        case .offline:
            "Reconnect to load this private note context."
        case .stale:
            "Refresh to load sources and backlinks for the current revision."
        case .unavailable:
            "Your note is unchanged. Try loading its context again."
        }
    }

    var glyph: UnfiledGlyph {
        switch self {
        case .deleted: .trash
        case .offline: .warning
        case .stale: .clock
        case .unavailable: .warning
        }
    }
}

struct NoteContextViewState: Equatable, Sendable {
    let revision: Int
    var sources: [NoteSource] = []
    var backlinks: [NoteBacklink] = []
    var isLoadingSources = false
    var isLoadingBacklinks = false
    var hasLoadedSources = false
    var hasLoadedBacklinks = false
    var isLoadingMoreSources = false
    var isLoadingMoreBacklinks = false
    var hasMoreSources = false
    var hasMoreBacklinks = false
    var sourcesFailure: NoteContextFailure?
    var backlinksFailure: NoteContextFailure?
    var sourcesNotice: String?
    var backlinksNotice: String?

    init(revision: Int) {
        self.revision = revision
    }
}

enum NoteContextPaginationError: Error, Equatable, Sendable {
    case duplicateItemIdentifier
    case inconsistentPageInfo
    case pageLimitExceeded
    case unexpectedPage
}

private struct NoteContextPageLedger: Equatable, Sendable {
    private(set) var nextCursor: String?
    private(set) var pageCount = 0
    private(set) var itemCount = 0
    private var seenItemIDs = Set<String>()
    private var seenCursors = Set<String>()

    var canLoadMore: Bool {
        nextCursor != nil && pageCount < NoteSourcesPaginationState.maximumPageCount
    }

    var reachedDisplayLimit: Bool {
        nextCursor != nil && pageCount >= NoteSourcesPaginationState.maximumPageCount
    }

    mutating func accept(
        identifiers: [String],
        pageInfo: PageInfo,
        after requestedCursor: String?,
        pageLimit: Int
    ) throws {
        guard pageCount < NoteSourcesPaginationState.maximumPageCount,
              identifiers.count <= pageLimit,
              itemCount <= NoteSourcesPaginationState.maximumItemCount - identifiers.count
        else {
            throw NoteContextPaginationError.pageLimitExceeded
        }
        guard (pageCount == 0 && requestedCursor == nil) ||
              (pageCount > 0 && requestedCursor == nextCursor && requestedCursor != nil)
        else {
            throw NoteContextPaginationError.unexpectedPage
        }

        let pageIDs = Set(identifiers)
        guard pageIDs.count == identifiers.count,
              seenItemIDs.isDisjoint(with: pageIDs) else {
            throw NoteContextPaginationError.duplicateItemIdentifier
        }

        let acceptedCursor: String?
        if pageInfo.hasMore {
            guard !identifiers.isEmpty,
                  let cursor = pageInfo.nextCursor,
                  !cursor.isEmpty,
                  seenCursors.insert(cursor).inserted else {
                throw NoteContextPaginationError.inconsistentPageInfo
            }
            acceptedCursor = cursor
        } else {
            guard pageInfo.nextCursor == nil else {
                throw NoteContextPaginationError.inconsistentPageInfo
            }
            acceptedCursor = nil
        }

        seenItemIDs.formUnion(pageIDs)
        nextCursor = acceptedCursor
        pageCount += 1
        itemCount += identifiers.count
    }
}

struct NoteSourcesPaginationState: Equatable, Sendable {
    static let maximumPageCount = 20
    static let maximumItemCount = 2_000

    let boundRevision: Int
    let pageLimit: Int
    private(set) var items: [NoteSource] = []
    private var ledger = NoteContextPageLedger()

    init(first page: NoteSourcesResponse, boundRevision: Int, pageLimit: Int = 30) throws {
        guard boundRevision > 0, (1 ... 100).contains(pageLimit) else {
            throw NoteContextPaginationError.unexpectedPage
        }
        self.boundRevision = boundRevision
        self.pageLimit = pageLimit
        try append(page, after: nil)
    }

    var nextCursor: String? { ledger.nextCursor }
    var pageCount: Int { ledger.pageCount }
    var canLoadMore: Bool { ledger.canLoadMore }
    var reachedDisplayLimit: Bool { ledger.reachedDisplayLimit }

    mutating func append(_ page: NoteSourcesResponse, after requestedCursor: String?) throws {
        try ledger.accept(
            identifiers: page.items.map {
                "\($0.captureId.rawValue)|\($0.mutationId.rawValue)"
            },
            pageInfo: page.pageInfo,
            after: requestedCursor,
            pageLimit: pageLimit
        )
        items.append(contentsOf: page.items)
    }
}

struct NoteBacklinksPaginationState: Equatable, Sendable {
    static let maximumPageCount = NoteSourcesPaginationState.maximumPageCount
    static let maximumItemCount = NoteSourcesPaginationState.maximumItemCount

    let boundRevision: Int
    let pageLimit: Int
    private(set) var items: [NoteBacklink] = []
    private var ledger = NoteContextPageLedger()

    init(first page: NoteBacklinksResponse, boundRevision: Int, pageLimit: Int = 30) throws {
        guard boundRevision > 0, (1 ... 100).contains(pageLimit) else {
            throw NoteContextPaginationError.unexpectedPage
        }
        self.boundRevision = boundRevision
        self.pageLimit = pageLimit
        try append(page, after: nil)
    }

    var nextCursor: String? { ledger.nextCursor }
    var pageCount: Int { ledger.pageCount }
    var canLoadMore: Bool { ledger.canLoadMore }
    var reachedDisplayLimit: Bool { ledger.reachedDisplayLimit }

    mutating func append(_ page: NoteBacklinksResponse, after requestedCursor: String?) throws {
        try ledger.accept(
            identifiers: page.items.map(\.linkId.rawValue),
            pageInfo: page.pageInfo,
            after: requestedCursor,
            pageLimit: pageLimit
        )
        items.append(contentsOf: page.items)
    }
}
