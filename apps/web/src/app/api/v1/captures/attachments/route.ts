import { captureHandlers } from "@/server/api/capture-handlers";

export const runtime = "nodejs";
export const maxDuration = 60;

export function POST(request: Request): Promise<Response> {
  return captureHandlers.uploadAttachment(request);
}
