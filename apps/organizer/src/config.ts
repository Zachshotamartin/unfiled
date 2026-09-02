import { createHash } from "node:crypto";
import { LOCAL_HASH_EMBEDDING_DIMENSIONS, LOCAL_HASH_EMBEDDING_MODEL_ID } from "@unfiled/search";

import { OrganizerConfigurationError } from "./errors.js";

const DEFAULT_PORT = 8_790;
const DEFAULT_TIMEOUT_MS = 49_000;
const DEFAULT_MAX_REQUEST_BYTES = 1_024;
const MAX_DATABASE_CA_BYTES = 32_768;
const MAX_DATABASE_URL_LENGTH = 4_096;
const MAX_RETIRED_ROOTS = 20;
const MAX_RETIRED_REGISTRY_BYTES = 32_768;
const ORGANIZER_OPENAI_API_KEY = "UNFILED_ORGANIZER_OPENAI_API_KEY" as const;
const KEY_CUSTODIAN_VARIABLE = "UNFILED_KEY_CUSTODIAN" as const;
const VERCEL_SENSITIVE_KEY_RING_VARIABLE = "UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1" as const;
const VERCEL_OBJECT_WRAP_ROOT_VARIABLE = "UNFILED_ORGANIZER_AI_OBJECT_WRAP_ROOT_KEY_ID" as const;
const VERCEL_CONTENT_MAC_ROOT_VARIABLE = "UNFILED_ORGANIZER_AI_CONTENT_MAC_ROOT_KEY_ID" as const;
const VERCEL_RETIRED_OBJECT_WRAP_ROOTS_VARIABLE =
  "UNFILED_ORGANIZER_RETIRED_AI_OBJECT_WRAP_ROOT_KEY_IDS_JSON" as const;
const VERCEL_RETIRED_CONTENT_MAC_ROOTS_VARIABLE =
  "UNFILED_ORGANIZER_RETIRED_AI_CONTENT_MAC_ROOT_KEY_IDS_JSON" as const;
const KMS_KEY_ARN_PATTERN =
  /^arn:(aws(?:-us-gov|-cn)?):kms:([a-z0-9-]+):(\d{12}):key\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const VERCEL_ROOT_KEY_ID_PATTERN =
  /^urn:unfiled:key-root:vercel-sensitive-env-v1:(preview|production):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const AWS_OIDC_AUDIENCE = "sts.amazonaws.com" as const;
export const VERCEL_OIDC_ISSUER_ORIGIN = "https://oidc.vercel.com" as const;
export const VERCEL_OIDC_AUDIENCE_ORIGIN = "https://vercel.com" as const;

const STATIC_AWS_CREDENTIALS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SECURITY_TOKEN",
  "AWS_PROFILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_SESSION_TOKEN"
] as const;
const PRIVATE_CAPABILITIES = [
  "UNFILED_PRIVATE_CONTENT_MAC_KMS_KEY_ARN",
  "UNFILED_PRIVATE_OBJECT_WRAP_KMS_KEY_ARN",
  "UNFILED_PRIVATE_KMS_KEY_ARN",
  "UNFILED_PRIVATE_MANUAL_KEK_B64URL"
] as const;
const USER_SESSION_CAPABILITIES = [
  "AUTH_SECRET",
  "NEXTAUTH_SECRET",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_ANON_KEY"
] as const;
const PROVIDER_CAPABILITIES = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "UNFILED_ANTHROPIC_API_KEY",
  "UNFILED_OPENAI_API_KEY",
  "UNFILED_ORGANIZATION_MODEL_API_KEY"
] as const;
const PROVIDER_CONFIGURATION_PATTERN =
  /(?:ANTHROPIC|OPENAI|BYOK|ORGANIZATION_MODEL|ORGANIZER_MODEL)/iu;
const GENERIC_DATABASE_CAPABILITY_PATTERN =
  /^(?:DATABASE_(?:URL|URI)(?:_[A-Z0-9]+)*|POSTGRES(?:QL)?_[A-Z0-9_]+|PG(?:DATABASE|HOST|PASSFILE|PASSWORD|PORT|SERVICE|SERVICEFILE|USER)(?:_[A-Z0-9]+)*)$/iu;
const SUPABASE_CAPABILITY_PATTERN = /SUPABASE/iu;

