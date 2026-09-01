import { RAG_GENERATION_VERIFICATION_MAX_DISTINCT_KEYS } from "@unfiled/contracts";

import {
  RAG_VERIFICATION_DATABASE_CONNECTION_ATTEMPTS,
  RAG_VERIFICATION_MAX_PAGES
} from "./capacity.js";
import { VerifierConfigurationError } from "./errors.js";

const DEFAULT_PORT = 8_789;
export const VERIFIER_REQUEST_DEFAULT_TIMEOUT_MS = 49_000;
const DEFAULT_MAX_REQUEST_BYTES = 1_024;
const DEFAULT_DECRYPT_CONCURRENCY = 8;
const DEFAULT_CONNECT_TIMEOUT_MS = 2_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 250;
const DEFAULT_KMS_TIMEOUT_MS = 2_000;
export const VERIFIER_REQUEST_MAX_TIMEOUT_MS = 49_000;
const MAX_REQUEST_BYTES = 4_096;
const MAX_DATABASE_CA_BYTES = 32_768;
const MAX_DATABASE_URL_LENGTH = 4_096;
const MAX_RETIRED_OBJECT_WRAP_ROOTS = 20;
const MAX_RETIRED_ROOT_REGISTRY_BYTES = 16_384;
const DATABASE_QUERY_CANCEL_GRACE_MS = 250;
const DATABASE_QUERY_CANCEL_GRACE_SLOTS = 2;
// One request preflight + every page + the initial and replay attestation attempts.
const DATABASE_RPC_QUERY_SLOTS = RAG_VERIFICATION_MAX_PAGES + 3;
// The verification-scoped executor hard-caps physical connection acquisitions at two.
const DATABASE_CONNECTION_IDENTITY_QUERY_SLOTS = RAG_VERIFICATION_DATABASE_CONNECTION_ATTEMPTS;
const BASE_CAPACITY_PROCESSING_BUDGET_MS = 18_000;
const FIXED_HTTP_OIDC_RUNTIME_HEADROOM_MS = 9_000;
const AWS_OIDC_AUDIENCE = "sts.amazonaws.com" as const;
const VERCEL_OIDC_ISSUER_ORIGIN = "https://oidc.vercel.com" as const;
const VERCEL_OIDC_AUDIENCE_ORIGIN = "https://vercel.com" as const;
const KMS_KEY_ARN_PATTERN =
  /^arn:(aws(?:-us-gov|-cn)?):kms:([a-z0-9-]+):(\d{12}):key\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const STATIC_AWS_CREDENTIALS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SECURITY_TOKEN",
  "AWS_PROFILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_SESSION_TOKEN"
] as const;

const FORBIDDEN_CAPABILITIES = [
  "AUTH_SECRET",
  "CRON_SECRET",
  "NEXTAUTH_SECRET",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_ANON_KEY",
  "UNFILED_AI_CONTENT_MAC_KMS_KEY_ARN",
  "UNFILED_AI_KMS_KEY_ID",
  "UNFILED_OPENAI_API_KEY",
  "UNFILED_OPENAI_EMBEDDING_API_KEY",
  "UNFILED_PRIVATE_CONTENT_MAC_KMS_KEY_ARN",
  "UNFILED_PRIVATE_KMS_KEY_ARN",
  "UNFILED_PRIVATE_KMS_KEY_ID",
  "UNFILED_PRIVATE_MANUAL_KEK_B64URL",
  "UNFILED_PRIVATE_MANUAL_KMS_KEY_ARN",
  "UNFILED_PRIVATE_OBJECT_WRAP_KMS_KEY_ARN",
  "UNFILED_WORKER_DATABASE_URL",
  "UNFILED_WORKER_DRAIN_SECRET"
] as const;

const FORBIDDEN_CAPACITY_OVERRIDES = [
  "UNFILED_VERIFIER_MAX_PAGES",
  "UNFILED_VERIFIER_PAGE_LIMIT",
  "UNFILED_VERIFIER_PAGE_CIPHERTEXT_BYTE_BUDGET"
] as const;

