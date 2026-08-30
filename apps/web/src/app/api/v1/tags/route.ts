import { manualNotesHandlers } from "@/server/api/manual-notes-handlers";

export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return manualNotesHandlers.listTags(request);
}

export function POST(request: Request): Promise<Response> {
  return manualNotesHandlers.createTag(request);
}
