import { routingRuleHandlers } from "@/server/api/routing-rule-handlers";

export const runtime = "nodejs";
export const maxDuration = 60;

type RouteContext = Readonly<{ params: Promise<Readonly<{ ruleId: string }>> }>;

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return routingRuleHandlers.update(request, await context.params);
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  return routingRuleHandlers.delete(request, await context.params);
}
