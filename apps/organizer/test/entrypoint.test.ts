import { afterEach, describe, expect, it, vi } from "vitest";

import { handleOrganizerRequest } from "../src/entrypoint.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe("organizer entrypoint", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("replaces a hostile caller request ID on configuration failure", async () => {
    vi.stubEnv("UNFILED_ORGANIZER_ENV", "invalid");
    const hostile = "cap_01ARZ3NDEKTSV4RRFFQ69G5FAV-private-fragment";
    const response = await handleOrganizerRequest(
      new Request("https://organizer.example/internal/drain", {
        headers: { "x-request-id": hostile },
        method: "POST"
      })
    );
    const generated = response.headers.get("x-request-id");
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(generated).toMatch(UUID_V4);
    expect(body).toContain(String(generated));
    expect(body).not.toContain(hostile);
  });

  it("logs a startup failure that names variables but never values", async () => {
    const bogus = "bogus-environment-7f3a";
    vi.stubEnv("UNFILED_ORGANIZER_ENV", bogus);
    const sink = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await handleOrganizerRequest(
        new Request("https://organizer.example/health")
      );
      expect(response.status).toBe(503);
      expect(sink).toHaveBeenCalledTimes(1);
      const line = String(sink.mock.calls[0]?.[0]);
      expect(JSON.parse(line)).toMatchObject({
        event: "organizer.startup_failed",
        service: "unfiled-organizer"
      });
      const parsed = JSON.parse(line) as { detail?: string };
      expect(parsed.detail).toMatch(/^The organizer configuration is invalid \([A-Z_, ]+\)\.$/u);
      expect(line).not.toContain(bogus);
    } finally {
      sink.mockRestore();
    }
  });
});
