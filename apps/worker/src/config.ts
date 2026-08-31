import { WorkerConfigurationError } from "./errors";

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
const INDEX_KMS_READINESS_CALLS = 4;
const INDEX_KMS_CALLS_PER_PROVIDER_ROUND = 2;
const INDEX_KMS_CALL_BUDGET_MS = 2_000;
export const INDEX_DATABASE_QUERY_CANCEL_GRACE_MS = 250;
const MAX_RETIRED_AI_ROOTS_PER_PURPOSE = 20;
const MAX_RETIRED_ROOT_REGISTRY_BYTES = 32_768;
const MAX_DATABASE_CA_BYTES = 32_768;
const MAX_DATABASE_URL_LENGTH = 4_096;
const MAX_PROVIDER_KEY_LENGTH = 512;
const RETIRED_ROOT_REGISTRY_VARIABLE = "UNFILED_RETIRED_AI_ROOT_REGISTRY_JSON";
const KMS_KEY_ARN_PATTERN =
  /^arn:(aws(?:-us-gov|-cn)?):kms:([a-z0-9-]+):(\d{12}):key\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

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

export type LocalWorkerKeyBoundary = Readonly<{
  kind: "local-synthetic";
  keyClass: "ai_assisted";
}>;

export type AiAssistedRetiredRoots = Readonly<{
  ai_assisted: Readonly<{
    content_mac: readonly string[];
    object_wrap: readonly string[];
  }>;
}>;

export type AwsWorkerKeyBoundary = Readonly<{
  aiContentMacKmsKeyArn: string;
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
      embedding: Readonly<{
        apiKey: string;
        dimensions: number;
        maxInputBytes: number;
        modelId: string;
        timeoutMs: number;
      }>;
      kind: "enabled";
      leaseSeconds: number;
      recoveryLimit: number;
    }>;

export type WorkerConfig = Readonly<{
  indexing: WorkerIndexingConfig;
  invocationAuth: WorkerInvocationAuth;
  keyBoundary: LocalWorkerKeyBoundary | AwsWorkerKeyBoundary;
  maxRequestBytes: number;
  port: number;
  requestTimeoutMs: number;
  runtime: WorkerRuntime;
}>;