export type OrganizerRuntime = "local" | "preview" | "production";
export type OrganizerEnvironment = Readonly<Record<string, string | undefined>>;
export type OrganizerReleaseIdentity = Readonly<{
  commit: string;
  deployment: `sha256:${string}`;
  environment: "preview" | "production";
}>;
export type OrganizerRetiredRoots = Readonly<{
  ai_assisted: Readonly<{
    content_mac: readonly string[];
    object_wrap: readonly string[];
  }>;
}>;
export type LocalOrganizerKeyBoundary = Readonly<{
  kind: "local-synthetic";
  keyClass: "ai_assisted";
}>;
export type AwsOrganizerKeyBoundary = Readonly<{
  aiContentMacKmsKeyArn: string;
  aiObjectWrapKmsKeyArn: string;
  expectedOidcSubject: string;
  kind: "aws-oidc";
  keyClass: "ai_assisted";
  oidcAudience: typeof AWS_OIDC_AUDIENCE;
  region: string;
  retiredRoots: OrganizerRetiredRoots;
  roleArn: string;
  vercelProjectId: string;
}>;
export type VercelSensitiveEnvironmentOrganizerKeyBoundary = Readonly<{
  aiContentMacRootKeyId: string;
  aiObjectWrapRootKeyId: string;
  deploymentEnvironment: "preview" | "production";
  kind: "vercel-sensitive-env-v1";
  keyClass: "ai_assisted";
  retiredRoots: OrganizerRetiredRoots;
  vercelProjectId: string;
}>;
export type OrganizerKeyBoundary =
  | LocalOrganizerKeyBoundary
  | AwsOrganizerKeyBoundary
  | VercelSensitiveEnvironmentOrganizerKeyBoundary;
export type VercelTrustedSource = Readonly<{
  audience: string;
  environment: "preview" | "production";
  expectedSubject: string;
  issuer: string;
  ownerId: string;
  projectId: string;
  projectName: string;
  teamSlug: string;
}>;
export type OrganizerInvocationAuth =
  | Readonly<{ kind: "bearer"; secret: string }>
  | Readonly<{ kind: "production-trusted-source"; trustedSource: VercelTrustedSource }>;
export type OrganizerPipelineConfig =
  | Readonly<{ kind: "disabled" }>
  | Readonly<{
      claimLimit: number;
      concurrency: number;
      database: Readonly<{
        caPem: string;
        connectTimeoutMs: number;
        expectedHost: string;
        projectRef: string;
        statementTimeoutMs: number;
        url: string;
      }>;
      kind: "enabled";
      leaseSeconds: number;
      recoveryLimit: number;
    }>;
/**
 * Managed runtimes always route through the lease-bound provider registry.
 * The operator-funded OpenAI key is optional: the free BYOK-only beta runs
 * with an empty app-default record, so app-default jobs fail closed: the capture stays saved
 * and marked failed with provider_unavailable until the owner saves a key and retries.
 */
export type OrganizerPlannerConfig =
  | Readonly<{ kind: "disabled" }>
  | Readonly<{
      appDefaultApiKeys: Readonly<{ openai?: string }>;
      kind: "lease-bound-provider-registry-v2";
    }>;
export type OrganizerEmbeddingConfig =
  | Readonly<{ kind: "disabled" }>
  | Readonly<{ kind: "openai" }>
  | Readonly<{
      dimensions: typeof LOCAL_HASH_EMBEDDING_DIMENSIONS;
      kind: "local-hash-v1";
      modelId: typeof LOCAL_HASH_EMBEDDING_MODEL_ID;
    }>;
export type OrganizerConfig = Readonly<{
  embedding: OrganizerEmbeddingConfig;
  invocationAuth: OrganizerInvocationAuth;
  keyBoundary: OrganizerKeyBoundary;
  maxRequestBytes: number;
  pipeline: OrganizerPipelineConfig;
  planner: OrganizerPlannerConfig;
  port: number;
  releaseIdentity: OrganizerReleaseIdentity | null;
  requestTimeoutMs: number;
  runtime: OrganizerRuntime;
}>;

export const ORGANIZER_CAPABILITIES = Object.freeze({
  acceptsUserSessions: false,
  decryptKeyClasses: ["ai_assisted"] as const,
  decryptKeyPurposes: ["content_mac", "object_wrap"] as const,
  generateDataKeyClasses: ["ai_assisted"] as const,
  generateDataKeyPurposes: ["content_mac", "object_wrap"] as const,
  productionPlannerConfigured: true,
  providerRegistryVersion: "organization-model-registry-v2" as const,
  providers: ["openai", "anthropic"] as const,
  requiresAppDefaultProviderKey: false,
  rendersUserInterface: false
});

