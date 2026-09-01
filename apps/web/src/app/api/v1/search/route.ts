import { manualNotesHandlers } from "@/server/api/manual-notes-handlers";

export const runtime = "nodejs";

const PRIVATE_SEARCH_CACHE_CONTROL = "private, no-store";

export function GET(request: Request): Response {
  void request;
  return new Response(null, {
    status: 405,
    headers: {
      allow: "POST",
      "cache-control": PRIVATE_SEARCH_CACHE_CONTROL,
      pragma: "no-cache"
    }
  });
}

export function POST(request: Request): Promise<Response> {
  return manualNotesHandlers.search(request);
}
