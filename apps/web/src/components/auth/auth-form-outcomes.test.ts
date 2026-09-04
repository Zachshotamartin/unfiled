import { ApiClientError } from "@unfiled/api-client";
import type { AuthSession } from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  requestAnotherCode,
  submitCredentials,
  submitVerificationCode,
  type AuthTransport
} from "./auth-form-rules";

const SESSION: AuthSession = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: "2026-09-03T19:00:00.000Z",
  user: { id: "00000000-0000-4000-8000-000000000001", email: "person@example.com" }
};

function transport(overrides: Partial<AuthTransport> = {}): AuthTransport {
  return {
    signUp: vi.fn(() => Promise.resolve(SESSION)),
    signIn: vi.fn(() => Promise.resolve(SESSION)),
    verifyEmail: vi.fn(() => Promise.resolve(SESSION)),
    resendVerification: vi.fn(() => Promise.resolve({ sent: true as const })),
    ...overrides
  };
}

function refusal(status: number, message: string): ApiClientError {
  return new ApiClientError(status, {
    code: status === 429 ? "rate_limited" : "unauthorized",
    message,
    requestId: "01J6M9Q7G4BMKB33GSG3NJ6D1X"
  });
}

describe("creating an account", () => {
  it("signs the owner in when the deployment confirms nothing", async () => {
    const signUp = vi.fn(() => Promise.resolve(SESSION));

    await expect(
      submitCredentials(transport({ signUp }), "sign-up", "person@example.com", "correct horse")
    ).resolves.toEqual({ status: "signed-in" });
    expect(signUp).toHaveBeenCalledWith({
      email: "person@example.com",
      password: "correct horse"
    });
  });

  it("asks for the emailed code when the deployment confirms addresses", async () => {
    // The account exists; only the session is withheld until the six digits come back. The same
    // build meets both kinds of deployment, so this is a normal outcome and not a failure.
    const signUp = vi.fn(() =>
      Promise.resolve({ verificationRequired: true as const, email: "person@example.com" })
    );

    await expect(
      submitCredentials(transport({ signUp }), "sign-up", " Person@Example.COM ", "correct horse")
    ).resolves.toEqual({ status: "code-required", email: "person@example.com" });
  });

  it("reports why an account could not be created in the words the API used", async () => {
    const signUp = vi.fn(() =>
      Promise.reject(refusal(409, "An account with this email already exists. Sign in instead."))
    );

    await expect(
      submitCredentials(transport({ signUp }), "sign-up", "person@example.com", "correct horse")
    ).resolves.toEqual({
      status: "refused",
      message: "An account with this email already exists. Sign in instead."
    });
  });

  it("says the account could not be created when the failure carries no message", async () => {
    const signUp = vi.fn(() => Promise.reject(new TypeError("network down")));

    await expect(
      submitCredentials(transport({ signUp }), "sign-up", "person@example.com", "correct horse")
    ).resolves.toEqual({
      status: "refused",
      message: "The account could not be created. Try again."
    });
  });
});

describe("signing in", () => {
  it("never asks for a code, because signing in is answered with a session or a refusal", async () => {
    const signUp = vi.fn(() => Promise.resolve(SESSION));
    const signIn = vi.fn(() => Promise.resolve(SESSION));

    await expect(
      submitCredentials(
        transport({ signIn, signUp }),
        "sign-in",
        "person@example.com",
        "correct horse"
      )
    ).resolves.toEqual({ status: "signed-in" });
    expect(signUp).not.toHaveBeenCalled();
  });

  it("reports a rejected password without inventing a reason of its own", async () => {
    const signIn = vi.fn(() => Promise.reject(refusal(401, "Email or password is incorrect.")));

    await expect(
      submitCredentials(transport({ signIn }), "sign-in", "person@example.com", "correct horse")
    ).resolves.toEqual({ status: "refused", message: "Email or password is incorrect." });
  });
});

describe("entering the emailed code", () => {
  it("sends only the digits, so a code read back as two groups still confirms", async () => {
    const verifyEmail = vi.fn(() => Promise.resolve(SESSION));

    await expect(
      submitVerificationCode(transport({ verifyEmail }), "person@example.com", "123 456")
    ).resolves.toEqual({ status: "signed-in" });
    expect(verifyEmail).toHaveBeenCalledWith({ email: "person@example.com", code: "123456" });
  });

  it("says plainly that a wrong or expired code did not sign the owner in", async () => {
    const verifyEmail = vi.fn(() =>
      Promise.reject(refusal(401, "That code is wrong or has expired. Ask for a new one."))
    );

    await expect(
      submitVerificationCode(transport({ verifyEmail }), "person@example.com", "123456")
    ).resolves.toEqual({
      status: "refused",
      message: "That code is wrong or has expired. Ask for a new one."
    });
  });

  it("says the code could not be checked when the attempt never reached the API", async () => {
    const verifyEmail = vi.fn(() => Promise.reject(new TypeError("network down")));

    await expect(
      submitVerificationCode(transport({ verifyEmail }), "person@example.com", "123456")
    ).resolves.toEqual({
      status: "refused",
      message: "That code could not be checked. Enter it again, or ask for a new one."
    });
  });
});

describe("asking for another code", () => {
  it("reports the address it was sent to and that the earlier code is retired", async () => {
    const resendVerification = vi.fn(() => Promise.resolve({ sent: true as const }));

    await expect(
      requestAnotherCode(transport({ resendVerification }), "person@example.com")
    ).resolves.toEqual({
      status: "sent",
      message:
        "A new code is on its way to person@example.com. Enter the newest one; the earlier code no longer works."
    });
    expect(resendVerification).toHaveBeenCalledWith({ email: "person@example.com" });
  });

  it("reports a refused resend in the API's own words rather than claiming a code was sent", async () => {
    const resendVerification = vi.fn(() =>
      Promise.reject(refusal(429, "Too many attempts. Try again later."))
    );

    await expect(
      requestAnotherCode(transport({ resendVerification }), "person@example.com")
    ).resolves.toEqual({ status: "refused", message: "Too many attempts. Try again later." });
  });

  it("says a code could not be sent when the attempt never reached the API", async () => {
    const resendVerification = vi.fn(() => Promise.reject(new TypeError("network down")));

    await expect(
      requestAnotherCode(transport({ resendVerification }), "person@example.com")
    ).resolves.toEqual({
      status: "refused",
      message: "A new code could not be sent just now. Try again in a moment."
    });
  });
});
