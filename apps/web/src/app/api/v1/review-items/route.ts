import { manualNotesHandlers } from "@/server/api/manual-notes-handlers";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return manualNotesHandlers.listReviewItems(request);
}
