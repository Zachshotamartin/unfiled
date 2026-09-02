import { createHash } from "node:crypto";
import {
  LOCAL_HASH_EMBEDDING_DIMENSIONS,
  LOCAL_HASH_EMBEDDING_MODEL_ID,
  MAX_LOCAL_HASH_EMBEDDING_INPUT_BYTES
} from "@unfiled/search";

import { WorkerConfigurationError } from "./errors.js";

const DEFAULT_MAX_REQUEST_BYTES = 1_024;
const DEFAULT_PORT = 8_788;
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_AUTH_SECRET_LENGTH = 512;
const MAX_REQUEST_BYTES = 16_384;
const MAX_TIMEOUT_MS = 45_000;
const MIN_AUTH_SECRET_LENGTH = 32;
const MIN_TIMEOUT_MS = 1_000;
const MIN_PIPELINE_SLACK_MS = 4_000;
const MIN_LEASE_MARGIN_MS = 5_000;
const INDEX_DATABASE_POOL_LIMIT = 2;
const INDEX_COLD_SETUP_QUERY_SLOTS = 6;
const INDEX_TERMINAL_QUERY_SLOTS_PER_JOB = 8;
const INDEX_KMS_READINESS_CALLS = 2;
const INDEX_KMS_CALLS_PER_PROVIDER_ROUND = 2;
const INDEX_KMS_CALL_BUDGET_MS = 2_000;
export const INDEX_DATABASE_QUERY_CANCEL_GRACE_MS = 250;
const MAX_RETIRED_AI_OBJECT_WRAP_ROOTS = 20;
const MAX_RETIRED_ROOT_REGISTRY_BYTES = 32_768;
const MAX_DATABASE_CA_BYTES = 32_768;
const MAX_DATABASE_URL_LENGTH = 4_096;
const MAX_PROVIDER_KEY_LENGTH = 512;
const RETIRED_OBJECT_WRAP_ROOTS_VARIABLE = "UNFILED_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON";
const KEY_CUSTODIAN_VARIABLE = "UNFILED_KEY_CUSTODIAN";
const VERCEL_SENSITIVE_KEY_RING_VARIABLE = "UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1";
const VERCEL_OBJECT_WRAP_ROOT_VARIABLE = "UNFILED_WORKER_AI_OBJECT_WRAP_ROOT_KEY_ID";
const VERCEL_RETIRED_OBJECT_WRAP_ROOTS_VARIABLE =
  "UNFILED_WORKER_RETIRED_AI_OBJECT_WRAP_ROOT_KEY_IDS_JSON";
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

const PRIVATE_MANUAL_CAPABILITIES = [
  "UNFILED_PRIVATE_CONTENT_MAC_KMS_KEY_ARN",
  "UNFILED_PRIVATE_KMS_KEY_ID",
  "UNFILED_PRIVATE_OBJECT_WRAP_KMS_KEY_ARN",
  "UNFILED_PRIVATE_MANUAL_KMS_KEY_ARN",
  "UNFILED_PRIVATE_KMS_KEY_ARN",
  "UNFILED_PRIVATE_MANUAL_KEK_B64URL"
] as const;

const LEGACY_SINGULAR_KEY_VARIABLES = ["UNFILED_AI_KMS_KEY_ID"] as const;

const FORBIDDEN_AI_CONTENT_MAC_CAPABILITIES = [
  "UNFILED_AI_CONTENT_MAC_KMS_KEY_ARN",
  "UNFILED_RETIRED_AI_CONTENT_MAC_ROOTS_JSON",
  "UNFILED_RETIRED_AI_ROOT_REGISTRY_JSON"
] as const;

const AI_CONTENT_MAC_CAPABILITY_PATTERN =
  /^UNFILED_(?=[A-Z0-9_]*AI)(?=[A-Z0-9_]*CONTENT_MAC)[A-Z0-9_]+$/u;

const USER_SESSION_CAPABILITIES = [
  "AUTH_SECRET",
  "NEXTAUTH_SECRET",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_ANON_KEY"
] as const;

// A linked Supabase/Vercel integration can inject more than a service-role key:
// JWT signing secrets and generic Postgres credentials can also bypass the
// worker's RPC-only database role. Refuse the whole ambient capability family.
// A future adapter may receive only the deliberately named, non-bypass URL.
const SUPABASE_CAPABILITY_PATTERN = /SUPABASE/iu;
const GENERIC_DATABASE_CAPABILITY_PATTERN =
  /^(?:DATABASE_(?:URL|URI)(?:_[A-Z0-9]+)*|POSTGRES(?:QL)?_[A-Z0-9_]+|PG(?:DATABASE|HOST|PASSFILE|PASSWORD|PORT|SERVICE|SERVICEFILE|USER)(?:_[A-Z0-9]+)*)$/iu;

