import { beforeEach, describe, expect, it, vi } from "vitest";

const integrationMocks = vi.hoisted(() => ({
  assertReadiness: vi.fn(() => Promise.resolve()),
  createCustodian: vi.fn(() => Object.freeze({})),
  createTransport: vi.fn(() => Promise.resolve({ destroy: vi.fn() })),
  verifyOidc: vi.fn()
}));

vi.mock("@unfiled/key-management", () => ({
  assertIndexWorkerKmsReadiness: integrationMocks.assertReadiness,
  createAwsKmsEnvelopeCustodian: integrationMocks.createCustodian,
  createVercelOidcKmsTransport: integrationMocks.createTransport,
  parseManagedKeyRecordV1: (value: unknown) => value,
  parseManagedKeyRecordV2: (value: unknown) => value
}));
vi.mock("@vercel/oidc", () => ({ verifyVercelOidcToken: integrationMocks.verifyOidc }));

import type { VercelTrustedSource, WorkerConfig } from "../src/config";
import type { WorkerDrainPort } from "../src/drain";
import { createWorkerApp } from "../src/http";
import {
  createWorkerKeyManagementAdapter,
  isAiAssistedKeyAuthority
} from "../src/key-management-adapter";
import { createVercelTrustedSourcesInvocationAuth } from "../src/invocation-auth-adapter";
import { createStructuredLogger } from "../src/logging";

const SECRET = "worker-only-drain-secret-with-adequate-length";
const TRUSTED_SOURCE_TOKEN = "source.header.signature";
const REQUEST_ID = "0d4259cf-4596-45b0-8f62-260189d863f3";

const trustedSource: VercelTrustedSource = {
  audience: "https://vercel.com/team-example",
  environment: "production",
  expectedSubject: "owner:team-example:project:unfiled-web:environment:production",
  issuer: "https://oidc.vercel.com/team-example",
  ownerId: "team_owner123",
  projectId: "prj_webexample",
  projectName: "unfiled-web",
  teamSlug: "team-example"
};

function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    indexing: { kind: "disabled" },
    invocationAuth: { kind: "bearer", secret: SECRET },
    keyBoundary: { kind: "local-synthetic", keyClass: "ai_assisted" },
    maxRequestBytes: 1_024,
    port: 8_788,
    releaseIdentity: null,
    requestTimeoutMs: 25_000,
    runtime: "local",
    ...overrides
  };
}

function logger(lines: string[]) {
  return createStructuredLogger(
    (line) => lines.push(line),
    () => new Date("2026-08-30T12:00:00.000Z")
  );
}

function keyManagement() {
  return createWorkerKeyManagementAdapter();
}

function productionInvocationAuth() {
  const now = Math.floor(Date.now() / 1_000);
  integrationMocks.verifyOidc.mockResolvedValue({
    payload: {
      aud: trustedSource.audience,
      environment: trustedSource.environment,
      exp: now + 300,
      iat: now,
      iss: trustedSource.issuer,
      nbf: now,
      owner: trustedSource.teamSlug,
      owner_id: trustedSource.ownerId,
      project: trustedSource.projectName,
      project_id: trustedSource.projectId,
      sub: trustedSource.expectedSubject
    },
    protectedHeader: { alg: "RS256" }
  });
  return createVercelTrustedSourcesInvocationAuth({ trustedSource });
}

function drain(): WorkerDrainPort {
  return {
    drain: vi.fn().mockResolvedValue({
      claimed: 3,
      completed: 2,
      failed: 0,
      retryScheduled: 1
    })
  };
}

function drainRequest(
  body?: string,
  overrides: Readonly<{ authorization?: string | null; headers?: HeadersInit; url?: string }> = {}
): Request {
  const headers = new Headers(overrides.headers);
  const authorization =
    overrides.authorization === undefined ? `Bearer ${SECRET}` : overrides.authorization;
  if (authorization !== null) headers.set("authorization", authorization);
  if (body !== undefined) headers.set("content-type", "application/json; charset=utf-8");
  return new Request(overrides.url ?? "https://worker.test/internal/drain", {
    ...(body === undefined ? {} : { body }),
    headers,
    method: "POST"
  });
}

