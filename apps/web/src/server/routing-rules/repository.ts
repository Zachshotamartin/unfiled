import type {
  EntityId,
  RoutingRuleCreateRequest,
  RoutingRuleDeleteRequest,
  RoutingRuleDeleteResponse,
  RoutingRuleListQuery,
  RoutingRuleListResponse,
  RoutingRuleMutationResponse,
  RoutingRuleUpdateRequest
} from "@unfiled/contracts";

export type RoutingRuleRepositoryContext = Readonly<{
  accessToken: string;
  userId: string;
}>;

export interface RoutingRuleRepository {
  list(
    context: RoutingRuleRepositoryContext,
    query: RoutingRuleListQuery
  ): Promise<RoutingRuleListResponse>;
  create(
    context: RoutingRuleRepositoryContext,
    request: RoutingRuleCreateRequest
  ): Promise<RoutingRuleMutationResponse>;
  update(
    context: RoutingRuleRepositoryContext,
    ruleId: EntityId<"rule">,
    request: RoutingRuleUpdateRequest
  ): Promise<RoutingRuleMutationResponse>;
  delete(
    context: RoutingRuleRepositoryContext,
    ruleId: EntityId<"rule">,
    request: RoutingRuleDeleteRequest
  ): Promise<RoutingRuleDeleteResponse>;
}
