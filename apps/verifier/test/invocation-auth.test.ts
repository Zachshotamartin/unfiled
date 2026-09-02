import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("@vercel/oidc", () => ({ verifyVercelOidcToken: mocks.verify }));

import type { VercelTrustedSource } from "../src/config";
import {
  assertWorkloadOidcPresence,
  createProductionInvocationAuth,
  isVerifiedVerifierInvocation,
  unconfiguredProductionInvocationAuth
} from "../src/invocation-auth";

const trusted: VercelTrustedSource = {
  audience: "https://vercel.com/team-example",
  environment: "production",
  expectedSubject: "owner:team-example:project:unfiled-web:environment:production",
  issuer: "https://oidc.vercel.com/team-example",
  ownerId: "team_owner123",
  projectId: "prj_web123",
  projectName: "unfiled-web",
  teamSlug: "team-example"
};

function tokenResult(
  overrides: Record<string, unknown> = {},
  source: VercelTrustedSource = trusted
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
    protectedHeader: { alg: "RS256" }
  };
}

function proof(overrides: Record<string, string | null> = {}) {
  return {
    authorizationHeader: null,
    protectionBypassHeader: null,
    requestId: "request-1",
    trustedSourceToken: "header.payload.signature",
    ...overrides
  };
}

describe("verifier invocation authentication", () => {
  beforeEach(() => {
    mocks.verify.mockReset().mockResolvedValue(tokenResult());
  });

  it("issues opaque request-bound authority only for every exact production claim", async () => {
    const capability = await createProductionInvocationAuth(trusted).authorize(
      proof(),
      new AbortController().signal
    );
    expect(
      isVerifiedVerifierInvocation(capability, { requestId: "request-1", runtime: "production" })
    ).toBe(true);
    expect(
      isVerifiedVerifierInvocation(capability, { requestId: "other", runtime: "production" })
    ).toBe(false);
    expect(
      isVerifiedVerifierInvocation({}, { requestId: "request-1", runtime: "production" })
    ).toBe(false);
    expect(mocks.verify).toHaveBeenCalledWith("header.payload.signature", {
      algorithms: ["RS256"],
      audience: trusted.audience,
      clockTolerance: 5,
      environment: "production",
      issuer: trusted.issuer,
      ownerId: trusted.ownerId,
      projectId: trusted.projectId,
      subject: trusted.expectedSubject
    });
  });

  it("issues an opaque Preview authority only for the exact Preview source", async () => {
    const previewSource: VercelTrustedSource = {
      ...trusted,
      environment: "preview",
      expectedSubject: "owner:team-example:project:unfiled-web:environment:preview"
    };
    mocks.verify.mockResolvedValue(tokenResult({}, previewSource));

    const capability = await createProductionInvocationAuth(previewSource).authorize(
      proof(),
      new AbortController().signal
    );

    expect(
      isVerifiedVerifierInvocation(capability, { requestId: "request-1", runtime: "preview" })
    ).toBe(true);
    expect(
      isVerifiedVerifierInvocation(capability, { requestId: "request-1", runtime: "production" })
    ).toBe(false);
    expect(mocks.verify).toHaveBeenCalledWith(
      "header.payload.signature",
      expect.objectContaining({
        environment: "preview",
        subject: previewSource.expectedSubject
      })
    );
  });

  it.each([
    { trustedSourceToken: null },
    { trustedSourceToken: "" },
    { trustedSourceToken: "not-a-jwt" },
    { trustedSourceToken: `a.${"x".repeat(16_385)}.b` },
    { trustedSourceToken: " header.payload.signature" },
    { authorizationHeader: "Bearer fallback" },
    { protectionBypassHeader: "bypass" }
  ])("rejects alternate or malformed caller credentials", async (change) => {
    await expect(
      createProductionInvocationAuth(trusted).authorize(proof(change), new AbortController().signal)
    ).rejects.toMatchObject({ code: "unauthorized", status: 401 });
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it.each([
    { aud: "other" },
    { environment: "preview" },
    { iss: "other" },
    { owner: "other" },
    { owner_id: "team_other" },
    { project: "other" },
    { project_id: "prj_other" },
    { sub: "other" },
    { exp: 0 },
    { iat: Number.MAX_SAFE_INTEGER },
    { nbf: Number.MAX_SAFE_INTEGER }
  ])("rejects claim drift", async (change) => {
    mocks.verify.mockResolvedValueOnce(tokenResult(change));
    await expect(
      createProductionInvocationAuth(trusted).authorize(proof(), new AbortController().signal)
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("redacts verifier errors and honors cancellation before and after verification", async () => {
    mocks.verify.mockRejectedValueOnce(new Error("oidc-secret-canary"));
    let captured: unknown;
    try {
      await createProductionInvocationAuth(trusted).authorize(
        proof(),
        new AbortController().signal
      );
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toMatchObject({ code: "unauthorized" });
    expect(String(captured)).not.toContain("canary");

    const before = new AbortController();
    before.abort();
    await expect(
      createProductionInvocationAuth(trusted).authorize(proof(), before.signal)
    ).rejects.toMatchObject({ code: "provider_unavailable" });

    const after = new AbortController();
    mocks.verify.mockImplementationOnce(() => {
      after.abort();
      return Promise.resolve(tokenResult());
    });
    await expect(
      createProductionInvocationAuth(trusted).authorize(proof(), after.signal)
    ).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("requires a bounded workload JWT and ships no unconfigured fallback", async () => {
    expect(() =>
      assertWorkloadOidcPresence(
        new Request("https://verifier.test/internal/verify", {
          headers: { "x-vercel-oidc-token": "header.payload.signature" }
        })
      )
    ).not.toThrow();
    for (const token of [undefined, "", "bad", `a.${"x".repeat(16_385)}.b`]) {
      expect(() =>
        assertWorkloadOidcPresence(
          new Request("https://verifier.test/internal/verify", {
            headers: token === undefined ? {} : { "x-vercel-oidc-token": token }
          })
        )
      ).toThrow();
    }
    await expect(
      unconfiguredProductionInvocationAuth.authorize(proof(), new AbortController().signal)
    ).rejects.toMatchObject({ code: "provider_unavailable" });
  });
});