function streamedDrainRequest(chunks: readonly string[]): Request {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
  return new Request("https://worker.test/internal/drain", {
    body,
    duplex: "half",
    headers: {
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/json"
    },
    method: "POST"
  } as RequestInit & { duplex: "half" });
}

describe("isolated worker HTTP app", () => {
  beforeEach(() => {
    integrationMocks.assertReadiness.mockReset().mockResolvedValue(undefined);
    integrationMocks.createCustodian.mockReset().mockReturnValue(Object.freeze({}));
    integrationMocks.createTransport.mockReset().mockResolvedValue({ destroy: vi.fn() });
    integrationMocks.verifyOidc.mockReset();
  });

  it("serves a content-free, non-cacheable health response", async () => {
    const lines: string[] = [];
    let now = 100;
    const app = createWorkerApp({
      clock: { now: () => (now += 5) },
      config: config(),
      logger: logger(lines)
    });

    const response = await app(new Request("https://worker.test/health"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.json()).resolves.toEqual({ service: "unfiled-worker", status: "ok" });
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      durationMs: 5,
      event: "request.completed",
      outcome: "ok",
      route: "health",
      service: "unfiled-worker",
      status: 200
    });
  });

  it("emits only the managed release consistency identity on success and error", async () => {
    const releaseIdentity = {
      commit: "a".repeat(40),
      deployment: `sha256:${"b".repeat(64)}` as const,
      environment: "preview" as const
    };
    const app = createWorkerApp({
      config: config({ releaseIdentity, runtime: "preview" }),
      logger: logger([])
    });

    for (const request of [
      new Request("https://worker.test/health"),
      new Request("https://worker.test/missing")
    ]) {
      const response = await app(request);
      expect(response.headers.get("x-unfiled-deployment")).toBe(releaseIdentity.deployment);
      expect(response.headers.get("x-unfiled-commit")).toBe(releaseIdentity.commit);
      expect(response.headers.get("x-unfiled-environment")).toBe("preview");
      expect(JSON.stringify([...response.headers])).not.toContain("dpl_");
    }
  });

  it("supports HEAD health without returning a body", async () => {
    const app = createWorkerApp({
      config: config(),
      logger: logger([])
    });
    const response = await app(new Request("https://worker.test/api/health", { method: "HEAD" }));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("authenticates and drains only through the AI-assisted authority", async () => {
    const lines: string[] = [];
    const keys = keyManagement();
    const drainPort = drain();
    const app = createWorkerApp({
      config: config(),
      drain: drainPort,
      keyManagement: keys,
      logger: logger(lines)
    });

    const response = await app(
      drainRequest('{"trigger":"manual"}', {
        headers: { "x-request-id": REQUEST_ID }
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      claimed: 3,
      completed: 2,
      failed: 0,
      retryScheduled: 1
    });
    const drainInput = vi.mocked(drainPort.drain).mock.calls[0]?.[0];
    expect(drainInput).toMatchObject({
      requestId: REQUEST_ID,
      trigger: "manual"
    });
    expect(isAiAssistedKeyAuthority(drainInput?.authority)).toBe(false);
    expect(Object.keys(drainInput?.authority ?? {})).toEqual([]);
    expect(drainInput?.signal).toBeInstanceOf(AbortSignal);
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  it("replaces caller-controlled request identifiers before logging or echoing them", async () => {
    const lines: string[] = [];
    const drainPort = drain();
    const app = createWorkerApp({
      config: config(),
      drain: drainPort,
      keyManagement: keyManagement(),
      logger: logger(lines)
    });

    const response = await app(
      drainRequest('{"trigger":"manual"}', {
        headers: { "x-request-id": SECRET }
      })
    );
    const generatedRequestId = response.headers.get("x-request-id");

    expect(response.status).toBe(200);
    expect(generatedRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
    expect(generatedRequestId).not.toBe(SECRET);
    expect(vi.mocked(drainPort.drain).mock.calls[0]?.[0].requestId).toBe(generatedRequestId);
    expect(lines.join("\n")).toContain(generatedRequestId ?? "missing-generated-request-id");
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  it("uses a content-free schedule trigger for an empty request", async () => {
    const drainPort = drain();
    const app = createWorkerApp({
      config: config(),
      drain: drainPort,
      keyManagement: keyManagement(),
      logger: logger([])
    });

    expect((await app(drainRequest())).status).toBe(200);
    expect(drainPort.drain).toHaveBeenCalledWith(expect.objectContaining({ trigger: "schedule" }));
  });

  it("rejects missing credentials and browser session cookies before adapters run", async () => {
    const keys = keyManagement();
    const drainPort = drain();
    const app = createWorkerApp({
      config: config(),
      drain: drainPort,
      keyManagement: keys,
      logger: logger([])
    });

    for (const request of [
      drainRequest(undefined, { authorization: "Bearer incorrect" }),
      drainRequest(undefined, { headers: { cookie: "session=user-content" } })
    ]) {
      const response = await app(request);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
    }
    expect(drainPort.drain).not.toHaveBeenCalled();
  });

  it("rejects queries, unknown routes, and unsupported methods without reflecting input", async () => {
    const canary = "private-plaintext-canary";
    const app = createWorkerApp({ config: config(), logger: logger([]) });
    const responses = await Promise.all([
      app(new Request(`https://worker.test/health?query=${canary}`)),
      app(new Request(`https://worker.test/${canary}`)),
      app(new Request("https://worker.test/health", { method: "DELETE" })),
      app(new Request("https://worker.test/internal/drain", { method: "GET" }))
    ]);

    expect(responses.map(({ status }) => status)).toEqual([400, 404, 405, 405]);
    expect(
      (await Promise.all(responses.map((response) => response.text()))).join("\n")
    ).not.toContain(canary);
  });

  it("strictly validates bounded content-free commands", async () => {
    const app = createWorkerApp({
      config: config({ maxRequestBytes: 24 }),
      drain: drain(),
      keyManagement: keyManagement(),
      logger: logger([])
    });
    const wrongType = drainRequest("text");
    wrongType.headers.set("content-type", "text/plain");

    const requests = [
      wrongType,
      drainRequest("[]"),
      drainRequest('{"trigger":"unknown"}'),
      drainRequest('{"note":"no"}'),
      drainRequest("not-json"),
      drainRequest('{"trigger":"manual"}', { headers: { "content-length": "invalid" } }),
      drainRequest('{"trigger":"manual"}', { headers: { "content-length": "99" } }),
      drainRequest(`{"trigger":"${"x".repeat(30)}"}`)
    ];
    const responses = [];
    for (const request of requests) responses.push(await app(request));

    expect(responses.map(({ status }) => status)).toEqual([400, 400, 400, 400, 400, 400, 413, 413]);
  });

  it("reconstructs a multi-chunk command exactly and bounds cumulative bytes", async () => {
    const drainPort = drain();
    const app = createWorkerApp({
      config: config({ maxRequestBytes: 24 }),
      drain: drainPort,
      keyManagement: keyManagement(),
      logger: logger([])
    });

    const valid = await app(streamedDrainRequest(["{", '"trigger"', ":", '"manual"', "}"]));
    expect(valid.status).toBe(200);
    expect(drainPort.drain).toHaveBeenCalledWith(expect.objectContaining({ trigger: "manual" }));

    const oversized = await app(streamedDrainRequest(['{"trigger":"', "x".repeat(20), '"}']));
    expect(oversized.status).toBe(413);
  });

  it("redacts unexpected adapter failures and invalid adapter results", async () => {
    const canary = "private-plaintext-canary";
    const lines: string[] = [];
    const exploding: WorkerDrainPort = {
      drain: vi.fn().mockRejectedValue(new Error(canary))
    };
    const invalid: WorkerDrainPort = {
      drain: vi.fn().mockResolvedValue({ claimed: 1, completed: 2, failed: 0, retryScheduled: 0 })
    };
    const dependencies = {
      config: config(),
      keyManagement: keyManagement(),
      logger: logger(lines)
    };

    const failure = await createWorkerApp({ ...dependencies, drain: exploding })(drainRequest());
    const invalidResult = await createWorkerApp({ ...dependencies, drain: invalid })(
      drainRequest()
    );
    const evidence = `${await failure.text()}\n${await invalidResult.text()}\n${lines.join("\n")}`;

    expect(failure.status).toBe(500);
    expect(invalidResult.status).toBe(503);
    expect(evidence).not.toContain(canary);
    expect(evidence).not.toContain("stack");
  });

  it("fails closed when the request exceeds its deadline", async () => {
    const pending: WorkerDrainPort = {
      drain: () => new Promise(() => undefined)
    };
    const app = createWorkerApp({
      config: config({ requestTimeoutMs: 5 }),
      drain: pending,
      keyManagement: keyManagement(),
      logger: logger([])
    });

    const response = await app(drainRequest());

    expect(response.status).toBe(504);
    expect(response.headers.get("retry-after")).toBe("5");
    await expect(response.json()).resolves.toMatchObject({ code: "request_timeout" });
  });

  it("requires a runtime OIDC proof before AWS key authorization", async () => {
    const drainPort = drain();
    const transport = { destroy: vi.fn() };
    integrationMocks.createTransport.mockResolvedValueOnce(transport);
    integrationMocks.createCustodian.mockReturnValueOnce({});
    const keys = keyManagement();
    const awsConfig = config({
      keyBoundary: {
        aiObjectWrapKmsKeyArn:
          "arn:aws:kms:us-west-2:123456789012:key/11111111-2222-4333-8444-555555555555",
        expectedOidcSubject: "owner:team-example:project:unfiled-worker:environment:production",
        kind: "aws-oidc",
        keyClass: "ai_assisted",
        oidcAudience: "sts.amazonaws.com",
        region: "us-west-2",
        retiredRoots: { ai_assisted: { object_wrap: [] } },
        roleArn: "arn:aws:iam::123456789012:role/unfiled-worker-production",
        vercelProjectId: "prj_example"
      },
      invocationAuth: { kind: "production-verifier", trustedSource },
      runtime: "production"
    });
    const invocationAuth = productionInvocationAuth();
    const app = createWorkerApp({
      config: awsConfig,
      drain: drainPort,
      keyManagement: keys,
      logger: logger([]),
      productionInvocationAuth: invocationAuth
    });

    expect((await app(drainRequest(undefined, { authorization: null }))).status).toBe(401);
    expect(integrationMocks.createTransport).not.toHaveBeenCalled();

    const request = drainRequest(undefined, {
      authorization: null,
      headers: {
        "x-request-id": REQUEST_ID,
        "x-vercel-oidc-token": "header.payload.signature",
        "x-unfiled-trusted-oidc-idp-token": TRUSTED_SOURCE_TOKEN
      }
    });
    expect((await app(request)).status).toBe(200);
    expect(integrationMocks.createTransport).toHaveBeenCalledWith({
      region: "us-west-2",
      roleArn: "arn:aws:iam::123456789012:role/unfiled-worker-production",
      workload: "index_worker"
    });
    expect(integrationMocks.assertReadiness).toHaveBeenCalledOnce();
    expect(transport.destroy).toHaveBeenCalledOnce();
    expect(drainPort.drain).toHaveBeenCalledOnce();
  });

  it("never falls back to bearer authentication in production", async () => {
    const app = createWorkerApp({
      config: config({
        invocationAuth: { kind: "production-verifier", trustedSource },
        runtime: "production"
      }),
      drain: drain(),
      keyManagement: keyManagement(),
      logger: logger([]),
      productionInvocationAuth: productionInvocationAuth()
    });

    const response = await app(drainRequest());

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({ code: "unauthorized" });
  });
});
