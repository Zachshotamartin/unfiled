import { describe, expect, it, vi } from "vitest";

import {
  createMobileAuthApi,
  mobileAuthErrorMessage,
  MobileAuthError,
  type MobileAuthApi
} from "../src/auth/authApi";
import {
  assertAuthSession,
  isSessionUsable,
  millisecondsUntilSessionRefresh,
  normalizeEmail,
  type AuthSessionStore,
  type PersistedAuthState
} from "../src/auth/session";
import {
  clearLocalSessionThenRevokeRemote,
  restorePersistedAuthState,
  shouldDiscardSessionAfterRefreshFailure
} from "../src/auth/sessionLifecycle";

const session = {
  accessToken: "access",
  expiresAt: "2030-01-01T00:00:00.000Z",
  refreshToken: "refresh",
  user: { email: "person@example.com", id: "a3e2aa89-f45d-45be-b2d6-56e43b599bff" }
};

function authApi(overrides: Partial<MobileAuthApi> = {}): MobileAuthApi {
  return {
    refresh: vi.fn(() => Promise.resolve(session)),
    requestCode: vi.fn(() => Promise.resolve(60)),
    signOut: vi.fn(() => Promise.resolve()),
    verifyCode: vi.fn(() => Promise.resolve(session)),
    ...overrides
  };
}

function sessionStore(
  persisted: PersistedAuthState = {
    lastProfileEmail: session.user.email,
    lastProfileId: session.user.id,
    session
  }
): AuthSessionStore {
  return {
    clearSession: vi.fn(() => Promise.resolve()),
    load: vi.fn(() => Promise.resolve(persisted)),
    saveSession: vi.fn(() => Promise.resolve())
  };
}

