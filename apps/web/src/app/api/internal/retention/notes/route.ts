import { noteRetentionHandler } from "@/server/retention/note-retention-handler";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return noteRetentionHandler(request);
}
