import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runNoteRetentionBatch } from "./note-retention";

const previous = {
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  url: process.env.NEXT_PUBLIC_SUPABASE_URL
};

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
  it("is dry-run by default and sends one bounded owner-scoped service RPC", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
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

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://retention-test.supabase.co/rest/v1/rpc/purge_expired_deleted_notes");
    expect(init).toMatchObject({ method: "POST", cache: "no-store" });
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer retention-service-role-test"
    );
    const body = init?.body;
    expect(typeof body).toBe("string");
    if (typeof body !== "string") throw new TypeError("expected a JSON request body");
    expect(JSON.parse(body)).toEqual({
      p_batch_size: 25,
      p_execute: false,
      p_now: "2026-08-30T12:00:00.000Z",
      p_owner_id: "11111111-1111-4111-8111-111111111111"
    });
  });

  it("requires an explicit execute flag for an executing batch", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
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

    const body = fetcher.mock.calls[0]?.[1]?.body;
    expect(typeof body).toBe("string");
    if (typeof body !== "string") throw new TypeError("expected a JSON request body");
    expect(JSON.parse(body)).toMatchObject({
      p_execute: true,
      p_owner_id: null
    });
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
