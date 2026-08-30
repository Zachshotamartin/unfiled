import { authHandlers } from "@/server/api/auth-handlers";

export const runtime = "nodejs";

export function PUT(request: Request): Promise<Response> {
  return authHandlers.verifyCode(request);
}
