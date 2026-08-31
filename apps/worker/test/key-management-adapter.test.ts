import { describe, expect, it } from "vitest";

import type { WorkerConfig } from "../src/config";
import { authorizeLocalWorkerInvocation } from "../src/invocation-auth-adapter";
import {
  createWorkerKeyManagementAdapter,
  isAiAssistedKeyAuthority,
  isAwsWorkerBoundary,
  oidcTokenFromRequest,
  unconfiguredKeyManagementAdapter
} from "../src/key-management-adapter";

const localBoundary: WorkerConfig["keyBoundary"] = {
  kind: "local-synthetic",
  keyClass: "ai_assisted"
};

const awsBoundary: WorkerConfig["keyBoundary"] = {
  aiContentMacKmsKeyArn:
    "arn:aws:kms:us-west-2:123456789012:key/66666666-7777-4888-9999-aaaaaaaaaaaa",
  aiObjectWrapKmsKeyArn:
    "arn:aws:kms:us-west-2:123456789012:key/11111111-2222-4333-8444-555555555555",
  expectedOidcSubject: "owner:team-example:project:unfiled-worker:environment:production",
  kind: "aws-oidc",
  keyClass: "ai_assisted",
  oidcAudience: "sts.amazonaws.com",
  region: "us-west-2",
  retiredRoots: { ai_assisted: { content_mac: [], object_wrap: [] } },
  roleArn: "arn:aws:iam::123456789012:role/unfiled-worker-production",
  vercelProjectId: "prj_example"
};

function localInvocation(requestId = "request-1") {
  return authorizeLocalWorkerInvocation({
    authorizationHeader: "Bearer worker-only-drain-secret-with-adequate-length",
    requestId,
    runtime: "local",
    secret: "worker-only-drain-secret-with-adequate-length"
  });
}

describe("worker key-management seam", () => {
  it("does not admit OIDC proof or structurally forged authority into local custody", async () => {
    const request = new Request("https://worker.test/internal/drain", {
      headers: { "x-vercel-oidc-token": "header.payload.signature" }
    });
    expect(oidcTokenFromRequest(request, localBoundary)).toBeUndefined();
    expect(isAwsWorkerBoundary(localBoundary)).toBe(false);
    expect(isAiAssistedKeyAuthority({ custody: "local-synthetic", keyClass: "ai_assisted" })).toBe(
      false
    );
    expect(isAiAssistedKeyAuthority(null)).toBe(false);

    const adapter = createWorkerKeyManagementAdapter();
    let issued: unknown;
    await adapter.withAiAssistedAuthority(
      localBoundary,
      {
        invocation: localInvocation(),
        oidcToken: undefined,
        requestId: "request-1",
        runtime: "local"
      },
      new AbortController().signal,
      (authority) => {
        issued = authority;
        expect(isAiAssistedKeyAuthority(authority)).toBe(true);
        expect(Object.keys(authority)).toEqual([]);
        return Promise.resolve();
      }
    );
    expect(isAiAssistedKeyAuthority(issued)).toBe(false);
  });

  it("extracts only a bounded JWT-shaped runtime OIDC token for AWS", () => {
    const token = "header.payload.signature";
    expect(
      oidcTokenFromRequest(
        new Request("https://worker.test/internal/drain", {
          headers: { "x-vercel-oidc-token": token }
        }),
        awsBoundary
      )
    ).toBe(token);
    expect(isAwsWorkerBoundary(awsBoundary)).toBe(true);

    for (const invalid of [undefined, "not-a-jwt", `a.${"x".repeat(17_000)}.c`]) {
      const headers = invalid === undefined ? {} : { "x-vercel-oidc-token": invalid };
      expect(() =>
        oidcTokenFromRequest(
          new Request("https://worker.test/internal/drain", { headers }),
          awsBoundary
        )
      ).toThrow(/ready/u);
    }
  });

  it("ships with a fail-closed custody adapter", async () => {
    await expect(
      unconfiguredKeyManagementAdapter.withAiAssistedAuthority(
        localBoundary,
        {
          invocation: localInvocation(),
          oidcToken: undefined,
          requestId: "request-1",
          runtime: "local"
        },
        new AbortController().signal,
        () => Promise.resolve()
      )
    ).rejects.toMatchObject({ code: "provider_unavailable", status: 503 });
  });
});
