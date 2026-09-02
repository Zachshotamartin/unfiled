import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PRODUCTION_CONFIRMATION,
  RELEASE_PROBE_ERROR_SCHEMA,
  RELEASE_PROBE_SCHEMA,
  atomicWriteReleaseProbeEvidence,
  executeReleaseProbeCli,
  parseReleaseProbeConfiguration,
  probeDeployedRelease,
  type ReleaseProbeConfiguration,
  type ReleaseProbeFetch,
  type ReleaseProbeTarget
} from "./deployed-release-probe.js";

const COMMIT = "a".repeat(40);
const FIXED_NOW = new Date("2026-09-02T19:20:21.000Z");
const ORIGINS = Object.freeze({
  organizer: "https://unfiled-organizer-preview.vercel.app",
  search: "https://unfiled-search-preview.vercel.app",
  verifier: "https://unfiled-verifier-preview.vercel.app",
  web: "https://unfiled-web-preview.vercel.app",
  worker: "https://unfiled-worker-preview.vercel.app"
});
const DEPLOYMENTS = Object.freeze({
  organizer: `sha256:${"b".repeat(64)}`,
  search: `sha256:${"e".repeat(64)}`,
  verifier: `sha256:${"d".repeat(64)}`,
  web: `sha256:${"a".repeat(64)}`,
  worker: `sha256:${"c".repeat(64)}`
});
const ENVIRONMENT = Object.freeze({
  UNFILED_RELEASE_PROBE_EXPECTED_COMMIT: COMMIT,
  UNFILED_RELEASE_PROBE_ORGANIZER_DEPLOYMENT: DEPLOYMENTS.organizer,
  UNFILED_RELEASE_PROBE_ORGANIZER_ORIGIN: ORIGINS.organizer,
  UNFILED_RELEASE_PROBE_SEARCH_DEPLOYMENT: DEPLOYMENTS.search,
  UNFILED_RELEASE_PROBE_SEARCH_ORIGIN: ORIGINS.search,
  UNFILED_RELEASE_PROBE_VERIFIER_DEPLOYMENT: DEPLOYMENTS.verifier,
  UNFILED_RELEASE_PROBE_VERIFIER_ORIGIN: ORIGINS.verifier,
  UNFILED_RELEASE_PROBE_WEB_DEPLOYMENT: DEPLOYMENTS.web,
  UNFILED_RELEASE_PROBE_WEB_ORIGIN: ORIGINS.web,
  UNFILED_RELEASE_PROBE_WORKER_DEPLOYMENT: DEPLOYMENTS.worker,
  UNFILED_RELEASE_PROBE_WORKER_ORIGIN: ORIGINS.worker
});

const PAGE_MARKERS: Readonly<Record<string, string>> = Object.freeze({
  "/account-deletion": "Delete the account, not just the app.",
  "/privacy": "Your notes are personal. The policy should be plain.",
  "/security": "Security claims should be specific and testable.",
  "/support": "Get unstuck without sharing the note.",
  "/terms": "Terms for the Unfiled private beta."
});

const SERVICE_NAMES: Readonly<Record<ReleaseProbeTarget, string>> = Object.freeze({
  organizer: "unfiled-organizer",
  search: "unfiled-search",
  verifier: "unfiled-rag-verifier",
  web: "unfiled-web",
  worker: "unfiled-worker"
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
  vi.restoreAllMocks();
});

function configuration(
  overrides: Partial<ReleaseProbeConfiguration> = {}
): ReleaseProbeConfiguration {
  const parsed = parseReleaseProbeConfiguration([], ENVIRONMENT);
  if ("help" in parsed) throw new Error("test configuration unexpectedly selected help");
  return { ...parsed, ...overrides };
}

