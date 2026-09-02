import { afterEach, describe, expect, it, vi } from "vitest";

import { handleVerifierRequest } from "../src/entrypoint.js";

describe("verifier entrypoint", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("logs a startup failure that names variables but never values", async () => {
    const bogus = "bogus-environment-7f3a";
    vi.stubEnv("UNFILED_VERIFIER_ENV", bogus);
    const sink = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await handleVerifierRequest(new Request("https://verifier.example/health"));
      expect(response.status).toBe(503);
      expect(sink).toHaveBeenCalledTimes(1);
      const line = String(sink.mock.calls[0]?.[0]);
      expect(JSON.parse(line)).toMatchObject({
        event: "verifier.startup_failed",
        service: "unfiled-verifier"
      });
      expect(line).toContain("UNFILED_VERIFIER_ENV");
      expect(line).not.toContain(bogus);
    } finally {
      sink.mockRestore();
    }
  });
});