describe("mobile authentication boundary", () => {
  it("normalizes email and validates a persisted session", () => {
    expect(normalizeEmail("  PERSON@Example.COM ")).toBe("person@example.com");
    expect(assertAuthSession(session)).toEqual(session);
    expect(isSessionUsable(session, Date.parse("2029-12-31T23:00:00.000Z"))).toBe(true);
    expect(isSessionUsable(session, Date.parse("2030-01-01T00:00:00.000Z"))).toBe(false);
    expect(millisecondsUntilSessionRefresh(session, Date.parse("2029-12-31T23:58:30.000Z"))).toBe(
      30_000
    );
    expect(millisecondsUntilSessionRefresh(session, Date.parse("2030-01-01T00:00:00.000Z"))).toBe(
      0
    );
    expect(isSessionUsable(null)).toBe(false);
    expect(millisecondsUntilSessionRefresh(null)).toBe(0);
    expect(millisecondsUntilSessionRefresh({ ...session, expiresAt: "not-a-date" })).toBe(0);
    expect(mobileAuthErrorMessage(new MobileAuthError("offline", "Offline.", 0))).toBe("Offline.");
  });

  it("rejects each malformed persisted-session boundary", () => {
    expect(() => assertAuthSession(null)).toThrow("Invalid auth session");
    expect(() => assertAuthSession({ ...session, accessToken: "" })).toThrow(
      "Invalid auth session field: accessToken"
    );
    expect(() => assertAuthSession({ ...session, user: null })).toThrow(
      "Invalid auth session user"
    );
    expect(() =>
      assertAuthSession({ ...session, user: { email: 7, id: session.user.id } })
    ).toThrow("Invalid auth session user");
    expect(() => assertAuthSession({ ...session, expiresAt: "not-a-date" })).toThrow(
      "Invalid session expiry"
    );
  });

  it("discards a session only when the server definitively rejects its refresh credential", () => {
    expect(
      shouldDiscardSessionAfterRefreshFailure(
        new MobileAuthError("unauthorized", "Session ended.", 401)
      )
    ).toBe(true);
    expect(
      shouldDiscardSessionAfterRefreshFailure(
        new MobileAuthError("rate_limited", "Try later.", 429, 60)
      )
    ).toBe(false);
    expect(
      shouldDiscardSessionAfterRefreshFailure(
        new MobileAuthError("provider_unavailable", "Try later.", 503)
      )
    ).toBe(false);
    expect(
      shouldDiscardSessionAfterRefreshFailure(new MobileAuthError("offline", "Offline.", 0))
    ).toBe(false);
  });

  it("refreshes an expired persisted session and rotates secure storage", async () => {
    const expired = { ...session, expiresAt: "2020-01-01T00:00:00.000Z" };
    const next = { ...session, accessToken: "rotated-access", refreshToken: "rotated-refresh" };
    const store = sessionStore({
      lastProfileEmail: expired.user.email,
      lastProfileId: expired.user.id,
      session: expired
    });
    const api = authApi({ refresh: vi.fn(() => Promise.resolve(next)) });

    await expect(restorePersistedAuthState(api, store)).resolves.toMatchObject({ session: next });
    expect(api.refresh).toHaveBeenCalledWith(expired.refreshToken);
    expect(store.saveSession).toHaveBeenCalledWith(next);
    expect(store.clearSession).not.toHaveBeenCalled();
  });

  it("restores signed-out and still-usable states without an unnecessary refresh", async () => {
    const signedOut = sessionStore({
      lastProfileEmail: session.user.email,
      lastProfileId: session.user.id,
      session: null
    });
    const usable = sessionStore();
    const api = authApi();

    await expect(restorePersistedAuthState(api, signedOut)).resolves.toMatchObject({
      session: null
    });
    await expect(restorePersistedAuthState(api, usable)).resolves.toMatchObject({ session });
    expect(api.refresh).not.toHaveBeenCalled();
  });

  it("preserves an expired local profile through transient refresh failures", async () => {
    const expired = { ...session, expiresAt: "2020-01-01T00:00:00.000Z" };
    const persisted = {
      lastProfileEmail: expired.user.email,
      lastProfileId: expired.user.id,
      session: expired
    };
    const store = sessionStore(persisted);
    const api = authApi({
      refresh: vi.fn(() =>
        Promise.reject(new MobileAuthError("provider_unavailable", "Try later.", 503))
      )
    });

    await expect(restorePersistedAuthState(api, store)).resolves.toEqual(persisted);
    expect(store.clearSession).not.toHaveBeenCalled();
  });

  it("does not misclassify a secure-storage rotation failure as a provider outage", async () => {
    const expired = { ...session, expiresAt: "2020-01-01T00:00:00.000Z" };
    const store = sessionStore({
      lastProfileEmail: expired.user.email,
      lastProfileId: expired.user.id,
      session: expired
    });
    vi.mocked(store.saveSession).mockRejectedValue(new Error("secure storage unavailable"));

    await expect(restorePersistedAuthState(authApi(), store)).rejects.toThrow(
      "secure storage unavailable"
    );
    expect(store.clearSession).not.toHaveBeenCalled();
  });

  it("clears an expired session after an authoritative refresh rejection", async () => {
    const expired = { ...session, expiresAt: "2020-01-01T00:00:00.000Z" };
    const store = sessionStore({
      lastProfileEmail: expired.user.email,
      lastProfileId: expired.user.id,
      session: expired
    });
    const api = authApi({
      refresh: vi.fn(() =>
        Promise.reject(new MobileAuthError("unauthorized", "Session ended.", 401))
      )
    });

    await expect(restorePersistedAuthState(api, store)).resolves.toMatchObject({ session: null });
    expect(store.clearSession).toHaveBeenCalledOnce();
  });

  it("clears device credentials before remote sign-out and surfaces revocation failure", async () => {
    const order: string[] = [];
    const store = sessionStore();
    vi.mocked(store.clearSession).mockImplementation(() => {
      order.push("local-clear");
      return Promise.resolve();
    });
    const api = authApi({
      signOut: vi.fn(() => {
        order.push("remote-revoke");
        return Promise.reject(new MobileAuthError("offline", "Offline.", 0));
      })
    });

    await expect(
      clearLocalSessionThenRevokeRemote(session, api, store, () => {
        order.push("memory-clear");
      })
    ).rejects.toMatchObject({ code: "offline" });
    expect(order).toEqual(["local-clear", "memory-clear", "remote-revoke"]);
  });

  it("clears an already signed-out store without attempting remote revocation", async () => {
    const store = sessionStore();
    const api = authApi();

    await expect(clearLocalSessionThenRevokeRemote(null, api, store)).resolves.toBeUndefined();
    expect(store.clearSession).toHaveBeenCalledOnce();
    expect(api.signOut).not.toHaveBeenCalled();
  });

  it("sends normalized OTP requests without leaking the email into a URL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ accepted: true, retryAfterSeconds: 60 }), {
        headers: { "Content-Type": "application/json" },
        status: 202
      })
    );
    const api = createMobileAuthApi("https://api.unfiled.test/", fetcher);
    await expect(api.requestCode(" PERSON@Example.COM ")).resolves.toBe(60);
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.unfiled.test/api/v1/auth/otp",
      expect.objectContaining({
        body: JSON.stringify({ email: "person@example.com" }),
        method: "POST"
      })
    );
  });

  it("parses a verified session and maps stable server errors", async () => {
    const success = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(session), { status: 200 }));
    await expect(
      createMobileAuthApi("https://api.unfiled.test", success).verifyCode(
        "person@example.com",
        "123456"
      )
    ).resolves.toEqual(session);

    const rejected = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "rate_limited",
          message: "Try again later.",
          requestId: "request-test",
          retryAfterSeconds: 137
        }),
        { status: 429 }
      )
    );
    const attempt = createMobileAuthApi("https://api.unfiled.test", rejected).requestCode(
      "person@example.com"
    );
    await expect(attempt).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
      retryAfterSeconds: 137
    } satisfies Partial<MobileAuthError>);

    await expect(attempt).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof MobileAuthError &&
        mobileAuthErrorMessage(error).includes("Try again in 137s")
    );
  });

  it("requires a provider acknowledgement for remote sign-out", async () => {
    const offline = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network detail"));
    await expect(
      createMobileAuthApi("https://api.unfiled.test", offline).refresh("refresh-token")
    ).rejects.toMatchObject({ code: "offline", status: 0 });

    const acknowledged = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    await expect(
      createMobileAuthApi("https://api.unfiled.test", acknowledged).signOut("access-token")
    ).resolves.toBeUndefined();

    const rejected = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    await expect(
      createMobileAuthApi("https://api.unfiled.test", rejected).signOut("expired-access-token")
    ).rejects.toMatchObject({ status: 401 });

    await expect(
      createMobileAuthApi("https://api.unfiled.test", offline).signOut("access-token")
    ).rejects.toMatchObject({ code: "offline", status: 0 });
  });

  it("maps local request-schema failures without invoking the network", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      createMobileAuthApi("https://api.unfiled.test", fetcher).requestCode("bad")
    ).rejects.toMatchObject({ code: "validation_failed", status: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