function robots(origin: string): string {
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

function sitemap(origin: string): string {
  const paths = ["", "/privacy", "/terms", "/security", "/support", "/account-deletion"];
  const entries = paths
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

function securityText(): string {
  return [
    "Contact: https://github.com/Zachshotamartin/unfiled/security/advisories/new",
    "Expires: 2027-08-31T23:59:59Z",
    "Preferred-Languages: en",
    "Canonical: https://unfiled.app/.well-known/security.txt",
    "Policy: https://unfiled.app/security",
    ""
  ].join("\n");
}

interface ResponseFixture {
  readonly body: string;
  readonly headers: Headers;
  readonly target: ReleaseProbeTarget;
}

function targetFor(url: URL, selected: ReleaseProbeConfiguration): ReleaseProbeTarget {
  const entry = (Object.entries(selected.origins) as [ReleaseProbeTarget, string][]).find(
    ([, origin]) => new URL(origin).host === url.host
  );
  if (entry === undefined) throw new Error("unexpected test origin");
  return entry[0];
}

function healthyFixture(url: URL, selected: ReleaseProbeConfiguration): ResponseFixture {
  const target = targetFor(url, selected);
  const headers = new Headers({
    "x-unfiled-commit": selected.expectedCommit,
    "x-unfiled-deployment": selected.deployments[target],
    "x-unfiled-environment": selected.environment
  });
  if (target === "web") {
    headers.set(
      "permissions-policy",
      "camera=(), microphone=(), geolocation=(), browsing-topics=()"
    );
    headers.set("referrer-policy", "strict-origin-when-cross-origin");
    headers.set("x-content-type-options", "nosniff");
    headers.set("x-frame-options", "DENY");
    if (url.pathname === "/api/health") {
      headers.set("cache-control", "no-store");
      headers.set("content-type", "application/json");
      return {
        body: JSON.stringify({ service: SERVICE_NAMES.web, status: "ok" }),
        headers,
        target
      };
    }
    const marker = PAGE_MARKERS[url.pathname];
    if (marker !== undefined) {
      headers.set("cache-control", "public, max-age=0, must-revalidate");
      headers.set("content-type", "text/html; charset=utf-8");
      return { body: `<main id="main-content"><h1>${marker}</h1></main>`, headers, target };
    }
    if (url.pathname === "/robots.txt") {
      headers.set("cache-control", "public, max-age=0, must-revalidate");
      headers.set("content-type", "text/plain");
      return { body: robots(selected.origins.web), headers, target };
    }
    if (url.pathname === "/sitemap.xml") {
      headers.set("cache-control", "public, max-age=0, must-revalidate");
      headers.set("content-type", "application/xml");
      return { body: sitemap(selected.origins.web), headers, target };
    }
    if (url.pathname === "/.well-known/security.txt") {
      headers.set("cache-control", "public, max-age=3600");
      headers.set("content-type", "text/plain; charset=utf-8");
      return { body: securityText(), headers, target };
    }
    throw new Error("unexpected test web route");
  }

  headers.set("allow", "GET, HEAD");
  headers.set("cache-control", "no-store");
  headers.set("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("permissions-policy", "camera=(), geolocation=(), microphone=()");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  return {
    body: JSON.stringify({ service: SERVICE_NAMES[target], status: "ok" }),
    headers,
    target
  };
}

function healthyFetch(
  selected: ReleaseProbeConfiguration,
  override?: (
    url: URL,
    fixture: ResponseFixture,
    init: RequestInit | undefined
  ) => Response | undefined
): ReleaseProbeFetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const fixture = healthyFixture(url, selected);
    return (
      override?.(url, fixture, init) ??
      new Response(fixture.body, { headers: fixture.headers, status: 200 })
    );
  });
}

