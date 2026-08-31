import { captureHandlers } from "@/server/api/capture-handlers";

export const runtime = "nodejs";

type Context = Readonly<{ params: Promise<{ captureId: string }> }>;

export async function GET(request: Request, context: Context): Promise<Response> {
  return captureHandlers.getReceipt(request, await context.params);
}