export type WorkerRuntime = "local" | "preview" | "production";
export type WorkerEnvironment = Readonly<Record<string, string | undefined>>;

export type WorkerReleaseIdentity = Readonly<{
  commit: string;
  deployment: `sha256:${string}`;
  environment: "preview" | "production";
}>;

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

export type LocalWorkerKeyBoundary = Readonly<{
  kind: "local-synthetic";
  keyClass: "ai_assisted";
}>;

export type AiAssistedRetiredRoots = Readonly<{
  ai_assisted: Readonly<{
    object_wrap: readonly string[];
  }>;
}>;

export type AwsWorkerKeyBoundary = Readonly<{
  aiObjectWrapKmsKeyArn: string;
  expectedOidcSubject: string;
  kind: "aws-oidc";
  keyClass: "ai_assisted";
  oidcAudience: typeof AWS_OIDC_AUDIENCE;
  region: string;
  retiredRoots: AiAssistedRetiredRoots;
  roleArn: string;
  vercelProjectId: string;
}>;

export type VercelSensitiveEnvironmentWorkerKeyBoundary = Readonly<{
  aiObjectWrapRootKeyId: string;
  deploymentEnvironment: "preview" | "production";
  kind: "vercel-sensitive-env-v1";
  keyClass: "ai_assisted";
  retiredRoots: AiAssistedRetiredRoots;
  vercelProjectId: string;
}>;

export type WorkerKeyBoundary =
  LocalWorkerKeyBoundary | AwsWorkerKeyBoundary | VercelSensitiveEnvironmentWorkerKeyBoundary;

export type WorkerInvocationAuth =
  | Readonly<{ kind: "bearer"; secret: string }>
  | Readonly<{ kind: "production-verifier"; trustedSource: VercelTrustedSource }>;

export type WorkerIndexingConfig =
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
      embedding:
        | Readonly<{
            apiKey: string;
            dimensions: number;
            kind: "openai";
            maxInputBytes: number;
            modelId: string;
            timeoutMs: number;
          }>
        | Readonly<{
            dimensions: typeof LOCAL_HASH_EMBEDDING_DIMENSIONS;
            kind: "local-hash-v1";
            maxInputBytes: number;
            modelId: typeof LOCAL_HASH_EMBEDDING_MODEL_ID;
            timeoutMs: number;
          }>;
      kind: "enabled";
      leaseSeconds: number;
      recoveryLimit: number;
    }>;

export type WorkerConfig = Readonly<{
  indexing: WorkerIndexingConfig;
  invocationAuth: WorkerInvocationAuth;
  keyBoundary: WorkerKeyBoundary;
  maxRequestBytes: number;
  port: number;
  releaseIdentity: WorkerReleaseIdentity | null;
  requestTimeoutMs: number;
  runtime: WorkerRuntime;
}>;

export const WORKER_CAPABILITIES = Object.freeze({
  acceptsUserSessions: false,
  decryptKeyClasses: ["ai_assisted"] as const,
  decryptKeyPurposes: ["object_wrap"] as const,
  generateDataKeyClasses: ["ai_assisted"] as const,
  generateDataKeyPurposes: ["object_wrap"] as const,
  rendersUserInterface: false
});

function hasValue(environment: WorkerEnvironment, name: string): boolean {
  return (environment[name]?.trim().length ?? 0) > 0;
}

function hasAsciiControlOrSpace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x20 || codeUnit === 0x7f) return true;
  }
  return false;
}

function hasInvalidPemCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (
      codeUnit !== 0x09 &&
      codeUnit !== 0x0a &&
      codeUnit !== 0x0d &&
      (codeUnit < 0x20 || codeUnit > 0x7e)
    ) {
      return true;
    }
  }
  return false;
}

function rejectCapabilities(environment: WorkerEnvironment, names: readonly string[]): void {
  const present = names.filter((name) => hasValue(environment, name));
  if (present.length > 0) throw new WorkerConfigurationError(present);
}

function rejectAiContentMacCapabilities(environment: WorkerEnvironment): void {
  const present = Object.keys(environment).filter(
    (name) => AI_CONTENT_MAC_CAPABILITY_PATTERN.test(name) && hasValue(environment, name)
  );
  if (present.length > 0) throw new WorkerConfigurationError(present);
}

