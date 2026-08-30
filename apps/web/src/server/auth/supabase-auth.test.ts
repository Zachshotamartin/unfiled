import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { HttpError } from "@/server/api/errors";

import { consumeOtpQuota, supabaseAuthProvider } from "./supabase-auth";

const previous = {
  anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  pepper: process.env.AUTH_RATE_LIMIT_PEPPER,
  serviceRole: process.env.SUPABASE_SERVICE_ROLE_KEY,
  url: process.env.NEXT_PUBLIC_SUPABASE_URL
};

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://quota-test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "quota-test-anon";
  delete process.env.AUTH_RATE_LIMIT_PEPPER;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

afterEach(() => {
  delete process.env.AUTH_RATE_LIMIT_PEPPER;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  vi.unstubAllGlobals();
});

afterAll(() => {
  if (previous.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = previous.url;
  if (previous.anonKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previous.anonKey;
  if (previous.pepper === undefined) delete process.env.AUTH_RATE_LIMIT_PEPPER;
  else process.env.AUTH_RATE_LIMIT_PEPPER = previous.pepper;
  if (previous.serviceRole === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = previous.serviceRole;
});

describe("local OTP quota fallback", () => {
  it("allows five requests per email and returns the remaining rolling-window interval", async () => {
    const email = "email-limit-41@example.com";
    for (let index = 0; index < 5; index += 1) {
      await consumeOtpQuota(email, `198.51.100.${index + 1}`);
    }

    const attempt = consumeOtpQuota(email, "198.51.100.99");
    await expect(attempt).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
      retryAfterSeconds: 3_600
    } satisfies Partial<HttpError>);
    await expect(attempt).rejects.not.toThrow(email);
  });

  it("allows twenty requests per IP and returns a safe retry interval on the twenty-first", async () => {
    const ipAddress = "203.0.113.241";
    for (let index = 0; index < 20; index += 1) {
      await consumeOtpQuota(`ip-limit-${index}@example.com`, ipAddress);
    }

    await expect(consumeOtpQuota("ip-limit-over@example.com", ipAddress)).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
      retryAfterSeconds: 3_600
    } satisfies Partial<HttpError>);
  });

  it("counts down to the oldest limiting request instead of returning a fixed minute", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    const email = "rolling-window@example.com";
    try {
      for (let index = 0; index < 5; index += 1) {
        await consumeOtpQuota(email, `192.0.2.${index + 1}`);
        vi.advanceTimersByTime(10_000);
      }

      await expect(consumeOtpQuota(email, "192.0.2.99")).rejects.toMatchObject({
        retryAfterSeconds: 3_550
      } satisfies Partial<HttpError>);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("durable OTP quota adapter", () => {
  it("persists only HMAC digests and validates the database allowance", async () => {
    process.env.AUTH_RATE_LIMIT_PEPPER = "test-only-pepper";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ allowed: true, emailCount: 1, ipCount: 1, windowSeconds: 3_600 }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await consumeOtpQuota("never-persist@example.com", "198.51.100.201");

    const call = fetchMock.mock.calls.at(0);
    if (call?.[1] === undefined || typeof call[1].body !== "string") {
      throw new TypeError("Expected the quota RPC request body");
    }
    const body = JSON.parse(call[1].body) as {
      p_email_hash: string;
      p_ip_hash: string;
    };
    expect(body.p_email_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(body.p_ip_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(call[1].body).not.toContain("never-persist@example.com");
    expect(call[1].body).not.toContain("198.51.100.201");
  });

  it("honors the database Retry-After header for a rate-limited request", async () => {
    process.env.AUTH_RATE_LIMIT_PEPPER = "test-only-pepper";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(JSON.stringify({ code: "rate_limited", message: "Try later." }), {
            status: 429,
            headers: { "retry-after": "73" }
          })
        )
      )
    );

    await expect(
      consumeOtpQuota("durable-limit@example.com", "198.51.100.202")
    ).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
      retryAfterSeconds: 73
    } satisfies Partial<HttpError>);
  });

  it("honors the auth provider Retry-After header instead of inventing a minute", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(JSON.stringify({ message: "rate limit" }), {
            status: 429,
            headers: { "retry-after": "137" }
          })
        )
      )
    );

    await expect(
      supabaseAuthProvider.requestCode("provider-limit@example.com")
    ).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
      retryAfterSeconds: 137
    } satisfies Partial<HttpError>);
  });
});

describe("Supabase session refresh adapter", () => {
  it("returns null only for a definitively rejected refresh credential", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 401 })))
    );

    await expect(supabaseAuthProvider.refresh("expired-refresh-token")).resolves.toBeNull();
  });

  it("preserves the provider Retry-After interval for a throttled refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response(null, { status: 429, headers: { "retry-after": "91" } }))
      )
    );

    await expect(supabaseAuthProvider.refresh("valid-refresh-token")).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
      retryAfterSeconds: 91
    } satisfies Partial<HttpError>);
  });

  it.each([
    ["provider 5xx", () => Promise.resolve(new Response(null, { status: 503 }))],
    ["malformed success", () => Promise.resolve(new Response("{}", { status: 200 }))],
    ["network failure", () => Promise.reject(new TypeError("network detail"))]
  ])(
    "maps %s to a retryable provider failure instead of invalidating the session",
    async (_, result) => {
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(result));

      await expect(supabaseAuthProvider.refresh("still-valid-refresh-token")).rejects.toMatchObject(
        {
          code: "provider_unavailable",
          status: 503
        } satisfies Partial<HttpError>
      );
    }
  );

  it("fails closed when global provider sign-out is not acknowledged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 500 })))
    );

    await expect(supabaseAuthProvider.signOut("access-token")).rejects.toMatchObject({
      code: "provider_unavailable",
      status: 503
    } satisfies Partial<HttpError>);
  });
});
