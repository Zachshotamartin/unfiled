import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DecryptOnlyIntermediateKeyCustodian,
  KeyCustodyOperationOptions,
  ManagedKeyRecordV1
} from "@unfiled/key-management";

import type { SearchConfig, SearchTrustedSource } from "../src/config.js";

const keyMocks = vi.hoisted(() => ({
  createCustodian: vi.fn(),
  createTransport: vi.fn(),
  verifyOidc: vi.fn()
}));

vi.mock("@unfiled/key-management", () => ({
  createAwsKmsEnvelopeCustodian: keyMocks.createCustodian,
  createVercelOidcKmsTransport: keyMocks.createTransport
}));
vi.mock("@vercel/oidc", () => ({ verifyVercelOidcToken: keyMocks.verifyOidc }));

const { authorizeLocalSearchInvocation, createSearchInvocationAuth } =
  await import("../src/invocation-auth.js");
const {
  createSearchKeyManagementAdapter,
  custodianForSearchAuthority,
  isAwsSearchBoundary,
  isSearchKeyAuthority,
  oidcTokenFromRequest,
  unconfiguredSearchKeyManagementAdapter
} = await import("../src/key-management.js");

const ACTIVE_ROOT = "arn:aws:kms:us-west-2:123456789012:key/11111111-2222-4333-8444-555555555555";
const RETIRED_ROOT = "arn:aws:kms:us-west-2:123456789012:key/88888888-8888-4888-8888-888888888888";

function source(environment: "preview" | "production"): SearchTrustedSource {
  return {
    audience: "https://vercel.com/team-example",
    environment,
    expectedSubject: `owner:team-example:project:unfiled-web:environment:${environment}`,
    issuer: "https://oidc.vercel.com/team-example",
    ownerId: "team_owner123",
    projectId: "prj_webexample",
    projectName: "unfiled-web",
    teamSlug: "team-example"
  };
}

function boundary(environment: "preview" | "production"): SearchConfig["keyBoundary"] {
  return {
    activeObjectWrapKeyArn: ACTIVE_ROOT,
    expectedOidcSubject: `owner:team-example:project:unfiled-search:environment:${environment}`,
    kind: "aws-oidc",
    region: "us-west-2",
    retiredObjectWrapKeyArns: [RETIRED_ROOT],
    roleArn: `arn:aws:iam::123456789012:role/unfiled-search-${environment}`,
    vercelProjectId: "prj_searchexample"
  };
}

async function invocation(environment: "preview" | "production", requestId = "request-1") {
  const trusted = source(environment);
  const now = Math.floor(Date.now() / 1_000);
  keyMocks.verifyOidc.mockResolvedValue({
    payload: {
      aud: trusted.audience,
      environment,
      exp: now + 300,
      iat: now,
      iss: trusted.issuer,
      nbf: now,
      owner: trusted.teamSlug,
      owner_id: trusted.ownerId,
      project: trusted.projectName,
      project_id: trusted.projectId,
      sub: trusted.expectedSubject
    },
    protectedHeader: { alg: "RS256" }
  });
  return await createSearchInvocationAuth(trusted).authorize(
    {
      authorizationHeader: null,
      protectionBypassHeader: null,
      requestId,
      trustedSourceToken: "source.header.signature"
    },
    new AbortController().signal
  );
}

function recordingCustodian(calls: { signals: (AbortSignal | undefined)[] }): Readonly<{
  custodian: DecryptOnlyIntermediateKeyCustodian;
  keys: Uint8Array[];
}> {
  const keys: Uint8Array[] = [];
  return {
    custodian: Object.freeze({
      async withUnwrappedIntermediateKey<Result>(
        _record: unknown,
        use: (keyBytes: Uint8Array, record: ManagedKeyRecordV1) => Promise<Result>,
        options?: KeyCustodyOperationOptions
      ): Promise<Result> {
        calls.signals.push(options?.signal);
        const bytes = new Uint8Array(32).fill(7);
        keys.push(bytes);
        try {
          return await use(bytes, Object.freeze({}) as ManagedKeyRecordV1);
        } finally {
          bytes.fill(0);
        }
      }
    }),
    keys
  };
}

beforeEach(() => {
  keyMocks.createCustodian.mockReset();
  keyMocks.createTransport.mockReset();
  keyMocks.verifyOidc.mockReset();
});

