import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runNoteRetentionBatch } from "./note-retention";

const previous = {
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  url: process.env.NEXT_PUBLIC_SUPABASE_URL
};

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  const body = init?.body;
  if (typeof body !== "string") throw new TypeError("expected a JSON request body");
  const parsed: unknown = JSON.parse(body) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("expected a JSON object request body");
  }
  return parsed as Record<string, unknown>;
}

function requestUrl(input: RequestInfo | URL | undefined): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  throw new TypeError("expected a request URL");
}

function contractState(state: "expand_compatible" | "contracted") {
  return {
    schemaVersion: 1,
    state,
    appliedAt: state === "contracted" ? "2026-08-30T11:59:00.000Z" : null
  };
}

function emptyEncryptedClaim(executed: boolean) {
  return {
    runAt: "2026-08-30T12:00:00.000Z",
    cutoff: "2026-07-31T12:00:00.000Z",
    eligibleCount: 0,
    executed,
    claimedCount: 0,
    claims: [],
    replayed: false
  };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://retention-test.supabase.co/";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "retention-service-role-test";
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previous.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = previous.url;
  if (previous.serviceRoleKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = previous.serviceRoleKey;
});

describe("runNoteRetentionBatch", () => {
  it("dispatches an expanded owner to the bounded legacy dry-run protocol", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(contractState("expand_compatible")))
      .mockResolvedValueOnce(
        Response.json({
          found: false,
          state: "expanded",
          writeMode: "legacy",
          readMode: "legacy",
          backfill: null,
          plaintextScrub: null,
          readiness: {
            readyForEncryptedRead: false,
            requiredObjectCount: 0,
            exactVerifiedObjectCount: 0,
            missingObjectCount: 0,
            missingBySurface: {},
            activeKeySlots: 0,
            taxonomyEpochReady: false,
            backfillComplete: false
          }
        })
      )
      .mockResolvedValueOnce(Response.json(contractState("expand_compatible")))
      .mockResolvedValueOnce(
        Response.json({
          cutoff: "2026-07-31T12:00:00+00:00",
          eligibleCount: 2,
          executed: false,
          purgedCount: 0,
          runAt: "2026-08-30T12:00:00+00:00"
        })
      );

    await expect(
      runNoteRetentionBatch(
        {
          batchSize: 25,
          now: new Date("2026-08-30T12:00:00.000Z"),
          ownerId: "11111111-1111-4111-8111-111111111111"
        },
        fetcher
      )
    ).resolves.toMatchObject({ eligibleCount: 2, executed: false, purgedCount: 0 });

    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://retention-test.supabase.co/rest/v1/rpc/get_encrypted_storage_contract_state"
    );
    const [rolloutUrl, rolloutInit] = fetcher.mock.calls[1] ?? [];
    expect(rolloutUrl).toBe(
      "https://retention-test.supabase.co/rest/v1/rpc/get_content_encryption_rollout"
    );
    expect(requestBody(rolloutInit)).toEqual({
      p_owner_id: "11111111-1111-4111-8111-111111111111"
    });
    expect(fetcher.mock.calls[2]?.[0]).toBe(
      "https://retention-test.supabase.co/rest/v1/rpc/get_encrypted_storage_contract_state"
    );
    const [url, init] = fetcher.mock.calls[3] ?? [];
    expect(url).toBe("https://retention-test.supabase.co/rest/v1/rpc/purge_expired_deleted_notes");
    expect(init).toMatchObject({ method: "POST", cache: "no-store" });
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer retention-service-role-test"
    );
    expect(requestBody(init)).toEqual({
      p_batch_size: 25,
      p_execute: false,
      p_now: "2026-08-30T12:00:00.000Z",
      p_owner_id: "11111111-1111-4111-8111-111111111111"
    });
  });

  it("runs encrypted discovery before the legacy remainder for a global executing batch", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(contractState("expand_compatible")))
      .mockResolvedValueOnce(
        Response.json({
          runAt: "2026-08-30T12:00:00.000Z",
          cutoff: "2026-07-31T12:00:00.000Z",
          eligibleCount: 0,
          executed: true,
          claimedCount: 0,
          claims: [],
          replayed: false
        })
      )
      .mockResolvedValueOnce(Response.json(contractState("expand_compatible")))
      .mockResolvedValueOnce(
        Response.json({
          cutoff: "2026-07-31T12:00:00+00:00",
          eligibleCount: 1,
          executed: true,
          purgedCount: 1,
          runAt: "2026-08-30T12:00:00+00:00"
        })
      );

    await expect(
      runNoteRetentionBatch({ execute: true, now: new Date("2026-08-30T12:00:00.000Z") }, fetcher)
    ).resolves.toMatchObject({ executed: true, purgedCount: 1 });

    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://retention-test.supabase.co/rest/v1/rpc/get_encrypted_storage_contract_state"
    );
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "https://retention-test.supabase.co/rest/v1/rpc/claim_encrypted_note_retention"
    );
    const claimBody = requestBody(fetcher.mock.calls[1]?.[1]);
    expect(claimBody).toMatchObject({
      p_batch_size: 25,
      p_execute: true,
      p_lease_seconds: 300,
      p_now: "2026-08-30T12:00:00.000Z",
      p_owner_id: null
    });
    expect(claimBody.p_run_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
    expect(claimBody.p_lease_token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
    expect(fetcher.mock.calls[2]?.[0]).toBe(
      "https://retention-test.supabase.co/rest/v1/rpc/get_encrypted_storage_contract_state"
    );
    expect(fetcher.mock.calls[3]?.[0]).toBe(
      "https://retention-test.supabase.co/rest/v1/rpc/purge_expired_deleted_notes"
    );
    expect(requestBody(fetcher.mock.calls[3]?.[1])).toMatchObject({
      p_execute: true,
      p_owner_id: null
    });
  });

  it("never names the legacy purge RPC after the global contract is active", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(contractState("contracted")))
      .mockResolvedValueOnce(Response.json(emptyEncryptedClaim(false)));

    await expect(
      runNoteRetentionBatch({ now: new Date("2026-08-30T12:00:00.000Z") }, fetcher)
    ).resolves.toMatchObject({ eligibleCount: 0, executed: false, purgedCount: 0 });

    expect(fetcher).toHaveBeenCalledTimes(2);
    const urls = fetcher.mock.calls.map(([url]) => requestUrl(url));
    expect(urls).toEqual([
      "https://retention-test.supabase.co/rest/v1/rpc/get_encrypted_storage_contract_state",
      "https://retention-test.supabase.co/rest/v1/rpc/claim_encrypted_note_retention"
    ]);
    expect(urls.join("\n")).not.toContain("purge_expired_deleted_notes");
    expect(urls.join("\n")).not.toContain("get_content_encryption_rollout");
  });

  it("rechecks the global contract and suppresses a legacy remainder during a cutover race", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(contractState("expand_compatible")))
      .mockResolvedValueOnce(Response.json(emptyEncryptedClaim(false)))
      .mockResolvedValueOnce(Response.json(contractState("contracted")));

    await expect(
      runNoteRetentionBatch({ now: new Date("2026-08-30T12:00:00.000Z") }, fetcher)
    ).resolves.toMatchObject({ eligibleCount: 0, executed: false, purgedCount: 0 });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.map(([url]) => requestUrl(url)).join("\n")).not.toContain(
      "purge_expired_deleted_notes"
    );
  });

  it.each([
    { schemaVersion: 2, state: "expand_compatible", appliedAt: null },
    { schemaVersion: 1, state: "contracted", appliedAt: null },
    {
      schemaVersion: 1,
      state: "expand_compatible",
      appliedAt: "2026-08-30T11:59:00.000Z"
    },
    { ...contractState("contracted"), extra: "reject" }
  ])("fails closed for a malformed contract projection: %o", async (projection) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(projection));

    await expect(runNoteRetentionBatch({}, fetcher)).rejects.toMatchObject({
      code: "provider_unavailable",
      status: 503
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(requestUrl(fetcher.mock.calls[0]?.[0])).not.toContain("purge_expired_deleted_notes");
  });

  it("rejects unsafe batch sizes before contacting the data service", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(runNoteRetentionBatch({ batchSize: 501 }, fetcher)).rejects.toMatchObject({
      code: "validation_failed",
      status: 400
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("maps failed and malformed provider responses to safe service errors", async () => {
    const failed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("database detail must not escape", { status: 500 }));
    await expect(runNoteRetentionBatch({}, failed)).rejects.toEqual(
      expect.objectContaining({
        code: "provider_unavailable",
        message: "The retention service could not complete this batch.",
        status: 503
      })
    );

    const malformed = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ purgedCount: -1 }));
    await expect(runNoteRetentionBatch({}, malformed)).rejects.toMatchObject({
      code: "provider_unavailable",
      status: 503
    });
  });
});