export const WORKER_CAPABILITIES = Object.freeze({
  acceptsUserSessions: false,
  decryptKeyClasses: ["ai_assisted"] as const,
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
  const requiredNames = [
    "UNFILED_WORKER_DATABASE_URL",
    "UNFILED_WORKER_DATABASE_EXPECTED_HOST",
    "UNFILED_WORKER_DATABASE_PROJECT_REF",
    "UNFILED_WORKER_DATABASE_CA_PEM_BASE64",
    "UNFILED_OPENAI_EMBEDDING_API_KEY",
    "UNFILED_EMBEDDING_MODEL_ID",
    "UNFILED_EMBEDDING_DIMENSIONS"
  ] as const;
  const present = requiredNames.filter((name) => hasValue(environment, name));
  if (runtime !== "production") {
    if (present.length > 0) throw new WorkerConfigurationError(present);
    return { kind: "disabled" };
  }
  if (present.length !== requiredNames.length) {
    throw new WorkerConfigurationError(
      requiredNames.filter((name) => !hasValue(environment, name))
    );
  }

  const url = required(environment, "UNFILED_WORKER_DATABASE_URL");
  const expectedHost = required(environment, "UNFILED_WORKER_DATABASE_EXPECTED_HOST").toLowerCase();
  const projectRef = required(environment, "UNFILED_WORKER_DATABASE_PROJECT_REF");
  const apiKey = required(environment, "UNFILED_OPENAI_EMBEDDING_API_KEY");
  const modelId = required(environment, "UNFILED_EMBEDDING_MODEL_ID");
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
  if (
    apiKey.length < 20 ||
    apiKey.length > MAX_PROVIDER_KEY_LENGTH ||
    apiKey.trim() !== apiKey ||
    hasAsciiControlOrSpace(apiKey)
  ) {
    invalid.push("UNFILED_OPENAI_EMBEDDING_API_KEY");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(modelId)) {
    invalid.push("UNFILED_EMBEDDING_MODEL_ID");
  }
  if (invalid.length > 0) throw new WorkerConfigurationError(invalid);

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
  const embeddingTimeoutMs = parseInteger(
    environment,
    "UNFILED_EMBEDDING_TIMEOUT_MS",
    10_000,
    1_000,
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
    embedding: Object.freeze({
      apiKey,
      dimensions: parseInteger(environment, "UNFILED_EMBEDDING_DIMENSIONS", 1_536, 1, 4_096),
      maxInputBytes: parseInteger(
        environment,
        "UNFILED_EMBEDDING_MAX_INPUT_BYTES",
        24_576,
        1_024,
        100_000
      ),
      modelId,
      timeoutMs: embeddingTimeoutMs
    }),
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
  const allowedVercelEnvironment =
    runtime === "production" ? "production" : runtime === "preview" ? "preview" : "development";
  if (
    (runtime === "production" && vercelEnvironment !== allowedVercelEnvironment) ||
    (runtime !== "production" &&
      vercelEnvironment !== undefined &&
      vercelEnvironment !== allowedVercelEnvironment)
  ) {
    throw new WorkerConfigurationError(["UNFILED_WORKER_ENV", "VERCEL_ENV"]);
  }
  return runtime;
}

function parseTrustedSource(
  environment: WorkerEnvironment,
  workerBoundary: AwsWorkerKeyBoundary
): VercelTrustedSource {
  const teamSlug = required(environment, "UNFILED_TRUSTED_SOURCE_TEAM_SLUG");
  const ownerId = required(environment, "UNFILED_TRUSTED_SOURCE_OWNER_ID");
  const projectId = required(environment, "UNFILED_TRUSTED_SOURCE_WEB_PROJECT_ID");
  const projectName = required(environment, "UNFILED_TRUSTED_SOURCE_WEB_PROJECT_NAME");
  const expectedSubject = required(environment, "UNFILED_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT");
  const issuer = `${VERCEL_OIDC_ISSUER_ORIGIN}/${teamSlug}`;
  const audience = `${VERCEL_OIDC_AUDIENCE_ORIGIN}/${teamSlug}`;
  const derivedSubject = `owner:${teamSlug}:project:${projectName}:environment:production`;
  const workerSubject = /^owner:([^:]+):project:([^:]+):environment:production$/u.exec(
    workerBoundary.expectedOidcSubject
  );
  const workerTeamSlug = workerSubject?.[1];
  const workerProjectName = workerSubject?.[2];
  const invalid: string[] = [];

  if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u.test(teamSlug) || teamSlug !== workerTeamSlug) {
    invalid.push("UNFILED_TRUSTED_SOURCE_TEAM_SLUG");
  }
  if (!/^team_[A-Za-z0-9]+$/u.test(ownerId)) {
    invalid.push("UNFILED_TRUSTED_SOURCE_OWNER_ID");
  }
  if (!/^prj_[A-Za-z0-9]+$/u.test(projectId) || projectId === workerBoundary.vercelProjectId) {
    invalid.push("UNFILED_TRUSTED_SOURCE_WEB_PROJECT_ID");
  }
  if (
    !/^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$/u.test(projectName) ||
    projectName === workerProjectName
  ) {
    invalid.push("UNFILED_TRUSTED_SOURCE_WEB_PROJECT_NAME");
  }
  if (expectedSubject !== derivedSubject) {
    invalid.push("UNFILED_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT");
  }
  if (invalid.length > 0) throw new WorkerConfigurationError([...new Set(invalid)]);

  return {
    audience,
    environment: "production",
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
  keyBoundary: LocalWorkerKeyBoundary | AwsWorkerKeyBoundary
): WorkerInvocationAuth {
  if (runtime === "production") {
    const forbidden = ["CRON_SECRET", "UNFILED_WORKER_DRAIN_SECRET"].filter((name) =>
      hasValue(environment, name)
    );
    if (forbidden.length > 0) throw new WorkerConfigurationError(forbidden);
    if (keyBoundary.kind !== "aws-oidc") throw new WorkerConfigurationError([]);
    return {
      kind: "production-verifier",
      trustedSource: parseTrustedSource(environment, keyBoundary)
    };
  }
  if (hasValue(environment, "CRON_SECRET")) throw new WorkerConfigurationError(["CRON_SECRET"]);
  const value = required(environment, "UNFILED_WORKER_DRAIN_SECRET");
  if (value.length < MIN_AUTH_SECRET_LENGTH || value.length > MAX_AUTH_SECRET_LENGTH) {
    throw new WorkerConfigurationError(["UNFILED_WORKER_DRAIN_SECRET"]);
  }
  return { kind: "bearer", secret: value };
}

function parseRetiredAiRoots(
  environment: WorkerEnvironment,
  expected: Readonly<{
    accountId: string;
    activeArns: readonly string[];
    partition: string;
    region: string;
  }>
): AiAssistedRetiredRoots {
  const raw = environment[RETIRED_ROOT_REGISTRY_VARIABLE]?.trim() ?? "[]";
  if (raw.length === 0) {
    return { ai_assisted: { content_mac: [], object_wrap: [] } };
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_RETIRED_ROOT_REGISTRY_BYTES) {
    throw new WorkerConfigurationError([RETIRED_ROOT_REGISTRY_VARIABLE]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WorkerConfigurationError([RETIRED_ROOT_REGISTRY_VARIABLE]);
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_RETIRED_AI_ROOTS_PER_PURPOSE * 2) {
    throw new WorkerConfigurationError([RETIRED_ROOT_REGISTRY_VARIABLE]);
  }

  const activeArns = new Set(expected.activeArns);
  const allRetiredArns = new Set<string>();
  const roots: Record<"content_mac" | "object_wrap", string[]> = {
    content_mac: [],
    object_wrap: []
  };
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new WorkerConfigurationError([RETIRED_ROOT_REGISTRY_VARIABLE]);
    }
    const record = entry as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !== "arn,keyClass,purpose,status" ||
      record.keyClass !== "ai_assisted" ||
      (record.purpose !== "content_mac" && record.purpose !== "object_wrap") ||
      record.status !== "retired" ||
      typeof record.arn !== "string"
    ) {
      throw new WorkerConfigurationError([RETIRED_ROOT_REGISTRY_VARIABLE]);
    }
    const match = KMS_KEY_ARN_PATTERN.exec(record.arn);
    if (
      match?.[1] !== expected.partition ||
      match[2] !== expected.region ||
      match[3] !== expected.accountId ||
      activeArns.has(record.arn) ||
      allRetiredArns.has(record.arn)
    ) {
      throw new WorkerConfigurationError([RETIRED_ROOT_REGISTRY_VARIABLE]);
    }
    const purposeRoots = roots[record.purpose];
    if (purposeRoots.length >= MAX_RETIRED_AI_ROOTS_PER_PURPOSE) {
      throw new WorkerConfigurationError([RETIRED_ROOT_REGISTRY_VARIABLE]);
    }
    purposeRoots.push(record.arn);
    allRetiredArns.add(record.arn);
  }

  return {
    ai_assisted: {
      content_mac: Object.freeze([...roots.content_mac]),
      object_wrap: Object.freeze([...roots.object_wrap])
    }
  };
}

