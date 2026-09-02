import { beforeEach, describe, expect, it, vi } from "vitest";

const oidcMocks = vi.hoisted(() => ({ verify: vi.fn() }));

vi.mock("@vercel/oidc", () => ({ verifyVercelOidcToken: oidcMocks.verify }));

import type { VercelTrustedSource } from "../src/config";
import {
  createVercelTrustedSourcesInvocationAuth,
  isVerifiedWorkerInvocation,
  unconfiguredProductionInvocationAuth
} from "../src/invocation-auth-adapter";

const NOW_MS = Date.now();
const NOW_SECONDS = Math.floor(NOW_MS / 1_000);
const TOKEN = "signedHeader.signedPayload.signature";

const trustedSource: VercelTrustedSource = Object.freeze({
  audience: "https://vercel.com/team-example",
  environment: "production",
  expectedSubject: "owner:team-example:project:unfiled-web:environment:production",
  issuer: "https://oidc.vercel.com/team-example",
  ownerId: "team_owner123",
  projectId: "prj_webexample",
  projectName: "unfiled-web",
  teamSlug: "team-example"
});

function tokenResult(
  overrides: Readonly<Record<string, unknown>> = {},
  source: VercelTrustedSource = trustedSource
) {
  return {
    payload: {
      aud: source.audience,
      environment: source.environment,
      exp: NOW_SECONDS + 300,
      iat: NOW_SECONDS - 10,
      iss: source.issuer,
      nbf: NOW_SECONDS - 10,
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

function proof(overrides: Readonly<Record<string, string | null>> = {}) {
  return {
    authorizationHeader: null,
    protectionBypassHeader: null,
    requestId: "request-1",
    trustedSourceToken: TOKEN,
    ...overrides
  };
}

function adapter() {
  return createVercelTrustedSourcesInvocationAuth({ trustedSource });
}

describe("Vercel Trusted Sources invocation authentication", () => {
  beforeEach(() => {
    oidcMocks.verify.mockReset();
    oidcMocks.verify.mockResolvedValue(tokenResult());
  });

  it("cryptographically verifies and independently pins every source claim", async () => {
    const capability = await adapter().authorize(proof(), new AbortController().signal);

    expect(oidcMocks.verify).toHaveBeenCalledWith(TOKEN, {
      algorithms: ["RS256"],
      audience: trustedSource.audience,
      clockTolerance: 5,
      environment: "production",
      issuer: trustedSource.issuer,
      ownerId: trustedSource.ownerId,
      projectId: trustedSource.projectId,
      subject: trustedSource.expectedSubject
    });
    expect(
      isVerifiedWorkerInvocation(capability, { requestId: "request-1", runtime: "production" })
    ).toBe(true);
    expect(
      isVerifiedWorkerInvocation(capability, { requestId: "request-2", runtime: "production" })
    ).toBe(false);
    expect(isVerifiedWorkerInvocation({}, { requestId: "request-1", runtime: "production" })).toBe(
      false
    );
    expect(Object.keys(capability)).toEqual([]);
  });

  it("issues a Preview-bound capability only for an exact Preview source identity", async () => {
    const previewSource: VercelTrustedSource = Object.freeze({
      ...trustedSource,
      environment: "preview",
      expectedSubject: "owner:team-example:project:unfiled-web:environment:preview"
    });
    oidcMocks.verify.mockResolvedValue(tokenResult({}, previewSource));

    const capability = await createVercelTrustedSourcesInvocationAuth({
      trustedSource: previewSource
    }).authorize(proof(), new AbortController().signal);

    expect(
      isVerifiedWorkerInvocation(capability, { requestId: "request-1", runtime: "preview" })
    ).toBe(true);
    expect(
      isVerifiedWorkerInvocation(capability, { requestId: "request-1", runtime: "production" })
    ).toBe(false);
    expect(oidcMocks.verify).toHaveBeenCalledWith(
      TOKEN,
      expect.objectContaining({
        environment: "preview",
        subject: previewSource.expectedSubject
      })
    );
  });

  it.each([
    ["issuer", { iss: "https://oidc.vercel.com/another-team" }],
    ["audience", { aud: "https://vercel.com/another-team" }],
    ["subject/project name", { sub: "owner:team-example:project:other:environment:production" }],
    ["owner slug", { owner: "another-team" }],
    ["project id", { project_id: "prj_other" }],
    ["project name", { project: "another-project" }],
    ["owner id", { owner_id: "team_other" }],
    ["environment", { environment: "preview" }],
    ["expired token", { exp: NOW_SECONDS - 60 }],
    ["missing issued-at", { iat: undefined }],
    ["missing not-before", { nbf: undefined }],
    ["future issuance", { iat: NOW_SECONDS + 60 }],
    ["future not-before", { nbf: NOW_SECONDS + 60 }],
    ["overlong production lifetime", { exp: NOW_SECONDS + 7_200 }]
  ])("rejects a cryptographically returned token with the wrong %s", async (_label, claims) => {
    oidcMocks.verify.mockResolvedValue(tokenResult(claims));
    await expect(adapter().authorize(proof(), new AbortController().signal)).rejects.toMatchObject({
      code: "unauthorized",
      status: 401
    });
  });

  it("rejects a non-RS256 protected header", async () => {
    oidcMocks.verify.mockResolvedValue({
      ...tokenResult(),
      protectedHeader: { alg: "HS256" }
    });
    await expect(adapter().authorize(proof(), new AbortController().signal)).rejects.toMatchObject({
      code: "unauthorized",
      status: 401
    });
  });

  it.each([
    ["missing Trusted Sources header", null],
    ["malformed token", "not-a-jwt"],
    ["padded token", ` ${TOKEN}`],
    ["oversized token", `a.${"x".repeat(17_000)}.c`]
  ])("rejects %s before verification", async (_label, trustedSourceToken) => {
    await expect(
      adapter().authorize(proof({ trustedSourceToken }), new AbortController().signal)
    ).rejects.toMatchObject({ code: "unauthorized", status: 401 });
    expect(oidcMocks.verify).not.toHaveBeenCalled();
  });

  it("rejects bearer and deployment-bypass credentials instead of treating them as fallbacks", async () => {
    for (const headers of [
      { authorizationHeader: "Bearer legacy-secret" },
      { protectionBypassHeader: "legacy-bypass-secret" }
    ]) {
      await expect(
        adapter().authorize(proof(headers), new AbortController().signal)
      ).rejects.toMatchObject({ code: "unauthorized", status: 401 });
    }
    expect(oidcMocks.verify).not.toHaveBeenCalled();
  });

  it("redacts verifier failures and the raw token", async () => {
    const canary = "raw-token-canary";
    const rawToken = `header.${canary}.signature`;
    oidcMocks.verify.mockRejectedValue(new Error(`expired ${rawToken}`));

    let captured: unknown;
    try {
      await adapter().authorize(
        proof({ trustedSourceToken: rawToken }),
        new AbortController().signal
      );
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toMatchObject({ code: "unauthorized", status: 401 });
    expect(String(captured)).not.toContain(canary);
  });

  it("fails closed before and after verification when the request is aborted", async () => {
    const before = new AbortController();
    before.abort();
    await expect(adapter().authorize(proof(), before.signal)).rejects.toMatchObject({
      code: "provider_unavailable",
      status: 503
    });
    expect(oidcMocks.verify).not.toHaveBeenCalled();

    const after = new AbortController();
    oidcMocks.verify.mockImplementation(() => {
      after.abort();
      return Promise.resolve(tokenResult());
    });
    await expect(adapter().authorize(proof(), after.signal)).rejects.toMatchObject({
      code: "provider_unavailable",
      status: 503
    });
  });

  it("ships with a fail-closed production invocation adapter", async () => {
    await expect(
      unconfiguredProductionInvocationAuth.authorize(proof(), new AbortController().signal)
    ).rejects.toMatchObject({ code: "provider_unavailable", status: 503 });
  });
});
