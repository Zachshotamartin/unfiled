import { describe, expect, it } from "vitest";

import {
  isManagedFallbackAvailable,
  MANAGED_FALLBACK_CAPABILITY_VARIABLE
} from "./managed-fallback-capability";

describe("managed fallback capability", () => {
  it("names a server-only variable that never looks like key material", () => {
    expect(MANAGED_FALLBACK_CAPABILITY_VARIABLE).toBe("UNFILED_MANAGED_AI_FALLBACK_AVAILABLE");
    expect(MANAGED_FALLBACK_CAPABILITY_VARIABLE.startsWith("NEXT_PUBLIC_")).toBe(false);
    expect(
      /(?:^|_)(?:KEK|MASTER_KEY|ROOT_KEY|KEY_BYTES|KEY_MATERIAL|KEY_RING|KEY)(?:_|$)/u.test(
        MANAGED_FALLBACK_CAPABILITY_VARIABLE
      )
    ).toBe(false);
  });

  it("is unavailable by default and for every non-opt-in value", () => {
    expect(isManagedFallbackAvailable({})).toBe(false);
    for (const value of ["", "0", "false", "no", "yes", "on", "enabled", " ", "2", "TRUE "]) {
      expect(isManagedFallbackAvailable({ [MANAGED_FALLBACK_CAPABILITY_VARIABLE]: value })).toBe(
        value.trim().toLowerCase() === "true"
      );
    }
    expect(
      isManagedFallbackAvailable({ UNFILED_ORGANIZER_OPENAI_API_KEY: "sk-test-not-a-real-key" })
    ).toBe(false);
  });

  it("is available only for an exact opt-in", () => {
    expect(isManagedFallbackAvailable({ [MANAGED_FALLBACK_CAPABILITY_VARIABLE]: "1" })).toBe(true);
    expect(isManagedFallbackAvailable({ [MANAGED_FALLBACK_CAPABILITY_VARIABLE]: "true" })).toBe(
      true
    );
    expect(isManagedFallbackAvailable({ [MANAGED_FALLBACK_CAPABILITY_VARIABLE]: "True" })).toBe(
      true
    );
  });

  it("reads process.env when no environment is supplied", () => {
    expect(typeof isManagedFallbackAvailable()).toBe("boolean");
  });
});
