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
    requestCode: vi.fn(() => Promise.resolve()),
    signOut: vi.fn(() => Promise.resolve()),
    verifyCode: vi.fn(() => Promise.resolve(session)),
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
  it("normalizes OTP email, applies privacy-safe quota, and returns non-enumerating acceptance", async () => {
    const requestCode = vi.fn(() => Promise.resolve());
    const auth = provider({ requestCode });
    const quota = vi.fn(() => Promise.resolve());
    const handlers = createAuthHandlers({ provider: auth, consumeQuota: quota });
    const response = await handlers.requestCode(
      jsonRequest(
        "/api/v1/auth/otp",
        { email: " Person@Example.COM " },
        { "x-forwarded-for": "203.0.113.7, 10.0.0.1" }
      )
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      accepted: true,
      retryAfterSeconds: 60
    });
    expect(quota).toHaveBeenCalledWith("person@example.com", "203.0.113.7");
    expect(requestCode).toHaveBeenCalledWith("person@example.com");
  });

  it("passes the authoritative retry interval through a safe 429 response", async () => {
    const handlers = createAuthHandlers({
      provider: provider(),
      consumeQuota: vi.fn(() =>
        Promise.reject(
          new HttpError(429, "rate_limited", "Try requesting another code later.", {
            retryAfterSeconds: 17
          })
        )
      )
    });
    const response = await handlers.requestCode(
      jsonRequest("/api/v1/auth/otp", { email: "person@example.com" })
    );
    const body = (await response.json()) as { retryAfterSeconds?: number };

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(body.retryAfterSeconds).toBe(17);
  });

  it("verifies a code, returns the canonical mobile session, and sets HttpOnly cookies", async () => {
    const handlers = createAuthHandlers({ provider: provider(), consumeQuota: vi.fn() });
    const response = await handlers.verifyCode(
      jsonRequest("/api/v1/auth/otp", { email: "person@example.com", code: "123456" })
    );
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(AuthSessionSchema.safeParse(body).success).toBe(true);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
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
