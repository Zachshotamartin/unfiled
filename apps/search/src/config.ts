import { SearchConfigurationError } from "./errors.js";

export const SEARCH_EMBEDDING_MODEL_ID = "text-embedding-3-small" as const;
export const SEARCH_EMBEDDING_DIMENSIONS = 1_536 as const;
export const SEARCH_OIDC_AUDIENCE = "sts.amazonaws.com" as const;

const DEFAULT_PORT = 8_791;
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_REQUEST_BYTES = 16_384;
const MAX_CA_BYTES = 32_768;
const KMS_ARN =
  /^arn:(aws(?:-us-gov|-cn)?):kms:([a-z0-9-]+):(\d{12}):key\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const IAM_ROLE_ARN = /^arn:(aws(?:-us-gov|-cn)?):iam::(\d{12}):role\/[A-Za-z0-9+=,.@_/-]+$/u;
const VERCEL_PROJECT_ID = /^prj_[A-Za-z0-9]{6,100}$/u;
const PROJECT_REF = /^[a-z0-9]{20}$/u;

export type SearchRuntime = "local" | "preview" | "production";
export type SearchEnvironment = Readonly<Record<string, string | undefined>>;
export type SearchTrustedSource = Readonly<{
  audience: string;
  environment: "preview" | "production";
  expectedSubject: string;
  issuer: string;
  ownerId: string;
  projectId: string;
  projectName: string;
  teamSlug: string;
}>;
export type SearchKeyBoundary =
  | Readonly<{ kind: "local-disabled" }>
  | Readonly<{
      activeObjectWrapKeyArn: string;
      expectedOidcSubject: string;
      kind: "aws-oidc";
      region: string;
      retiredObjectWrapKeyArns: readonly string[];
      roleArn: string;
      vercelProjectId: string;
    }>;
export type SearchPipeline =
  | Readonly<{ kind: "disabled" }>
  | Readonly<{
      database: Readonly<{
        caPem: string;
        connectTimeoutMs: number;
        expectedHost: string;
        projectRef: string;
        statementTimeoutMs: number;
        url: string;
      }>;
      kind: "enabled";
      providerApiKey: string;
    }>;
export type SearchInvocation =
  | Readonly<{ kind: "local-bearer"; secret: string }>
  | Readonly<{ kind: "trusted-source"; source: SearchTrustedSource }>;
export type SearchConfig = Readonly<{
  invocation: SearchInvocation;
  keyBoundary: SearchKeyBoundary;
  maxRequestBytes: number;
  pipeline: SearchPipeline;
  port: number;
  requestTimeoutMs: number;
  runtime: SearchRuntime;
}>;

function fail(): never {
  throw new SearchConfigurationError();
}

function value(environment: SearchEnvironment, name: string): string {
  const result = environment[name]?.trim();
  return result === undefined || result.length === 0 ? fail() : result;
}

function hasValue(environment: SearchEnvironment, name: string): boolean {
  return (environment[name]?.trim().length ?? 0) > 0;
}

function hasUnsafeSecretCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

function boundedInteger(
  environment: SearchEnvironment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = environment[name]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  if (!/^\d+$/u.test(raw)) return fail();
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fail();
}

function runtime(environment: SearchEnvironment): SearchRuntime {
  const selected = value(environment, "UNFILED_SEARCH_ENV");
  if (selected !== "local" && selected !== "preview" && selected !== "production") return fail();
  if (selected === "local") {
    if (environment.VERCEL !== undefined || environment.VERCEL_ENV !== undefined) return fail();
  } else if (environment.VERCEL !== "1" || environment.VERCEL_ENV !== selected) {
    return fail();
  }
  return selected;
}

function assertNoAmbientCapabilities(environment: SearchEnvironment): void {
  const explicitlyForbidden = new Set([
    "ANTHROPIC_API_KEY",
    "AUTH_SECRET",
    "AWS_ACCESS_KEY_ID",
    "AWS_PROFILE",
    "AWS_SECURITY_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_SESSION_TOKEN",
    "CRON_SECRET",
    "NEXTAUTH_SECRET",
    "OPENAI_API_KEY",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "UNFILED_AI_CONTENT_MAC_KMS_KEY_ARN",
    "UNFILED_PRIVATE_CONTENT_MAC_KMS_KEY_ARN",
    "UNFILED_PRIVATE_OBJECT_WRAP_KMS_KEY_ARN"
  ]);
  const forbidden = Object.keys(environment).filter((name) => {
    if (!hasValue(environment, name)) return false;
    if (explicitlyForbidden.has(name)) return true;
    if (/SUPABASE/iu.test(name)) return true;
    if (/^(?:DATABASE_URL|POSTGRES(?:QL)?_|PG(?:HOST|USER|PASSWORD|DATABASE|PORT))/u.test(name)) {
      return true;
    }
    if (
      /(?:OPENAI|ANTHROPIC|PROVIDER).*KEY/iu.test(name) &&
      name !== "UNFILED_SEARCH_OPENAI_API_KEY"
    ) {
      return true;
    }
    return false;
  });
  if (forbidden.length > 0) fail();
}

