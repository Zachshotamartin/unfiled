import { randomUUID } from "node:crypto";
import { lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

export const RELEASE_PROBE_SCHEMA = "unfiled.deployed-release-probe.v1" as const;
export const RELEASE_PROBE_ERROR_SCHEMA = "unfiled.deployed-release-probe-error.v1" as const;
export const PRODUCTION_CONFIRMATION = "I_CONFIRM_UNFILED_PRODUCTION_PROBE" as const;

const DEFAULT_TIMEOUT_MS = 5_000;
const MINIMUM_TIMEOUT_MS = 500;
const MAXIMUM_TIMEOUT_MS = 30_000;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DEPLOYMENT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

const targetNames = ["web", "organizer", "worker", "verifier", "search"] as const;
export type ReleaseProbeTarget = (typeof targetNames)[number];
export type ReleaseEnvironment = "preview" | "production";

const publicInformationRoutes = [
  {
    marker: "Your notes are personal. The policy should be plain.",
    name: "privacy",
    path: "/privacy"
  },
  {
    marker: "Terms for the Unfiled private beta.",
    name: "terms",
    path: "/terms"
  },
  {
    marker: "Security claims should be specific and testable.",
    name: "security",
    path: "/security"
  },
  {
    marker: "Get unstuck without sharing the note.",
    name: "support",
    path: "/support"
  },
  {
    marker: "Delete the account, not just the app.",
    name: "account-deletion",
    path: "/account-deletion"
  }
] as const;

const serviceNames: Readonly<Record<ReleaseProbeTarget, string>> = Object.freeze({
  organizer: "unfiled-organizer",
  search: "unfiled-search",
  verifier: "unfiled-rag-verifier",
  web: "unfiled-web",
  worker: "unfiled-worker"
});

const webSecurityHeaders = Object.freeze({
  "permissions-policy": "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
});

const isolatedServiceSecurityHeaders = Object.freeze({
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "permissions-policy": "camera=(), geolocation=(), microphone=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
});

export interface ReleaseProbeConfiguration {
  readonly deployments: Readonly<Record<ReleaseProbeTarget, string>>;
  readonly environment: ReleaseEnvironment;
  readonly expectedCommit: string;
  readonly origins: Readonly<Record<ReleaseProbeTarget, string>>;
  readonly outputPath?: string;
  readonly timeoutMs: number;
}

export type ProbeFailureCode =
  | "body_invalid_utf8"
  | "body_marker_mismatch"
  | "body_missing"
  | "body_mismatch"
  | "body_read_failed"
  | "body_too_large"
  | "cache_control_mismatch"
  | "content_length_invalid"
  | "content_type_mismatch"
  | "deployment_identity_mismatch"
  | "environment_identity_mismatch"
  | "forbidden_header_present"
  | "git_commit_identity_mismatch"
  | "network_failure"
  | "redirect_rejected"
  | "request_timeout"
  | "security_header_mismatch"
  | "status_mismatch";

export interface ReleaseProbeObservation {
  readonly failureCodes: readonly ProbeFailureCode[];
  readonly outcome: "pass" | "fail";
  readonly path: string;
  readonly surface: string;
  readonly target: ReleaseProbeTarget;
}

export interface ReleaseProbeSummary {
  readonly commit: string;
  readonly environment: ReleaseEnvironment;
  readonly observedAt: string;
  readonly outcome: "pass" | "fail";
  readonly probes: readonly ReleaseProbeObservation[];
  readonly schemaVersion: typeof RELEASE_PROBE_SCHEMA;
  readonly targets: readonly {
    readonly deploymentDigest: string;
    readonly target: ReleaseProbeTarget;
  }[];
  readonly totals: {
    readonly failed: number;
    readonly passed: number;
    readonly probes: number;
  };
}

type ConfigurationFailureCode =
  | "ambiguous_option_source"
  | "duplicate_option"
  | "invalid_commit"
  | "invalid_deployment_digest"
  | "invalid_environment"
  | "invalid_option_value"
  | "invalid_origin"
  | "invalid_output_path"
  | "invalid_timeout"
  | "missing_option"
  | "production_confirmation_required"
  | "production_confirmation_unexpected"
  | "reused_deployment_digest"
  | "reused_origin"
  | "unexpected_argument"
  | "unknown_option";

class ReleaseProbeConfigurationError extends Error {
  constructor(readonly code: ConfigurationFailureCode) {
    super(code);
    this.name = "ReleaseProbeConfigurationError";
  }
}

class ProbeTimeoutError extends Error {
  constructor() {
    super("request_timeout");
    this.name = "ProbeTimeoutError";
  }
}

class BoundedBodyError extends Error {
  constructor(readonly code: ProbeFailureCode) {
    super(code);
    this.name = "BoundedBodyError";
  }
}

interface ProbeSpecification {
  readonly bodyExpectation:
    | { readonly kind: "exact"; readonly value: string }
    | { readonly kind: "html-marker"; readonly value: string };
  readonly cacheControl: string;
  readonly contentType: string;
  readonly maximumBodyBytes: number;
  readonly path: string;
  readonly securityHeaders: Readonly<Record<string, string>>;
  readonly surface: string;
  readonly target: ReleaseProbeTarget;
}

export type ReleaseProbeFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface ReleaseProbeDependencies {
  readonly fetch: ReleaseProbeFetch;
  readonly now?: () => Date;
  readonly writeEvidence?: (outputPath: string, contents: string) => Promise<void>;
}

export interface ReleaseProbeCliExecution {
  readonly exitCode: 0 | 1;
  readonly stderr: string;
  readonly stdout: string;
}

const optionEnvironmentNames = Object.freeze({
  "--environment": "UNFILED_RELEASE_PROBE_ENVIRONMENT",
  "--expected-commit": "UNFILED_RELEASE_PROBE_EXPECTED_COMMIT",
  "--organizer-deployment": "UNFILED_RELEASE_PROBE_ORGANIZER_DEPLOYMENT",
  "--organizer-origin": "UNFILED_RELEASE_PROBE_ORGANIZER_ORIGIN",
  "--search-deployment": "UNFILED_RELEASE_PROBE_SEARCH_DEPLOYMENT",
  "--search-origin": "UNFILED_RELEASE_PROBE_SEARCH_ORIGIN",
  "--timeout-ms": "UNFILED_RELEASE_PROBE_TIMEOUT_MS",
  "--verifier-deployment": "UNFILED_RELEASE_PROBE_VERIFIER_DEPLOYMENT",
  "--verifier-origin": "UNFILED_RELEASE_PROBE_VERIFIER_ORIGIN",
  "--web-deployment": "UNFILED_RELEASE_PROBE_WEB_DEPLOYMENT",
  "--web-origin": "UNFILED_RELEASE_PROBE_WEB_ORIGIN",
  "--worker-deployment": "UNFILED_RELEASE_PROBE_WORKER_DEPLOYMENT",
  "--worker-origin": "UNFILED_RELEASE_PROBE_WORKER_ORIGIN"
} as const);

type EnvironmentBackedOption = keyof typeof optionEnvironmentNames;
type ParsedOptions = ReadonlyMap<string, string>;

const helpText = `Usage: pnpm release:probe [--] [options]

Required origins (flag or matching UNFILED_RELEASE_PROBE_* environment variable):
  --web-origin URL
  --organizer-origin URL
  --worker-origin URL
  --verifier-origin URL
  --search-origin URL

Required public release identity expectations (flag or matching environment variable):
  --expected-commit FULL_GIT_SHA
  --web-deployment sha256:HEX
  --organizer-deployment sha256:HEX
  --worker-deployment sha256:HEX
  --verifier-deployment sha256:HEX
  --search-deployment sha256:HEX

Optional:
  --environment preview|production  Defaults to preview.
  --timeout-ms 500..30000           Defaults to 5000.
  --output PATH                     Atomically writes the JSON summary.
  --confirm-production ${PRODUCTION_CONFIRMATION}
                                    Required as an explicit flag for Production.
  --help

The probe makes unauthenticated GET requests only. Deployment digests must be one-way
SHA-256 values, never raw Vercel deployment or project IDs.
`;

function parseOptions(arguments_: readonly string[]): ParsedOptions {
  const options = new Map<string, string>();
  const valueOptions = new Set<string>([
    ...Object.keys(optionEnvironmentNames),
    "--confirm-production",
    "--output"
  ]);

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) throw new ReleaseProbeConfigurationError("unexpected_argument");
    if (argument === "--" && index === 0) continue;
    if (argument === "--help") {
      if (options.has("--help")) throw new ReleaseProbeConfigurationError("duplicate_option");
      options.set("--help", "true");
      continue;
    }
    if (!argument.startsWith("--")) {
      throw new ReleaseProbeConfigurationError("unexpected_argument");
    }
    const separator = argument.indexOf("=");
    const name = separator === -1 ? argument : argument.slice(0, separator);
    if (!valueOptions.has(name)) throw new ReleaseProbeConfigurationError("unknown_option");
    if (options.has(name)) throw new ReleaseProbeConfigurationError("duplicate_option");
    const inlineValue = separator === -1 ? undefined : argument.slice(separator + 1);
    const value = inlineValue ?? arguments_[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new ReleaseProbeConfigurationError("invalid_option_value");
    }
    if (inlineValue === undefined) index += 1;
    options.set(name, value);
  }
  return options;
}

