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
});