describe("release probe configuration", () => {
  it("accepts a complete Preview configuration from the allowlisted environment", () => {
    expect(parseReleaseProbeConfiguration([], ENVIRONMENT)).toEqual({
      deployments: DEPLOYMENTS,
      environment: "preview",
      expectedCommit: COMMIT,
      origins: ORIGINS,
      timeoutMs: 5_000
    });
  });

  it("requires an explicit strong confirmation flag for Production", () => {
    const productionEnvironment = {
      ...ENVIRONMENT,
      UNFILED_RELEASE_PROBE_ENVIRONMENT: "production"
    };
    expect(() => parseReleaseProbeConfiguration([], productionEnvironment)).toThrow(
      "production_confirmation_required"
    );
    expect(
      parseReleaseProbeConfiguration(
        ["--confirm-production", PRODUCTION_CONFIRMATION],
        productionEnvironment
      )
    ).toMatchObject({ environment: "production" });
    expect(() =>
      parseReleaseProbeConfiguration(["--confirm-production", PRODUCTION_CONFIRMATION], ENVIRONMENT)
    ).toThrow("production_confirmation_unexpected");
  });

  it.each([
    "http://unfiled-web-preview.vercel.app",
    "https://user:password@unfiled-web-preview.vercel.app",
    "https://unfiled-web-preview.vercel.app/private",
    "https://unfiled-web-preview.vercel.app?token=secret",
    "https://127.0.0.1",
    "https://2130706433",
    "https://localhost",
    "https://unfiled.test",
    "https://unfiled-web-preview.vercel.app.",
    " https://unfiled-web-preview.vercel.app "
  ])("rejects an unsafe origin without echoing it: %s", (origin) => {
    expect(() =>
      parseReleaseProbeConfiguration([], {
        ...ENVIRONMENT,
        UNFILED_RELEASE_PROBE_WEB_ORIGIN: origin
      })
    ).toThrow("invalid_origin");
  });

  it("rejects reused origins/digests, raw deployment IDs, and ambiguous flag/env input", () => {
    expect(() =>
      parseReleaseProbeConfiguration([], {
        ...ENVIRONMENT,
        UNFILED_RELEASE_PROBE_SEARCH_ORIGIN: ORIGINS.worker
      })
    ).toThrow("reused_origin");
    expect(() =>
      parseReleaseProbeConfiguration([], {
        ...ENVIRONMENT,
        UNFILED_RELEASE_PROBE_SEARCH_DEPLOYMENT: DEPLOYMENTS.worker
      })
    ).toThrow("reused_deployment_digest");
    expect(() =>
      parseReleaseProbeConfiguration([], {
        ...ENVIRONMENT,
        UNFILED_RELEASE_PROBE_WEB_DEPLOYMENT: "dpl_sensitive-opaque-identifier"
      })
    ).toThrow("invalid_deployment_digest");
    expect(() =>
      parseReleaseProbeConfiguration(["--expected-commit", "b".repeat(40)], ENVIRONMENT)
    ).toThrow("ambiguous_option_source");
  });

  it("rejects unknown, repeated, malformed, and positional arguments", () => {
    expect(() => parseReleaseProbeConfiguration(["--unknown", "value"], ENVIRONMENT)).toThrow(
      "unknown_option"
    );
    expect(() =>
      parseReleaseProbeConfiguration(["--timeout-ms", "500", "--timeout-ms", "501"], ENVIRONMENT)
    ).toThrow("duplicate_option");
    expect(() => parseReleaseProbeConfiguration(["--timeout-ms", "499"], ENVIRONMENT)).toThrow(
      "invalid_timeout"
    );
    expect(() => parseReleaseProbeConfiguration(["positional"], ENVIRONMENT)).toThrow(
      "unexpected_argument"
    );
  });
});

