import { captureHandlers } from "@/server/api/capture-handlers";

export const runtime = "nodejs";
export const maxDuration = 60;

type Context = Readonly<{ params: Promise<{ captureId: string }> }>;

export async function GET(request: Request, context: Context): Promise<Response> {
  return captureHandlers.getCapture(request, await context.params);
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  return captureHandlers.deleteCapture(request, await context.params);
}
