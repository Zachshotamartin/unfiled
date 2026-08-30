import { manualNotesHandlers } from "@/server/api/manual-notes-handlers";

export const runtime = "nodejs";
type Context = Readonly<{ params: Promise<{ spaceId: string }> }>;

export async function GET(request: Request, context: Context): Promise<Response> {
  return manualNotesHandlers.getSpace(request, await context.params);
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  return manualNotesHandlers.updateSpace(request, await context.params);
}
