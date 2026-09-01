import { ownerDataHandlers } from "@/server/api/owner-data-handlers";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function DELETE(request: Request): Promise<Response> {
  return ownerDataHandlers.deleteAccount(request);
}

const notAllowed = (): Response => ownerDataHandlers.methodNotAllowed("DELETE");

export const GET = notAllowed;
export const HEAD = notAllowed;
export const PATCH = notAllowed;
export const POST = notAllowed;
export const PUT = notAllowed;