function awsKeyBoundary(environment: WorkerEnvironment): AwsWorkerKeyBoundary {
  const region = required(environment, "UNFILED_AWS_REGION");
  const roleArn = required(environment, "UNFILED_AWS_ROLE_ARN");
  const aiObjectWrapKmsKeyArn = required(environment, "UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN");
  const aiContentMacKmsKeyArn = required(environment, "UNFILED_AI_CONTENT_MAC_KMS_KEY_ARN");
  const expectedOidcSubject = required(environment, "UNFILED_WORKER_EXPECTED_OIDC_SUBJECT");
  const vercelProjectId = required(environment, "UNFILED_WORKER_PROJECT_ID");

  const role = /^arn:(aws(?:-us-gov|-cn)?):iam::(\d{12}):role\/[A-Za-z0-9+=,.@_/-]+$/.exec(roleArn);
  const objectWrapArn = KMS_KEY_ARN_PATTERN.exec(aiObjectWrapKmsKeyArn);
  const contentMacArn = KMS_KEY_ARN_PATTERN.exec(aiContentMacKmsKeyArn);
  const validSubject =
    expectedOidcSubject.length <= 512 &&
    expectedOidcSubject.endsWith(":environment:production") &&
    !expectedOidcSubject.includes(":project:prj_") &&
    /^[A-Za-z0-9_./:@-]+$/.test(expectedOidcSubject);
  const actualProjectId = environment.VERCEL_PROJECT_ID?.trim();

  const invalid: string[] = [];
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) invalid.push("UNFILED_AWS_REGION");
  if (role === null) invalid.push("UNFILED_AWS_ROLE_ARN");
  if (objectWrapArn === null) invalid.push("UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN");
  if (contentMacArn === null) invalid.push("UNFILED_AI_CONTENT_MAC_KMS_KEY_ARN");
  if (aiObjectWrapKmsKeyArn === aiContentMacKmsKeyArn) {
    invalid.push("UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN", "UNFILED_AI_CONTENT_MAC_KMS_KEY_ARN");
  }
  if (!validSubject) invalid.push("UNFILED_WORKER_EXPECTED_OIDC_SUBJECT");
  if (!/^prj_[A-Za-z0-9]+$/.test(vercelProjectId) || actualProjectId !== vercelProjectId) {
    invalid.push("UNFILED_WORKER_PROJECT_ID", "VERCEL_PROJECT_ID");
  }
  if (
    role !== null &&
    objectWrapArn !== null &&
    contentMacArn !== null &&
    (role[1] !== objectWrapArn[1] ||
      role[2] !== objectWrapArn[3] ||
      region !== objectWrapArn[2] ||
      role[1] !== contentMacArn[1] ||
      role[2] !== contentMacArn[3] ||
      region !== contentMacArn[2])
  ) {
    invalid.push(
      "UNFILED_AWS_ROLE_ARN",
      "UNFILED_AWS_REGION",
      "UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN",
      "UNFILED_AI_CONTENT_MAC_KMS_KEY_ARN"
    );
  }
  const rolePartition = role?.[1];
  const roleAccountId = role?.[2];
  if (
    invalid.length > 0 ||
    rolePartition === undefined ||
    roleAccountId === undefined ||
    objectWrapArn === null ||
    contentMacArn === null
  ) {
    throw new WorkerConfigurationError([...new Set(invalid)]);
  }
  const retiredRoots = parseRetiredAiRoots(environment, {
    accountId: roleAccountId,
    activeArns: [aiObjectWrapKmsKeyArn, aiContentMacKmsKeyArn],
    partition: rolePartition,
    region
  });

  return {
    aiContentMacKmsKeyArn,
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

export function loadWorkerConfig(environment: WorkerEnvironment = process.env): WorkerConfig {
  rejectCapabilities(environment, STATIC_AWS_CREDENTIALS);
  rejectCapabilities(environment, PRIVATE_MANUAL_CAPABILITIES);
  rejectCapabilities(environment, LEGACY_SINGULAR_KEY_VARIABLES);
  rejectCapabilities(environment, USER_SESSION_CAPABILITIES);
  rejectAmbientDatabaseCapabilities(environment);

  const runtime = parseRuntime(environment);
  const keyBoundary =
    runtime === "production"
      ? awsKeyBoundary(environment)
      : ({ kind: "local-synthetic", keyClass: "ai_assisted" } as const);
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
    requestTimeoutMs,
    runtime
  };
}