describe("deployed release observations", () => {
  it("probes the five health endpoints and every public trust route with safe requests", async () => {
    const selected = configuration();
    const fetchImplementation = healthyFetch(selected);
    const summary = await probeDeployedRelease(selected, {
      fetch: fetchImplementation,
      now: () => FIXED_NOW
    });

    expect(summary).toMatchObject({
      commit: COMMIT,
      environment: "preview",
      observedAt: FIXED_NOW.toISOString(),
      outcome: "pass",
      schemaVersion: RELEASE_PROBE_SCHEMA,
      totals: { failed: 0, passed: 13, probes: 13 }
    });
    expect(summary.targets).toEqual([
      { deploymentDigest: DEPLOYMENTS.web, target: "web" },
      { deploymentDigest: DEPLOYMENTS.organizer, target: "organizer" },
      { deploymentDigest: DEPLOYMENTS.worker, target: "worker" },
      { deploymentDigest: DEPLOYMENTS.verifier, target: "verifier" },
      { deploymentDigest: DEPLOYMENTS.search, target: "search" }
    ]);
    expect(summary.probes.map(({ surface, target }) => `${target}:${surface}`)).toEqual([
      "web:health",
      "web:privacy",
      "web:terms",
      "web:security",
      "web:support",
      "web:account-deletion",
      "web:robots",
      "web:sitemap",
      "web:security-text",
      "organizer:health",
      "worker:health",
      "verifier:health",
      "search:health"
    ]);
    expect(fetchImplementation).toHaveBeenCalledTimes(13);
    for (const [input, init] of vi.mocked(fetchImplementation).mock.calls) {
      expect(String(input)).toMatch(/^https:\/\//u);
      expect(init).toMatchObject({
        cache: "no-store",
        credentials: "omit",
        method: "GET",
        redirect: "error",
        referrerPolicy: "no-referrer"
      });
      const requestHeaders = new Headers(init?.headers);
      expect(requestHeaders.has("authorization")).toBe(false);
      expect(requestHeaders.has("cookie")).toBe(false);
      expect(requestHeaders.has("x-vercel-protection-bypass")).toBe(false);
    }
    const publicOutput = JSON.stringify(summary);
    for (const origin of Object.values(ORIGINS)) expect(publicOutput).not.toContain(origin);
    expect(publicOutput).not.toContain("main-content");
    expect(publicOutput).not.toContain("Your notes are personal");
  });

  it("fails closed on exact status, content, cache, security, and identity drift", async () => {
    const selected = configuration();
    const fetchImplementation = healthyFetch(selected, (url, fixture) => {
      if (url.pathname !== "/health" || fixture.target !== "organizer") return undefined;
      const headers = new Headers(fixture.headers);
      headers.set("cache-control", "public");
      headers.set("content-type", "application/problem+json");
      headers.set("permissions-policy", "camera=*");
      headers.set("set-cookie", "private=value");
      headers.set("x-unfiled-commit", "b".repeat(40));
      headers.set("x-unfiled-deployment", `sha256:${"f".repeat(64)}`);
      headers.set("x-unfiled-environment", "production");
      return new Response('{"service":"wrong","status":"ok"}', { headers, status: 503 });
    });

    const summary = await probeDeployedRelease(selected, {
      fetch: fetchImplementation,
      now: () => FIXED_NOW
    });
    const failed = summary.probes.find(
      ({ target, surface }) => target === "organizer" && surface === "health"
    );
    expect(summary.outcome).toBe("fail");
    expect(failed).toEqual({
      failureCodes: [
        "status_mismatch",
        "content_type_mismatch",
        "cache_control_mismatch",
        "security_header_mismatch",
        "forbidden_header_present",
        "deployment_identity_mismatch",
        "git_commit_identity_mismatch",
        "environment_identity_mismatch",
        "body_mismatch"
      ],
      outcome: "fail",
      path: "/health",
      surface: "health",
      target: "organizer"
    });
    expect(JSON.stringify(summary)).not.toContain("private=value");
  });

  it("enforces declared and streamed response body caps without recording bodies", async () => {
    const selected = configuration();
    const oversizedMarker = "sensitive-body-marker";
    const fetchImplementation = healthyFetch(selected, (url, fixture) => {
      if (url.pathname === "/privacy") {
        const headers = new Headers(fixture.headers);
        headers.set("content-length", "999999");
        return new Response(oversizedMarker, { headers, status: 200 });
      }
      if (url.pathname === "/terms") {
        const headers = new Headers(fixture.headers);
        return new Response("x".repeat(131_073) + oversizedMarker, { headers, status: 200 });
      }
      if (url.pathname === "/security") {
        const headers = new Headers(fixture.headers);
        headers.set("content-length", "not-a-number");
        return new Response(oversizedMarker, { headers, status: 200 });
      }
      return undefined;
    });

    const summary = await probeDeployedRelease(selected, {
      fetch: fetchImplementation,
      now: () => FIXED_NOW
    });
    expect(summary.probes.find(({ surface }) => surface === "privacy")?.failureCodes).toEqual([
      "body_too_large"
    ]);
    expect(summary.probes.find(({ surface }) => surface === "terms")?.failureCodes).toEqual([
      "body_too_large"
    ]);
    expect(summary.probes.find(({ surface }) => surface === "security")?.failureCodes).toEqual([
      "content_length_invalid"
    ]);
    expect(JSON.stringify(summary)).not.toContain(oversizedMarker);
  });

  it("fails closed on missing, unreadable, and non-UTF-8 bodies", async () => {
    const selected = configuration();
    const privateStreamError = "stream failed near private response bytes";
    const fetchImplementation = healthyFetch(selected, (url, fixture) => {
      if (url.pathname === "/privacy") {
        return new Response(null, { headers: fixture.headers, status: 200 });
      }
      if (url.pathname === "/terms") {
        return new Response(new Uint8Array([0xff]), { headers: fixture.headers, status: 200 });
      }
      if (url.pathname === "/security") {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error(privateStreamError));
          }
        });
        return new Response(body, { headers: fixture.headers, status: 200 });
      }
      return undefined;
    });

    const summary = await probeDeployedRelease(selected, {
      fetch: fetchImplementation,
      now: () => FIXED_NOW
    });
    expect(summary.probes.find(({ surface }) => surface === "privacy")?.failureCodes).toEqual([
      "body_missing"
    ]);
    expect(summary.probes.find(({ surface }) => surface === "terms")?.failureCodes).toEqual([
      "body_invalid_utf8"
    ]);
    expect(summary.probes.find(({ surface }) => surface === "security")?.failureCodes).toEqual([
      "body_read_failed"
    ]);
    expect(JSON.stringify(summary)).not.toContain(privateStreamError);
  });

  it("sanitizes network errors and rejects redirected observations", async () => {
    const selected = configuration();
    const secret = "Bearer should-never-be-visible";
    const fetchImplementation = healthyFetch(selected, (url, fixture) => {
      if (url.pathname === "/privacy") throw new Error(secret);
      if (url.pathname === "/terms") {
        const response = new Response(fixture.body, { headers: fixture.headers, status: 200 });
        Object.defineProperty(response, "redirected", { value: true });
        return response;
      }
      return undefined;
    });

    const summary = await probeDeployedRelease(selected, {
      fetch: fetchImplementation,
      now: () => FIXED_NOW
    });
    expect(summary.probes.find(({ surface }) => surface === "privacy")?.failureCodes).toEqual([
      "network_failure"
    ]);
    expect(summary.probes.find(({ surface }) => surface === "terms")?.failureCodes).toEqual([
      "redirect_rejected"
    ]);
    expect(JSON.stringify(summary)).not.toContain(secret);
  });

  it("applies one strict timeout to fetch plus body consumption", async () => {
    const selected = configuration({ timeoutMs: 10 });
    const fetchImplementation: ReleaseProbeFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("opaque request context must stay private"));
          });
        })
    );

    const summary = await probeDeployedRelease(selected, {
      fetch: fetchImplementation,
      now: () => FIXED_NOW
    });
    expect(summary.outcome).toBe("fail");
    expect(summary.probes).toHaveLength(13);
    expect(summary.probes.every(({ failureCodes }) => failureCodes[0] === "request_timeout")).toBe(
      true
    );
    expect(JSON.stringify(summary)).not.toContain("opaque request context");
  });

  it("does not let a late response mutate an already returned timeout summary", async () => {
    const selected = configuration({ timeoutMs: 10 });
    const fetchImplementation: ReleaseProbeFetch = vi.fn(
      async () =>
        await new Promise<Response>((resolve) => {
          setTimeout(() => resolve(new Response("late private diagnostic")), 20);
        })
    );

    const summary = await probeDeployedRelease(selected, {
      fetch: fetchImplementation,
      now: () => FIXED_NOW
    });
    const initial = JSON.stringify(summary);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(JSON.stringify(summary)).toBe(initial);
    expect(summary.probes.every(({ failureCodes }) => failureCodes[0] === "request_timeout")).toBe(
      true
    );
    expect(initial).not.toContain("late private diagnostic");
  });
});