function environmentOption(
  options: ParsedOptions,
  environment: Readonly<Record<string, string | undefined>>,
  name: EnvironmentBackedOption,
  required: boolean
): string | undefined {
  const flagValue = options.get(name);
  const environmentValue = environment[optionEnvironmentNames[name]];
  if (flagValue !== undefined && environmentValue !== undefined && flagValue !== environmentValue) {
    throw new ReleaseProbeConfigurationError("ambiguous_option_source");
  }
  const value = flagValue ?? environmentValue;
  if (required && (value === undefined || value.length === 0)) {
    throw new ReleaseProbeConfigurationError("missing_option");
  }
  return value;
}

function exactEnvironment(value: string | undefined): ReleaseEnvironment {
  const selected = value ?? "preview";
  if (selected !== "preview" && selected !== "production") {
    throw new ReleaseProbeConfigurationError("invalid_environment");
  }
  return selected;
}

function exactCommit(value: string | undefined): string {
  if (value === undefined || !GIT_SHA_PATTERN.test(value)) {
    throw new ReleaseProbeConfigurationError("invalid_commit");
  }
  return value;
}

function deploymentDigest(value: string | undefined): string {
  if (value === undefined || !DEPLOYMENT_DIGEST_PATTERN.test(value)) {
    throw new ReleaseProbeConfigurationError("invalid_deployment_digest");
  }
  return value;
}

function hasAsciiControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

function isDnsName(host: string): boolean {
  if (host.length > 253) return false;
  const labels = host.split(".");
  if (labels.length < 2 || !/[a-z]/u.test(labels.at(-1) ?? "")) return false;
  return labels.every(
    (label) =>
      label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
  );
}

function safeOrigin(value: string | undefined): string {
  if (
    value === undefined ||
    value.trim() !== value ||
    value.length > 512 ||
    hasAsciiControlCharacter(value)
  ) {
    throw new ReleaseProbeConfigurationError("invalid_origin");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ReleaseProbeConfigurationError("invalid_origin");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    !isDnsName(host) ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".test") ||
    host.endsWith(".invalid") ||
    host.endsWith(".example")
  ) {
    throw new ReleaseProbeConfigurationError("invalid_origin");
  }
  return url.origin;
}

function exactTimeout(value: string | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!/^\d+$/u.test(value)) throw new ReleaseProbeConfigurationError("invalid_timeout");
  const milliseconds = Number(value);
  if (milliseconds < MINIMUM_TIMEOUT_MS || milliseconds > MAXIMUM_TIMEOUT_MS) {
    throw new ReleaseProbeConfigurationError("invalid_timeout");
  }
  return milliseconds;
}

function safeOutputPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (
    value.trim() !== value ||
    value.length === 0 ||
    value.length > 4_096 ||
    hasAsciiControlCharacter(value) ||
    value.endsWith(path.sep)
  ) {
    throw new ReleaseProbeConfigurationError("invalid_output_path");
  }
  return value;
}

