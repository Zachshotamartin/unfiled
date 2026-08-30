import { describe, expect, it } from "vitest";

import { authSubmitDisabled } from "./auth-form";

describe("authSubmitDisabled", () => {
  it("keeps email requests disabled during the server cooldown", () => {
    expect(authSubmitDisabled("email", false, 60, 0)).toBe(true);
    expect(authSubmitDisabled("email", false, 0, 0)).toBe(false);
  });

  it("allows a complete OTP to be submitted while resend remains on cooldown", () => {
    expect(authSubmitDisabled("code", false, 60, 6)).toBe(false);
    expect(authSubmitDisabled("code", false, 60, 5)).toBe(true);
    expect(authSubmitDisabled("code", true, 0, 6)).toBe(true);
  });
});
