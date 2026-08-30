import { manualNotesHandlers } from "@/server/api/manual-notes-handlers";

export const runtime = "nodejs";
type Context = Readonly<{ params: Promise<{ noteId: string; tagId: string }> }>;

export async function DELETE(request: Request, context: Context): Promise<Response> {
  return manualNotesHandlers.unlinkTag(request, await context.params);
}
