import { routingRuleHandlers } from "@/server/api/routing-rule-handlers";

export const runtime = "nodejs";
export const maxDuration = 60;

export function GET(request: Request): Promise<Response> {
  return routingRuleHandlers.list(request);
}

export function POST(request: Request): Promise<Response> {
  return routingRuleHandlers.create(request);
}
