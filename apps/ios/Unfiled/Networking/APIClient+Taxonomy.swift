import Foundation

extension APIClient {
    public func listSpaces(_ query: SpaceListQuery = .init()) async throws -> SpaceListResponse {
        var items = try pageItems(cursor: query.cursor, limit: query.limit)
        items.append(.init(name: "includeArchived", value: String(query.includeArchived)))
        return try await get("/spaces", query: items)
    }
    public func getSpace(_ id: SpaceID) async throws -> SpaceDetailResponse { try await get("/spaces/\(id.rawValue)") }
    public func createSpace(_ request: SpaceCreateRequest) async throws -> SpaceMutationResult {
        try await post("/spaces", body: request, idempotencyKey: request.idempotencyKey)
    }
    public func updateSpace(_ id: SpaceID, request: SpaceUpdateRequest) async throws -> SpaceMutationResult {
        try await patch("/spaces/\(id.rawValue)", body: request, idempotencyKey: request.idempotencyKey)
    }
    public func archiveSpace(_ id: SpaceID, request: SpaceArchiveRequest) async throws -> SpaceMutationResult {
        try await post("/spaces/\(id.rawValue)/archive", body: request, idempotencyKey: request.idempotencyKey)
    }

    public func listTags(_ query: TagListQuery = .init()) async throws -> TagListResponse {
        try await get("/tags", query: pageItems(cursor: query.cursor, limit: query.limit))
    }
    public func createTag(_ request: TagCreateRequest) async throws -> TagMutationResult {
        try await post("/tags", body: request, idempotencyKey: request.idempotencyKey)
    }
    public func updateTag(_ id: TagID, request: TagUpdateRequest) async throws -> TagMutationResult {
        try await patch("/tags/\(id.rawValue)", body: request, idempotencyKey: request.idempotencyKey)
    }
    public func deleteTag(_ id: TagID, request: TagDeleteRequest) async throws -> DeleteMutationResult {
        try await delete("/tags/\(id.rawValue)", body: request, idempotencyKey: request.idempotencyKey)
    }

    public func searchNotes(_ query: SearchNotesQuery) async throws -> SearchNotesResponse {
        guard !query.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              query.query.utf16.count <= 200 else { throw APIClientError.invalidRequest }
        var items = try pageItems(cursor: query.cursor, limit: query.limit)
        items.append(.init(name: "q", value: query.query))
        items.append(.init(name: "archive", value: query.archive.rawValue))
        return try await get("/search", query: items)
    }

    public func listReviewItems(_ query: ReviewItemListQuery = .init()) async throws -> ListReviewItemsResponse {
        var items = try pageItems(cursor: query.cursor, limit: query.limit)
        items.append(.init(name: "state", value: query.state.rawValue))
        return try await get("/review-items", query: items)
    }
}
