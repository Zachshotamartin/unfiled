import { randomUUID } from "node:crypto";

import { createOrganizerComposition } from "./composition.js";
import { loadOrganizerConfig } from "./config.js";
import { OrganizerConfigurationError } from "./errors.js";
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
/** Server-side only: configuration failures name the offending variables, never their values. */
function reportStartupFailure(error: unknown): void {
  const detail =
    error instanceof OrganizerConfigurationError
      ? error.message
      : error instanceof Error
        ? error.name
        : "unknown";
  console.error(
    JSON.stringify({ event: "organizer.startup_failed", service: "unfiled-organizer", detail })
  );
}

export function handleOrganizerRequest(request: Request): Promise<Response> {
  try {
    application ??= createOrganizerComposition(loadOrganizerConfig()).app;
    return application(request);
  } catch (error) {
    reportStartupFailure(error);
    return Promise.resolve(unavailable());
  }
}
