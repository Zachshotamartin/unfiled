import { createEntityId } from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "../src/index.js";

describe("API client", () => {
  it("validates and submits a capture without a user id", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          capture: {
            id: "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X",
            rawContent: "milk",
            source: "web",
            privacy: "ai_assisted",
            clientCreatedAt: "2026-08-30T18:30:00.000Z",
            receivedAt: "2026-08-30T18:30:01.000Z",
            status: "queued",
            lastErrorCode: null
          },
          jobId: "job_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
          replayed: false
        }),
        { status: 202, headers: { "content-type": "application/json" } }
      )
    );
    const client = createApiClient({
      baseUrl: "https://example.test/",
      getAccessToken: () => Promise.resolve("token"),
      fetch: fetcher
    });

    const response = await client.createCapture({
      clientCaptureId: createEntityId("cap"),
      rawContent: "milk",
      source: "web",
      clientCreatedAt: "2026-08-30T18:30:00.000Z",
      clientTimezone: "UTC",
      privacy: "ai_assisted",
      expansionDisabled: false
    });

    expect(response.capture.status).toBe("queued");
    expect(fetcher).toHaveBeenCalledOnce();
    const request = fetcher.mock.calls.at(0);
    expect(request).toBeDefined();
    if (!request) {
      throw new Error("Expected the API client to issue a fetch request.");
    }

    const [url, init] = request;
    const headers = new Headers(init?.headers);
    expect(url).toBe("https://example.test/api/v1/captures");
    expect(headers.get("authorization")).toBe("Bearer token");
    expect(headers.get("idempotency-key")).toMatch(/^cap_/u);
  });
});
