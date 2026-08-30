import { manualNotesHandlers } from "@/server/api/manual-notes-handlers";

export const runtime = "nodejs";
type Context = Readonly<{ params: Promise<{ noteId: string }> }>;

export async function GET(request: Request, context: Context): Promise<Response> {
  return manualNotesHandlers.listRevisions(request, await context.params);
}
