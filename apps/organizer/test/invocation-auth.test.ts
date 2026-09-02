import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@vercel/oidc", () => ({ verifyVercelOidcToken: vi.fn() }));

import { verifyVercelOidcToken } from "@vercel/oidc";

import type { VercelTrustedSource } from "../src/config.js";
import { OrganizerUnavailableError } from "../src/errors.js";
import {
  authorizeLocalOrganizerInvocation,
  createVercelTrustedSourcesInvocationAuth,
  isVerifiedOrganizerInvocation,
  unconfiguredProductionInvocationAuth
} from "../src/invocation-auth.js";

const trusted: VercelTrustedSource = Object.freeze({
  audience: "https://vercel.com/team-example",
  environment: "production",
  expectedSubject: "owner:team-example:project:unfiled-web:environment:production",
  issuer: "https://oidc.vercel.com/team-example",
  ownerId: "team_owner123",
  projectId: "prj_web123",
  projectName: "unfiled-web",
  teamSlug: "team-example"
});
const token = "aaa.bbb.ccc";

function verified(overrides: Record<string, unknown> = {}, source: VercelTrustedSource = trusted) {
  const now = Math.floor(Date.now() / 1_000);
  return {
    protectedHeader: { alg: "RS256" },
    payload: {
      aud: source.audience,
      environment: source.environment,
      exp: now + 600,
      iat: now,
      iss: source.issuer,
      nbf: now,
      owner: source.teamSlug,
      owner_id: source.ownerId,
      project: source.projectName,
      project_id: source.projectId,
      sub: source.expectedSubject,
      ...overrides
    }
  };
}

function proof(overrides: Record<string, unknown> = {}) {
  return {
    authorizationHeader: null,
    protectionBypassHeader: null,
    requestId: "request-1",
    trustedSourceToken: token,
    ...overrides
  };
}

