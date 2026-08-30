import { manualNotesHandlers } from "@/server/api/manual-notes-handlers";

export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return manualNotesHandlers.search(request);
}