function hasValue(environment: OrganizerEnvironment, name: string): boolean {
  return (environment[name]?.trim().length ?? 0) > 0;
}

function rejectCapabilities(environment: OrganizerEnvironment, names: readonly string[]): void {
  const present = names.filter((name) => hasValue(environment, name));
  if (present.length > 0) throw new OrganizerConfigurationError(present);
}

function rejectUnapprovedProviderConfiguration(environment: OrganizerEnvironment): void {
  const present = Object.keys(environment).filter(
    (name) =>
      name !== ORGANIZER_OPENAI_API_KEY &&
      PROVIDER_CONFIGURATION_PATTERN.test(name) &&
      hasValue(environment, name)
  );
  if (present.length > 0) throw new OrganizerConfigurationError(present);
}

function rejectAmbientDatabaseCapabilities(environment: OrganizerEnvironment): void {
  const present = Object.keys(environment).filter(
    (name) =>
      (SUPABASE_CAPABILITY_PATTERN.test(name) || GENERIC_DATABASE_CAPABILITY_PATTERN.test(name)) &&
      hasValue(environment, name)
  );
  if (present.length > 0) throw new OrganizerConfigurationError(present);
}

function required(environment: OrganizerEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) throw new OrganizerConfigurationError([name]);
  return value;
}

function hasUnsafeSecretCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x20 || codeUnit === 0x7f) return true;
  }
  return false;
}

function planner(
  environment: OrganizerEnvironment,
  selectedRuntime: OrganizerRuntime
): OrganizerPlannerConfig {
  const raw = environment[ORGANIZER_OPENAI_API_KEY];
  if (selectedRuntime === "local") {
    if (hasValue(environment, ORGANIZER_OPENAI_API_KEY))
      throw new OrganizerConfigurationError([ORGANIZER_OPENAI_API_KEY]);
    return Object.freeze({ kind: "disabled" });
  }
  if (raw === undefined || raw.length === 0) {
    return Object.freeze({
      appDefaultApiKeys: Object.freeze({}),
      kind: "lease-bound-provider-registry-v2"
    });
  }
  if (raw.length < 20 || raw.length > 512 || raw.trim() !== raw || hasUnsafeSecretCharacter(raw)) {
    throw new OrganizerConfigurationError([ORGANIZER_OPENAI_API_KEY]);
  }
  return Object.freeze({
    appDefaultApiKeys: Object.freeze({ openai: raw }),
    kind: "lease-bound-provider-registry-v2"
  });
}

function embedding(
  environment: OrganizerEnvironment,
  selectedRuntime: OrganizerRuntime
): OrganizerEmbeddingConfig {
  const name = "UNFILED_ORGANIZER_EMBEDDING_PROVIDER";
  if (selectedRuntime === "local") {
    if (hasValue(environment, name)) throw new OrganizerConfigurationError([name]);
    return Object.freeze({ kind: "disabled" });
  }
  const selected = required(environment, name);
  if (selected === "openai") return Object.freeze({ kind: "openai" });
  if (selected === "local-hash-v1") {
    return Object.freeze({
      dimensions: LOCAL_HASH_EMBEDDING_DIMENSIONS,
      kind: "local-hash-v1",
      modelId: LOCAL_HASH_EMBEDDING_MODEL_ID
    });
  }
  throw new OrganizerConfigurationError([name]);
}

function integer(
  environment: OrganizerEnvironment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = environment[name]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  if (!/^\d+$/u.test(raw)) throw new OrganizerConfigurationError([name]);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new OrganizerConfigurationError([name]);
  }
  return parsed;
}

function runtime(environment: OrganizerEnvironment): OrganizerRuntime {
  const value = required(environment, "UNFILED_ORGANIZER_ENV");
  if (value !== "local" && value !== "preview" && value !== "production") {
    throw new OrganizerConfigurationError(["UNFILED_ORGANIZER_ENV"]);
  }
  const vercel = environment.VERCEL_ENV?.trim();
  if (
    (value === "local" &&
      (environment.VERCEL !== undefined || environment.VERCEL_ENV !== undefined)) ||
    (value !== "local" && (environment.VERCEL !== "1" || vercel !== value))
  ) {
    throw new OrganizerConfigurationError(["UNFILED_ORGANIZER_ENV", "VERCEL_ENV"]);
  }
  return value;
}