const PRODUCTION_VARIABLES = [
  "UNFILED_AWS_REGION",
  "UNFILED_AWS_ROLE_ARN",
  "UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN",
  "UNFILED_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON",
  "UNFILED_VERIFIER_EXPECTED_OIDC_SUBJECT",
  "UNFILED_VERIFIER_PROJECT_ID",
  "UNFILED_TRUSTED_SOURCE_TEAM_SLUG",
  "UNFILED_TRUSTED_SOURCE_OWNER_ID",
  "UNFILED_TRUSTED_SOURCE_WEB_PROJECT_ID",
  "UNFILED_TRUSTED_SOURCE_WEB_PROJECT_NAME",
  "UNFILED_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT",
  "UNFILED_VERIFIER_DATABASE_URL",
  "UNFILED_VERIFIER_DATABASE_EXPECTED_HOST",
  "UNFILED_VERIFIER_DATABASE_PROJECT_REF",
  "UNFILED_VERIFIER_DATABASE_CA_PEM_BASE64"
] as const;

const SUPABASE_CAPABILITY_PATTERN = /SUPABASE/iu;
const GENERIC_DATABASE_CAPABILITY_PATTERN =
  /^(?:DATABASE_(?:URL|URI)(?:_[A-Z0-9]+)*|POSTGRES(?:QL)?_[A-Z0-9_]+|PG(?:DATABASE|HOST|PASSFILE|PASSWORD|PORT|SERVICE|SERVICEFILE|USER)(?:_[A-Z0-9]+)*)$/iu;

export type VerifierRuntime = "local" | "preview" | "production";
export type VerifierEnvironment = Readonly<Record<string, string | undefined>>;

export type VercelTrustedSource = Readonly<{
  audience: string;
  environment: "production";
  expectedSubject: string;
  issuer: string;
  ownerId: string;
  projectId: string;
  projectName: string;
  teamSlug: string;
}>;

export type VerifierDatabaseConfig = Readonly<{
  caPem: string;
  connectTimeoutMs: number;
  expectedHost: string;
  projectRef: string;
  statementTimeoutMs: number;
  url: string;
}>;

export type VerifierKmsConfig = Readonly<{
  activeObjectWrapRootArn: string;
  expectedOidcSubject: string;
  maxKeyRecords: number;
  oidcAudience: typeof AWS_OIDC_AUDIENCE;
  region: string;
  retiredObjectWrapRootArns: readonly string[];
  roleArn: string;
  timeoutMs: number;
  vercelProjectId: string;
}>;

export type EnabledVerificationConfig = Readonly<{
  database: VerifierDatabaseConfig;
  decryptConcurrency: number;
  invocation: VercelTrustedSource;
  kind: "enabled";
  kms: VerifierKmsConfig;
}>;

export type VerifierConfig = Readonly<{
  maxRequestBytes: number;
  port: number;
  requestTimeoutMs: number;
  runtime: VerifierRuntime;
  verification: Readonly<{ kind: "disabled" }> | EnabledVerificationConfig;
}>;

export function verifierCapacityProcessingBudgetMs(decryptConcurrency: number): number {
  if (
    !Number.isSafeInteger(decryptConcurrency) ||
    decryptConcurrency < 1 ||
    decryptConcurrency > DEFAULT_DECRYPT_CONCURRENCY
  ) {
    throw new VerifierConfigurationError(["UNFILED_VERIFIER_DECRYPT_CONCURRENCY"]);
  }
  return Math.ceil(
    (BASE_CAPACITY_PROCESSING_BUDGET_MS * DEFAULT_DECRYPT_CONCURRENCY) / decryptConcurrency
  );
}

