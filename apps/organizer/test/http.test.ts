import { describe, expect, it, vi } from "vitest";

import { loadOrganizerConfig } from "../src/config.js";
import type { OrganizerDrainPort } from "../src/drain.js";
import { createOrganizerApp } from "../src/http.js";
import { createOrganizerKeyManagementAdapter } from "../src/key-management.js";

const secret = "local-organizer-secret-at-least-32-characters";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function config(timeout = 1_000) {
  return loadOrganizerConfig({
    UNFILED_ORGANIZER_ENV: "local",
    UNFILED_ORGANIZER_DRAIN_SECRET: secret,
    UNFILED_ORGANIZER_TIMEOUT_MS: String(timeout)
  });
}
function drain(
  result: unknown = { claimed: 1, completed: 1, failed: 0, retryScheduled: 0 }
): OrganizerDrainPort {
  return { drain: vi.fn().mockResolvedValue(result) };
}
function request(path = "/internal/drain", init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  const body = Object.prototype.hasOwnProperty.call(init, "body")
    ? (init.body ?? null)
    : '{"trigger":"manual"}';
  if (init.headers === undefined) headers.set("authorization", `Bearer ${secret}`);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  if (!headers.has("x-request-id")) headers.set("x-request-id", "request-1");
  return new Request(`https://organizer.example${path}`, {
    ...init,
    body,
    headers,
    method: init.method ?? "POST"
  });
}

