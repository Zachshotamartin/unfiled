import { authHandlers } from "@/server/api/auth-handlers";

export const runtime = "nodejs";

export function POST(request: Request): Promise<Response> {
  return authHandlers.resendVerification(request);
}
