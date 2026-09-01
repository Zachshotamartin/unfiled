import { ragGenerationMaintenanceCronHandler } from "@/server/indexing/rag-generation-maintenance-cron-handler";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return ragGenerationMaintenanceCronHandler(request);
}
