import { WorkerConfigurationError } from "./errors";

const DEFAULT_MAX_REQUEST_BYTES = 1_024;
const DEFAULT_PORT = 8_788;
const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_AUTH_SECRET_LENGTH = 512;
const MAX_REQUEST_BYTES = 16_384;
const MAX_TIMEOUT_MS = 55_000;
const MIN_AUTH_SECRET_LENGTH = 32;
const MIN_TIMEOUT_MS = 1_000;
const MAX_RETIRED_AI_ROOTS_PER_PURPOSE = 20;
const MAX_RETIRED_ROOT_REGISTRY_BYTES = 32_768;
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

export type WorkerConfig = Readonly<{
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
  return {
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
    requestTimeoutMs: parseInteger(
      environment,
      "UNFILED_WORKER_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS
    ),
    runtime
  };
}
