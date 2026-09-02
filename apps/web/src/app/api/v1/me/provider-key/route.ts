import { aiSettingsHandlers } from "@/server/api/ai-settings-handlers";

export const runtime = "nodejs";
export const maxDuration = 60;

export function GET(request: Request): Promise<Response> {
  return aiSettingsHandlers.getProviderKey(request);
}

export function PUT(request: Request): Promise<Response> {
  return aiSettingsHandlers.putProviderKey(request);
}

export function DELETE(request: Request): Promise<Response> {
  return aiSettingsHandlers.deleteProviderKey(request);
}