describe("organizer HTTP app", () => {
  it("serves content-free health and HEAD with hardened headers", async () => {
    const app = createOrganizerApp({ config: config() });
    const response = await app(new Request("https://organizer.example/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ service: "unfiled-organizer", status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    const head = await app(new Request("https://organizer.example/api/health", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
  it("emits only the managed release consistency identity on success and error", async () => {
    const releaseIdentity = {
      commit: "b".repeat(40),
      deployment: `sha256:${"c".repeat(64)}` as const,
      environment: "preview" as const
    };
    const managedConfig = { ...config(), releaseIdentity, runtime: "preview" as const };
    const app = createOrganizerApp({ config: managedConfig });

    for (const incoming of [
      new Request("https://organizer.example/health"),
      new Request("https://organizer.example/missing")
    ]) {
      const response = await app(incoming);
      expect(response.headers.get("x-unfiled-deployment")).toBe(releaseIdentity.deployment);
      expect(response.headers.get("x-unfiled-commit")).toBe(releaseIdentity.commit);
      expect(response.headers.get("x-unfiled-environment")).toBe("preview");
      expect(JSON.stringify([...response.headers])).not.toContain("dpl_");
    }
  });
  it("authorizes a local content-free drain and defaults empty body to schedule", async () => {
    const port = drain();
    const app = createOrganizerApp({
      config: config(),
      drain: port,
      keyManagement: createOrganizerKeyManagementAdapter()
    });
    const response = await app(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      claimed: 1,
      completed: 1,
      failed: 0,
      retryScheduled: 0
    });
    const firstRequestId = response.headers.get("x-request-id");
    expect(firstRequestId).toMatch(UUID_V4);
    expect(port.drain).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "manual", requestId: firstRequestId })
    );
    const empty = await app(request("/api/internal/drain", { body: null }));
    expect(empty.status).toBe(200);
    expect(port.drain).toHaveBeenLastCalledWith(expect.objectContaining({ trigger: "schedule" }));
  });
  it("replaces a hostile caller request ID and preserves safe response/log correlation", async () => {
    const hostile = "note_01ARZ3NDEKTSV4RRFFQ69G5FAV-capture-secret";
    const logger = { log: vi.fn() };
    const response = await createOrganizerApp({ config: config(), logger })(
      request("/internal/drain", {
        headers: { "content-type": "application/json", "x-request-id": hostile }
      })
    );
    const generated = response.headers.get("x-request-id");
    const body = await response.text();
    expect(response.status).toBe(401);
    expect(generated).toMatch(UUID_V4);
    expect(body).toContain(String(generated));
    expect(body).not.toContain(hostile);
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain(hostile);
    expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({ requestId: generated }));
  });
  it.each([
    [request("/missing"), 404, "not_found"],
    [
      new Request("https://organizer.example/health", { method: "POST" }),
      405,
      "method_not_allowed"
    ],
    [
      new Request("https://organizer.example/internal/drain", { method: "GET" }),
      405,
      "method_not_allowed"
    ],
    [request("/internal/drain?owner=secret"), 400, "validation_failed"],
    [
      request("/internal/drain", {
        headers: {
          authorization: `Bearer ${secret}`,
          cookie: "session=secret",
          "content-type": "application/json"
        }
      }),
      401,
      "unauthorized"
    ],
    [
      request("/internal/drain", { headers: { "content-type": "application/json" } }),
      401,
      "unauthorized"
    ]
  ])("returns a redacted error for route case %#", async (input, status, code) => {
    const response = await createOrganizerApp({
      config: config(),
      drain: drain(),
      keyManagement: createOrganizerKeyManagementAdapter()
    })(input);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
  });
  it.each([
    ["text/plain", '{"trigger":"manual"}'],
    ["application/json", '{"trigger":"invented"}'],
    ["application/json", '{"trigger":"manual","ownerId":"secret"}'],
    ["application/json", "[1]"],
    ["application/json", "{"],
    ["application/json", "\ud800"]
  ])("rejects malformed content-free drain body %#", async (contentType, body) => {
    const response = await createOrganizerApp({
      config: config(),
      drain: drain(),
      keyManagement: createOrganizerKeyManagementAdapter()
    })(
      request("/internal/drain", {
        body,
        headers: { authorization: `Bearer ${secret}`, "content-type": contentType }
      })
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "validation_failed" });
  });
  it("rejects declared and streamed oversized bodies", async () => {
    const app = createOrganizerApp({
      config: config(),
      drain: drain(),
      keyManagement: createOrganizerKeyManagementAdapter()
    });
    const declared = await app(
      request("/internal/drain", {
        headers: {
          authorization: `Bearer ${secret}`,
          "content-length": "999999",
          "content-type": "application/json"
        }
      })
    );
    expect(declared.status).toBe(413);
    const streamed = await app(request("/internal/drain", { body: "x".repeat(2_000) }));
    expect(streamed.status).toBe(413);
    const invalidLength = await app(
      request("/internal/drain", {
        headers: {
          authorization: `Bearer ${secret}`,
          "content-length": "not-a-number",
          "content-type": "application/json"
        }
      })
    );
    expect(invalidLength.status).toBe(400);
  });
  it("maps body stream failures and malformed drain results to safe availability errors", async () => {
    const app = createOrganizerApp({
      config: config(),
      drain: drain(),
      keyManagement: createOrganizerKeyManagementAdapter()
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("capture"));
      }
    });
    const broken = await app(
      new Request("https://organizer.example/internal/drain", {
        body: stream,
        duplex: "half",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        method: "POST"
      } as RequestInit)
    );
    expect(broken.status).toBe(400);
    expect(await broken.text()).not.toContain("capture");
    const malformed = await createOrganizerApp({
      config: config(),
      drain: drain({ claimed: 1, completed: 2, failed: 0, retryScheduled: 0 }),
      keyManagement: createOrganizerKeyManagementAdapter()
    })(request());
    expect(malformed.status).toBe(503);
    expect(await malformed.json()).toMatchObject({ code: "provider_unavailable" });
  });
  it("rejects a pre-aborted request before invoking auth or drain", async () => {
    const controller = new AbortController();
    controller.abort();
    const port = drain();
    const response = await createOrganizerApp({
      config: config(),
      drain: port,
      keyManagement: createOrganizerKeyManagementAdapter()
    })(request("/internal/drain", { signal: controller.signal }));
    expect(response.status).toBe(504);
    expect(port.drain).not.toHaveBeenCalled();
  });
  it("aborts a hung drain at the request deadline and consumes late settlement", async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const port: OrganizerDrainPort = {
      drain: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ claimed: 0, completed: 0, failed: 0, retryScheduled: 0 });
          })
      )
    };
    const responsePromise = createOrganizerApp({
      config: config(1_000),
      drain: port,
      keyManagement: createOrganizerKeyManagementAdapter()
    })(request());
    await vi.advanceTimersByTimeAsync(1_001);
    const response = await responsePromise;
    expect(response.status).toBe(504);
    finish?.();
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });
  it("logs only a safe completion event", async () => {
    const logger = { log: vi.fn() };
    const clock = { now: vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(125) };
    await createOrganizerApp({
      clock,
      config: config(),
      logger,
      drain: drain(),
      keyManagement: createOrganizerKeyManagementAdapter()
    })(request());
    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({ durationMs: 25, route: "internal_drain", status: 200 })
    );
  });
});
