import { manualNotesHandlers } from "@/server/api/manual-notes-handlers";

export const runtime = "nodejs";
export const maxDuration = 60;
type Context = Readonly<{ params: Promise<{ noteId: string }> }>;

export async function GET(request: Request, context: Context): Promise<Response> {
  return manualNotesHandlers.listNoteLinks(request, await context.params);
}

export async function POST(request: Request, context: Context): Promise<Response> {
  return manualNotesHandlers.createNoteLink(request, await context.params);
}
