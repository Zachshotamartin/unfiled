import { manualNotesHandlers } from "@/server/api/manual-notes-handlers";

export const runtime = "nodejs";
export const maxDuration = 60;
type Context = Readonly<{ params: Promise<{ mutationId: string }> }>;

export async function POST(request: Request, context: Context): Promise<Response> {
  return manualNotesHandlers.undoMutation(request, await context.params);
}