function localConfig(environment: SearchEnvironment): Omit<SearchConfig, "runtime"> {
  const secret = value(environment, "UNFILED_SEARCH_INVOCATION_SECRET");
  if (secret.length < 32 || secret.length > 512 || hasUnsafeSecretCharacter(secret)) fail();
  return {
    invocation: { kind: "local-bearer", secret },
    keyBoundary: { kind: "local-disabled" },
    maxRequestBytes: boundedInteger(
      environment,
      "UNFILED_SEARCH_MAX_REQUEST_BYTES",
      DEFAULT_MAX_REQUEST_BYTES,
      1_024,
      32_768
    ),
    pipeline: { kind: "disabled" },
    port: boundedInteger(environment, "PORT", DEFAULT_PORT, 1_024, 65_535),
    requestTimeoutMs: boundedInteger(
      environment,
      "UNFILED_SEARCH_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS,
      1_000,
      29_000
    )
  };
}

function pem(environment: SearchEnvironment): string {
  const encoded = value(environment, "UNFILED_SEARCH_DATABASE_CA_PEM_BASE64");
  if (
    encoded.length > Math.ceil((MAX_CA_BYTES * 4) / 3) + 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)
  ) {
    return fail();
  }
  const bytes = Buffer.from(encoded, "base64");
  try {
    const decoded = bytes.toString("utf8");
    if (
      bytes.toString("base64").replace(/=+$/u, "") !== encoded.replace(/=+$/u, "") ||
      !decoded.startsWith("-----BEGIN CERTIFICATE-----\n") ||
      !decoded.endsWith("-----END CERTIFICATE-----\n") ||
      bytes.byteLength > MAX_CA_BYTES
    ) {
      return fail();
    }
    return decoded;
  } finally {
    bytes.fill(0);
  }
}

function retiredRoots(
  environment: SearchEnvironment,
  active: string,
  expected: Readonly<{ account: string; partition: string; region: string }>
): readonly string[] {
  const raw = environment.UNFILED_SEARCH_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON?.trim() ?? "[]";
  if (new TextEncoder().encode(raw).byteLength > 32_768) return fail();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail();
  }
  if (!Array.isArray(parsed) || parsed.length > 20) return fail();
  const roots = parsed.map((entry) => {
    const match = typeof entry === "string" ? KMS_ARN.exec(entry) : null;
    if (
      match?.[1] !== expected.partition ||
      match[2] !== expected.region ||
      match[3] !== expected.account ||
      entry === active
    ) {
      return fail();
    }
    return entry as string;
  });
  if (new Set(roots).size !== roots.length) return fail();
  return Object.freeze(roots);
}

function trustedSource(
  environment: SearchEnvironment,
  selectedRuntime: "preview" | "production"
): SearchTrustedSource {
  const teamSlug = value(environment, "UNFILED_SEARCH_TRUSTED_SOURCE_TEAM_SLUG");
  const ownerId = value(environment, "UNFILED_SEARCH_TRUSTED_SOURCE_OWNER_ID");
  const projectId = value(environment, "UNFILED_SEARCH_TRUSTED_SOURCE_WEB_PROJECT_ID");
  const projectName = value(environment, "UNFILED_SEARCH_TRUSTED_SOURCE_WEB_PROJECT_NAME");
  const expectedSubject = value(environment, "UNFILED_SEARCH_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT");
  if (
    !/^[a-z0-9][a-z0-9-]{0,99}$/u.test(teamSlug) ||
    !/^[A-Za-z0-9_]{3,128}$/u.test(ownerId) ||
    !VERCEL_PROJECT_ID.test(projectId) ||
    !/^[a-z0-9][a-z0-9-]{0,99}$/u.test(projectName) ||
    expectedSubject !== `owner:${teamSlug}:project:${projectName}:environment:${selectedRuntime}`
  ) {
    return fail();
  }
  return Object.freeze({
    audience: `https://vercel.com/${teamSlug}`,
    environment: selectedRuntime,
    expectedSubject,
    issuer: `https://oidc.vercel.com/${teamSlug}`,
    ownerId,
    projectId,
    projectName,
    teamSlug
  });
}

