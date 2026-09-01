import { ownerDataHandlers } from "@/server/api/owner-data-handlers";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  return ownerDataHandlers.replayDeletionReceipt(request);
}

const notAllowed = (): Response => ownerDataHandlers.methodNotAllowed("POST");

export const DELETE = notAllowed;
export const GET = notAllowed;
export const HEAD = notAllowed;
export const PATCH = notAllowed;
export const PUT = notAllowed;