function releaseIdentity(
  environment: OrganizerEnvironment,
  selectedRuntime: OrganizerRuntime
): OrganizerReleaseIdentity | null {
  if (selectedRuntime === "local") {
    rejectCapabilities(environment, ["VERCEL_DEPLOYMENT_ID", "VERCEL_GIT_COMMIT_SHA"]);
    return null;
  }
  const deploymentId = environment.VERCEL_DEPLOYMENT_ID?.trim();
  const commit = environment.VERCEL_GIT_COMMIT_SHA;
  const invalid: string[] = [];
  if (deploymentId === undefined || !/^[A-Za-z0-9_-]{1,128}$/u.test(deploymentId)) {
    invalid.push("VERCEL_DEPLOYMENT_ID");
  }
  if (commit === undefined || !/^[0-9a-f]{40}$/u.test(commit)) {
    invalid.push("VERCEL_GIT_COMMIT_SHA");
  }
  if (invalid.length > 0 || deploymentId === undefined || commit === undefined) {
    throw new OrganizerConfigurationError(invalid);
  }
  return Object.freeze({
    commit,
    deployment: `sha256:${createHash("sha256").update(deploymentId, "utf8").digest("hex")}`,
    environment: selectedRuntime
  });
}

function parsePem(environment: OrganizerEnvironment): string {
  const name = "UNFILED_ORGANIZER_DATABASE_CA_PEM_BASE64";
  const encoded = required(environment, name);
  if (
    encoded.length > Math.ceil((MAX_DATABASE_CA_BYTES * 4) / 3) + 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)
  ) {
    throw new OrganizerConfigurationError([name]);
  }
  const bytes = Buffer.from(encoded, "base64");
  const canonical = bytes.toString("base64").replace(/=+$/u, "");
  const pem = bytes.toString("utf8");
  bytes.fill(0);
  if (
    canonical !== encoded.replace(/=+$/u, "") ||
    !pem.startsWith("-----BEGIN CERTIFICATE-----\n") ||
    !pem.endsWith("-----END CERTIFICATE-----\n") ||
    new TextEncoder().encode(pem).byteLength > MAX_DATABASE_CA_BYTES
  ) {
    throw new OrganizerConfigurationError([name]);
  }
  return pem;
}

function parseRetiredRoots(
  environment: OrganizerEnvironment,
  expected: Readonly<{
    accountId: string;
    partition: string;
    region: string;
    active: readonly string[];
  }>
): OrganizerRetiredRoots {
  function parse(name: string): readonly string[] {
    const raw = environment[name]?.trim() ?? "[]";
    if (new TextEncoder().encode(raw).byteLength > MAX_RETIRED_REGISTRY_BYTES) {
      throw new OrganizerConfigurationError([name]);
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new OrganizerConfigurationError([name]);
    }
    if (!Array.isArray(value) || value.length > MAX_RETIRED_ROOTS) {
      throw new OrganizerConfigurationError([name]);
    }
    const seen = new Set<string>();
    for (const entry of value) {
      const match = typeof entry === "string" ? KMS_KEY_ARN_PATTERN.exec(entry) : null;
      if (
        match?.[1] !== expected.partition ||
        match[2] !== expected.region ||
        match[3] !== expected.accountId ||
        expected.active.includes(String(entry)) ||
        typeof entry !== "string" ||
        seen.has(entry)
      )
        throw new OrganizerConfigurationError([name]);
      seen.add(entry);
    }
    return Object.freeze([...seen]);
  }
  return Object.freeze({
    ai_assisted: Object.freeze({
      content_mac: parse("UNFILED_ORGANIZER_RETIRED_AI_CONTENT_MAC_ROOTS_JSON"),
      object_wrap: parse("UNFILED_ORGANIZER_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON")
    })
  });
}

