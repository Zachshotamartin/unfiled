import { authHandlers } from "@/server/api/auth-handlers";

export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return authHandlers.session(request);
}
