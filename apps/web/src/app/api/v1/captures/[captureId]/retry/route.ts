import { captureHandlers } from "@/server/api/capture-handlers";

export const runtime = "nodejs";
export const maxDuration = 60;

type Context = Readonly<{ params: Promise<{ captureId: string }> }>;

export async function POST(request: Request, context: Context): Promise<Response> {
  return captureHandlers.retryCapture(request, await context.params);
}
