import { describe, expect, it } from "vitest";

import { authSubmitDisabled } from "./auth-form";

describe("authSubmitDisabled", () => {
  it("requires an email and a password within the length bounds, and blocks while pending", () => {
    expect(authSubmitDisabled(false, "person@example.com", "correct horse")).toBe(false);
    expect(authSubmitDisabled(true, "person@example.com", "correct horse")).toBe(true);
    expect(authSubmitDisabled(false, "   ", "correct horse")).toBe(true);
    expect(authSubmitDisabled(false, "person@example.com", "short")).toBe(true);
    expect(authSubmitDisabled(false, "person@example.com", "x".repeat(73))).toBe(true);
  });
});