function rejectAmbientDatabaseCapabilities(environment: WorkerEnvironment): void {
  const present = Object.keys(environment).filter(
    (name) =>
      (SUPABASE_CAPABILITY_PATTERN.test(name) || GENERIC_DATABASE_CAPABILITY_PATTERN.test(name)) &&
      hasValue(environment, name)
  );
  if (present.length > 0) throw new WorkerConfigurationError(present);
}

function required(environment: WorkerEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) throw new WorkerConfigurationError([name]);
  return value;
}

function parseInteger(
  environment: WorkerEnvironment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = environment[name]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  if (!/^\d+$/.test(raw)) throw new WorkerConfigurationError([name]);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new WorkerConfigurationError([name]);
  }
  return value;
}

function decodeDatabaseCa(environment: WorkerEnvironment): string {
  const name = "UNFILED_WORKER_DATABASE_CA_PEM_BASE64";
  const encoded = required(environment, name);
  if (
    encoded.length > Math.ceil((MAX_DATABASE_CA_BYTES * 4) / 3) + 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)
  ) {
    throw new WorkerConfigurationError([name]);
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(encoded, "base64");
  } catch {
    throw new WorkerConfigurationError([name]);
  }
  const canonical = decoded.toString("base64");
  const normalizedInput = encoded.replace(/=+$/u, "");
  if (
    decoded.byteLength < 64 ||
    decoded.byteLength > MAX_DATABASE_CA_BYTES ||
    canonical.replace(/=+$/u, "") !== normalizedInput
  ) {
    decoded.fill(0);
    throw new WorkerConfigurationError([name]);
  }
  const pem = decoded.toString("utf8");
  decoded.fill(0);
  if (
    !pem.startsWith("-----BEGIN CERTIFICATE-----\n") ||
    !pem.endsWith("-----END CERTIFICATE-----\n") ||
    hasInvalidPemCharacter(pem)
  ) {
    throw new WorkerConfigurationError([name]);
  }
  return pem;
}