function awsBoundary(
  environment: OrganizerEnvironment,
  selectedRuntime: "preview" | "production"
): AwsOrganizerKeyBoundary {
  const region = required(environment, "UNFILED_AWS_REGION");
  const roleArn = required(environment, "UNFILED_AWS_ROLE_ARN");
  const objectArn = required(environment, "UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN");
  const macArn = required(environment, "UNFILED_AI_CONTENT_MAC_KMS_KEY_ARN");
  const subject = required(environment, "UNFILED_ORGANIZER_EXPECTED_OIDC_SUBJECT");
  const projectId = required(environment, "UNFILED_ORGANIZER_PROJECT_ID");
  const role = /^arn:(aws(?:-us-gov|-cn)?):iam::(\d{12}):role\/[A-Za-z0-9+=,.@_/-]+$/u.exec(
    roleArn
  );
  const objectMatch = KMS_KEY_ARN_PATTERN.exec(objectArn);
  const macMatch = KMS_KEY_ARN_PATTERN.exec(macArn);
  const invalid: string[] = [];
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u.test(region)) invalid.push("UNFILED_AWS_REGION");
  if (role === null) invalid.push("UNFILED_AWS_ROLE_ARN");
  if (objectMatch === null) invalid.push("UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN");
  if (macMatch === null || macArn === objectArn) invalid.push("UNFILED_AI_CONTENT_MAC_KMS_KEY_ARN");
  const subjectMatch = /^owner:([^:]+):project:([^:]+):environment:(preview|production)$/u.exec(
    subject
  );
  if (
    !/^[A-Za-z0-9_./:@-]{1,512}$/u.test(subject) ||
    subjectMatch?.[3] !== selectedRuntime ||
    subject.includes(":project:prj_")
  )
    invalid.push("UNFILED_ORGANIZER_EXPECTED_OIDC_SUBJECT");
  if (!/^prj_[A-Za-z0-9]+$/u.test(projectId) || environment.VERCEL_PROJECT_ID?.trim() !== projectId)
    invalid.push("UNFILED_ORGANIZER_PROJECT_ID", "VERCEL_PROJECT_ID");
  for (const match of [objectMatch, macMatch]) {
    if (
      role !== null &&
      match !== null &&
      (role[1] !== match[1] || role[2] !== match[3] || region !== match[2])
    )
      invalid.push("UNFILED_AWS_ROLE_ARN", "UNFILED_AWS_REGION");
  }
  if (invalid.length > 0 || role === null)
    throw new OrganizerConfigurationError([...new Set(invalid)]);
  const partition = role[1];
  const accountId = role[2];
  if (partition === undefined || accountId === undefined)
    throw new OrganizerConfigurationError(["UNFILED_AWS_ROLE_ARN"]);
  return Object.freeze({
    aiContentMacKmsKeyArn: macArn,
    aiObjectWrapKmsKeyArn: objectArn,
    expectedOidcSubject: subject,
    kind: "aws-oidc",
    keyClass: "ai_assisted",
    oidcAudience: AWS_OIDC_AUDIENCE,
    region,
    retiredRoots: parseRetiredRoots(environment, {
      accountId,
      partition,
      region,
      active: [objectArn, macArn]
    }),
    roleArn,
    vercelProjectId: projectId
  });
}

function exactSensitiveValue(environment: OrganizerEnvironment, name: string): string {
  const raw = environment[name];
  if (raw === undefined || raw.length === 0 || raw.trim() !== raw) {
    throw new OrganizerConfigurationError([name]);
  }
  return raw;
}

function parseVercelRetiredRoots(
  environment: OrganizerEnvironment,
  selectedRuntime: "preview" | "production",
  activeRoots: readonly string[]
): OrganizerRetiredRoots {
  function parse(name: string): readonly string[] {
    const raw = environment[name] ?? "[]";
    if (
      raw.trim() !== raw ||
      new TextEncoder().encode(raw).byteLength > MAX_RETIRED_REGISTRY_BYTES
    ) {
      throw new OrganizerConfigurationError([name]);
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new OrganizerConfigurationError([name]);
    }
    if (
      !Array.isArray(value) ||
      value.length > MAX_RETIRED_ROOTS ||
      JSON.stringify(value) !== raw
    ) {
      throw new OrganizerConfigurationError([name]);
    }
    const roots: string[] = [];
    const seen = new Set(activeRoots);
    for (const entry of value) {
      if (
        typeof entry !== "string" ||
        VERCEL_ROOT_KEY_ID_PATTERN.exec(entry)?.[1] !== selectedRuntime ||
        seen.has(entry)
      ) {
        throw new OrganizerConfigurationError([name]);
      }
      seen.add(entry);
      roots.push(entry);
    }
    return Object.freeze(roots);
  }
  return Object.freeze({
    ai_assisted: Object.freeze({
      content_mac: parse(VERCEL_RETIRED_CONTENT_MAC_ROOTS_VARIABLE),
      object_wrap: parse(VERCEL_RETIRED_OBJECT_WRAP_ROOTS_VARIABLE)
    })
  });
}

