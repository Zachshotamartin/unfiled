import { ownerInteractionHandlers } from "@/server/api/owner-interaction-handlers";

export const runtime = "nodejs";
export const maxDuration = 60;

type Context = Readonly<{ params: Promise<{ reviewItemId: string }> }>;

const methodNotAllowed = (): Response => ownerInteractionHandlers.methodNotAllowed("POST");

export {
  methodNotAllowed as DELETE,
  methodNotAllowed as GET,
  methodNotAllowed as PATCH,
  methodNotAllowed as PUT
};

export async function POST(request: Request, context: Context): Promise<Response> {
  return ownerInteractionHandlers.resolveReviewItem(request, await context.params);
}