export function verifierMinimumRequestBudgetMs(
  input: Readonly<{
    connectTimeoutMs: number;
    decryptConcurrency: number;
    kmsTimeoutMs: number;
    statementTimeoutMs: number;
  }>
): number {
  return (
    (DATABASE_RPC_QUERY_SLOTS + DATABASE_CONNECTION_IDENTITY_QUERY_SLOTS) *
      input.statementTimeoutMs +
    DATABASE_QUERY_CANCEL_GRACE_SLOTS * DATABASE_QUERY_CANCEL_GRACE_MS +
    RAG_VERIFICATION_DATABASE_CONNECTION_ATTEMPTS * input.connectTimeoutMs +
    RAG_GENERATION_VERIFICATION_MAX_DISTINCT_KEYS * input.kmsTimeoutMs +
    verifierCapacityProcessingBudgetMs(input.decryptConcurrency) +
    FIXED_HTTP_OIDC_RUNTIME_HEADROOM_MS
  );
}

export const VERIFIER_CAPABILITIES = Object.freeze({
  acceptsUserSessions: false,
  decryptKeyClasses: ["ai_assisted"] as const,
  decryptKeyPurposes: ["object_wrap"] as const,
  generatesDataKeys: false,
  mutatesIndexRows: false,
  rendersUserInterface: false
});

function hasValue(environment: VerifierEnvironment, name: string): boolean {
  return (environment[name]?.trim().length ?? 0) > 0;
}

function rejectCapabilities(environment: VerifierEnvironment, names: readonly string[]): void {
  const present = names.filter((name) => hasValue(environment, name));
  if (present.length > 0) throw new VerifierConfigurationError(present);
}

function rejectAmbientDatabaseCapabilities(environment: VerifierEnvironment): void {
  const present = Object.keys(environment).filter(
    (name) =>
      (SUPABASE_CAPABILITY_PATTERN.test(name) || GENERIC_DATABASE_CAPABILITY_PATTERN.test(name)) &&
      hasValue(environment, name)
  );
  if (present.length > 0) throw new VerifierConfigurationError(present);
}

function required(environment: VerifierEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) throw new VerifierConfigurationError([name]);
  return value;
}

function parseInteger(
  environment: VerifierEnvironment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = environment[name]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  if (!/^\d+$/u.test(raw)) throw new VerifierConfigurationError([name]);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new VerifierConfigurationError([name]);
  }
  return parsed;
}

function parseRuntime(environment: VerifierEnvironment): VerifierRuntime {
  const runtime = required(environment, "UNFILED_VERIFIER_ENV");
  if (runtime !== "local" && runtime !== "preview" && runtime !== "production") {
    throw new VerifierConfigurationError(["UNFILED_VERIFIER_ENV"]);
  }
  const expectedVercelEnvironment =
    runtime === "production" ? "production" : runtime === "preview" ? "preview" : "development";
  const actualVercelEnvironment = environment.VERCEL_ENV?.trim();
  if (
    (runtime === "production" && actualVercelEnvironment !== expectedVercelEnvironment) ||
    (runtime !== "production" &&
      actualVercelEnvironment !== undefined &&
      actualVercelEnvironment !== expectedVercelEnvironment)
  ) {
    throw new VerifierConfigurationError(["UNFILED_VERIFIER_ENV", "VERCEL_ENV"]);
  }
  return runtime;
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

function decodeDatabaseCa(environment: VerifierEnvironment): string {
  const name = "UNFILED_VERIFIER_DATABASE_CA_PEM_BASE64";
  const encoded = required(environment, name);
  if (
    encoded.length > Math.ceil((MAX_DATABASE_CA_BYTES * 4) / 3) + 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)
  ) {
    throw new VerifierConfigurationError([name]);
  }
  const decoded = Buffer.from(encoded, "base64");
  const canonical = decoded.toString("base64");
  const normalizedInput = encoded.replace(/=+$/u, "");
  if (
    decoded.byteLength < 64 ||
    decoded.byteLength > MAX_DATABASE_CA_BYTES ||
    canonical.replace(/=+$/u, "") !== normalizedInput
  ) {
    decoded.fill(0);
    throw new VerifierConfigurationError([name]);
  }
  const pem = decoded.toString("utf8");
  decoded.fill(0);
  if (
    !pem.startsWith("-----BEGIN CERTIFICATE-----\n") ||
    !pem.endsWith("-----END CERTIFICATE-----\n") ||
    hasInvalidPemCharacter(pem)
  ) {
    throw new VerifierConfigurationError([name]);
  }
  return pem;
}