function vercelSensitiveEnvironmentBoundary(
  environment: OrganizerEnvironment,
  selectedRuntime: "preview" | "production"
): VercelSensitiveEnvironmentOrganizerKeyBoundary {
  const projectId = exactSensitiveValue(environment, "UNFILED_ORGANIZER_PROJECT_ID");
  const objectRootKeyId = exactSensitiveValue(environment, VERCEL_OBJECT_WRAP_ROOT_VARIABLE);
  const contentMacRootKeyId = exactSensitiveValue(environment, VERCEL_CONTENT_MAC_ROOT_VARIABLE);
  const ring = exactSensitiveValue(environment, VERCEL_SENSITIVE_KEY_RING_VARIABLE);
  const invalid: string[] = [];
  if (!/^prj_[A-Za-z0-9]+$/u.test(projectId) || environment.VERCEL_PROJECT_ID !== projectId) {
    invalid.push("UNFILED_ORGANIZER_PROJECT_ID", "VERCEL_PROJECT_ID");
  }
  if (VERCEL_ROOT_KEY_ID_PATTERN.exec(objectRootKeyId)?.[1] !== selectedRuntime) {
    invalid.push(VERCEL_OBJECT_WRAP_ROOT_VARIABLE);
  }
  if (
    VERCEL_ROOT_KEY_ID_PATTERN.exec(contentMacRootKeyId)?.[1] !== selectedRuntime ||
    contentMacRootKeyId === objectRootKeyId
  ) {
    invalid.push(VERCEL_CONTENT_MAC_ROOT_VARIABLE);
  }
  if (new TextEncoder().encode(ring).byteLength > 32_768) {
    invalid.push(VERCEL_SENSITIVE_KEY_RING_VARIABLE);
  }
  if (invalid.length > 0) throw new OrganizerConfigurationError([...new Set(invalid)]);
  return Object.freeze({
    aiContentMacRootKeyId: contentMacRootKeyId,
    aiObjectWrapRootKeyId: objectRootKeyId,
    deploymentEnvironment: selectedRuntime,
    kind: "vercel-sensitive-env-v1",
    keyClass: "ai_assisted",
    retiredRoots: parseVercelRetiredRoots(environment, selectedRuntime, [
      objectRootKeyId,
      contentMacRootKeyId
    ]),
    vercelProjectId: projectId
  });
}

function managedKeyBoundary(
  environment: OrganizerEnvironment,
  selectedRuntime: "preview" | "production"
): AwsOrganizerKeyBoundary | VercelSensitiveEnvironmentOrganizerKeyBoundary {
  const mode = exactSensitiveValue(environment, KEY_CUSTODIAN_VARIABLE);
  const awsOnly = [
    "UNFILED_AWS_REGION",
    "UNFILED_AWS_ROLE_ARN",
    "UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN",
    "UNFILED_AI_CONTENT_MAC_KMS_KEY_ARN",
    "UNFILED_ORGANIZER_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON",
    "UNFILED_ORGANIZER_RETIRED_AI_CONTENT_MAC_ROOTS_JSON",
    "UNFILED_ORGANIZER_EXPECTED_OIDC_SUBJECT"
  ] as const;
  const sensitiveOnly = [
    VERCEL_SENSITIVE_KEY_RING_VARIABLE,
    VERCEL_OBJECT_WRAP_ROOT_VARIABLE,
    VERCEL_CONTENT_MAC_ROOT_VARIABLE,
    VERCEL_RETIRED_OBJECT_WRAP_ROOTS_VARIABLE,
    VERCEL_RETIRED_CONTENT_MAC_ROOTS_VARIABLE
  ] as const;
  if (mode === "aws-kms") {
    rejectCapabilities(environment, sensitiveOnly);
    return awsBoundary(environment, selectedRuntime);
  }
  if (mode === "vercel-sensitive-env-v1") {
    rejectCapabilities(environment, awsOnly);
    return vercelSensitiveEnvironmentBoundary(environment, selectedRuntime);
  }
  throw new OrganizerConfigurationError([KEY_CUSTODIAN_VARIABLE]);
}

