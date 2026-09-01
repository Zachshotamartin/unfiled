import { randomUUID } from "node:crypto";

import { createOrganizerComposition } from "./composition.js";
import { loadOrganizerConfig } from "./config.js";
import type { OrganizerApp } from "./http.js";

let application: OrganizerApp | undefined;
function unavailable(): Response {
  const requestId = randomUUID();
  return Response.json(
    { code: "configuration_error", message: "The organizer is unavailable.", requestId },
    {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
        "referrer-policy": "no-referrer",
        "retry-after": "5",
        "x-content-type-options": "nosniff",
        "x-request-id": requestId
      }
    }
  );
}
export function handleOrganizerRequest(request: Request): Promise<Response> {
  try {
    application ??= createOrganizerComposition(loadOrganizerConfig()).app;
    return application(request);
  } catch {
    return Promise.resolve(unavailable());
  }
}
