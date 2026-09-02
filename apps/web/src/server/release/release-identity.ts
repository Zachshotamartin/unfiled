import { createHash } from "node:crypto";

export type WebReleaseIdentityEnvironment = Readonly<Record<string, string | undefined>>;

export type WebReleaseIdentity = Readonly<{
  commit: string;
  deployment: `sha256:${string}`;
  environment: "preview" | "production";
}>;

export class WebReleaseIdentityConfigurationError extends Error {
  public constructor() {
    super("Vercel release identity is incomplete or invalid.");
    this.name = "WebReleaseIdentityConfigurationError";
  }
}

export function loadWebReleaseIdentity(
  environment: WebReleaseIdentityEnvironment = process.env
): WebReleaseIdentity | null {
  const hasManagedIdentity =
    environment.VERCEL !== undefined ||
    environment.VERCEL_ENV !== undefined ||
    environment.VERCEL_DEPLOYMENT_ID !== undefined ||
    environment.VERCEL_GIT_COMMIT_SHA !== undefined;
  if (!hasManagedIdentity) return null;

  const deploymentId = environment.VERCEL_DEPLOYMENT_ID?.trim();
  const commit = environment.VERCEL_GIT_COMMIT_SHA;
  const selectedEnvironment = environment.VERCEL_ENV;
  if (
    environment.VERCEL !== "1" ||
    (selectedEnvironment !== "preview" && selectedEnvironment !== "production") ||
    deploymentId === undefined ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(deploymentId) ||
    commit === undefined ||
    !/^[0-9a-f]{40}$/u.test(commit)
  ) {
    throw new WebReleaseIdentityConfigurationError();
  }

  return Object.freeze({
    commit,
    deployment: `sha256:${createHash("sha256").update(deploymentId, "utf8").digest("hex")}`,
    environment: selectedEnvironment
  });
}

export function releaseIdentityHeaderEntries(
  identity: WebReleaseIdentity | null
): readonly Readonly<{ key: string; value: string }>[] {
  if (identity === null) return [];
  return Object.freeze([
    Object.freeze({ key: "x-unfiled-deployment", value: identity.deployment }),
    Object.freeze({ key: "x-unfiled-commit", value: identity.commit }),
    Object.freeze({ key: "x-unfiled-environment", value: identity.environment })
  ]);
}

export function releaseIdentityHeaders(identity: WebReleaseIdentity | null): Headers {
  const headers = new Headers({ "cache-control": "no-store" });
  for (const { key, value } of releaseIdentityHeaderEntries(identity)) headers.set(key, value);
  return headers;
}
