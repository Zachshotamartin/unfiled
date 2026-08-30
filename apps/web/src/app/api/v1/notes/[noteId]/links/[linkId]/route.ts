import { manualNotesHandlers } from "@/server/api/manual-notes-handlers";

export const runtime = "nodejs";
type Context = Readonly<{ params: Promise<{ linkId: string; noteId: string }> }>;

export async function DELETE(request: Request, context: Context): Promise<Response> {
  return manualNotesHandlers.deleteNoteLink(request, await context.params);
}
