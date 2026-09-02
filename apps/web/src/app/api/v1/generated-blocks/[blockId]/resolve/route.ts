import { ownerInteractionHandlers } from "@/server/api/owner-interaction-handlers";

export const runtime = "nodejs";
export const maxDuration = 60;

type RouteContext = Readonly<{ params: Promise<{ blockId: string }> }>;

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return ownerInteractionHandlers.resolveGeneratedBlock(request, await context.params);
}

export function GET(): Response {
  return ownerInteractionHandlers.methodNotAllowed("POST");
}

export function PATCH(): Response {
  return ownerInteractionHandlers.methodNotAllowed("POST");
}

export function DELETE(): Response {
  return ownerInteractionHandlers.methodNotAllowed("POST");
}
