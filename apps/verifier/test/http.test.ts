import { describe, expect, it, vi } from "vitest";

import type { VerifierConfig, VercelTrustedSource } from "../src/config";
import { GenerationVerificationError, VerifierError } from "../src/errors";
import { createVerifierApp } from "../src/http";
import type { ProductionInvocationAuth } from "../src/invocation-auth";
import type { VerifierKeySession, VerifierKmsAdapter } from "../src/kms";
import type { GenerationVerifier } from "../src/verifier";
import { GENERATION_ID, OWNER_ID } from "./fixtures";

const trustedSource: VercelTrustedSource = {
  audience: "https://vercel.com/team-example",
  environment: "production",
  expectedSubject: "owner:team-example:project:unfiled-web:environment:production",
  issuer: "https://oidc.vercel.com/team-example",
  ownerId: "team_owner123",
  projectId: "prj_web123",
  projectName: "unfiled-web",
  teamSlug: "team-example"
};

const productionConfig: VerifierConfig = {
  maxRequestBytes: 1_024,
  port: 8_789,
  requestTimeoutMs: 5_000,
  runtime: "production",
  verification: {
    kind: "enabled",
    database: {
      caPem: "ca",
      connectTimeoutMs: 2_000,
      expectedHost: "db.example.com",
      projectRef: "abcdefghijklmnopqrst",
      statementTimeoutMs: 250,
      url: "postgresql://unused"
    },
    decryptConcurrency: 8,
    invocation: trustedSource,
    kms: {
      activeObjectWrapRootArn:
        "arn:aws:kms:us-west-2:123456789012:key/11111111-2222-4333-8444-555555555555",
      expectedOidcSubject: "owner:team-example:project:unfiled-verifier:environment:production",
      maxKeyRecords: 4,
      oidcAudience: "sts.amazonaws.com",
      region: "us-west-2",
      retiredObjectWrapRootArns: [],
      roleArn: "arn:aws:iam::123456789012:role/unfiled-verifier-production",
      timeoutMs: 2_000,
      vercelProjectId: "prj_verifier123"
    }
  }
};

const fakeKeys: VerifierKeySession = {
  keyFor: () => Promise.reject(new Error("unused"))
};

function productionAuth(): ProductionInvocationAuth {
  return {
    authorize(proof) {
      if (
        proof.authorizationHeader !== null ||
        proof.protectionBypassHeader !== null ||
        proof.trustedSourceToken !== "source.header.signature"
      ) {
        return Promise.reject(new VerifierError(401, "unauthorized", "invalid"));
      }
      return Promise.resolve({} as never);
    }
  };
}

function kmsAdapter(spy = vi.fn()): VerifierKmsAdapter {
  return {
    withKeySession(_config, proof, signal, use) {
      spy(proof, signal);
      return use(fakeKeys);
    }
  };
}

function verifierPort(spy = vi.fn()): GenerationVerifier {
  return {
    verify(target, keys, signal) {
      spy(target, keys, signal);
      return Promise.resolve({
        generationId: GENERATION_ID,
        revisionToken: "4",
        verified: true,
        verifiedNoteCount: 1
      });
    }
  };
}

