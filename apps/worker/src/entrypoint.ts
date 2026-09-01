import { randomUUID } from "node:crypto";

import { loadWorkerConfig } from "./config.js";
import { createWorkerComposition } from "./composition.js";
import type { WorkerApp } from "./http.js";

let application: WorkerApp | undefined;

function unavailableResponse(request: Request): Response {
  const candidate = request.headers.get("x-request-id")?.trim();
  const requestId =
    candidate !== undefined && /^[A-Za-z0-9_.:-]{1,80}$/.test(candidate) ? candidate : randomUUID();
  return Response.json(
    {
      code: "configuration_error",
      message: "The worker is unavailable.",
      requestId
    },
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

export function handleWorkerRequest(request: Request): Promise<Response> {
  try {
    if (application === undefined) {
      const config = loadWorkerConfig();
      application = createWorkerComposition(config).app;
    }
    return application(request);
  } catch {
    return Promise.resolve(unavailableResponse(request));
  }
}
