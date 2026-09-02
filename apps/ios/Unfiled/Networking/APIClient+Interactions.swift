import Foundation

extension APIClient {
    public func correctDecision(
        _ id: DecisionID,
        request: DecisionCorrectionRequest
    ) async throws -> DecisionCorrectionResponse {
        try await post(
            "/decisions/\(id.rawValue)/correct",
            body: request,
            idempotencyKey: request.idempotencyKey
        )
    }

    public func resolveReviewItem(
        _ id: ReviewID,
        request: ReviewResolveRequest
    ) async throws -> ReviewResolveResponse {
        try await post(
            "/review-items/\(id.rawValue)/resolve",
            body: request,
            idempotencyKey: request.idempotencyKey
        )
    }

    public func listRoutingRules(after cursor: String? = nil) async throws -> RoutingRuleListResponse {
        if let cursor, RuleID(rawValue: cursor) == nil { throw APIClientError.invalidRequest }
        return try await get(
            "/routing-rules",
            query: cursor.map { [URLQueryItem(name: "cursor", value: $0)] } ?? [],
            maximumResponseBytes: 8_388_608
        )
    }

    public func createRoutingRule(
        _ request: RoutingRuleCreateRequest
    ) async throws -> RoutingRuleMutationResponse {
        try await post(
            "/routing-rules",
            body: request,
            idempotencyKey: request.idempotencyKey
        )
    }

    public func updateRoutingRule(
        _ id: RuleID,
        request: RoutingRuleUpdateRequest
    ) async throws -> RoutingRuleMutationResponse {
        try await patch(
            "/routing-rules/\(id.rawValue)",
            body: request,
            idempotencyKey: request.idempotencyKey
        )
    }

    public func deleteRoutingRule(
        _ id: RuleID,
        request: RoutingRuleDeleteRequest
    ) async throws -> RoutingRuleDeleteResponse {
        try await delete(
            "/routing-rules/\(id.rawValue)",
            body: request,
            idempotencyKey: request.idempotencyKey
        )
    }

    public func listGeneratedBlocks(
        noteId: NoteID,
        after cursor: String? = nil
    ) async throws -> GeneratedBlockListResponse {
        if let cursor, BlockID(rawValue: cursor) == nil { throw APIClientError.invalidRequest }
        let response: GeneratedBlockListResponse = try await get(
            "/notes/\(noteId.rawValue)/generated-blocks",
            query: cursor.map { [URLQueryItem(name: "cursor", value: $0)] } ?? [],
            maximumResponseBytes: 8_388_608
        )
        guard response.items.allSatisfy({ block in
            block.noteId == noteId && (cursor.map { block.id.rawValue > $0 } ?? true)
        }) else {
            throw APIClientError.malformedResponse(status: 200)
        }
        return response
    }

    public func getGeneratedBlock(
        _ id: BlockID,
        expectedNoteId: NoteID
    ) async throws -> GeneratedBlockDetailResponse {
        let response: GeneratedBlockDetailResponse = try await get(
            "/generated-blocks/\(id.rawValue)",
            maximumResponseBytes: 8_388_608
        )
        guard response.block.id == id,
              response.block.noteId == expectedNoteId else {
            throw APIClientError.malformedResponse(status: 200)
        }
        return response
    }

    public func resolveGeneratedBlock(
        _ id: BlockID,
        request: GeneratedBlockResolveRequest
    ) async throws -> GeneratedBlockResolveResponse {
        let response: GeneratedBlockResolveResponse = try await post(
            "/generated-blocks/\(id.rawValue)/resolve",
            body: request,
            idempotencyKey: request.idempotencyKey,
            maximumResponseBytes: 8_388_608
        )
        let expectedState: GeneratedBlockState = request.resolution == .accept
            ? .accepted
            : .rejected
        guard response.block.id == id,
              response.block.state == expectedState,
              response.block.stateRevision == request.expectedStateRevision + 1 else {
            throw APIClientError.malformedResponse(status: 200)
        }
        return response
    }
}