describe("decrypt-only search key-management authority", () => {
  it.each(["preview", "production"] as const)(
    "uses the isolated %s role and exposes only revocable unwrap",
    async (runtime) => {
      const transport = { destroy: vi.fn() };
      const calls = { signals: [] as (AbortSignal | undefined)[] };
      const raw = recordingCustodian(calls);
      keyMocks.createTransport.mockResolvedValue(transport);
      keyMocks.createCustodian.mockReturnValue(raw.custodian);
      let retainedAuthority: Parameters<typeof custodianForSearchAuthority>[0] | undefined;
      let retainedCustodian: DecryptOnlyIntermediateKeyCustodian | undefined;

      const result = await createSearchKeyManagementAdapter().withAiAssistedSearchAuthority(
        boundary(runtime),
        {
          invocation: await invocation(runtime),
          oidcToken: "workload.header.signature",
          requestId: "request-1",
          runtime
        },
        new AbortController().signal,
        async (authority) => {
          retainedAuthority = authority;
          retainedCustodian = custodianForSearchAuthority(authority);
          expect(Object.keys(retainedCustodian)).toEqual(["withUnwrappedIntermediateKey"]);
          expect("withGeneratedIntermediateKey" in retainedCustodian).toBe(false);
          expect("rewrapIntermediateKey" in retainedCustodian).toBe(false);
          return await retainedCustodian.withUnwrappedIntermediateKey({}, () =>
            Promise.resolve("opened")
          );
        }
      );

      expect(result).toBe("opened");
      expect(keyMocks.createTransport).toHaveBeenCalledWith({
        maxAttempts: 2,
        region: "us-west-2",
        roleArn: `arn:aws:iam::123456789012:role/unfiled-search-${runtime}`,
        workload: "search_worker"
      });
      expect(keyMocks.createCustodian).toHaveBeenCalledWith({
        activeRoots: { ai_assisted: { object_wrap: ACTIVE_ROOT } },
        retiredRoots: { ai_assisted: { object_wrap: [RETIRED_ROOT] } },
        transport,
        workload: "search_worker"
      });
      expect(JSON.stringify(keyMocks.createTransport.mock.calls)).not.toContain(
        "workload.header.signature"
      );
      expect(calls.signals).toHaveLength(1);
      expect(calls.signals[0]?.aborted).toBe(true);
      expect(raw.keys.every((key) => key.every((byte) => byte === 0))).toBe(true);
      expect(transport.destroy).toHaveBeenCalledOnce();
      const releasedAuthority = retainedAuthority;
      const releasedCustodian = retainedCustodian;
      if (releasedAuthority === undefined || releasedCustodian === undefined) {
        throw new Error("Expected authority callback");
      }
      expect(isSearchKeyAuthority(releasedAuthority)).toBe(false);
      expect(() => custodianForSearchAuthority(releasedAuthority)).toThrow();
      await expect(
        releasedCustodian.withUnwrappedIntermediateKey({}, () => Promise.resolve("late"))
      ).rejects.toMatchObject({ code: "provider_unavailable", status: 503 });
    }
  );

  it("revokes in-flight unwrap immediately when the request is aborted", async () => {
    const controller = new AbortController();
    const transport = { destroy: vi.fn() };
    const operationSignals: AbortSignal[] = [];
    const consumer = vi.fn(() => Promise.resolve("must-not-run"));
    const raw: DecryptOnlyIntermediateKeyCustodian = Object.freeze({
      withUnwrappedIntermediateKey<Result>(
        _record: unknown,
        _use: (keyBytes: Uint8Array, record: ManagedKeyRecordV1) => Promise<Result>,
        options?: KeyCustodyOperationOptions
      ): Promise<Result> {
        const signal = options?.signal;
        if (signal === undefined) return Promise.reject(new Error("missing signal"));
        operationSignals.push(signal);
        return new Promise<Result>((_resolve, reject) => {
          const abort = (): void => reject(new Error("PRIVATE-KMS-ABORT-CANARY"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      }
    });
    keyMocks.createTransport.mockResolvedValue(transport);
    keyMocks.createCustodian.mockReturnValue(raw);

    await createSearchKeyManagementAdapter().withAiAssistedSearchAuthority(
      boundary("production"),
      {
        invocation: await invocation("production"),
        oidcToken: "workload.header.signature",
        requestId: "request-1",
        runtime: "production"
      },
      controller.signal,
      async (authority) => {
        const pending = custodianForSearchAuthority(authority).withUnwrappedIntermediateKey(
          {},
          consumer
        );
        void pending.catch(() => undefined);
        controller.abort();
        await expect(pending).rejects.toMatchObject({ code: "provider_unavailable" });
      }
    );

    expect(operationSignals).toHaveLength(1);
    expect(operationSignals[0]?.aborted).toBe(true);
    expect(consumer).not.toHaveBeenCalled();
    expect(transport.destroy).toHaveBeenCalledOnce();
  });

  it("rejects forged, mismatched, missing-token, and local-disabled proof before custody", async () => {
    const localBoundary: SearchConfig["keyBoundary"] = { kind: "local-disabled" };
    const localInvocation = authorizeLocalSearchInvocation({
      authorizationHeader: "Bearer local-search-secret-with-more-than-32-characters",
      requestId: "request-1",
      secret: "local-search-secret-with-more-than-32-characters"
    });
    const attempts = [
      {
        boundary: boundary("production"),
        proof: {
          invocation: {} as never,
          oidcToken: "workload.header.signature",
          requestId: "request-1",
          runtime: "production" as const
        }
      },
      {
        boundary: boundary("production"),
        proof: {
          invocation: await invocation("production", "different-request"),
          oidcToken: "workload.header.signature",
          requestId: "request-1",
          runtime: "production" as const
        }
      },
      {
        boundary: boundary("production"),
        proof: {
          invocation: await invocation("production"),
          oidcToken: undefined,
          requestId: "request-1",
          runtime: "production" as const
        }
      },
      {
        boundary: boundary("preview"),
        proof: {
          invocation: await invocation("production"),
          oidcToken: "workload.header.signature",
          requestId: "request-1",
          runtime: "production" as const
        }
      },
      {
        boundary: localBoundary,
        proof: {
          invocation: localInvocation,
          oidcToken: undefined,
          requestId: "request-1",
          runtime: "local" as const
        }
      }
    ] as const;
    const use = vi.fn(() => Promise.resolve());

    for (const attempt of attempts) {
      await expect(
        createSearchKeyManagementAdapter().withAiAssistedSearchAuthority(
          attempt.boundary,
          attempt.proof,
          new AbortController().signal,
          use
        )
      ).rejects.toMatchObject({ code: "provider_unavailable", status: 503 });
    }
    expect(use).not.toHaveBeenCalled();
    expect(keyMocks.createTransport).not.toHaveBeenCalled();
  });

  it("accepts only a bounded, exact JWT-shaped workload header for AWS", () => {
    const aws = boundary("production");
    expect(isAwsSearchBoundary(aws)).toBe(true);
    expect(
      oidcTokenFromRequest(
        new Request("https://search.test/internal/query", {
          headers: { "x-vercel-oidc-token": "header.payload.signature" }
        }),
        aws
      )
    ).toBe("header.payload.signature");
    expect(
      oidcTokenFromRequest(
        new Request("https://search.test/internal/query", {
          headers: { "x-vercel-oidc-token": "header.payload.signature" }
        }),
        { kind: "local-disabled" }
      )
    ).toBeUndefined();
    for (const token of [
      undefined,
      "bad",
      "header.pay load.signature",
      `a.${"x".repeat(17_000)}.c`
    ]) {
      const headers = token === undefined ? {} : { "x-vercel-oidc-token": token };
      expect(() =>
        oidcTokenFromRequest(new Request("https://search.test/internal/query", { headers }), aws)
      ).toThrow();
    }
  });

  it("destroys a late transport if the request ends during OIDC credential setup", async () => {
    const transport = { destroy: vi.fn() };
    let resolveTransport: ((value: typeof transport) => void) | undefined;
    keyMocks.createTransport.mockReturnValue(
      new Promise<typeof transport>((resolve) => {
        resolveTransport = resolve;
      })
    );
    const controller = new AbortController();
    const pending = createSearchKeyManagementAdapter().withAiAssistedSearchAuthority(
      boundary("production"),
      {
        invocation: await invocation("production"),
        oidcToken: "workload.header.signature",
        requestId: "request-1",
        runtime: "production"
      },
      controller.signal,
      () => Promise.resolve("must-not-run")
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "provider_unavailable" });
    resolveTransport?.(transport);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport.destroy).toHaveBeenCalledOnce();
    expect(keyMocks.createCustodian).not.toHaveBeenCalled();
  });

  it("ships a fail-closed unconfigured adapter", async () => {
    await expect(
      unconfiguredSearchKeyManagementAdapter.withAiAssistedSearchAuthority(
        { kind: "local-disabled" },
        {
          invocation: authorizeLocalSearchInvocation({
            authorizationHeader: "Bearer local-search-secret-with-more-than-32-characters",
            requestId: "request-1",
            secret: "local-search-secret-with-more-than-32-characters"
          }),
          oidcToken: undefined,
          requestId: "request-1",
          runtime: "local"
        },
        new AbortController().signal,
        () => Promise.resolve()
      )
    ).rejects.toMatchObject({ code: "provider_unavailable", status: 503 });
  });
});
