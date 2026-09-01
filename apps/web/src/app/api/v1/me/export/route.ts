import { ownerDataHandlers } from "@/server/api/owner-data-handlers";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  return ownerDataHandlers.exportAccount(request);
}

const notAllowed = (): Response => ownerDataHandlers.methodNotAllowed("GET");

export const DELETE = notAllowed;
export const HEAD = notAllowed;
export const PATCH = notAllowed;
export const POST = notAllowed;
export const PUT = notAllowed;