export function parseReleaseProbeConfiguration(
  arguments_: readonly string[],
  processEnvironment: Readonly<Record<string, string | undefined>>
): ReleaseProbeConfiguration | { readonly help: true } {
  const options = parseOptions(arguments_);
  if (options.has("--help")) {
    if (options.size !== 1) throw new ReleaseProbeConfigurationError("unexpected_argument");
    return { help: true };
  }

  const environment = exactEnvironment(
    environmentOption(options, processEnvironment, "--environment", false)
  );
  const confirmation = options.get("--confirm-production");
  if (environment === "production" && confirmation !== PRODUCTION_CONFIRMATION) {
    throw new ReleaseProbeConfigurationError("production_confirmation_required");
  }
  if (environment === "preview" && confirmation !== undefined) {
    throw new ReleaseProbeConfigurationError("production_confirmation_unexpected");
  }

  const origins = Object.freeze({
    organizer: safeOrigin(
      environmentOption(options, processEnvironment, "--organizer-origin", true)
    ),
    search: safeOrigin(environmentOption(options, processEnvironment, "--search-origin", true)),
    verifier: safeOrigin(environmentOption(options, processEnvironment, "--verifier-origin", true)),
    web: safeOrigin(environmentOption(options, processEnvironment, "--web-origin", true)),
    worker: safeOrigin(environmentOption(options, processEnvironment, "--worker-origin", true))
  });
  if (new Set(Object.values(origins)).size !== targetNames.length) {
    throw new ReleaseProbeConfigurationError("reused_origin");
  }

  const deployments = Object.freeze({
    organizer: deploymentDigest(
      environmentOption(options, processEnvironment, "--organizer-deployment", true)
    ),
    search: deploymentDigest(
      environmentOption(options, processEnvironment, "--search-deployment", true)
    ),
    verifier: deploymentDigest(
      environmentOption(options, processEnvironment, "--verifier-deployment", true)
    ),
    web: deploymentDigest(environmentOption(options, processEnvironment, "--web-deployment", true)),
    worker: deploymentDigest(
      environmentOption(options, processEnvironment, "--worker-deployment", true)
    )
  });
  if (new Set(Object.values(deployments)).size !== targetNames.length) {
    throw new ReleaseProbeConfigurationError("reused_deployment_digest");
  }

  const outputPath = safeOutputPath(options.get("--output"));
  return {
    deployments,
    environment,
    expectedCommit: exactCommit(
      environmentOption(options, processEnvironment, "--expected-commit", true)
    ),
    origins,
    ...(outputPath === undefined ? {} : { outputPath }),
    timeoutMs: exactTimeout(environmentOption(options, processEnvironment, "--timeout-ms", false))
  };
}

function expectedRobots(origin: string): string {
  return [
    "User-Agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Disallow: /app",
    "Disallow: /auth",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    ""
  ].join("\n");
}

function expectedSitemap(origin: string): string {
  const routes = ["", ...publicInformationRoutes.map(({ path: routePath }) => routePath)];
  const entries = routes
    .map((routePath) => {
      const priority = routePath === "" ? "1" : routePath === "/support" ? "0.6" : "0.4";
      return [
        "<url>",
        `<loc>${origin}${routePath}</loc>`,
        "<changefreq>monthly</changefreq>",
        `<priority>${priority}</priority>`,
        "</url>"
      ].join("\n");
    })
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    entries,
    "</urlset>",
    ""
  ].join("\n");
}

function expectedSecurityText(): string {
  return [
    "Contact: https://github.com/Zachshotamartin/unfiled/security/advisories/new",
    "Expires: 2027-08-31T23:59:59Z",
    "Preferred-Languages: en",
    "Canonical: https://unfiled.app/.well-known/security.txt",
    "Policy: https://unfiled.app/security",
    ""
  ].join("\n");
}

