import { ownerInteractionHandlers } from "@/server/api/owner-interaction-handlers";

export const runtime = "nodejs";
export const maxDuration = 60;

type RouteContext = Readonly<{ params: Promise<{ blockId: string }> }>;

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return ownerInteractionHandlers.getGeneratedBlock(request, await context.params);
}

export function POST(): Response {
  return ownerInteractionHandlers.methodNotAllowed("GET");
}

export function PATCH(): Response {
  return ownerInteractionHandlers.methodNotAllowed("GET");
}

export function DELETE(): Response {
  return ownerInteractionHandlers.methodNotAllowed("GET");
}