function parseDatabase(
  environment: VerifierEnvironment,
  connectTimeoutMs: number,
  statementTimeoutMs: number
): VerifierDatabaseConfig {
  const url = required(environment, "UNFILED_VERIFIER_DATABASE_URL");
  const expectedHost = required(
    environment,
    "UNFILED_VERIFIER_DATABASE_EXPECTED_HOST"
  ).toLowerCase();
  const projectRef = required(environment, "UNFILED_VERIFIER_DATABASE_PROJECT_REF");
  const invalid: string[] = [];
  if (url.length > MAX_DATABASE_URL_LENGTH) invalid.push("UNFILED_VERIFIER_DATABASE_URL");
  if (
    expectedHost.length > 253 ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(expectedHost)
  ) {
    invalid.push("UNFILED_VERIFIER_DATABASE_EXPECTED_HOST");
  }
  if (!/^[a-z0-9]{20}$/u.test(projectRef)) {
    invalid.push("UNFILED_VERIFIER_DATABASE_PROJECT_REF");
  }
  if (invalid.length > 0) throw new VerifierConfigurationError(invalid);
  return Object.freeze({
    caPem: decodeDatabaseCa(environment),
    connectTimeoutMs,
    expectedHost,
    projectRef,
    statementTimeoutMs,
    url
  });
}

function parseRetiredObjectWrapRoots(
  environment: VerifierEnvironment,
  expected: Readonly<{
    accountId: string;
    activeArn: string;
    partition: string;
    region: string;
  }>
): readonly string[] {
  const name = "UNFILED_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON";
  const raw = environment[name]?.trim() ?? "[]";
  if (new TextEncoder().encode(raw).byteLength > MAX_RETIRED_ROOT_REGISTRY_BYTES) {
    throw new VerifierConfigurationError([name]);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new VerifierConfigurationError([name]);
  }
  if (!Array.isArray(value) || value.length > MAX_RETIRED_OBJECT_WRAP_ROOTS) {
    throw new VerifierConfigurationError([name]);
  }
  const roots: string[] = [];
  const seen = new Set<string>([expected.activeArn]);
  for (const entry of value) {
    if (typeof entry !== "string") throw new VerifierConfigurationError([name]);
    const match = KMS_KEY_ARN_PATTERN.exec(entry);
    if (
      match?.[1] !== expected.partition ||
      match[2] !== expected.region ||
      match[3] !== expected.accountId ||
      seen.has(entry)
    ) {
      throw new VerifierConfigurationError([name]);
    }
    seen.add(entry);
    roots.push(entry);
  }
  return Object.freeze(roots);
}

