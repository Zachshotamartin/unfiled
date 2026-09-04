import { AuthSessionSchema } from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import type { AuthProvider, AuthSession } from "@/server/auth/supabase-auth";

import { createAuthHandlers } from "./auth-handlers";
import { HttpError } from "./errors";

const session: AuthSession = {
  accessToken: "access-token",
  refreshToken: "refresh-token-next",
  expiresIn: 3_600,
  user: { id: "00000000-0000-4000-8000-000000000001", email: "person@example.com" }
};

function provider(overrides: Partial<AuthProvider> = {}): AuthProvider {
  return {
    getUser: vi.fn(() => Promise.resolve(session.user)),
    refresh: vi.fn(() => Promise.resolve(session)),
    signInWithPassword: vi.fn(() => Promise.resolve(session)),
    signOut: vi.fn(() => Promise.resolve()),
    signUp: vi.fn(() => Promise.resolve(session)),
    verifyEmail: vi.fn(() => Promise.resolve(session)),
    resendVerification: vi.fn(() => Promise.resolve()),
    ...overrides
  };
}

function jsonRequest(path: string, body: unknown, headers?: HeadersInit): Request {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("content-type", "application/json");
  return new Request(`https://unfiled.test${path}`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body)
  });
}

describe("auth route handlers", () => {
  it("creates an account with a normalized email, applies the quota, and returns a session with HttpOnly cookies", async () => {
    const signUp = vi.fn(() => Promise.resolve(session));
    const quota = vi.fn(() => Promise.resolve());
    const handlers = createAuthHandlers({ provider: provider({ signUp }), consumeQuota: quota });
    const response = await handlers.signUp(
      jsonRequest(
        "/api/v1/auth/sign-up",
        { email: " Person@Example.COM ", password: "correct horse battery" },
        { "x-forwarded-for": "203.0.113.7, 10.0.0.1" }
      )
    );
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(AuthSessionSchema.safeParse(body).success).toBe(true);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(quota).toHaveBeenCalledWith("person@example.com", "203.0.113.7");
    expect(signUp).toHaveBeenCalledWith("person@example.com", "correct horse battery");
  });

  it("asks for the emailed code when the deployment confirms addresses", async () => {
    // A confirming deployment answers sign-up with a code by email and no session. That is the
    // normal path, not a failure: the account exists and the owner finishes at /auth/verify.
    const signUp = vi.fn(() => Promise.resolve(null));
    const handlers = createAuthHandlers({
      provider: provider({ signUp }),
      consumeQuota: vi.fn(() => Promise.resolve())
    });
    const response = await handlers.signUp(
      jsonRequest("/api/v1/auth/sign-up", {
        email: " Person@Example.COM ",
        password: "correct horse battery"
      })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      verificationRequired: true,
      email: "person@example.com"
    });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("exchanges the emailed code for a session and spends the quota on every attempt", async () => {
    const verifyEmail = vi.fn(() => Promise.resolve(session));
    const quota = vi.fn(() => Promise.resolve());
    const handlers = createAuthHandlers({
      provider: provider({ verifyEmail }),
      consumeQuota: quota
    });
    const response = await handlers.verify(
      jsonRequest("/api/v1/auth/verify", { email: " Person@Example.COM ", code: "123456" })
    );
    expect(response.status).toBe(200);
    expect(verifyEmail).toHaveBeenCalledWith("person@example.com", "123456");
    // A six digit code must not be guessable by volume, so every attempt is counted.
    expect(quota).toHaveBeenCalledTimes(1);
  });

  it("refuses a code that is not six digits before reaching the provider", async () => {
    const verifyEmail = vi.fn(() => Promise.resolve(session));
    const handlers = createAuthHandlers({
      provider: provider({ verifyEmail }),
      consumeQuota: vi.fn(() => Promise.resolve())
    });
    for (const code of ["12345", "1234567", "12345a", ""]) {
      const response = await handlers.verify(
        jsonRequest("/api/v1/auth/verify", { email: "person@example.com", code })
      );
      expect(response.status).toBe(400);
    }
    expect(verifyEmail).not.toHaveBeenCalled();
  });

  it("answers a resend the same way whether or not the address has an account", async () => {
    // The reply must not disclose who has an account, so a provider that refuses the address
    // and one that accepts it produce the same response.
    const handlers = createAuthHandlers({
      provider: provider({ resendVerification: vi.fn(() => Promise.resolve()) }),
      consumeQuota: vi.fn(() => Promise.resolve())
    });
    const response = await handlers.resendVerification(
      jsonRequest("/api/v1/auth/resend", { email: "nobody@example.com" })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sent: true });
  });

  it("rejects short passwords and malformed emails before touching the provider", async () => {
    const signUp = vi.fn(() => Promise.resolve(session));
    const quota = vi.fn(() => Promise.resolve());
    const handlers = createAuthHandlers({ provider: provider({ signUp }), consumeQuota: quota });
    const response = await handlers.signUp(
      jsonRequest("/api/v1/auth/sign-up", { email: "person@example.com", password: "short" })
    );

    expect(response.status).toBe(400);
    expect(quota).not.toHaveBeenCalled();
    expect(signUp).not.toHaveBeenCalled();
  });

  it("passes the authoritative retry interval through a safe 429 response", async () => {
    const handlers = createAuthHandlers({
      provider: provider(),
      consumeQuota: vi.fn(() =>
        Promise.reject(
          new HttpError(429, "rate_limited", "Too many attempts. Try again later.", {
            retryAfterSeconds: 17
          })
        )
      )
    });
    const response = await handlers.signUp(
      jsonRequest("/api/v1/auth/sign-up", {
        email: "person@example.com",
        password: "correct horse battery"
      })
    );
    const body = (await response.json()) as { retryAfterSeconds?: number };

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(body.retryAfterSeconds).toBe(17);
  });

  it("signs in with a password, returns the canonical session, and never consumes quota on success", async () => {
    const quota = vi.fn(() => Promise.resolve());
    const handlers = createAuthHandlers({ provider: provider(), consumeQuota: quota });
    const response = await handlers.signIn(
      jsonRequest("/api/v1/auth/sign-in", {
        email: "person@example.com",
        password: "correct horse battery"
      })
    );
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(AuthSessionSchema.safeParse(body).success).toBe(true);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(quota).not.toHaveBeenCalled();
  });

  it("counts rejected credentials against the quota and answers with a stable 401", async () => {
    const quota = vi.fn(() => Promise.resolve());
    const handlers = createAuthHandlers({
      provider: provider({
        signInWithPassword: vi.fn(() =>
          Promise.reject(new HttpError(401, "unauthorized", "Email or password is incorrect."))
        )
      }),
      consumeQuota: quota
    });
    const response = await handlers.signIn(
      jsonRequest("/api/v1/auth/sign-in", {
        email: "person@example.com",
        password: "wrong password"
      })
    );

    expect(response.status).toBe(401);
    expect(quota).toHaveBeenCalledWith("person@example.com", "unknown");
  });

  it("refreshes restart-safe mobile credentials without trusting a user id", async () => {
    const refresh = vi.fn(() => Promise.resolve(session));
    const auth = provider({ refresh });
    const handlers = createAuthHandlers({ provider: auth });
    const response = await handlers.refresh(
      jsonRequest("/api/v1/auth/refresh", { refreshToken: "refresh-token" })
    );
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(AuthSessionSchema.safeParse(body).success).toBe(true);
    expect(refresh).toHaveBeenCalledWith("refresh-token");
  });

  it("uses a stable safe error for an expired refresh token", async () => {
    const handlers = createAuthHandlers({
      provider: provider({ refresh: vi.fn(() => Promise.resolve(null)) })
    });
    const response = await handlers.refresh(
      jsonRequest("/api/v1/auth/refresh", { refreshToken: "expired" })
    );
    const body = (await response.json()) as { code: string; message: string };

    expect(response.status).toBe(401);
    expect(body.code).toBe("unauthorized");
    expect(JSON.stringify(body)).not.toContain("expired");
  });

  it("clears browser credentials even when global provider revocation fails", async () => {
    const handlers = createAuthHandlers({
      provider: provider({
        signOut: vi.fn(() =>
          Promise.reject(
            new HttpError(503, "provider_unavailable", "Identity service unavailable.")
          )
        )
      })
    });
    const response = await handlers.signOut(
      new Request("https://unfiled.test/api/v1/auth/sign-out", {
        headers: { authorization: "Bearer access-token" },
        method: "POST"
      })
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
