import { describe, expect, it, vi } from "vitest";

import {
  ORGANIZER_IDENTITY_SQL,
  ORGANIZER_RPC_SQL,
  OrganizerDatabaseContractError,
  assertOrganizerSessionRows
} from "../src/database.js";
import { createOrganizerDatabaseExecutor, type OrganizerPool } from "../src/postgres.js";

function pool(
  query: ReturnType<typeof vi.fn>
): OrganizerPool & { client: { release: ReturnType<typeof vi.fn> } } {
  const client = { query, release: vi.fn() };
  return {
    client,
    connect: vi.fn().mockResolvedValue(client),
    end: vi.fn().mockResolvedValue(undefined)
  };
}

describe("organizer Postgres executor", () => {
  it("allows only identity preflight and the exact eleven RPC SQL statements", async () => {
    const selectedPool = pool(vi.fn().mockResolvedValue({ rows: [{ result: {} }] }));
    const database = createOrganizerDatabaseExecutor(selectedPool);
    await database.executor.query({
      signal: new AbortController().signal,
      text: ORGANIZER_IDENTITY_SQL,
      values: []
    });
    for (const text of Object.values(ORGANIZER_RPC_SQL)) {
      await database.executor.query({ signal: new AbortController().signal, text, values: [] });
    }
    expect(Object.values(ORGANIZER_RPC_SQL)).toHaveLength(11);
    expect(selectedPool.client.release).toHaveBeenCalledTimes(
      Object.values(ORGANIZER_RPC_SQL).length + 1
    );
    await expect(
      database.executor.query({
        signal: new AbortController().signal,
        text: "select * from public.notes",
        values: []
      })
    ).rejects.toBeInstanceOf(OrganizerDatabaseContractError);
    await expect(
      database.executor.query({
        signal: new AbortController().signal,
        text: "select public.claim_encrypted_organizer_jobs() as result",
        values: []
      })
    ).rejects.toBeInstanceOf(OrganizerDatabaseContractError);
    await database.close();
    expect(selectedPool.end).toHaveBeenCalledOnce();
  });

  it("destroys the checked-out connection when an in-flight query is aborted", async () => {
    let resolve!: (value: { rows: readonly unknown[] }) => void;
    const selectedPool = pool(
      vi.fn().mockReturnValue(
        new Promise((done) => {
          resolve = done;
        })
      )
    );
    const controller = new AbortController();
    const pending = createOrganizerDatabaseExecutor(selectedPool).executor.query({
      signal: controller.signal,
      text: ORGANIZER_RPC_SQL.claim,
      values: ["worker", 1, 120]
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(selectedPool.client.release).toHaveBeenCalledWith(expect.any(Error));
    resolve({ rows: [] });
  });

  it("rejects pre-aborted operations and invalid query values", async () => {
    const selectedPool = pool(vi.fn().mockResolvedValue({ rows: [] }));
    const database = createOrganizerDatabaseExecutor(selectedPool);
    const controller = new AbortController();
    controller.abort();
    await expect(
      database.executor.query({
        signal: controller.signal,
        text: ORGANIZER_RPC_SQL.claim,
        values: []
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      database.executor.query({
        signal: new AbortController().signal,
        text: ORGANIZER_RPC_SQL.claim,
        values: {} as never
      })
    ).rejects.toBeInstanceOf(OrganizerDatabaseContractError);
  });

  it("validates exact session identity rows", () => {
    expect(() =>
      assertOrganizerSessionRows([
        { sessionUser: "unfiled_organizer_worker", currentUser: "unfiled_organizer_worker" }
      ])
    ).not.toThrow();
    expect(() => assertOrganizerSessionRows([])).toThrow("denied");
    expect(() =>
      assertOrganizerSessionRows([
        { sessionUser: "postgres", currentUser: "unfiled_organizer_worker" }
      ])
    ).toThrow("denied");
    expect(() =>
      assertOrganizerSessionRows([
        {
          sessionUser: "unfiled_organizer_worker",
          currentUser: "unfiled_organizer_worker",
          extra: true
        }
      ])
    ).toThrow("rejected");
  });
});