function parseKms(
  environment: VerifierEnvironment,
  timeoutMs: number,
  maxKeyRecords: number
): VerifierKmsConfig {
  const region = required(environment, "UNFILED_AWS_REGION");
  const roleArn = required(environment, "UNFILED_AWS_ROLE_ARN");
  const activeObjectWrapRootArn = required(environment, "UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN");
  const expectedOidcSubject = required(environment, "UNFILED_VERIFIER_EXPECTED_OIDC_SUBJECT");
  const vercelProjectId = required(environment, "UNFILED_VERIFIER_PROJECT_ID");
  const role = /^arn:(aws(?:-us-gov|-cn)?):iam::(\d{12}):role\/[A-Za-z0-9+=,.@_/-]+$/u.exec(
    roleArn
  );
  const root = KMS_KEY_ARN_PATTERN.exec(activeObjectWrapRootArn);
  const subject = /^owner:([^:]+):project:([^:]+):environment:production$/u.exec(
    expectedOidcSubject
  );
  const actualProjectId = environment.VERCEL_PROJECT_ID?.trim();
  const invalid: string[] = [];
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u.test(region)) invalid.push("UNFILED_AWS_REGION");
  if (role === null) invalid.push("UNFILED_AWS_ROLE_ARN");
  if (root === null) invalid.push("UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN");
  if (subject === null || expectedOidcSubject.length > 512) {
    invalid.push("UNFILED_VERIFIER_EXPECTED_OIDC_SUBJECT");
  }
  if (!/^prj_[A-Za-z0-9]+$/u.test(vercelProjectId) || actualProjectId !== vercelProjectId) {
    invalid.push("UNFILED_VERIFIER_PROJECT_ID", "VERCEL_PROJECT_ID");
  }
  if (
    role !== null &&
    root !== null &&
    (role[1] !== root[1] || role[2] !== root[3] || region !== root[2])
  ) {
    invalid.push(
      "UNFILED_AWS_ROLE_ARN",
      "UNFILED_AWS_REGION",
      "UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN"
    );
  }
  const partition = role?.[1];
  const accountId = role?.[2];
  if (
    invalid.length > 0 ||
    role === null ||
    root === null ||
    partition === undefined ||
    accountId === undefined
  ) {
    throw new VerifierConfigurationError([...new Set(invalid)]);
  }
  return Object.freeze({
    activeObjectWrapRootArn,
    expectedOidcSubject,
    maxKeyRecords,
    oidcAudience: AWS_OIDC_AUDIENCE,
    region,
    retiredObjectWrapRootArns: parseRetiredObjectWrapRoots(environment, {
      accountId,
      activeArn: activeObjectWrapRootArn,
      partition,
      region
    }),
    roleArn,
    timeoutMs,
    vercelProjectId
  });
}

function parseTrustedSource(
  environment: VerifierEnvironment,
  verifierSubject: string,
  verifierProjectId: string
): VercelTrustedSource {
  const teamSlug = required(environment, "UNFILED_TRUSTED_SOURCE_TEAM_SLUG");
  const ownerId = required(environment, "UNFILED_TRUSTED_SOURCE_OWNER_ID");
  const projectId = required(environment, "UNFILED_TRUSTED_SOURCE_WEB_PROJECT_ID");
  const projectName = required(environment, "UNFILED_TRUSTED_SOURCE_WEB_PROJECT_NAME");
  const expectedSubject = required(environment, "UNFILED_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT");
  const verifierMatch = /^owner:([^:]+):project:([^:]+):environment:production$/u.exec(
    verifierSubject
  );
  const derivedSubject = `owner:${teamSlug}:project:${projectName}:environment:production`;
  const invalid: string[] = [];
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u.test(teamSlug) ||
    verifierMatch?.[1] !== teamSlug
  ) {
    invalid.push("UNFILED_TRUSTED_SOURCE_TEAM_SLUG");
  }
  if (!/^team_[A-Za-z0-9]+$/u.test(ownerId)) {
    invalid.push("UNFILED_TRUSTED_SOURCE_OWNER_ID");
  }
  if (!/^prj_[A-Za-z0-9]+$/u.test(projectId) || projectId === verifierProjectId) {
    invalid.push("UNFILED_TRUSTED_SOURCE_WEB_PROJECT_ID");
  }
  if (
    !/^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$/u.test(projectName) ||
    projectName === verifierMatch?.[2]
  ) {
    invalid.push("UNFILED_TRUSTED_SOURCE_WEB_PROJECT_NAME");
  }
  if (expectedSubject !== derivedSubject) {
    invalid.push("UNFILED_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT");
  }
  if (invalid.length > 0) throw new VerifierConfigurationError([...new Set(invalid)]);
  return Object.freeze({
    audience: `${VERCEL_OIDC_AUDIENCE_ORIGIN}/${teamSlug}`,
    environment: "production",
    expectedSubject,
    issuer: `${VERCEL_OIDC_ISSUER_ORIGIN}/${teamSlug}`,
    ownerId,
    projectId,
    projectName,
    teamSlug
  });
}