function parseIndexingConfig(
  environment: WorkerEnvironment,
  runtime: WorkerRuntime,
  requestTimeoutMs: number
): WorkerIndexingConfig {
  const baseNames = [
    "UNFILED_WORKER_DATABASE_URL",
    "UNFILED_WORKER_DATABASE_EXPECTED_HOST",
    "UNFILED_WORKER_DATABASE_PROJECT_REF",
    "UNFILED_WORKER_DATABASE_CA_PEM_BASE64",
    "UNFILED_WORKER_EMBEDDING_PROVIDER"
  ] as const;
  const providerNames = [
    "UNFILED_OPENAI_EMBEDDING_API_KEY",
    "UNFILED_EMBEDDING_MODEL_ID",
    "UNFILED_EMBEDDING_DIMENSIONS"
  ] as const;
  const present = [...baseNames, ...providerNames].filter((name) => hasValue(environment, name));
  if (runtime === "local") {
    if (present.length > 0) throw new WorkerConfigurationError(present);
    return { kind: "disabled" };
  }
  const missingBase = baseNames.filter((name) => !hasValue(environment, name));
  if (missingBase.length > 0) {
    throw new WorkerConfigurationError(missingBase);
  }

  const url = required(environment, "UNFILED_WORKER_DATABASE_URL");
  const expectedHost = required(environment, "UNFILED_WORKER_DATABASE_EXPECTED_HOST").toLowerCase();
  const projectRef = required(environment, "UNFILED_WORKER_DATABASE_PROJECT_REF");
  const embeddingProvider = required(environment, "UNFILED_WORKER_EMBEDDING_PROVIDER");
  const invalid: string[] = [];
  if (url.length > MAX_DATABASE_URL_LENGTH) invalid.push("UNFILED_WORKER_DATABASE_URL");
  if (
    expectedHost.length > 253 ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(expectedHost)
  ) {
    invalid.push("UNFILED_WORKER_DATABASE_EXPECTED_HOST");
  }
  if (!/^[a-z0-9]{20}$/u.test(projectRef)) {
    invalid.push("UNFILED_WORKER_DATABASE_PROJECT_REF");
  }
  if (embeddingProvider !== "openai" && embeddingProvider !== "local-hash-v1")
    invalid.push("UNFILED_WORKER_EMBEDDING_PROVIDER");
  if (invalid.length > 0) throw new WorkerConfigurationError(invalid);

  let embedding: Extract<WorkerIndexingConfig, { kind: "enabled" }>["embedding"];
  const embeddingTimeoutMs = parseInteger(
    environment,
    "UNFILED_EMBEDDING_TIMEOUT_MS",
    10_000,
    1_000,
    30_000
  );
  const maxInputBytes = parseInteger(
    environment,
    "UNFILED_EMBEDDING_MAX_INPUT_BYTES",
    24_576,
    1_024,
    MAX_LOCAL_HASH_EMBEDDING_INPUT_BYTES
  );
  if (embeddingProvider === "openai") {
    const missing = providerNames.filter((name) => !hasValue(environment, name));
    if (missing.length > 0) throw new WorkerConfigurationError(missing);
    const apiKey = required(environment, "UNFILED_OPENAI_EMBEDDING_API_KEY");
    const modelId = required(environment, "UNFILED_EMBEDDING_MODEL_ID");
    if (
      apiKey.length < 20 ||
      apiKey.length > MAX_PROVIDER_KEY_LENGTH ||
      apiKey.trim() !== apiKey ||
      hasAsciiControlOrSpace(apiKey)
    )
      invalid.push("UNFILED_OPENAI_EMBEDDING_API_KEY");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(modelId))
      invalid.push("UNFILED_EMBEDDING_MODEL_ID");
    if (invalid.length > 0) throw new WorkerConfigurationError(invalid);
    embedding = Object.freeze({
      apiKey,
      dimensions: parseInteger(environment, "UNFILED_EMBEDDING_DIMENSIONS", 1_536, 1, 4_096),
      kind: "openai" as const,
      maxInputBytes,
      modelId,
      timeoutMs: embeddingTimeoutMs
    });
  } else {
    rejectCapabilities(environment, providerNames);
    embedding = Object.freeze({
      dimensions: LOCAL_HASH_EMBEDDING_DIMENSIONS,
      kind: "local-hash-v1" as const,
      maxInputBytes,
      modelId: LOCAL_HASH_EMBEDDING_MODEL_ID,
      timeoutMs: embeddingTimeoutMs
    });
  }

  const claimLimit = parseInteger(environment, "UNFILED_INDEX_CLAIM_LIMIT", 2, 1, 4);
  const concurrency = parseInteger(environment, "UNFILED_INDEX_CONCURRENCY", 2, 1, 4);
  if (concurrency > claimLimit) {
    throw new WorkerConfigurationError(["UNFILED_INDEX_CONCURRENCY", "UNFILED_INDEX_CLAIM_LIMIT"]);
  }
  const connectTimeoutMs = parseInteger(
    environment,
    "UNFILED_WORKER_DATABASE_CONNECT_TIMEOUT_MS",
    3_000,
    500,
    15_000
  );
  const statementTimeoutMs = parseInteger(
    environment,
    "UNFILED_WORKER_DATABASE_STATEMENT_TIMEOUT_MS",
    500,
    250,
    30_000
  );
  const leaseSeconds = parseInteger(environment, "UNFILED_INDEX_LEASE_SECONDS", 120, 30, 900);
  const processingRounds = Math.ceil(claimLimit / concurrency);
  const databaseConcurrency = Math.min(concurrency, INDEX_DATABASE_POOL_LIMIT);
  const querySlots =
    INDEX_COLD_SETUP_QUERY_SLOTS +
    Math.ceil(
      (INDEX_TERMINAL_QUERY_SLOTS_PER_JOB * claimLimit + (databaseConcurrency - 1)) /
        databaseConcurrency
    );
  const kmsCallCount =
    INDEX_KMS_READINESS_CALLS + INDEX_KMS_CALLS_PER_PROVIDER_ROUND * processingRounds;
  const minimumRequestBudget =
    querySlots * (statementTimeoutMs + INDEX_DATABASE_QUERY_CANCEL_GRACE_MS) +
    databaseConcurrency * connectTimeoutMs +
    processingRounds * embeddingTimeoutMs +
    kmsCallCount * INDEX_KMS_CALL_BUDGET_MS +
    MIN_PIPELINE_SLACK_MS;
  if (requestTimeoutMs < minimumRequestBudget) {
    throw new WorkerConfigurationError([
      "UNFILED_WORKER_TIMEOUT_MS",
      "UNFILED_INDEX_CLAIM_LIMIT",
      "UNFILED_INDEX_CONCURRENCY",
      "UNFILED_EMBEDDING_TIMEOUT_MS",
      "UNFILED_WORKER_DATABASE_CONNECT_TIMEOUT_MS",
      "UNFILED_WORKER_DATABASE_STATEMENT_TIMEOUT_MS"
    ]);
  }
  if (leaseSeconds * 1_000 < requestTimeoutMs + MIN_LEASE_MARGIN_MS) {
    throw new WorkerConfigurationError([
      "UNFILED_INDEX_LEASE_SECONDS",
      "UNFILED_WORKER_TIMEOUT_MS"
    ]);
  }
  return Object.freeze({
    claimLimit,
    concurrency,
    database: Object.freeze({
      caPem: decodeDatabaseCa(environment),
      connectTimeoutMs,
      expectedHost,
      projectRef,
      statementTimeoutMs,
      url
    }),
    embedding,
    kind: "enabled",
    leaseSeconds,
    recoveryLimit: parseInteger(environment, "UNFILED_INDEX_RECOVERY_LIMIT", 100, 1, 100)
  });
}

