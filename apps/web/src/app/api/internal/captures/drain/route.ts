import { captureWorkflowHandler } from "@/server/captures/workflow-handler";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return captureWorkflowHandler(request);
}
