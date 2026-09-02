import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SearchTrustedSource } from "../src/config.js";

const mocks = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("@vercel/oidc", () => ({ verifyVercelOidcToken: mocks.verify }));

const { authorizeLocalSearchInvocation, createSearchInvocationAuth, isVerifiedSearchInvocation } =
  await import("../src/invocation-auth.js");

function trusted(environment: "preview" | "production" = "production"): SearchTrustedSource {
  return {
    audience: "https://vercel.com/team-example",
    environment,
    expectedSubject: `owner:team-example:project:unfiled-web:environment:${environment}`,
    issuer: "https://oidc.vercel.com/team-example",
    ownerId: "team_owner123",
    projectId: "prj_webexample",
    projectName: "unfiled-web",
    teamSlug: "team-example"
  };
}

function verifiedResult(
  source: SearchTrustedSource,
  overrides: Readonly<Record<string, unknown>> = {},
  header: Readonly<Record<string, unknown>> = { alg: "RS256" }
) {
  const now = Math.floor(Date.now() / 1_000);
  return {
    payload: {
      aud: source.audience,
      environment: source.environment,
      exp: now + 300,
      iat: now,
      iss: source.issuer,
      nbf: now,
      owner: source.teamSlug,
      owner_id: source.ownerId,
      project: source.projectName,
      project_id: source.projectId,
      sub: source.expectedSubject,
      ...overrides
    },
    protectedHeader: header
  };
}

function proof(overrides: Readonly<Record<string, string | null>> = {}) {
  return {
    authorizationHeader: null,
    protectionBypassHeader: null,
    requestId: "request-1",
    trustedSourceToken: "header.payload.signature",
    ...overrides
  };
}

beforeEach(() => mocks.verify.mockReset());

describe("search invocation authentication", () => {
  it.each(["preview", "production"] as const)(
    "accepts exact signed %s claims and binds the issued capability to the request",
    async (runtime) => {
      const source = trusted(runtime);
      mocks.verify.mockResolvedValue(verifiedResult(source));

      const invocation = await createSearchInvocationAuth(source).authorize(
        proof(),
        new AbortController().signal
      );

      expect(mocks.verify).toHaveBeenCalledWith("header.payload.signature", {
        algorithms: ["RS256"],
        audience: source.audience,
        clockTolerance: 5,
        environment: runtime,
        issuer: source.issuer,
        ownerId: source.ownerId,
        projectId: source.projectId,
        subject: source.expectedSubject
      });
      expect(isVerifiedSearchInvocation(invocation, { requestId: "request-1", runtime })).toBe(
        true
      );
      expect(isVerifiedSearchInvocation(invocation, { requestId: "request-2", runtime })).toBe(
        false
      );
      expect(isVerifiedSearchInvocation({}, { requestId: "request-1", runtime })).toBe(false);
    }
  );

  it.each([
    ["issuer", { iss: "https://attacker.invalid" }, { alg: "RS256" }],
    ["audience", { aud: "attacker" }, { alg: "RS256" }],
    ["subject", { sub: "owner:wrong" }, { alg: "RS256" }],
    ["owner", { owner: "other-team" }, { alg: "RS256" }],
    ["owner id", { owner_id: "team_other" }, { alg: "RS256" }],
    ["project", { project: "other-project" }, { alg: "RS256" }],
    ["project id", { project_id: "prj_other" }, { alg: "RS256" }],
    ["environment", { environment: "preview" }, { alg: "RS256" }],
    ["algorithm", {}, { alg: "HS256" }],
    ["missing algorithm", {}, {}]
  ] as const)("rejects signed claim drift: %s", async (_name, overrides, header) => {
    const source = trusted();
    mocks.verify.mockResolvedValue(verifiedResult(source, overrides, header));
    await expect(
      createSearchInvocationAuth(source).authorize(proof(), new AbortController().signal)
    ).rejects.toMatchObject({ code: "unauthorized", status: 401 });
  });

  it("rejects expired, future, inverted, overlong, fractional, and missing lifetimes", async () => {
    const source = trusted();
    const now = Math.floor(Date.now() / 1_000);
    const lifetimes = [
      { exp: now - 6, iat: now - 100, nbf: now - 100 },
      { exp: now + 300, iat: now + 6, nbf: now },
      { exp: now + 300, iat: now, nbf: now + 6 },
      { exp: now + 100, iat: now, nbf: now + 101 },
      { exp: now + 3_606, iat: now, nbf: now },
      { exp: now + 300.5, iat: now, nbf: now },
      { exp: now + 300, iat: now, nbf: undefined }
    ];
    for (const lifetime of lifetimes) {
      mocks.verify.mockResolvedValueOnce(verifiedResult(source, lifetime));
      await expect(
        createSearchInvocationAuth(source).authorize(proof(), new AbortController().signal)
      ).rejects.toMatchObject({ code: "unauthorized", status: 401 });
    }
  });

  it.each([
    ["authorization", proof({ authorizationHeader: "Bearer forbidden" })],
    ["deployment bypass", proof({ protectionBypassHeader: "forbidden" })],
    ["missing", proof({ trustedSourceToken: null })],
    ["empty", proof({ trustedSourceToken: "" })],
    ["whitespace", proof({ trustedSourceToken: " header.payload.signature" })],
    ["malformed", proof({ trustedSourceToken: "not-a-jwt" })],
    ["oversized", proof({ trustedSourceToken: `a.${"x".repeat(16_384)}.c` })]
  ])("rejects an invalid source-token boundary: %s", async (_name, request) => {
    await expect(
      createSearchInvocationAuth(trusted()).authorize(request, new AbortController().signal)
    ).rejects.toMatchObject({ code: "unauthorized", status: 401 });
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("redacts verifier errors and settles when verification ignores cancellation", async () => {
    mocks.verify.mockRejectedValueOnce(new Error("PRIVATE-OIDC-VERIFIER-CANARY"));
    let caught: unknown;
    try {
      await createSearchInvocationAuth(trusted()).authorize(proof(), new AbortController().signal);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "unauthorized", status: 401 });
    expect(String(caught)).not.toContain("PRIVATE-OIDC-VERIFIER-CANARY");

    const controller = new AbortController();
    mocks.verify.mockReturnValueOnce(new Promise(() => undefined));
    const pending = createSearchInvocationAuth(trusted()).authorize(proof(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "provider_unavailable", status: 503 });
  });

  it("issues local bearer proof only for the exact credential", () => {
    const secret = "local-search-secret-with-at-least-32-characters";
    const invocation = authorizeLocalSearchInvocation({
      authorizationHeader: `Bearer ${secret}`,
      requestId: "request-local",
      secret
    });
    expect(
      isVerifiedSearchInvocation(invocation, {
        requestId: "request-local",
        runtime: "local"
      })
    ).toBe(true);
    expect(() =>
      authorizeLocalSearchInvocation({
        authorizationHeader: "Bearer wrong",
        requestId: "request-local",
        secret
      })
    ).toThrow();
  });
});
