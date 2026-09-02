import { noteContextHandlers } from "@/server/api/note-context-handlers";

export const runtime = "nodejs";
export const maxDuration = 60;
type Context = Readonly<{ params: Promise<{ noteId: string }> }>;

export async function GET(request: Request, context: Context): Promise<Response> {
  return noteContextHandlers.listSources(request, await context.params);
}