function parseRuntime(environment: WorkerEnvironment): WorkerRuntime {
  const runtime = required(environment, "UNFILED_WORKER_ENV");
  if (runtime !== "local" && runtime !== "preview" && runtime !== "production") {
    throw new WorkerConfigurationError(["UNFILED_WORKER_ENV"]);
  }

  const vercelEnvironment = environment.VERCEL_ENV?.trim();
  if (
    (runtime === "local" &&
      (environment.VERCEL !== undefined || environment.VERCEL_ENV !== undefined)) ||
    (runtime !== "local" && (environment.VERCEL !== "1" || vercelEnvironment !== runtime))
  ) {
    throw new WorkerConfigurationError(["UNFILED_WORKER_ENV", "VERCEL_ENV"]);
  }
  return runtime;
}

function parseReleaseIdentity(
  environment: WorkerEnvironment,
  runtime: WorkerRuntime
): WorkerReleaseIdentity | null {
  if (runtime === "local") {
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
    throw new WorkerConfigurationError(invalid);
  }
  return Object.freeze({
    commit,
    deployment: `sha256:${createHash("sha256").update(deploymentId, "utf8").digest("hex")}`,
    environment: runtime
  });
}

function parseTrustedSource(
  environment: WorkerEnvironment,
  workerProjectId: string,
  runtime: "preview" | "production"
): VercelTrustedSource {
  const teamSlug = required(environment, "UNFILED_TRUSTED_SOURCE_TEAM_SLUG");
  const ownerId = required(environment, "UNFILED_TRUSTED_SOURCE_OWNER_ID");
  const projectId = required(environment, "UNFILED_TRUSTED_SOURCE_WEB_PROJECT_ID");
  const projectName = required(environment, "UNFILED_TRUSTED_SOURCE_WEB_PROJECT_NAME");
  const expectedSubject = required(environment, "UNFILED_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT");
  const issuer = `${VERCEL_OIDC_ISSUER_ORIGIN}/${teamSlug}`;
  const audience = `${VERCEL_OIDC_AUDIENCE_ORIGIN}/${teamSlug}`;
  const derivedSubject = `owner:${teamSlug}:project:${projectName}:environment:${runtime}`;
  const invalid: string[] = [];

  if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u.test(teamSlug)) {
    invalid.push("UNFILED_TRUSTED_SOURCE_TEAM_SLUG");
  }
  if (!/^team_[A-Za-z0-9]+$/u.test(ownerId)) {
    invalid.push("UNFILED_TRUSTED_SOURCE_OWNER_ID");
  }
  if (!/^prj_[A-Za-z0-9]+$/u.test(projectId) || projectId === workerProjectId) {
    invalid.push("UNFILED_TRUSTED_SOURCE_WEB_PROJECT_ID");
  }
  if (!/^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$/u.test(projectName)) {
    invalid.push("UNFILED_TRUSTED_SOURCE_WEB_PROJECT_NAME");
  }
  if (expectedSubject !== derivedSubject) {
    invalid.push("UNFILED_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT");
  }
  if (invalid.length > 0) throw new WorkerConfigurationError([...new Set(invalid)]);

  return {
    audience,
    environment: runtime,
    expectedSubject,
    issuer,
    ownerId,
    projectId,
    projectName,
    teamSlug
  };
}

