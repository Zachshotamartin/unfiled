import { manualNotesHandlers } from "@/server/api/manual-notes-handlers";

export const runtime = "nodejs";
export const maxDuration = 60;

type Context = Readonly<{ params: Promise<{ noteId: string }> }>;

export async function GET(request: Request, context: Context): Promise<Response> {
  return manualNotesHandlers.getNote(request, await context.params);
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  return manualNotesHandlers.updateNote(request, await context.params);
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  return manualNotesHandlers.deleteNote(request, await context.params);
}