describe("organizer invocation authentication", () => {
  beforeEach(() => {
    vi.mocked(verifyVercelOidcToken).mockReset();
    vi.mocked(verifyVercelOidcToken).mockResolvedValue(verified());
  });

  it("issues only an exact request-bound local capability", () => {
    const secret = "s".repeat(32);
    const capability = authorizeLocalOrganizerInvocation({
      authorizationHeader: `Bearer ${secret}`,
      requestId: "request-1",
      runtime: "local",
      secret
    });
    expect(
      isVerifiedOrganizerInvocation(capability, { requestId: "request-1", runtime: "local" })
    ).toBe(true);
    expect(
      isVerifiedOrganizerInvocation(capability, { requestId: "request-2", runtime: "local" })
    ).toBe(false);
    expect(isVerifiedOrganizerInvocation({}, { requestId: "request-1", runtime: "local" })).toBe(
      false
    );
    expect(() =>
      authorizeLocalOrganizerInvocation({
        authorizationHeader: "Bearer wrong",
        requestId: "r",
        runtime: "local",
        secret
      })
    ).toThrow("invalid");
  });

  it("verifies exact production Trusted Source claims and rejects ambient credentials", async () => {
    const adapter = createVercelTrustedSourcesInvocationAuth({ trustedSource: trusted });
    const capability = await adapter.authorize(proof(), new AbortController().signal);
    expect(
      isVerifiedOrganizerInvocation(capability, { requestId: "request-1", runtime: "production" })
    ).toBe(true);
    expect(verifyVercelOidcToken).toHaveBeenCalledWith(
      token,
      expect.objectContaining({
        algorithms: ["RS256"],
        projectId: trusted.projectId,
        subject: trusted.expectedSubject
      })
    );
    await expect(
      adapter.authorize(proof({ authorizationHeader: "Bearer user" }), new AbortController().signal)
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      adapter.authorize(proof({ protectionBypassHeader: "bypass" }), new AbortController().signal)
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      adapter.authorize(proof({ trustedSourceToken: " bad " }), new AbortController().signal)
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("issues a Preview-bound capability only from exact Preview Trusted Source claims", async () => {
    const previewSource: VercelTrustedSource = Object.freeze({
      ...trusted,
      environment: "preview",
      expectedSubject: "owner:team-example:project:unfiled-web:environment:preview"
    });
    vi.mocked(verifyVercelOidcToken).mockResolvedValue(verified({}, previewSource));

    const capability = await createVercelTrustedSourcesInvocationAuth({
      trustedSource: previewSource
    }).authorize(proof(), new AbortController().signal);

    expect(
      isVerifiedOrganizerInvocation(capability, { requestId: "request-1", runtime: "preview" })
    ).toBe(true);
    expect(
      isVerifiedOrganizerInvocation(capability, { requestId: "request-1", runtime: "production" })
    ).toBe(false);
    expect(verifyVercelOidcToken).toHaveBeenCalledWith(
      token,
      expect.objectContaining({
        environment: "preview",
        subject: previewSource.expectedSubject
      })
    );
  });

  it.each([
    ["algorithm", {}, { alg: "HS256" }],
    ["issuer", { iss: "https://attacker.test" }, undefined],
    ["audience", { aud: "wrong" }, undefined],
    ["subject", { sub: "wrong" }, undefined],
    ["owner", { owner: "wrong" }, undefined],
    ["project", { project_id: "prj_wrong" }, undefined],
    ["expired", { exp: 1 }, undefined],
    ["future", { iat: Math.floor(Date.now() / 1_000) + 100 }, undefined]
  ])("rejects %s claim drift", async (_label, payload, header) => {
    const result = verified(payload);
    if (header !== undefined) result.protectedHeader = header;
    vi.mocked(verifyVercelOidcToken).mockResolvedValue(result);
    await expect(
      createVercelTrustedSourcesInvocationAuth({ trustedSource: trusted }).authorize(
        proof(),
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("turns verifier failure into unauthorized and abort into unavailable", async () => {
    const adapter = createVercelTrustedSourcesInvocationAuth({ trustedSource: trusted });
    vi.mocked(verifyVercelOidcToken).mockRejectedValueOnce(new Error("signature detail"));
    await expect(adapter.authorize(proof(), new AbortController().signal)).rejects.toMatchObject({
      code: "unauthorized"
    });

    let settle!: () => void;
    vi.mocked(verifyVercelOidcToken).mockReturnValueOnce(
      new Promise((resolve) => {
        settle = () => resolve(verified());
      })
    );
    const controller = new AbortController();
    const pending = adapter.authorize(proof(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(OrganizerUnavailableError);
    settle();
  });

  it("keeps the production adapter fail closed when unconfigured", async () => {
    await expect(
      unconfiguredProductionInvocationAuth.authorize(proof(), new AbortController().signal)
    ).rejects.toBeInstanceOf(OrganizerUnavailableError);
  });
  it("logs a content-free rejection reason naming the failing claims only", async () => {
    const sink = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const adapter = createVercelTrustedSourcesInvocationAuth({ trustedSource: trusted });
      vi.mocked(verifyVercelOidcToken).mockResolvedValueOnce(
        verified({ environment: "development", owner_id: "team_other" })
      );
      await expect(adapter.authorize(proof(), new AbortController().signal)).rejects.toMatchObject({
        code: "unauthorized"
      });
      expect(sink).toHaveBeenCalledTimes(1);
      const line = String(sink.mock.calls[0]?.[0]);
      expect(JSON.parse(line)).toEqual({
        event: "organizer.trusted_source_rejected",
        service: "unfiled-organizer",
        reason: "claims:owner_id,environment"
      });
      expect(line).not.toContain(token);
      expect(line).not.toContain("team_other");
      expect(line).not.toContain("development");
      const failure = Object.assign(new Error("signature verification failed"), {
        code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED"
      });
      vi.mocked(verifyVercelOidcToken).mockRejectedValueOnce(failure);
      await expect(adapter.authorize(proof(), new AbortController().signal)).rejects.toMatchObject({
        code: "unauthorized"
      });
      expect(JSON.parse(String(sink.mock.calls[1]?.[0]))).toMatchObject({
        reason: "verification:ERR_JWS_SIGNATURE_VERIFICATION_FAILED"
      });
      await expect(
        adapter.authorize(
          proof({ authorizationHeader: "Bearer ambient" }),
          new AbortController().signal
        )
      ).rejects.toMatchObject({ code: "unauthorized" });
      expect(JSON.parse(String(sink.mock.calls[2]?.[0]))).toMatchObject({ reason: "proof_shape" });
    } finally {
      sink.mockRestore();
    }
  });
});
