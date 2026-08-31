import { randomUUID } from "node:crypto";

import { loadWorkerConfig } from "./config";
import { createWorkerApp, type WorkerApp } from "./http";
import { createVercelTrustedSourcesInvocationAuth } from "./invocation-auth-adapter";
import { createWorkerKeyManagementAdapter } from "./key-management-adapter";

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
      application = createWorkerApp({
        config,
        keyManagement: createWorkerKeyManagementAdapter(),
        ...(config.invocationAuth.kind === "production-verifier"
          ? {
              productionInvocationAuth: createVercelTrustedSourcesInvocationAuth({
                trustedSource: config.invocationAuth.trustedSource
              })
            }
          : {})
      });
    }
    return application(request);
  } catch {
    return Promise.resolve(unavailableResponse(request));
  }
}
