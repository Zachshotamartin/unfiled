import { randomUUID } from "node:crypto";

import { createVerifierComposition } from "./composition.js";
import { loadVerifierConfig } from "./config.js";
import type { VerifierApp } from "./http.js";

let application: VerifierApp | undefined;

function unavailableResponse(request: Request): Response {
  const candidate = request.headers.get("x-request-id")?.trim();
  const requestId =
    candidate !== undefined &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(candidate)
      ? candidate
      : randomUUID();
  return Response.json(
    { code: "configuration_error", message: "The verifier is unavailable.", requestId },
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

export function handleVerifierRequest(request: Request): Promise<Response> {
  try {
    application ??= createVerifierComposition(loadVerifierConfig()).app;
    return application(request);
  } catch {
    return Promise.resolve(unavailableResponse(request));
  }
}
