import { randomUUID } from "node:crypto";

import { createSearchComposition } from "./composition.js";
import { loadSearchConfig } from "./config.js";
import type { SearchApp } from "./http.js";

let application: SearchApp | undefined;

function unavailableResponse(): Response {
  const requestId = randomUUID();
  return Response.json(
    { code: "configuration_error", message: "Search is temporarily unavailable.", requestId },
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

export function handleSearchRequest(request: Request): Promise<Response> {
  try {
    application ??= createSearchComposition(loadSearchConfig()).app;
    return application(request);
  } catch {
    return Promise.resolve(unavailableResponse());
  }
}