function trustedSource(
  environment: OrganizerEnvironment,
  organizerProjectId: string,
  selectedRuntime: "preview" | "production"
): VercelTrustedSource {
  const teamSlug = required(environment, "UNFILED_TRUSTED_SOURCE_TEAM_SLUG");
  const ownerId = required(environment, "UNFILED_TRUSTED_SOURCE_OWNER_ID");
  const projectId = required(environment, "UNFILED_TRUSTED_SOURCE_WEB_PROJECT_ID");
  const projectName = required(environment, "UNFILED_TRUSTED_SOURCE_WEB_PROJECT_NAME");
  const subject = required(environment, "UNFILED_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT");
  const expected = `owner:${teamSlug}:project:${projectName}:environment:${selectedRuntime}`;
  const invalid: string[] = [];
  if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u.test(teamSlug))
    invalid.push("UNFILED_TRUSTED_SOURCE_TEAM_SLUG");
  if (!/^team_[A-Za-z0-9]+$/u.test(ownerId)) invalid.push("UNFILED_TRUSTED_SOURCE_OWNER_ID");
  if (!/^prj_[A-Za-z0-9]+$/u.test(projectId) || projectId === organizerProjectId)
    invalid.push("UNFILED_TRUSTED_SOURCE_WEB_PROJECT_ID");
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/u.test(projectName))
    invalid.push("UNFILED_TRUSTED_SOURCE_WEB_PROJECT_NAME");
  if (subject !== expected) invalid.push("UNFILED_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT");
  if (invalid.length > 0) throw new OrganizerConfigurationError([...new Set(invalid)]);
  return Object.freeze({
    audience: `${VERCEL_OIDC_AUDIENCE_ORIGIN}/${teamSlug}`,
    environment: selectedRuntime,
    expectedSubject: subject,
    issuer: `${VERCEL_OIDC_ISSUER_ORIGIN}/${teamSlug}`,
    ownerId,
    projectId,
    projectName,
    teamSlug
  });
}

function pipeline(
  environment: OrganizerEnvironment,
  selectedRuntime: OrganizerRuntime
): OrganizerPipelineConfig {
  const names = [
    "UNFILED_ORGANIZER_DATABASE_URL",
    "UNFILED_ORGANIZER_DATABASE_EXPECTED_HOST",
    "UNFILED_ORGANIZER_DATABASE_PROJECT_REF",
    "UNFILED_ORGANIZER_DATABASE_CA_PEM_BASE64"
  ] as const;
  const present = names.filter((name) => hasValue(environment, name));
  if (selectedRuntime === "local") {
    if (present.length > 0) throw new OrganizerConfigurationError(present);
    return Object.freeze({ kind: "disabled" });
  }
  if (present.length !== names.length)
    throw new OrganizerConfigurationError(names.filter((name) => !hasValue(environment, name)));
  const url = required(environment, names[0]);
  const expectedHost = required(environment, names[1]).toLowerCase();
  const projectRef = required(environment, names[2]);
  const invalid: string[] = [];
  if (url.length > MAX_DATABASE_URL_LENGTH) invalid.push(names[0]);
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(expectedHost))
    invalid.push(names[1]);
  if (!/^[a-z0-9]{20}$/u.test(projectRef)) invalid.push(names[2]);
  if (invalid.length > 0) throw new OrganizerConfigurationError(invalid);
  const claimLimit = integer(environment, "UNFILED_ORGANIZER_CLAIM_LIMIT", 2, 1, 4);
  const concurrency = integer(environment, "UNFILED_ORGANIZER_CONCURRENCY", 2, 1, 4);
  if (concurrency > claimLimit)
    throw new OrganizerConfigurationError([
      "UNFILED_ORGANIZER_CONCURRENCY",
      "UNFILED_ORGANIZER_CLAIM_LIMIT"
    ]);
  return Object.freeze({
    claimLimit,
    concurrency,
    database: Object.freeze({
      caPem: parsePem(environment),
      connectTimeoutMs: integer(
        environment,
        "UNFILED_ORGANIZER_DATABASE_CONNECT_TIMEOUT_MS",
        3_000,
        500,
        15_000
      ),
      expectedHost,
      projectRef,
      statementTimeoutMs: integer(
        environment,
        "UNFILED_ORGANIZER_DATABASE_STATEMENT_TIMEOUT_MS",
        1_500,
        250,
        10_000
      ),
      url
    }),
    kind: "enabled",
    leaseSeconds: integer(environment, "UNFILED_ORGANIZER_LEASE_SECONDS", 120, 60, 900),
    recoveryLimit: integer(environment, "UNFILED_ORGANIZER_RECOVERY_LIMIT", 100, 1, 100)
  });
}

