import { aiSettingsHandlers } from "@/server/api/ai-settings-handlers";

export const runtime = "nodejs";
export const maxDuration = 60;

export function GET(request: Request): Promise<Response> {
  return aiSettingsHandlers.getSettings(request);
}

export function PATCH(request: Request): Promise<Response> {
  return aiSettingsHandlers.updateSettings(request);
}