function request(
  input: Readonly<{
    body?: string;
    headers?: Record<string, string>;
    method?: string;
    path?: string;
    signal?: AbortSignal;
  }> = {}
): Request {
  const headers = new Headers({
    "content-type": "application/json",
    "x-vercel-oidc-token": "workload.header.signature",
    "x-vercel-trusted-oidc-idp-token": "source.header.signature",
    ...input.headers
  });
  const method = input.method ?? "POST";
  return new Request(`https://verifier.test${input.path ?? "/internal/verify"}`, {
    ...(method === "GET" || method === "HEAD"
      ? {}
      : {
          body:
            input.body ??
            JSON.stringify({
              ownerId: OWNER_ID,
              generationId: GENERATION_ID,
              revisionToken: "4"
            })
        }),
    headers,
    method,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
}

describe("verifier HTTP service", () => {
  it("returns only bounded verification metadata after both OIDC boundaries", async () => {
    const verify = vi.fn();
    const kms = vi.fn();
    const logs: unknown[] = [];
    const response = await createVerifierApp({
      config: productionConfig,
      kms: kmsAdapter(kms),
      logger: { log: (event) => logs.push(event) },
      productionInvocationAuth: productionAuth(),
      verifier: verifierPort(verify)
    })(request({ headers: { "x-request-id": "not-safe-attacker-content" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      generationId: GENERATION_ID,
      revisionToken: "4",
      verified: true,
      verifiedNoteCount: 1
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
    expect(response.headers.get("x-request-id")).not.toBe("not-safe-attacker-content");
    expect(verify).toHaveBeenCalledWith(
      { ownerId: OWNER_ID, generationId: GENERATION_ID, revisionToken: "4" },
      fakeKeys,
      expect.any(AbortSignal)
    );
    expect(kms).toHaveBeenCalledOnce();
    expect(JSON.stringify(logs)).not.toContain(OWNER_ID);
    expect(JSON.stringify(logs)).not.toContain(GENERATION_ID);
  });

  it("preserves only an incoming UUIDv4 request identifier", async () => {
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const response = await createVerifierApp({
      config: productionConfig,
      kms: kmsAdapter(),
      productionInvocationAuth: productionAuth(),
      verifier: verifierPort()
    })(request({ headers: { "x-request-id": id } }));
    expect(response.headers.get("x-request-id")).toBe(id);
  });

  it("exposes a content-free GET/HEAD health route only", async () => {
    const app = createVerifierApp({ config: productionConfig });
    const get = await app(request({ method: "GET", path: "/health" }));
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ service: "unfiled-rag-verifier", status: "ok" });
    expect(get.headers.get("allow")).toBe("GET, HEAD");
    const head = await app(request({ method: "HEAD", path: "/api/health" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await app(request({ method: "POST", path: "/health" }))).status).toBe(405);
  });

  it("fails closed in local/preview without touching auth, KMS, or verifier", async () => {
    const authorize = vi.fn();
    const kms = vi.fn();
    const verify = vi.fn();
    const app = createVerifierApp({
      config: {
        ...productionConfig,
        runtime: "preview",
        verification: { kind: "disabled" }
      },
      kms: kmsAdapter(kms),
      productionInvocationAuth: { authorize },
      verifier: verifierPort(verify)
    });
    const response = await app(request());
    expect(response.status).toBe(503);
    expect(authorize).not.toHaveBeenCalled();
    expect(kms).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong method", request({ method: "GET" }), 405],
    ["query", request({ path: "/internal/verify?owner=leak" }), 400],
    ["cookie", request({ headers: { cookie: "session=secret" } }), 401],
    ["authorization", request({ headers: { authorization: "Bearer fallback" } }), 401],
    ["bypass", request({ headers: { "x-vercel-protection-bypass": "fallback" } }), 401],
    ["missing source", request({ headers: { "x-vercel-trusted-oidc-idp-token": "wrong" } }), 401],
    ["missing workload", request({ headers: { "x-vercel-oidc-token": "wrong" } }), 503],
    ["unknown route", request({ path: "/notes" }), 404]
  ])("rejects %s", async (_label, incoming, expectedStatus) => {
    const response = await createVerifierApp({
      config: productionConfig,
      kms: kmsAdapter(),
      productionInvocationAuth: productionAuth(),
      verifier: verifierPort()
    })(incoming);
    expect(response.status).toBe(expectedStatus);
    expect(await response.text()).not.toContain(OWNER_ID);
  });

  it.each([
    ["", "application/json"],
    ["[]", "application/json"],
    ["{}", "application/json"],
    ["{", "application/json"],
    [
      JSON.stringify({ ownerId: OWNER_ID, generationId: GENERATION_ID, revisionToken: 4 }),
      "application/json"
    ],
    [
      JSON.stringify({ ownerId: OWNER_ID, generationId: GENERATION_ID, revisionToken: "04" }),
      "application/json"
    ],
    [
      JSON.stringify({
        ownerId: OWNER_ID,
        generationId: GENERATION_ID,
        revisionToken: "4",
        extra: true
      }),
      "application/json"
    ],
    [
      JSON.stringify({ ownerId: OWNER_ID, generationId: GENERATION_ID, revisionToken: "4" }),
      "text/plain"
    ]
  ])("rejects malformed or noncanonical targets", async (body, contentType) => {
    const response = await createVerifierApp({
      config: productionConfig,
      kms: kmsAdapter(),
      productionInvocationAuth: productionAuth(),
      verifier: verifierPort()
    })(request({ body, headers: { "content-type": contentType } }));
    expect(response.status).toBe(400);
  });

  it("enforces content length and streamed body bounds", async () => {
    const app = createVerifierApp({
      config: { ...productionConfig, maxRequestBytes: 32 },
      kms: kmsAdapter(),
      productionInvocationAuth: productionAuth(),
      verifier: verifierPort()
    });
    expect((await app(request({ headers: { "content-length": "33" } }))).status).toBe(413);
    expect((await app(request({ headers: { "content-length": "bad" } }))).status).toBe(400);
    expect((await app(request({ body: "x".repeat(33) }))).status).toBe(413);
  });

  it("redacts provider failures and applies the outer request deadline", async () => {
    const failing = createVerifierApp({
      config: productionConfig,
      kms: kmsAdapter(),
      productionInvocationAuth: productionAuth(),
      verifier: {
        verify: () => Promise.reject(new Error("plaintext-ciphertext-key-canary"))
      }
    });
    const failure = await failing(request());
    expect(failure.status).toBe(500);
    expect(await failure.text()).not.toContain("canary");

    const timed = createVerifierApp({
      config: { ...productionConfig, requestTimeoutMs: 5 },
      kms: kmsAdapter(),
      productionInvocationAuth: productionAuth(),
      verifier: { verify: () => new Promise(() => undefined) }
    });
    const timeout = await timed(request());
    expect(timeout.status).toBe(504);
    expect(timeout.headers.get("retry-after")).toBe("5");
  });

  it("rejects a request disconnected before handler entry without touching dependencies", async () => {
    const controller = new AbortController();
    controller.abort();
    const authorize = vi.fn();
    const kms = vi.fn();
    const verify = vi.fn();
    const app = createVerifierApp({
      config: productionConfig,
      kms: kmsAdapter(kms),
      productionInvocationAuth: { authorize },
      verifier: verifierPort(verify)
    });

    const response = await app(request({ signal: controller.signal }));

    expect(response.status).toBe(504);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(authorize).not.toHaveBeenCalled();
    expect(kms).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it("preserves deterministic generation rejection as the stable non-retryable 409 contract", async () => {
    const app = createVerifierApp({
      config: productionConfig,
      kms: kmsAdapter(),
      productionInvocationAuth: productionAuth(),
      verifier: { verify: () => Promise.reject(new GenerationVerificationError()) }
    });
    const response = await app(request());
    expect(response.status).toBe(409);
    expect(response.headers.get("retry-after")).toBeNull();
    const body: unknown = await response.json();
    expect(body).toEqual({
      code: "generation_invalid",
      message: "That encrypted generation could not be verified.",
      requestId: response.headers.get("x-request-id")
    });
  });

  it("fails closed when an adapter returns a malformed result", async () => {
    const app = createVerifierApp({
      config: productionConfig,
      kms: kmsAdapter(),
      productionInvocationAuth: productionAuth(),
      verifier: {
        verify: () => Promise.resolve({ verified: true } as never)
      }
    });
    expect((await app(request())).status).toBe(503);
  });
});
