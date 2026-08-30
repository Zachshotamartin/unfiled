import { manualNotesHandlers } from "@/server/api/manual-notes-handlers";

export const runtime = "nodejs";
type Context = Readonly<{ params: Promise<{ tagId: string }> }>;

export async function DELETE(request: Request, context: Context): Promise<Response> {
  return manualNotesHandlers.deleteTag(request, await context.params);
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  return manualNotesHandlers.updateTag(request, await context.params);
}
