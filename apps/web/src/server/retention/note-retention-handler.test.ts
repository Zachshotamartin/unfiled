import { describe, expect, it, vi } from "vitest";

import { createNoteRetentionHandler } from "./note-retention-handler";

const SECRET = "retention-cron-test-secret-is-32-chars-minimum";
const RUN_AT = new Date("2026-08-30T12:00:00.000Z");

function request(path = "", authorization?: string): Request {
  return new Request(`https://unfiled.test/api/internal/retention/notes${path}`, {
    headers: authorization === undefined ? {} : { authorization }
  });
}

describe("note retention cron handler", () => {
  it("rejects missing or incorrect cron authorization before touching data", async () => {
    const runBatch = vi.fn();
    const handler = createNoteRetentionHandler({ getSecret: () => SECRET, runBatch });

    const missing = await handler(request());
    const incorrect = await handler(request("", "Bearer incorrect"));

    expect(missing.status).toBe(401);
    expect(incorrect.status).toBe(401);
    expect(runBatch).not.toHaveBeenCalled();
  });

  it("fails closed when the cron secret is absent or too short", async () => {
    const runBatch = vi.fn();
    const missing = createNoteRetentionHandler({ getSecret: () => undefined, runBatch });
    const short = createNoteRetentionHandler({ getSecret: () => "short", runBatch });

    await expect((await missing(request())).json()).resolves.toMatchObject({
      code: "provider_unavailable"
    });
    expect((await short(request("", "Bearer short"))).status).toBe(503);
    expect(runBatch).not.toHaveBeenCalled();
  });

  it("runs an authenticated dry run while execution is disabled", async () => {
    const runBatch = vi.fn().mockResolvedValue({
      cutoff: "2026-07-31T12:00:00.000Z",
      eligibleCount: 17,
      executed: false,
      purgedCount: 0,
      runAt: RUN_AT.toISOString()
    });
    const handler = createNoteRetentionHandler({
      executionEnabled: () => false,
      getSecret: () => SECRET,
      now: () => RUN_AT,
      runBatch
    });

    const response = await handler(request("", `Bearer ${SECRET}`));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      batches: 1,
      dryRun: true,
      eligibleCount: 17,
      executionEnabled: false,
      purgedCount: 0
    });
    expect(runBatch).toHaveBeenCalledWith({
      batchSize: 500,
      execute: false,
      now: RUN_AT,
      ownerId: null
    });
  });

  it("drains full batches only after the explicit execution gate is enabled", async () => {
    const runBatch = vi
      .fn()
      .mockResolvedValueOnce({
        cutoff: "2026-07-31T12:00:00.000Z",
        eligibleCount: 500,
        executed: true,
        purgedCount: 500,
        runAt: RUN_AT.toISOString()
      })
      .mockResolvedValueOnce({
        cutoff: "2026-07-31T12:00:00.000Z",
        eligibleCount: 7,
        executed: true,
        purgedCount: 7,
        runAt: RUN_AT.toISOString()
      });
    const handler = createNoteRetentionHandler({
      executionEnabled: () => true,
      getSecret: () => SECRET,
      now: () => RUN_AT,
      runBatch
    });

    const response = await handler(request("", `Bearer ${SECRET}`));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      batchLimitReached: false,
      batches: 2,
      dryRun: false,
      eligibleCount: 507,
      executionEnabled: true,
      purgedCount: 507,
      runAt: RUN_AT.toISOString()
    });
    expect(runBatch).toHaveBeenCalledTimes(2);
    expect(runBatch).toHaveBeenNthCalledWith(1, {
      batchSize: 500,
      execute: true,
      now: RUN_AT,
      ownerId: null
    });
  });

  it("keeps the authenticated dry-run override after execution is enabled", async () => {
    const runBatch = vi.fn().mockResolvedValue({
      cutoff: "2026-07-31T12:00:00.000Z",
      eligibleCount: 1,
      executed: false,
      purgedCount: 0,
      runAt: RUN_AT.toISOString()
    });
    const handler = createNoteRetentionHandler({
      executionEnabled: () => true,
      getSecret: () => SECRET,
      now: () => RUN_AT,
      runBatch
    });

    const response = await handler(request("?dryRun=true", `Bearer ${SECRET}`));

    expect(response.status).toBe(200);
    expect(runBatch).toHaveBeenCalledWith(expect.objectContaining({ execute: false }));
  });

  it("fails closed if the database does not honor the requested execution mode", async () => {
    const runBatch = vi.fn().mockResolvedValue({
      cutoff: "2026-07-31T12:00:00.000Z",
      eligibleCount: 1,
      executed: false,
      purgedCount: 0,
      runAt: RUN_AT.toISOString()
    });
    const handler = createNoteRetentionHandler({
      executionEnabled: () => true,
      getSecret: () => SECRET,
      runBatch
    });

    const response = await handler(request("", `Bearer ${SECRET}`));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "provider_unavailable" });
  });
});
