import { afterEach, describe, expect, it, vi } from "vitest";

import { handleSearchRequest } from "../src/entrypoint.js";

describe("search entrypoint", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("logs a startup failure that names variables but never values", async () => {
    const bogus = "bogus-environment-7f3a";
    vi.stubEnv("UNFILED_SEARCH_ENV", bogus);
    const sink = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await handleSearchRequest(new Request("https://search.example/health"));
      expect(response.status).toBe(503);
      expect(sink).toHaveBeenCalledTimes(1);
      const line = String(sink.mock.calls[0]?.[0]);
      expect(JSON.parse(line)).toMatchObject({
        event: "search.startup_failed",
        service: "unfiled-search"
      });
      expect(JSON.parse(line)).toMatchObject({ detail: "SearchConfigurationError" });
      expect(line).not.toContain(bogus);
    } finally {
      sink.mockRestore();
    }
  });
});
