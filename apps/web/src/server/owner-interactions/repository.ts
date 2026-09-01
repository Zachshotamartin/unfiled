import type {
  DecisionCorrectionRequest,
  DecisionCorrectionResponse,
  EntityId,
  MutationBatchUndoResponse,
  MutationUndoRequest,
  ReviewResolveRequest,
  ReviewResolveResponse
} from "@unfiled/contracts";

/**
 * The authenticated, owner-derived context for an interactive encrypted write.
 * Implementations must never accept an owner identifier from a request body or
 * forward the browser access token to a service-role RPC.
 */
export type OwnerInteractionRepositoryContext = Readonly<{
  accessToken: string;
  userId: string;
}>;

/**
 * Owner-authorized Milestone E interactions. This surface is deliberately
 * separate from the rollout-aware manual-note repository: these operations
 * have no plaintext legacy implementation or fallback path.
 */
export interface OwnerInteractionRepository {
  correctDecision(
    context: OwnerInteractionRepositoryContext,
    decisionId: EntityId<"dec">,
    request: DecisionCorrectionRequest
  ): Promise<DecisionCorrectionResponse>;

  resolveReviewItem(
    context: OwnerInteractionRepositoryContext,
    reviewItemId: EntityId<"rvw">,
    request: ReviewResolveRequest
  ): Promise<ReviewResolveResponse>;

  undoMutationBatch(
    context: OwnerInteractionRepositoryContext,
    mutationId: EntityId<"mut">,
    request: MutationUndoRequest
  ): Promise<MutationBatchUndoResponse>;
}