function cloudConfig(
  environment: SearchEnvironment,
  selectedRuntime: "preview" | "production"
): Omit<SearchConfig, "runtime"> {
  const projectTeamSlug = value(environment, "UNFILED_SEARCH_PROJECT_TEAM_SLUG");
  const projectName = value(environment, "UNFILED_SEARCH_PROJECT_NAME");
  const region = value(environment, "UNFILED_AWS_REGION");
  const roleArn = value(environment, "UNFILED_SEARCH_AWS_ROLE_ARN");
  const activeObjectWrapKeyArn = value(environment, "UNFILED_SEARCH_AI_OBJECT_WRAP_KMS_KEY_ARN");
  const expectedOidcSubject = value(environment, "UNFILED_SEARCH_EXPECTED_OIDC_SUBJECT");
  const vercelProjectId = value(environment, "UNFILED_SEARCH_PROJECT_ID");
  const role = IAM_ROLE_ARN.exec(roleArn);
  const kms = KMS_ARN.exec(activeObjectWrapKeyArn);
  if (
    role === null ||
    kms === null ||
    role[1] !== kms[1] ||
    role[2] !== kms[3] ||
    kms[2] !== region ||
    !VERCEL_PROJECT_ID.test(vercelProjectId) ||
    environment.VERCEL_PROJECT_ID !== vercelProjectId ||
    !/^[a-z0-9][a-z0-9-]{0,99}$/u.test(projectTeamSlug) ||
    !/^[a-z0-9][a-z0-9-]{0,99}$/u.test(projectName) ||
    expectedOidcSubject !==
      `owner:${projectTeamSlug}:project:${projectName}:environment:${selectedRuntime}`
  ) {
    return fail();
  }
  const providerApiKey = value(environment, "UNFILED_SEARCH_OPENAI_API_KEY");
  if (
    providerApiKey.length < 20 ||
    providerApiKey.length > 512 ||
    hasUnsafeSecretCharacter(providerApiKey)
  ) {
    return fail();
  }
  const projectRef = value(environment, "UNFILED_SEARCH_DATABASE_PROJECT_REF");
  if (!PROJECT_REF.test(projectRef)) return fail();
  return {
    invocation: { kind: "trusted-source", source: trustedSource(environment, selectedRuntime) },
    keyBoundary: {
      activeObjectWrapKeyArn,
      expectedOidcSubject,
      kind: "aws-oidc",
      region,
      retiredObjectWrapKeyArns: retiredRoots(environment, activeObjectWrapKeyArn, {
        account: role[2] ?? fail(),
        partition: role[1] ?? fail(),
        region
      }),
      roleArn,
      vercelProjectId
    },
    maxRequestBytes: boundedInteger(
      environment,
      "UNFILED_SEARCH_MAX_REQUEST_BYTES",
      DEFAULT_MAX_REQUEST_BYTES,
      1_024,
      32_768
    ),
    pipeline: {
      database: {
        caPem: pem(environment),
        connectTimeoutMs: boundedInteger(
          environment,
          "UNFILED_SEARCH_DATABASE_CONNECT_TIMEOUT_MS",
          3_000,
          250,
          10_000
        ),
        expectedHost: value(environment, "UNFILED_SEARCH_DATABASE_EXPECTED_HOST"),
        projectRef,
        statementTimeoutMs: boundedInteger(
          environment,
          "UNFILED_SEARCH_DATABASE_STATEMENT_TIMEOUT_MS",
          2_000,
          250,
          10_000
        ),
        url: value(environment, "UNFILED_SEARCH_DATABASE_URL")
      },
      kind: "enabled",
      providerApiKey
    },
    port: boundedInteger(environment, "PORT", DEFAULT_PORT, 1_024, 65_535),
    requestTimeoutMs: boundedInteger(
      environment,
      "UNFILED_SEARCH_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS,
      1_000,
      29_000
    )
  };
}

export function loadSearchConfig(environment: SearchEnvironment = process.env): SearchConfig {
  assertNoAmbientCapabilities(environment);
  const selectedRuntime = runtime(environment);
  const config =
    selectedRuntime === "local"
      ? localConfig(environment)
      : cloudConfig(environment, selectedRuntime);
  return Object.freeze({ ...config, runtime: selectedRuntime });
}
