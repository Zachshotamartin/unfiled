import { describe, expect, it, vi } from "vitest";

import type { AuthProvider, AuthSession } from "./supabase-auth";
import { ACCESS_COOKIE, REFRESH_COOKIE, authenticateRequest } from "./session";

const refreshed: AuthSession = {
  accessToken: "fresh-access",
  refreshToken: "fresh-refresh",
  expiresIn: 3_600,
  user: { id: "00000000-0000-4000-8000-000000000001", email: "person@example.com" }
};

function provider(overrides: Partial<AuthProvider>): AuthProvider {
  return {
    getUser: vi.fn(() => Promise.resolve(null)),
    refresh: vi.fn(() => Promise.resolve(null)),
    signInWithPassword: vi.fn(() => Promise.resolve(refreshed)),
    signOut: vi.fn(() => Promise.resolve()),
    signUp: vi.fn(() => Promise.resolve(refreshed)),
    ...overrides
  };
}

describe("authenticateRequest", () => {
  it("derives identity from a verified Bearer token", async () => {
    const auth = provider({ getUser: vi.fn(() => Promise.resolve(refreshed.user)) });
    const session = await authenticateRequest(
      new Request("https://unfiled.test/api/v1/notes", {
        headers: { authorization: "Bearer mobile-access" }
      }),
      auth
    );
    expect(session.user.id).toBe(refreshed.user.id);
    expect(session.accessToken).toBe("mobile-access");
    expect(session.cookies).toEqual([]);
  });

  it("refreshes an expired cookie session and rotates both HttpOnly cookies", async () => {
    const refresh = vi.fn(() => Promise.resolve(refreshed));
    const auth = provider({ refresh });
    const session = await authenticateRequest(
      new Request("https://unfiled.test/api/v1/notes", {
        headers: { cookie: `${ACCESS_COOKIE}=expired; ${REFRESH_COOKIE}=stored-refresh` }
      }),
      auth
    );
    expect(refresh).toHaveBeenCalledWith("stored-refresh");
    expect(session.accessToken).toBe("fresh-access");
    expect(session.cookies).toHaveLength(2);
    expect(session.cookies.join(";")).toContain("HttpOnly");
  });

  it("rejects a request when neither credential can be verified", async () => {
    await expect(
      authenticateRequest(new Request("https://unfiled.test/api/v1/notes"), provider({}))
    ).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });
});
