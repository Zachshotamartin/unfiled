import Foundation

extension APIClient {
    public func listNotes(_ query: NoteListQuery = .init()) async throws -> NoteListResponse {
        var items = try pageItems(cursor: query.cursor, limit: query.limit)
        if query.restrictToSpace { items.append(.init(name: "spaceId", value: query.spaceId?.rawValue ?? "root")) }
        if let type = query.type { items.append(.init(name: "type", value: type.rawValue)) }
        items.append(.init(name: "archive", value: query.archive.rawValue))
        items.append(.init(name: "deleted", value: query.deleted.rawValue))
        return try await get("/notes", query: items)
    }

    public func getNote(_ id: NoteID) async throws -> NoteDetailResponse { try await get("/notes/\(id.rawValue)") }

    public func createNote(_ request: NoteCreateRequest) async throws -> MutationResult {
        guard NoteRequestContract.isValid(request) else {
            throw APIClientError.invalidRequest
        }
        return try await post("/notes", body: request, idempotencyKey: request.idempotencyKey)
    }

    public func updateNote(_ id: NoteID, request: NoteUpdateRequest) async throws -> MutationResult {
        guard NoteRequestContract.isValid(request) else {
            throw APIClientError.invalidRequest
        }
        return try await patch(
            "/notes/\(id.rawValue)",
            body: request,
            idempotencyKey: request.idempotencyKey
        )
    }

    public func softDeleteNote(_ id: NoteID, request: NoteSoftDeleteRequest) async throws -> MutationResult {
        try await delete("/notes/\(id.rawValue)", body: request, idempotencyKey: request.idempotencyKey)
    }

    public func applyNoteOperations(_ id: NoteID, request: InteractiveOperationsRequest) async throws -> MutationResult {
        guard (1 ... 20).contains(request.operations.count) else { throw APIClientError.invalidRequest }
        return try await post("/notes/\(id.rawValue)/operations", body: request, idempotencyKey: request.idempotencyKey)
    }

    public func moveNote(_ id: NoteID, request: NoteMoveRequest) async throws -> MutationResult {
        try await post("/notes/\(id.rawValue)/move", body: request, idempotencyKey: request.idempotencyKey)
    }

    public func archiveNote(_ id: NoteID, request: NoteArchiveRequest) async throws -> MutationResult {
        try await post("/notes/\(id.rawValue)/archive", body: request, idempotencyKey: request.idempotencyKey)
    }

    public func restoreDeletedNote(_ id: NoteID, request: NoteRestoreDeletedRequest) async throws -> MutationResult {
        try await post("/notes/\(id.rawValue)/restore-deleted", body: request, idempotencyKey: request.idempotencyKey)
    }

    public func listNoteRevisions(_ id: NoteID, cursor: String? = nil, limit: Int = 30) async throws -> NoteRevisionListResponse {
        try await get("/notes/\(id.rawValue)/revisions", query: pageItems(cursor: cursor, limit: limit))
    }

    public func restoreNoteRevision(_ id: NoteID, request: NoteRestoreRequest) async throws -> MutationResult {
        try await post("/notes/\(id.rawValue)/restore", body: request, idempotencyKey: request.idempotencyKey)
    }

    public func listNoteLinks(_ id: NoteID) async throws -> NoteLinkListResponse {
        try await get("/notes/\(id.rawValue)/links")
    }

    public func createNoteLink(_ id: NoteID, request: NoteLinkMutationRequest) async throws -> MutationResult {
        try await post("/notes/\(id.rawValue)/links", body: request, idempotencyKey: request.idempotencyKey)
    }

    public func deleteNoteLink(_ noteId: NoteID, linkId: LinkID, request: NoteLinkMutationRequest) async throws -> MutationResult {
        try await delete("/notes/\(noteId.rawValue)/links/\(linkId.rawValue)", body: request, idempotencyKey: request.idempotencyKey)
    }

    public func linkNoteTag(_ noteId: NoteID, request: NoteTagLinkRequest) async throws -> MutationResult {
        try await post("/notes/\(noteId.rawValue)/tags", body: request, idempotencyKey: request.idempotencyKey)
    }

    public func unlinkNoteTag(_ noteId: NoteID, tagId: TagID, request: RevisionMutationRequest) async throws -> MutationResult {
        try await delete("/notes/\(noteId.rawValue)/tags/\(tagId.rawValue)", body: request, idempotencyKey: request.idempotencyKey)
    }

    public func undoMutation(_ id: MutationID, request: MutationUndoRequest) async throws -> MutationResult {
        try await post("/mutations/\(id.rawValue)/undo", body: request, idempotencyKey: request.idempotencyKey)
    }
}

private enum NoteRequestContract {
    private static let maximumTitleUTF16Units = 200
    private static let maximumBodyUTF16Units = 200_000
    private static let maximumTagCount = 100
    private static let maximumLinkCount = 100

    static func isValid(_ request: NoteCreateRequest) -> Bool {
        isValidTitle(request.title)
            && request.bodyMarkdown.utf16.count <= maximumBodyUTF16Units
            && request.tagIds.count <= maximumTagCount
            && request.links.count <= maximumLinkCount
    }

    static func isValid(_ request: NoteUpdateRequest) -> Bool {
        request.expectedRevision > 0
            && isValidTitle(request.title)
            && isValidBody(request.bodyMarkdown)
            && isValidCollection(request.tagIds, maximumCount: maximumTagCount)
            && isValidCollection(request.links, maximumCount: maximumLinkCount)
    }

    private static func isValidTitle(_ title: String) -> Bool {
        let normalized = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return (1 ... maximumTitleUTF16Units).contains(normalized.utf16.count)
    }

    private static func isValidTitle(_ title: PatchField<String>) -> Bool {
        switch title {
        case .unchanged:
            true
        case let .value(value):
            isValidTitle(value)
        case .null:
            false
        }
    }

    private static func isValidBody(_ body: PatchField<String>) -> Bool {
        switch body {
        case .unchanged:
            true
        case let .value(value):
            value.utf16.count <= maximumBodyUTF16Units
        case .null:
            false
        }
    }

    private static func isValidCollection<Element: Encodable & Sendable>(
        _ field: PatchField<[Element]>,
        maximumCount: Int
    ) -> Bool {
        switch field {
        case .unchanged:
            true
        case let .value(values):
            values.count <= maximumCount
        case .null:
            false
        }
    }
}
