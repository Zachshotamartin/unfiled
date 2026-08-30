import { manualNotesHandlers } from "@/server/api/manual-notes-handlers";

export const runtime = "nodejs";
type Context = Readonly<{ params: Promise<{ spaceId: string }> }>;

export async function POST(request: Request, context: Context): Promise<Response> {
  return manualNotesHandlers.archiveSpace(request, await context.params);
}