function specifications(configuration: ReleaseProbeConfiguration): readonly ProbeSpecification[] {
  const webHealth: ProbeSpecification = {
    bodyExpectation: {
      kind: "exact",
      value: JSON.stringify({ service: serviceNames.web, status: "ok" })
    },
    cacheControl: "no-store",
    contentType: "application/json",
    maximumBodyBytes: 256,
    path: "/api/health",
    securityHeaders: webSecurityHeaders,
    surface: "health",
    target: "web"
  };
  const publicPages = publicInformationRoutes.map(
    ({ marker, name, path: routePath }): ProbeSpecification => ({
      bodyExpectation: { kind: "html-marker", value: marker },
      cacheControl: "public, max-age=0, must-revalidate",
      contentType: "text/html; charset=utf-8",
      maximumBodyBytes: 131_072,
      path: routePath,
      securityHeaders: webSecurityHeaders,
      surface: name,
      target: "web"
    })
  );
  const discovery: readonly ProbeSpecification[] = [
    {
      bodyExpectation: { kind: "exact", value: expectedRobots(configuration.origins.web) },
      cacheControl: "public, max-age=0, must-revalidate",
      contentType: "text/plain; charset=utf-8",
      maximumBodyBytes: 2_048,
      path: "/robots.txt",
      securityHeaders: webSecurityHeaders,
      surface: "robots",
      target: "web"
    },
    {
      bodyExpectation: { kind: "exact", value: expectedSitemap(configuration.origins.web) },
      cacheControl: "public, max-age=0, must-revalidate",
      contentType: "application/xml",
      maximumBodyBytes: 16_384,
      path: "/sitemap.xml",
      securityHeaders: webSecurityHeaders,
      surface: "sitemap",
      target: "web"
    },
    {
      bodyExpectation: { kind: "exact", value: expectedSecurityText() },
      cacheControl: "public, max-age=3600",
      contentType: "text/plain; charset=utf-8",
      maximumBodyBytes: 4_096,
      path: "/.well-known/security.txt",
      securityHeaders: webSecurityHeaders,
      surface: "security-text",
      target: "web"
    }
  ];
  const isolatedHealth = (["organizer", "worker", "verifier", "search"] as const).map(
    (target): ProbeSpecification => ({
      bodyExpectation: {
        kind: "exact",
        value: JSON.stringify({ service: serviceNames[target], status: "ok" })
      },
      cacheControl: "no-store",
      contentType: "application/json; charset=utf-8",
      maximumBodyBytes: 256,
      path: "/health",
      securityHeaders: isolatedServiceSecurityHeaders,
      surface: "health",
      target
    })
  );
  return [webHealth, ...publicPages, ...discovery, ...isolatedHealth];
}

function addFailure(failures: ProbeFailureCode[], code: ProbeFailureCode): void {
  if (!failures.includes(code)) failures.push(code);
}

function validateHeaders(
  response: Response,
  specification: ProbeSpecification,
  configuration: ReleaseProbeConfiguration,
  failures: ProbeFailureCode[]
): void {
  if (response.headers.get("content-type") !== specification.contentType) {
    addFailure(failures, "content_type_mismatch");
  }
  if (response.headers.get("cache-control") !== specification.cacheControl) {
    addFailure(failures, "cache_control_mismatch");
  }
  for (const [name, expected] of Object.entries(specification.securityHeaders)) {
    if (response.headers.get(name) !== expected) addFailure(failures, "security_header_mismatch");
  }
  if (
    response.headers.has("set-cookie") ||
    response.headers.has("location") ||
    response.headers.has("www-authenticate") ||
    response.headers.has("x-powered-by")
  ) {
    addFailure(failures, "forbidden_header_present");
  }
  if (
    response.headers.get("x-unfiled-deployment") !== configuration.deployments[specification.target]
  ) {
    addFailure(failures, "deployment_identity_mismatch");
  }
  if (response.headers.get("x-unfiled-commit") !== configuration.expectedCommit) {
    addFailure(failures, "git_commit_identity_mismatch");
  }
  if (response.headers.get("x-unfiled-environment") !== configuration.environment) {
    addFailure(failures, "environment_identity_mismatch");
  }
  if (specification.target !== "web" && response.headers.get("allow") !== "GET, HEAD") {
    addFailure(failures, "security_header_mismatch");
  }
}

async function boundedBody(response: Response, maximumBytes: number): Promise<string> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximumBytes)) {
    throw new BoundedBodyError(/^\d+$/u.test(length) ? "body_too_large" : "content_length_invalid");
  }
  if (response.body === null) throw new BoundedBodyError("body_missing");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BoundedBodyError("body_too_large");
      }
      chunks.push(result.value);
    }
  } catch (error: unknown) {
    if (error instanceof BoundedBodyError) throw error;
    throw new BoundedBodyError("body_read_failed");
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BoundedBodyError("body_invalid_utf8");
  }
}

