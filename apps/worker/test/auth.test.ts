import { describe, expect, it } from "vitest";

import { hasValidBearerCredential } from "../src/auth";

describe("worker bearer authentication", () => {
  const secret = "worker-only-drain-secret-with-adequate-length";

  it("accepts only the exact bearer credential", () => {
    expect(hasValidBearerCredential(`Bearer ${secret}`, secret)).toBe(true);
    expect(hasValidBearerCredential(`bearer ${secret}`, secret)).toBe(false);
    expect(hasValidBearerCredential(`Bearer ${secret} `, secret)).toBe(false);
    expect(hasValidBearerCredential(secret, secret)).toBe(false);
    expect(hasValidBearerCredential(null, secret)).toBe(false);
  });

  it("bounds hostile authorization headers before comparison", () => {
    expect(hasValidBearerCredential(`Bearer ${"x".repeat(3_000)}`, secret)).toBe(false);
  });
});
