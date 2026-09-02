import { describe, expect, it } from "vitest";

import {
  loadWebReleaseIdentity,
  releaseIdentityHeaderEntries,
  releaseIdentityHeaders,
  WebReleaseIdentityConfigurationError
} from "./release-identity";

describe("web release identity", () => {
  it("keeps local execution unlabelled", () => {
    expect(loadWebReleaseIdentity({})).toBeNull();
    expect([...releaseIdentityHeaders(null)]).toEqual([["cache-control", "no-store"]]);
  });

  it.each(["preview", "production"] as const)(
    "emits a hashed deployment and exact %s commit/environment",
    (environment) => {
      const identity = loadWebReleaseIdentity({
        VERCEL: "1",
        VERCEL_DEPLOYMENT_ID: "  dpl_webproduction123  ",
        VERCEL_ENV: environment,
        VERCEL_GIT_COMMIT_SHA: "e".repeat(40)
      });
      expect(identity).toEqual({
        commit: "e".repeat(40),
        deployment: "sha256:af6d2a64977f628346e979b3113511302f3148e144d66af5c318214a18a2e224",
        environment
      });
      const headers = releaseIdentityHeaders(identity);
      expect(headers.get("x-unfiled-deployment")).toBe(identity?.deployment);
      expect(headers.get("x-unfiled-commit")).toBe(identity?.commit);
      expect(headers.get("x-unfiled-environment")).toBe(environment);
      expect(JSON.stringify([...headers])).not.toContain("dpl_");
      expect(releaseIdentityHeaderEntries(identity)).toEqual([
        { key: "x-unfiled-deployment", value: identity?.deployment },
        { key: "x-unfiled-commit", value: identity?.commit },
        { key: "x-unfiled-environment", value: environment }
      ]);
    }
  );

  it("accepts Vercel's supported custom deployment-ID alphabet", () => {
    expect(
      loadWebReleaseIdentity({
        VERCEL: "1",
        VERCEL_DEPLOYMENT_ID: "custom-build_20260902",
        VERCEL_ENV: "preview",
        VERCEL_GIT_COMMIT_SHA: "e".repeat(40)
      })
    ).toMatchObject({
      deployment: "sha256:57e70825bba59d28e7ee226e812f82700db241025d9f864f2fb5b54e19551dc2"
    });
  });

  it.each([
    { VERCEL: "1", VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_SHA: "e".repeat(40) },
    {
      VERCEL: "1",
      VERCEL_DEPLOYMENT_ID: "unsafe/value",
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_SHA: "e".repeat(40)
    },
    {
      VERCEL: "1",
      VERCEL_DEPLOYMENT_ID: "dpl_webproduction123",
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_SHA: "E".repeat(40)
    },
    {
      VERCEL: "1",
      VERCEL_DEPLOYMENT_ID: "dpl_webproduction123",
      VERCEL_ENV: "development",
      VERCEL_GIT_COMMIT_SHA: "e".repeat(40)
    },
    { VERCEL_DEPLOYMENT_ID: "dpl_webproduction123" }
  ])("fails closed for incomplete or invalid managed identity %#", (environment) => {
    expect(() => loadWebReleaseIdentity(environment)).toThrow(WebReleaseIdentityConfigurationError);
  });
});