function parseInvocationAuth(
  environment: WorkerEnvironment,
  runtime: WorkerRuntime,
  keyBoundary: WorkerKeyBoundary
): WorkerInvocationAuth {
  if (runtime !== "local") {
    const forbidden = ["CRON_SECRET", "UNFILED_WORKER_DRAIN_SECRET"].filter((name) =>
      hasValue(environment, name)
    );
    if (forbidden.length > 0) throw new WorkerConfigurationError(forbidden);
    if (keyBoundary.kind === "local-synthetic") throw new WorkerConfigurationError([]);
    return {
      kind: "production-verifier",
      trustedSource: parseTrustedSource(environment, keyBoundary.vercelProjectId, runtime)
    };
  }
  if (hasValue(environment, "CRON_SECRET")) throw new WorkerConfigurationError(["CRON_SECRET"]);
  const value = required(environment, "UNFILED_WORKER_DRAIN_SECRET");
  if (value.length < MIN_AUTH_SECRET_LENGTH || value.length > MAX_AUTH_SECRET_LENGTH) {
    throw new WorkerConfigurationError(["UNFILED_WORKER_DRAIN_SECRET"]);
  }
  return { kind: "bearer", secret: value };
}

function parseRetiredAiObjectWrapRoots(
  environment: WorkerEnvironment,
  expected: Readonly<{
    accountId: string;
    activeArn: string;
    partition: string;
    region: string;
  }>
): AiAssistedRetiredRoots {
  const raw = environment[RETIRED_OBJECT_WRAP_ROOTS_VARIABLE]?.trim() ?? "[]";
  if (new TextEncoder().encode(raw).byteLength > MAX_RETIRED_ROOT_REGISTRY_BYTES) {
    throw new WorkerConfigurationError([RETIRED_OBJECT_WRAP_ROOTS_VARIABLE]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WorkerConfigurationError([RETIRED_OBJECT_WRAP_ROOTS_VARIABLE]);
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_RETIRED_AI_OBJECT_WRAP_ROOTS) {
    throw new WorkerConfigurationError([RETIRED_OBJECT_WRAP_ROOTS_VARIABLE]);
  }

  const allRetiredArns = new Set<string>();
  const objectWrapRoots: string[] = [];
  for (const entry of parsed) {
    const match = typeof entry === "string" ? KMS_KEY_ARN_PATTERN.exec(entry) : null;
    if (
      match?.[1] !== expected.partition ||
      match[2] !== expected.region ||
      match[3] !== expected.accountId ||
      entry === expected.activeArn ||
      typeof entry !== "string" ||
      allRetiredArns.has(entry)
    ) {
      throw new WorkerConfigurationError([RETIRED_OBJECT_WRAP_ROOTS_VARIABLE]);
    }
    objectWrapRoots.push(entry);
    allRetiredArns.add(entry);
  }

  return {
    ai_assisted: {
      object_wrap: Object.freeze(objectWrapRoots)
    }
  };
}

function awsKeyBoundary(
  environment: WorkerEnvironment,
  runtime: "preview" | "production"
): AwsWorkerKeyBoundary {
  const region = required(environment, "UNFILED_AWS_REGION");
  const roleArn = required(environment, "UNFILED_AWS_ROLE_ARN");
  const aiObjectWrapKmsKeyArn = required(environment, "UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN");
  const expectedOidcSubject = required(environment, "UNFILED_WORKER_EXPECTED_OIDC_SUBJECT");
  const vercelProjectId = required(environment, "UNFILED_WORKER_PROJECT_ID");

  const role = /^arn:(aws(?:-us-gov|-cn)?):iam::(\d{12}):role\/[A-Za-z0-9+=,.@_/-]+$/.exec(roleArn);
  const objectWrapArn = KMS_KEY_ARN_PATTERN.exec(aiObjectWrapKmsKeyArn);
  const subject = /^owner:([^:]+):project:([^:]+):environment:(preview|production)$/u.exec(
    expectedOidcSubject
  );
  const validSubject =
    expectedOidcSubject.length <= 512 &&
    subject?.[3] === runtime &&
    !expectedOidcSubject.includes(":project:prj_") &&
    /^[A-Za-z0-9_./:@-]+$/.test(expectedOidcSubject);
  const actualProjectId = environment.VERCEL_PROJECT_ID?.trim();

  const invalid: string[] = [];
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) invalid.push("UNFILED_AWS_REGION");
  if (role === null) invalid.push("UNFILED_AWS_ROLE_ARN");
  if (objectWrapArn === null) invalid.push("UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN");
  if (!validSubject) invalid.push("UNFILED_WORKER_EXPECTED_OIDC_SUBJECT");
  if (!/^prj_[A-Za-z0-9]+$/.test(vercelProjectId) || actualProjectId !== vercelProjectId) {
    invalid.push("UNFILED_WORKER_PROJECT_ID", "VERCEL_PROJECT_ID");
  }
  if (
    role !== null &&
    objectWrapArn !== null &&
    (role[1] !== objectWrapArn[1] || role[2] !== objectWrapArn[3] || region !== objectWrapArn[2])
  ) {
    invalid.push(
      "UNFILED_AWS_ROLE_ARN",
      "UNFILED_AWS_REGION",
      "UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN"
    );
  }
  const rolePartition = role?.[1];
  const roleAccountId = role?.[2];
  if (
    invalid.length > 0 ||
    rolePartition === undefined ||
    roleAccountId === undefined ||
    objectWrapArn === null
  ) {
    throw new WorkerConfigurationError([...new Set(invalid)]);
  }
  const retiredRoots = parseRetiredAiObjectWrapRoots(environment, {
    accountId: roleAccountId,
    activeArn: aiObjectWrapKmsKeyArn,
    partition: rolePartition,
    region
  });

  return {
    aiObjectWrapKmsKeyArn,
    expectedOidcSubject,
    kind: "aws-oidc",
    keyClass: "ai_assisted",
    oidcAudience: AWS_OIDC_AUDIENCE,
    region,
    retiredRoots,
    roleArn,
    vercelProjectId
  };
}