export function loadOrganizerConfig(
  environment: OrganizerEnvironment = process.env
): OrganizerConfig {
  rejectCapabilities(environment, STATIC_AWS_CREDENTIALS);
  rejectCapabilities(environment, PRIVATE_CAPABILITIES);
  rejectCapabilities(environment, USER_SESSION_CAPABILITIES);
  rejectCapabilities(environment, PROVIDER_CAPABILITIES);
  rejectUnapprovedProviderConfiguration(environment);
  rejectAmbientDatabaseCapabilities(environment);
  const selectedRuntime = runtime(environment);
  const selectedPlanner = planner(environment, selectedRuntime);
  const selectedEmbedding = embedding(environment, selectedRuntime);
  let keyBoundary: OrganizerKeyBoundary;
  if (selectedRuntime === "local") {
    rejectCapabilities(environment, [
      KEY_CUSTODIAN_VARIABLE,
      VERCEL_SENSITIVE_KEY_RING_VARIABLE,
      VERCEL_OBJECT_WRAP_ROOT_VARIABLE,
      VERCEL_CONTENT_MAC_ROOT_VARIABLE,
      VERCEL_RETIRED_OBJECT_WRAP_ROOTS_VARIABLE,
      VERCEL_RETIRED_CONTENT_MAC_ROOTS_VARIABLE,
      "UNFILED_AWS_REGION",
      "UNFILED_AWS_ROLE_ARN",
      "UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN",
      "UNFILED_AI_CONTENT_MAC_KMS_KEY_ARN",
      "UNFILED_ORGANIZER_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON",
      "UNFILED_ORGANIZER_RETIRED_AI_CONTENT_MAC_ROOTS_JSON",
      "UNFILED_ORGANIZER_EXPECTED_OIDC_SUBJECT",
      "UNFILED_ORGANIZER_PROJECT_ID"
    ]);
    keyBoundary = { kind: "local-synthetic", keyClass: "ai_assisted" };
  } else {
    keyBoundary = managedKeyBoundary(environment, selectedRuntime);
  }
  let invocationAuth: OrganizerInvocationAuth;
  if (selectedRuntime !== "local") {
    if (keyBoundary.kind === "local-synthetic") {
      throw new OrganizerConfigurationError([KEY_CUSTODIAN_VARIABLE]);
    }
    const forbidden = ["CRON_SECRET", "UNFILED_ORGANIZER_DRAIN_SECRET"].filter((name) =>
      hasValue(environment, name)
    );
    if (forbidden.length > 0) throw new OrganizerConfigurationError(forbidden);
    invocationAuth = {
      kind: "production-trusted-source",
      trustedSource: trustedSource(environment, keyBoundary.vercelProjectId, selectedRuntime)
    };
  } else {
    if (hasValue(environment, "CRON_SECRET"))
      throw new OrganizerConfigurationError(["CRON_SECRET"]);
    const secret = required(environment, "UNFILED_ORGANIZER_DRAIN_SECRET");
    if (secret.length < 32 || secret.length > 512)
      throw new OrganizerConfigurationError(["UNFILED_ORGANIZER_DRAIN_SECRET"]);
    invocationAuth = { kind: "bearer", secret };
  }
  const requestTimeoutMs = integer(
    environment,
    "UNFILED_ORGANIZER_TIMEOUT_MS",
    DEFAULT_TIMEOUT_MS,
    1_000,
    49_000
  );
  const selectedPipeline = pipeline(environment, selectedRuntime);
  if (
    selectedPipeline.kind === "enabled" &&
    selectedPipeline.leaseSeconds * 1_000 < requestTimeoutMs + 5_000
  ) {
    throw new OrganizerConfigurationError([
      "UNFILED_ORGANIZER_LEASE_SECONDS",
      "UNFILED_ORGANIZER_TIMEOUT_MS"
    ]);
  }
  return Object.freeze({
    embedding: selectedEmbedding,
    invocationAuth,
    keyBoundary,
    maxRequestBytes: integer(
      environment,
      "UNFILED_ORGANIZER_MAX_REQUEST_BYTES",
      DEFAULT_MAX_REQUEST_BYTES,
      2,
      16_384
    ),
    pipeline: selectedPipeline,
    planner: selectedPlanner,
    port: integer(environment, "PORT", DEFAULT_PORT, 1, 65_535),
    releaseIdentity: releaseIdentity(environment, selectedRuntime),
    requestTimeoutMs,
    runtime: selectedRuntime
  });
}
