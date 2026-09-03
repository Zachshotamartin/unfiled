import { captureHandlers } from "@/server/api/capture-handlers";

export const runtime = "nodejs";
export const maxDuration = 60;

type Context = Readonly<{ params: Promise<{ attachmentId: string }> }>;

export async function GET(request: Request, context: Context): Promise<Response> {
  return captureHandlers.getAttachment(request, await context.params);
}
