import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "../src/index.js";

describe("API client", () => {
  it("does not advertise capture submission before its route exists", () => {
    const client = createApiClient({
      baseUrl: "https://example.test/",
      getAccessToken: () => Promise.resolve("token"),
      fetch: vi.fn<typeof fetch>()
    });
    expect(client).not.toHaveProperty("createCapture");
  });
});
