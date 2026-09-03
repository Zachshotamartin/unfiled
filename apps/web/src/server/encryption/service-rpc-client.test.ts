import { describe, expect, it, vi } from "vitest";

import { ConfigurationError } from "@/server/api/errors";

import { mappedServiceRpcHttpError } from "./managed-encryption-error-mapping";
import { createServiceRpcClient, ServiceRpcError, ServiceRpcErrorCode } from "./service-rpc-client";

const environment = Object.freeze({
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co/",
  NODE_ENV: "test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value-with-safe-length"
});

describe("allowlisted encrypted service RPC client", () => {
  it("maps a raced routing destination to a stable non-retryable owner error", () => {
    expect(
      mappedServiceRpcHttpError(
        new ServiceRpcError(ServiceRpcErrorCode.ROUTING_RULE_DESTINATION_INVALID),
        "routing rule"
      )
    ).toMatchObject({
      code: "validation_failed",
      message: "Choose an active destination and try again.",
      status: 400
    });
  });

  it("calls only an explicit function with server credentials and no cache", async () => {
    const request = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return Promise.resolve(Response.json({ state: "expanded" }, { status: 200 }));
    });
    const client = createServiceRpcClient({
      allowedFunctions: ["get_content_encryption_rollout"],
      environment,
      fetch: request
    });

    await expect(
      client.rpc("get_content_encryption_rollout", {
        p_owner_id: "00000000-0000-4000-8000-000000000001"
      })
    ).resolves.toEqual({ state: "expanded" });
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0] ?? [];
    expect(url).toBe("https://project.supabase.co/rest/v1/rpc/get_content_encryption_rollout");
    expect(init).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      method: "POST",
      redirect: "error",
      referrerPolicy: "no-referrer"
    });
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer service-role-test-value-with-safe-length"
    );
  });

  it("rejects unlisted functions before making a request", async () => {
    const request = vi.fn();
    const client = createServiceRpcClient({
      allowedFunctions: ["get_content_encryption_rollout"],
      environment,
      fetch: request
    });
    await expect(client.rpc("rewrap_user_content_key", {})).rejects.toMatchObject({
      code: ServiceRpcErrorCode.FORBIDDEN
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("maps database failures to bounded errors without reflecting content", async () => {
    const canary = "plaintext-note-canary";
    const request = vi.fn(() =>
      Promise.resolve(
        Response.json(
          { message: `stale_revision ${canary}`, details: canary, hint: canary },
          { status: 409 }
        )
      )
    );
    const client = createServiceRpcClient({
      allowedFunctions: ["apply_encrypted_note_mutation"],
      environment,
      fetch: request
    });

    let error: unknown;
    try {
      await client.rpc("apply_encrypted_note_mutation", {});
    } catch (cause: unknown) {
      error = cause;
    }
    expect(error).toBeInstanceOf(ServiceRpcError);
    expect(error).toMatchObject({ code: ServiceRpcErrorCode.STALE_REVISION });
    expect(String(error)).not.toContain(canary);
    expect(JSON.stringify(error)).not.toContain(canary);
  });

  it("cuts off capability responses above an explicit per-client ceiling", async () => {
    const cancelled = vi.fn();
    const client = createServiceRpcClient({
      allowedFunctions: ["get_owner_ai_settings"],
      environment,
      fetch: vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              cancel: cancelled,
              start(controller) {
                controller.enqueue(new Uint8Array(17));
              }
            })
          )
        )
      ),
      maximumResponseBytes: 16
    });

    await expect(client.rpc("get_owner_ai_settings", {})).rejects.toMatchObject({
      code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it.each([
    ["conflict_requires_review", ServiceRpcErrorCode.CONFLICT_REQUIRES_REVIEW],
    ["capture_id_conflict", ServiceRpcErrorCode.INVALID_IDEMPOTENCY_KEY],
    ["routing_rule_match_stale", ServiceRpcErrorCode.ROUTING_RULE_MATCH_STALE],
    ["routing_rule_observation_stale", ServiceRpcErrorCode.ROUTING_RULE_OBSERVATION_STALE],
    ["routing_rule_limit", ServiceRpcErrorCode.RATE_LIMITED],
    ["routing_rule_enabled_limit", ServiceRpcErrorCode.RATE_LIMITED],
    ["routing_rule_destination_invalid", ServiceRpcErrorCode.ROUTING_RULE_DESTINATION_INVALID],
    ["stale_maintenance_cursor", ServiceRpcErrorCode.STALE_MAINTENANCE_CURSOR],
    ["stale_scrub_cursor", ServiceRpcErrorCode.STALE_MAINTENANCE_CURSOR],
    ["explicit_destination_not_owned", ServiceRpcErrorCode.FORBIDDEN],
    ["attachment_not_owned", ServiceRpcErrorCode.FORBIDDEN],
    ["invalid_rollout_state", ServiceRpcErrorCode.PROVIDER_UNAVAILABLE],
    ["invalid_scrub_state", ServiceRpcErrorCode.PROVIDER_UNAVAILABLE],
    ["encrypted_organizer_write_unavailable", ServiceRpcErrorCode.PROVIDER_UNAVAILABLE],
    ["incomplete_encryption_backfill", ServiceRpcErrorCode.PROVIDER_UNAVAILABLE],
    ["incomplete_index_coverage", ServiceRpcErrorCode.PROVIDER_UNAVAILABLE],
    ["cutover_work_in_flight", ServiceRpcErrorCode.PROVIDER_UNAVAILABLE],
    ["plaintext_scrub_complete", ServiceRpcErrorCode.PROVIDER_UNAVAILABLE],
    ["plaintext_scrub_incomplete", ServiceRpcErrorCode.PROVIDER_UNAVAILABLE],
    ["scrub_attestation_stale", ServiceRpcErrorCode.PROVIDER_UNAVAILABLE]
  ] as const)("maps %s before the provider's generic HTTP status", async (message, code) => {
    const client = createServiceRpcClient({
      allowedFunctions: ["create_encrypted_capture_with_job"],
      environment,
      fetch: vi.fn(() => Promise.resolve(Response.json({ message }, { status: 400 })))
    });

    await expect(client.rpc("create_encrypted_capture_with_job", {})).rejects.toMatchObject({
      code
    });
  });

  it("fails closed for invalid configuration, URLs, allowlists, and transport errors", async () => {
    expect(() =>
      createServiceRpcClient({ allowedFunctions: [], environment, fetch: vi.fn() })
    ).toThrow(ConfigurationError);
    expect(() =>
      createServiceRpcClient({
        allowedFunctions: ["Not-Safe"],
        environment,
        fetch: vi.fn()
      })
    ).toThrow(ConfigurationError);
    expect(() =>
      createServiceRpcClient({
        allowedFunctions: ["safe", "safe"],
        environment,
        fetch: vi.fn()
      })
    ).toThrow(ConfigurationError);
    expect(() =>
      createServiceRpcClient({
        allowedFunctions: ["safe"],
        environment: { ...environment, NEXT_PUBLIC_SUPABASE_URL: "http://remote.invalid" },
        fetch: vi.fn()
      })
    ).toThrow(ConfigurationError);
    expect(() =>
      createServiceRpcClient({
        allowedFunctions: ["safe"],
        environment: {
          ...environment,
          NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
          NODE_ENV: "production"
        },
        fetch: vi.fn()
      })
    ).toThrow(ConfigurationError);
    expect(() =>
      createServiceRpcClient({
        allowedFunctions: ["safe"],
        environment: {
          ...environment,
          CI: "true",
          NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
          NODE_ENV: "production",
          UNFILED_ALLOW_INSECURE_LOCAL_SUPABASE_E2E: "1",
          VERCEL: "1",
          VERCEL_ENV: "production"
        },
        fetch: vi.fn()
      })
    ).toThrow(ConfigurationError);
    expect(() =>
      createServiceRpcClient({
        allowedFunctions: ["safe"],
        environment: {
          ...environment,
          NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co/path"
        },
        fetch: vi.fn()
      })
    ).toThrow(ConfigurationError);
    expect(() =>
      createServiceRpcClient({
        allowedFunctions: ["safe"],
        environment: { ...environment, SUPABASE_SERVICE_ROLE_KEY: "short" },
        fetch: vi.fn()
      })
    ).toThrow(ConfigurationError);

    const unavailable = createServiceRpcClient({
      allowedFunctions: ["safe"],
      environment: {
        ...environment,
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321"
      },
      fetch: vi.fn(() => Promise.reject(new Error("network canary")))
    });
    await expect(unavailable.rpc("safe", {})).rejects.toMatchObject({
      code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    });
  });

  it("permits only the explicit non-Vercel built-CI loopback transport", async () => {
    const request = vi.fn(() => Promise.resolve(Response.json({ state: "expanded" })));
    const client = createServiceRpcClient({
      allowedFunctions: ["safe"],
      environment: {
        ...environment,
        CI: "true",
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
        NODE_ENV: "production",
        UNFILED_ALLOW_INSECURE_LOCAL_SUPABASE_E2E: "1"
      },
      fetch: request
    });

    await expect(client.rpc("safe", {})).resolves.toEqual({ state: "expanded" });
    expect(request).toHaveBeenCalledWith(
      "http://127.0.0.1:54321/rest/v1/rpc/safe",
      expect.objectContaining({ method: "POST", redirect: "error" })
    );
  });

  it("forwards capability-scope revocation to the network request", async () => {
    const scope = new AbortController();
    const request = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(scope.signal);
      scope.abort();
      return Promise.reject(new Error("request aborted"));
    });
    const client = createServiceRpcClient({
      allowedFunctions: ["safe"],
      environment,
      fetch: request,
      signal: scope.signal
    });

    await expect(client.rpc("safe", {})).rejects.toMatchObject({
      code: ServiceRpcErrorCode.PROVIDER_UNAVAILABLE
    });
    expect(request).toHaveBeenCalledOnce();
  });
});