async function observe(
  specification: ProbeSpecification,
  configuration: ReleaseProbeConfiguration,
  fetchImplementation: ReleaseProbeFetch
): Promise<ReleaseProbeObservation> {
  const failures: ProbeFailureCode[] = [];
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new ProbeTimeoutError());
      controller.abort();
    }, configuration.timeoutMs);
  });
  const request = async (): Promise<ProbeFailureCode[]> => {
    const requestFailures: ProbeFailureCode[] = [];
    const response = await fetchImplementation(
      `${configuration.origins[specification.target]}${specification.path}`,
      {
        cache: "no-store",
        credentials: "omit",
        headers: {
          accept: specification.contentType.split(";", 1)[0] ?? "*/*",
          "user-agent": "unfiled-release-probe/1"
        },
        method: "GET",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal
      }
    );
    if (response.redirected) addFailure(requestFailures, "redirect_rejected");
    if (response.status !== 200) addFailure(requestFailures, "status_mismatch");
    validateHeaders(response, specification, configuration, requestFailures);
    try {
      const body = await boundedBody(response, specification.maximumBodyBytes);
      if (specification.bodyExpectation.kind === "exact") {
        if (body !== specification.bodyExpectation.value) {
          addFailure(requestFailures, "body_mismatch");
        }
      } else if (
        !body.includes('id="main-content"') ||
        !body.includes(specification.bodyExpectation.value)
      ) {
        addFailure(requestFailures, "body_marker_mismatch");
      }
    } catch (error: unknown) {
      addFailure(
        requestFailures,
        error instanceof BoundedBodyError ? error.code : "body_read_failed"
      );
    }
    return requestFailures;
  };

  try {
    failures.push(...(await Promise.race([request(), timeout])));
  } catch (error: unknown) {
    addFailure(
      failures,
      timedOut || error instanceof ProbeTimeoutError ? "request_timeout" : "network_failure"
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  return {
    failureCodes: failures,
    outcome: failures.length === 0 ? "pass" : "fail",
    path: specification.path,
    surface: specification.surface,
    target: specification.target
  };
}

export async function probeDeployedRelease(
  configuration: ReleaseProbeConfiguration,
  dependencies: Pick<ReleaseProbeDependencies, "fetch" | "now">
): Promise<ReleaseProbeSummary> {
  const observedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const probes = await Promise.all(
    specifications(configuration).map((specification) =>
      observe(specification, configuration, dependencies.fetch)
    )
  );
  const failed = probes.filter(({ outcome }) => outcome === "fail").length;
  return {
    commit: configuration.expectedCommit,
    environment: configuration.environment,
    observedAt,
    outcome: failed === 0 ? "pass" : "fail",
    probes,
    schemaVersion: RELEASE_PROBE_SCHEMA,
    targets: targetNames.map((target) => ({
      deploymentDigest: configuration.deployments[target],
      target
    })),
    totals: {
      failed,
      passed: probes.length - failed,
      probes: probes.length
    }
  };
}

export async function atomicWriteReleaseProbeEvidence(
  outputPath: string,
  contents: string
): Promise<void> {
  const resolved = path.resolve(outputPath);
  const directory = path.dirname(resolved);
  const filename = path.basename(resolved);
  let existing: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    existing = await lstat(resolved);
  } catch (error: unknown) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  if (existing !== undefined && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error("unsafe_output_target");
  }

  const temporary = path.join(directory, `.${filename}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, resolved);
  } catch {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw new Error("evidence_write_failed");
  }
}

function serialized(value: unknown): string {
  return `${JSON.stringify(value, undefined, 2)}\n`;
}

function safeCliError(failure: string): string {
  return serialized({
    failure,
    outcome: "fail",
    schemaVersion: RELEASE_PROBE_ERROR_SCHEMA
  });
}

export async function executeReleaseProbeCli(
  arguments_: readonly string[],
  processEnvironment: Readonly<Record<string, string | undefined>>,
  dependencies: ReleaseProbeDependencies
): Promise<ReleaseProbeCliExecution> {
  let configuration: ReleaseProbeConfiguration | { readonly help: true };
  try {
    configuration = parseReleaseProbeConfiguration(arguments_, processEnvironment);
  } catch (error: unknown) {
    const failure =
      error instanceof ReleaseProbeConfigurationError ? error.code : "configuration_invalid";
    return { exitCode: 1, stderr: "", stdout: safeCliError(failure) };
  }
  if ("help" in configuration) {
    return { exitCode: 0, stderr: "", stdout: helpText };
  }

  let summary: ReleaseProbeSummary;
  try {
    summary = await probeDeployedRelease(configuration, dependencies);
  } catch {
    return { exitCode: 1, stderr: "", stdout: safeCliError("probe_internal_failure") };
  }
  const output = serialized(summary);
  if (configuration.outputPath !== undefined) {
    try {
      await (dependencies.writeEvidence ?? atomicWriteReleaseProbeEvidence)(
        configuration.outputPath,
        output
      );
    } catch {
      return { exitCode: 1, stderr: "", stdout: safeCliError("evidence_write_failed") };
    }
  }
  return {
    exitCode: summary.outcome === "pass" ? 0 : 1,
    stderr: "",
    stdout: output
  };
}
