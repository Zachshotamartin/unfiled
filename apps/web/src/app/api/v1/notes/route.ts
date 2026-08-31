import { manualNotesHandlers } from "@/server/api/manual-notes-handlers";

export const runtime = "nodejs";
export const maxDuration = 60;

export function GET(request: Request): Promise<Response> {
  return manualNotesHandlers.listNotes(request);
}

export function POST(request: Request): Promise<Response> {
  return manualNotesHandlers.createNote(request);
}
