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

    public func searchNotes(_ request: SearchNotesRequest) async throws -> SearchNotesResponse {
        guard (1 ... 200).contains(request.query.utf16.count),
              (1 ... 100).contains(request.limit),
              request.cursor.map({ (1 ... 512).contains($0.utf16.count) }) ?? true,
              request.tagIds.count <= 20,
              Set(request.tagIds).count == request.tagIds.count,
              request.updatedFrom.map({ from in
                  request.updatedTo.map({ from < $0 }) ?? true
              }) ?? true else {
            throw APIClientError.invalidRequest
        }
        return try await post("/search", body: request)
    }

    public func listReviewItems(_ query: ReviewItemListQuery = .init()) async throws -> ListReviewItemsResponse {
        var items = try pageItems(cursor: query.cursor, limit: query.limit)
        items.append(.init(name: "state", value: query.state.rawValue))
        return try await get("/review-items", query: items)
    }
}