function enabledVerification(
  environment: VerifierEnvironment,
  requestTimeoutMs: number
): EnabledVerificationConfig {
  const decryptConcurrency = parseInteger(
    environment,
    "UNFILED_VERIFIER_DECRYPT_CONCURRENCY",
    DEFAULT_DECRYPT_CONCURRENCY,
    1,
    8
  );
  const connectTimeoutMs = parseInteger(
    environment,
    "UNFILED_VERIFIER_DATABASE_CONNECT_TIMEOUT_MS",
    DEFAULT_CONNECT_TIMEOUT_MS,
    500,
    10_000
  );
  const statementTimeoutMs = parseInteger(
    environment,
    "UNFILED_VERIFIER_DATABASE_STATEMENT_TIMEOUT_MS",
    DEFAULT_STATEMENT_TIMEOUT_MS,
    250,
    5_000
  );
  const kmsTimeoutMs = parseInteger(
    environment,
    "UNFILED_VERIFIER_KMS_TIMEOUT_MS",
    DEFAULT_KMS_TIMEOUT_MS,
    500,
    5_000
  );
  const minimumBudget = verifierMinimumRequestBudgetMs({
    connectTimeoutMs,
    decryptConcurrency,
    kmsTimeoutMs,
    statementTimeoutMs
  });
  if (requestTimeoutMs < minimumBudget) {
    throw new VerifierConfigurationError([
      "UNFILED_VERIFIER_TIMEOUT_MS",
      "UNFILED_VERIFIER_DECRYPT_CONCURRENCY",
      "UNFILED_VERIFIER_DATABASE_CONNECT_TIMEOUT_MS",
      "UNFILED_VERIFIER_DATABASE_STATEMENT_TIMEOUT_MS",
      "UNFILED_VERIFIER_KMS_TIMEOUT_MS"
    ]);
  }
  const kms = parseKms(environment, kmsTimeoutMs, RAG_GENERATION_VERIFICATION_MAX_DISTINCT_KEYS);
  return Object.freeze({
    database: parseDatabase(environment, connectTimeoutMs, statementTimeoutMs),
    decryptConcurrency,
    invocation: parseTrustedSource(environment, kms.expectedOidcSubject, kms.vercelProjectId),
    kind: "enabled",
    kms
  });
}

export function loadVerifierConfig(environment: VerifierEnvironment = process.env): VerifierConfig {
  rejectCapabilities(environment, STATIC_AWS_CREDENTIALS);
  rejectCapabilities(environment, FORBIDDEN_CAPABILITIES);
  rejectCapabilities(environment, FORBIDDEN_CAPACITY_OVERRIDES);
  rejectAmbientDatabaseCapabilities(environment);
  const runtime = parseRuntime(environment);
  const requestTimeoutMs = parseInteger(
    environment,
    "UNFILED_VERIFIER_TIMEOUT_MS",
    VERIFIER_REQUEST_DEFAULT_TIMEOUT_MS,
    1_000,
    VERIFIER_REQUEST_MAX_TIMEOUT_MS
  );
  if (runtime !== "production") {
    rejectCapabilities(environment, PRODUCTION_VARIABLES);
    return Object.freeze({
      maxRequestBytes: parseInteger(
        environment,
        "UNFILED_VERIFIER_MAX_REQUEST_BYTES",
        DEFAULT_MAX_REQUEST_BYTES,
        2,
        MAX_REQUEST_BYTES
      ),
      port: parseInteger(environment, "PORT", DEFAULT_PORT, 1, 65_535),
      requestTimeoutMs,
      runtime,
      verification: Object.freeze({ kind: "disabled" })
    });
  }
  return Object.freeze({
    maxRequestBytes: parseInteger(
      environment,
      "UNFILED_VERIFIER_MAX_REQUEST_BYTES",
      DEFAULT_MAX_REQUEST_BYTES,
      2,
      MAX_REQUEST_BYTES
    ),
    port: parseInteger(environment, "PORT", DEFAULT_PORT, 1, 65_535),
    requestTimeoutMs,
    runtime,
    verification: enabledVerification(environment, requestTimeoutMs)
  });
}

export const verifierDatabaseQueryCancelGraceMs = DATABASE_QUERY_CANCEL_GRACE_MS;