describe("release probe CLI and evidence writes", () => {
  it("returns help without networking or writing evidence", async () => {
    const fetchImplementation = vi.fn<ReleaseProbeFetch>();
    const writeEvidence = vi.fn(async () => undefined);
    const execution = await executeReleaseProbeCli(
      ["--", "--help"],
      {},
      {
        fetch: fetchImplementation,
        writeEvidence
      }
    );

    expect(execution).toMatchObject({ exitCode: 0, stderr: "" });
    expect(execution.stdout).toContain("Usage: pnpm release:probe");
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(writeEvidence).not.toHaveBeenCalled();
  });

  it("does not write evidence unless an output path was explicitly supplied", async () => {
    const selected = configuration();
    const writeEvidence = vi.fn(async () => undefined);
    const execution = await executeReleaseProbeCli([], ENVIRONMENT, {
      fetch: healthyFetch(selected),
      now: () => FIXED_NOW,
      writeEvidence
    });

    expect(execution.exitCode).toBe(0);
    expect(writeEvidence).not.toHaveBeenCalled();
    expect(JSON.parse(execution.stdout)).toMatchObject({
      outcome: "pass",
      schemaVersion: RELEASE_PROBE_SCHEMA
    });
    expect(execution.stderr).toBe("");
  });

  it("writes the same deterministic JSON atomically through the injected writer when requested", async () => {
    const selected = configuration({ outputPath: "evidence/release-probe.json" });
    const writeEvidence = vi.fn(async () => undefined);
    const execution = await executeReleaseProbeCli(
      ["--output", "evidence/release-probe.json"],
      ENVIRONMENT,
      {
        fetch: healthyFetch(selected),
        now: () => FIXED_NOW,
        writeEvidence
      }
    );

    expect(execution.exitCode).toBe(0);
    expect(writeEvidence).toHaveBeenCalledOnce();
    expect(writeEvidence).toHaveBeenCalledWith("evidence/release-probe.json", execution.stdout);
    expect(execution.stdout.endsWith("\n")).toBe(true);
  });

  it("sanitizes configuration, fetch, and evidence-writer failures", async () => {
    const fetchImplementation = vi.fn(async () => {
      throw new Error("https://private.example/?token=secret");
    });
    const invalid = await executeReleaseProbeCli(
      ["--web-origin", "https://user:secret@private.example"],
      ENVIRONMENT,
      { fetch: fetchImplementation }
    );
    expect(invalid.exitCode).toBe(1);
    expect(JSON.parse(invalid.stdout)).toEqual({
      failure: "ambiguous_option_source",
      outcome: "fail",
      schemaVersion: RELEASE_PROBE_ERROR_SCHEMA
    });
    expect(invalid.stdout).not.toContain("secret");
    expect(fetchImplementation).not.toHaveBeenCalled();

    const selected = configuration({ outputPath: "release.json" });
    const writeFailure = await executeReleaseProbeCli(["--output", "release.json"], ENVIRONMENT, {
      fetch: healthyFetch(selected),
      now: () => FIXED_NOW,
      writeEvidence: async () => {
        throw new Error("token=writer-secret");
      }
    });
    expect(writeFailure.exitCode).toBe(1);
    expect(JSON.parse(writeFailure.stdout)).toEqual({
      failure: "evidence_write_failed",
      outcome: "fail",
      schemaVersion: RELEASE_PROBE_ERROR_SCHEMA
    });
    expect(writeFailure.stdout).not.toContain("writer-secret");
  });

  it("atomically creates and replaces regular evidence files while rejecting symlinks", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "unfiled-release-probe-"));
    temporaryDirectories.push(directory);
    const output = path.join(directory, "probe.json");
    await atomicWriteReleaseProbeEvidence(output, "first\n");
    expect(await readFile(output, "utf8")).toBe("first\n");

    await writeFile(output, "old\n", "utf8");
    await atomicWriteReleaseProbeEvidence(output, "second\n");
    expect(await readFile(output, "utf8")).toBe("second\n");
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    const real = path.join(directory, "real.json");
    const linked = path.join(directory, "linked.json");
    await writeFile(real, "keep\n", "utf8");
    await symlink(real, linked);
    await expect(atomicWriteReleaseProbeEvidence(linked, "replace\n")).rejects.toThrow(
      "unsafe_output_target"
    );
    expect(await readFile(real, "utf8")).toBe("keep\n");
  });
});