function exactSensitiveValue(environment: WorkerEnvironment, name: string): string {
  const raw = environment[name];
  if (raw === undefined || raw.length === 0 || raw.trim() !== raw) {
    throw new WorkerConfigurationError([name]);
  }
  return raw;
}

function parseVercelRetiredAiObjectWrapRoots(
  environment: WorkerEnvironment,
  activeRootKeyId: string,
  runtime: "preview" | "production"
): AiAssistedRetiredRoots {
  const raw = environment[VERCEL_RETIRED_OBJECT_WRAP_ROOTS_VARIABLE] ?? "[]";
  if (
    raw.trim() !== raw ||
    new TextEncoder().encode(raw).byteLength > MAX_RETIRED_ROOT_REGISTRY_BYTES
  ) {
    throw new WorkerConfigurationError([VERCEL_RETIRED_OBJECT_WRAP_ROOTS_VARIABLE]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WorkerConfigurationError([VERCEL_RETIRED_OBJECT_WRAP_ROOTS_VARIABLE]);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > MAX_RETIRED_AI_OBJECT_WRAP_ROOTS ||
    JSON.stringify(parsed) !== raw
  ) {
    throw new WorkerConfigurationError([VERCEL_RETIRED_OBJECT_WRAP_ROOTS_VARIABLE]);
  }
  const roots: string[] = [];
  const seen = new Set<string>([activeRootKeyId]);
  for (const entry of parsed) {
    if (
      typeof entry !== "string" ||
      VERCEL_ROOT_KEY_ID_PATTERN.exec(entry)?.[1] !== runtime ||
      seen.has(entry)
    ) {
      throw new WorkerConfigurationError([VERCEL_RETIRED_OBJECT_WRAP_ROOTS_VARIABLE]);
    }
    seen.add(entry);
    roots.push(entry);
  }
  return Object.freeze({
    ai_assisted: Object.freeze({ object_wrap: Object.freeze(roots) })
  });
}

function vercelSensitiveEnvironmentKeyBoundary(
  environment: WorkerEnvironment,
  runtime: "preview" | "production"
): VercelSensitiveEnvironmentWorkerKeyBoundary {
  const vercelProjectId = exactSensitiveValue(environment, "UNFILED_WORKER_PROJECT_ID");
  const activeRootKeyId = exactSensitiveValue(environment, VERCEL_OBJECT_WRAP_ROOT_VARIABLE);
  const ring = exactSensitiveValue(environment, VERCEL_SENSITIVE_KEY_RING_VARIABLE);
  const invalid: string[] = [];
  if (
    !/^prj_[A-Za-z0-9]+$/u.test(vercelProjectId) ||
    environment.VERCEL_PROJECT_ID !== vercelProjectId
  ) {
    invalid.push("UNFILED_WORKER_PROJECT_ID", "VERCEL_PROJECT_ID");
  }
  if (VERCEL_ROOT_KEY_ID_PATTERN.exec(activeRootKeyId)?.[1] !== runtime) {
    invalid.push(VERCEL_OBJECT_WRAP_ROOT_VARIABLE);
  }
  if (new TextEncoder().encode(ring).byteLength > 32_768) {
    invalid.push(VERCEL_SENSITIVE_KEY_RING_VARIABLE);
  }
  if (invalid.length > 0) throw new WorkerConfigurationError([...new Set(invalid)]);
  return Object.freeze({
    aiObjectWrapRootKeyId: activeRootKeyId,
    deploymentEnvironment: runtime,
    kind: "vercel-sensitive-env-v1",
    keyClass: "ai_assisted",
    retiredRoots: parseVercelRetiredAiObjectWrapRoots(environment, activeRootKeyId, runtime),
    vercelProjectId
  });
}

function managedKeyBoundary(
  environment: WorkerEnvironment,
  runtime: "preview" | "production"
): AwsWorkerKeyBoundary | VercelSensitiveEnvironmentWorkerKeyBoundary {
  const mode = exactSensitiveValue(environment, KEY_CUSTODIAN_VARIABLE);
  const awsOnly = [
    "UNFILED_AWS_REGION",
    "UNFILED_AWS_ROLE_ARN",
    "UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN",
    RETIRED_OBJECT_WRAP_ROOTS_VARIABLE,
    "UNFILED_WORKER_EXPECTED_OIDC_SUBJECT"
  ] as const;
  const sensitiveOnly = [
    VERCEL_SENSITIVE_KEY_RING_VARIABLE,
    VERCEL_OBJECT_WRAP_ROOT_VARIABLE,
    VERCEL_RETIRED_OBJECT_WRAP_ROOTS_VARIABLE
  ] as const;
  if (mode === "aws-kms") {
    rejectCapabilities(environment, sensitiveOnly);
    return awsKeyBoundary(environment, runtime);
  }
  if (mode === "vercel-sensitive-env-v1") {
    rejectCapabilities(environment, awsOnly);
    return vercelSensitiveEnvironmentKeyBoundary(environment, runtime);
  }
  throw new WorkerConfigurationError([KEY_CUSTODIAN_VARIABLE]);
}

export function loadWorkerConfig(environment: WorkerEnvironment = process.env): WorkerConfig {
  rejectCapabilities(environment, STATIC_AWS_CREDENTIALS);
  rejectCapabilities(environment, PRIVATE_MANUAL_CAPABILITIES);
  rejectCapabilities(environment, LEGACY_SINGULAR_KEY_VARIABLES);
  rejectCapabilities(environment, FORBIDDEN_AI_CONTENT_MAC_CAPABILITIES);
  rejectAiContentMacCapabilities(environment);
  rejectCapabilities(environment, USER_SESSION_CAPABILITIES);
  rejectAmbientDatabaseCapabilities(environment);

  const runtime = parseRuntime(environment);
  let keyBoundary: WorkerKeyBoundary;
  if (runtime === "local") {
    rejectCapabilities(environment, [
      KEY_CUSTODIAN_VARIABLE,
      VERCEL_SENSITIVE_KEY_RING_VARIABLE,
      VERCEL_OBJECT_WRAP_ROOT_VARIABLE,
      VERCEL_RETIRED_OBJECT_WRAP_ROOTS_VARIABLE,
      "UNFILED_AWS_REGION",
      "UNFILED_AWS_ROLE_ARN",
      "UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN",
      RETIRED_OBJECT_WRAP_ROOTS_VARIABLE,
      "UNFILED_WORKER_EXPECTED_OIDC_SUBJECT",
      "UNFILED_WORKER_PROJECT_ID",
      "UNFILED_WORKER_DATABASE_URL",
      "UNFILED_WORKER_DATABASE_EXPECTED_HOST",
      "UNFILED_WORKER_DATABASE_PROJECT_REF",
      "UNFILED_WORKER_DATABASE_CA_PEM_BASE64",
      "UNFILED_OPENAI_EMBEDDING_API_KEY"
    ]);
    keyBoundary = { kind: "local-synthetic", keyClass: "ai_assisted" };
  } else {
    keyBoundary = managedKeyBoundary(environment, runtime);
  }
  const requestTimeoutMs = parseInteger(
    environment,
    "UNFILED_WORKER_TIMEOUT_MS",
    DEFAULT_TIMEOUT_MS,
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS
  );
  return {
    indexing: parseIndexingConfig(environment, runtime, requestTimeoutMs),
    invocationAuth: parseInvocationAuth(environment, runtime, keyBoundary),
    keyBoundary,
    maxRequestBytes: parseInteger(
      environment,
      "UNFILED_WORKER_MAX_REQUEST_BYTES",
      DEFAULT_MAX_REQUEST_BYTES,
      2,
      MAX_REQUEST_BYTES
    ),
    port: parseInteger(environment, "PORT", DEFAULT_PORT, 1, 65_535),
    releaseIdentity: parseReleaseIdentity(environment, runtime),
    requestTimeoutMs,
    runtime
  };
}
