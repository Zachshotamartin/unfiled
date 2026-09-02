import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

describe("GET /api/health", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns a non-cacheable healthy response", async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      service: "unfiled-web",
      status: "ok"
    });
    expect(response.headers.get("x-unfiled-deployment")).toBeNull();
  });

  it("emits managed release consistency headers without the raw deployment ID", () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_webproduction123");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "e".repeat(40));

    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-unfiled-deployment")).toBe(
      "sha256:af6d2a64977f628346e979b3113511302f3148e144d66af5c318214a18a2e224"
    );
    expect(response.headers.get("x-unfiled-commit")).toBe("e".repeat(40));
    expect(response.headers.get("x-unfiled-environment")).toBe("preview");
    expect(JSON.stringify([...response.headers])).not.toContain("dpl_");
  });

  it("fails health closed when a managed release identity is incomplete", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "preview");

    const response = GET();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-unfiled-deployment")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      service: "unfiled-web",
      status: "unavailable"
    });
  });
});
