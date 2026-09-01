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

    public func listRoutingRules() async throws -> RoutingRuleListResponse {
        try await get("/routing-rules")
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
        noteId: NoteID
    ) async throws -> GeneratedBlockListResponse {
        try await get("/notes/\(noteId.rawValue)/generated-blocks")
    }

    public func resolveGeneratedBlock(
        _ id: BlockID,
        request: GeneratedBlockResolveRequest
    ) async throws -> GeneratedBlockResolveResponse {
        try await post(
            "/generated-blocks/\(id.rawValue)/resolve",
            body: request,
            idempotencyKey: request.idempotencyKey
        )
    }
}
