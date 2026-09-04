import { describe, expect, it, vi } from "vitest";

import {
  ApiClientError,
  ApiClientMalformedResponseError,
  authVerificationRequired,
  createApiClient
} from "../src/index.js";

const SESSION = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: "2026-09-03T19:00:00.000Z",
  user: { id: "00000000-0000-4000-8000-000000000001", email: "person@example.com" }
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status
  });
}

function client(fetcher: ReturnType<typeof vi.fn<typeof fetch>>) {
  return createApiClient({
    baseUrl: "https://example.test",
    fetch: fetcher,
    getAccessToken: () => Promise.resolve(null)
  });
}

describe("account confirmation in the API client", () => {
  it("returns the session when the deployment confirms nothing", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(SESSION));

    const response = await client(fetcher).signUp({
      email: "person@example.com",
      password: "correct horse battery"
    });

    expect(response).toEqual(SESSION);
    expect(authVerificationRequired(response)).toBe(false);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://example.test/api/v1/auth/sign-up");
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({ "content-type": "application/json" });
  });

  it("returns the address awaiting a code when the deployment confirms one", async () => {
    // A confirming deployment answers sign-up with no session at all. The account exists; the
    // owner finishes by entering the six digits it just emailed.
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ verificationRequired: true, email: "person@example.com" }));

    const response = await client(fetcher).signUp({
      email: " Person@Example.COM ",
      password: "correct horse battery"
    });

    expect(authVerificationRequired(response)).toBe(true);
    expect(response).toEqual({ verificationRequired: true, email: "person@example.com" });
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ email: "person@example.com", password: "correct horse battery" })
    );
  });

  it("refuses a sign-up answer that is neither a session nor a request for a code", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ verificationRequired: false }));

    await expect(
      client(fetcher).signUp({ email: "person@example.com", password: "correct horse battery" })
    ).rejects.toBeInstanceOf(ApiClientMalformedResponseError);
  });

  it("exchanges the six digits for a session", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(SESSION));

    await expect(
      client(fetcher).verifyEmail({ email: " Person@Example.COM ", code: "123456" })
    ).resolves.toEqual(SESSION);

    expect(fetcher.mock.calls[0]?.[0]).toBe("https://example.test/api/v1/auth/verify");
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ email: "person@example.com", code: "123456" })
    );
  });

  it("rejects a code that is not six digits before any network request", () => {
    const fetcher = vi.fn<typeof fetch>();
    const api = client(fetcher);

    expect(() => api.verifyEmail({ email: "person@example.com", code: "12345" })).toThrow();
    expect(() => api.verifyEmail({ email: "person@example.com", code: "1234567" })).toThrow();
    expect(() => api.verifyEmail({ email: "person@example.com", code: "12345x" })).toThrow();
    expect(fetcher.mock.calls).toHaveLength(0);
  });

  it("carries a refused code back to the caller with the reason the API gave", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          code: "unauthorized",
          message: "That code is wrong or has expired. Ask for a new one.",
          requestId: "01J6M9Q7G4BMKB33GSG3NJ6D1X"
        },
        401
      )
    );

    await expect(
      client(fetcher).verifyEmail({ email: "person@example.com", code: "123456" })
    ).rejects.toBeInstanceOf(ApiClientError);
  });

  it("asks for another code and reports that the API accepted the request", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ sent: true }));

    await expect(
      client(fetcher).resendVerification({ email: " Person@Example.COM " })
    ).resolves.toEqual({ sent: true });

    expect(fetcher.mock.calls[0]?.[0]).toBe("https://example.test/api/v1/auth/resend");
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ email: "person@example.com" }));
  });

  it("treats a resend answer that does not say it was sent as a transport failure", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ sent: false }));

    await expect(
      client(fetcher).resendVerification({ email: "person@example.com" })
    ).rejects.toBeInstanceOf(ApiClientMalformedResponseError);
  });

  it("never sends an authorization header on a confirmation request", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(SESSION));
    const api = createApiClient({
      baseUrl: "https://example.test",
      fetch: fetcher,
      getAccessToken: () => Promise.resolve("a-stale-token")
    });

    await api.verifyEmail({ email: "person@example.com", code: "123456" });

    expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({ "content-type": "application/json" });
  });
});
