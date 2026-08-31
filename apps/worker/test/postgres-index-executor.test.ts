import { describe, expect, it, vi } from "vitest";

import type { IndexDatabaseQuery } from "../src/index-database";
import {
  createIndexDatabaseQueryExecutor,
  verifyIndexSessionRows,
  type IndexPool
} from "../src/postgres-index-executor";

const IDENTITY_SQL =
  'select session_user::text as "sessionUser", current_user::text as "currentUser"';

function query(text = IDENTITY_SQL, signal = new AbortController().signal): IndexDatabaseQuery {
  return { signal, text, values: [] };
}

describe("PostgreSQL index executor", () => {
  it("uses unnamed allowlisted statements and releases the checked-out session", async () => {
    const release = vi.fn();
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [{ currentUser: "unfiled_index_worker", sessionUser: "unfiled_index_worker" }]
      }),
      release
    };
    const pool: IndexPool = { connect: vi.fn().mockResolvedValue(client), end: vi.fn() };
    const postgres = createIndexDatabaseQueryExecutor(pool);

    await expect(postgres.executor.query(query())).resolves.toMatchObject({
      rows: [expect.anything()]
    });
    expect(client.query).toHaveBeenCalledWith({ text: IDENTITY_SQL, values: [] });
    expect(client.query.mock.calls[0]?.[0]).not.toHaveProperty("name");
    expect(release).toHaveBeenCalledWith();
  });

  it("rejects table SQL, SET ROLE, comments, and non-allowlisted functions before checkout", async () => {
    const pool: IndexPool = { connect: vi.fn(), end: vi.fn() };
    const executor = createIndexDatabaseQueryExecutor(pool).executor;
    for (const text of [
      "select * from public.notes",
      "set role service_role",
      "select public.enqueue_note_index_job($1) as result",
      "select public.claim_note_index_jobs($1) as result; -- no"
    ]) {
      await expect(executor.query(query(text))).rejects.toMatchObject({
        code: "contract_violation"
      });
    }
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("destroys the in-flight connection and rejects promptly on abort", async () => {
    const controller = new AbortController();
    const release = vi.fn();
    const client = {
      query: vi.fn(() => new Promise(() => undefined)),
      release
    };
    const pool: IndexPool = { connect: vi.fn().mockResolvedValue(client), end: vi.fn() };
    const pending = createIndexDatabaseQueryExecutor(pool).executor.query(
      query(IDENTITY_SQL, controller.signal)
    );
    await vi.waitFor(() => {
      expect(client.query).toHaveBeenCalledOnce();
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(release).toHaveBeenCalledWith(expect.any(Error));
  });

  it("destroys a checked-out session when the signal was already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const release = vi.fn();
    const client = { query: vi.fn(), release };
    const pool: IndexPool = { connect: vi.fn().mockResolvedValue(client), end: vi.fn() };

    await expect(
      createIndexDatabaseQueryExecutor(pool).executor.query(query(IDENTITY_SQL, controller.signal))
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(client.query).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(expect.any(Error));
  });

  it("releases rather than destroys a session when PostgreSQL rejects the query", async () => {
    const databaseError = new Error("database unavailable");
    const release = vi.fn();
    const client = {
      query: vi.fn().mockRejectedValue(databaseError),
      release
    };
    const pool: IndexPool = { connect: vi.fn().mockResolvedValue(client), end: vi.fn() };

    await expect(createIndexDatabaseQueryExecutor(pool).executor.query(query())).rejects.toBe(
      databaseError
    );
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith();
  });

  it("passes bounded RPC values through an unnamed allowlisted statement", async () => {
    const rpc = "select public.recover_stale_note_index_jobs($1::integer) as result";
    const release = vi.fn();
    const client = {
      query: vi
        .fn()
        .mockResolvedValue({ rows: [{ result: { failedCount: 0, recoveredCount: 0 } }] }),
      release
    };
    const pool: IndexPool = { connect: vi.fn().mockResolvedValue(client), end: vi.fn() };
    const request: IndexDatabaseQuery = {
      signal: new AbortController().signal,
      text: rpc,
      values: [100]
    };

    await expect(createIndexDatabaseQueryExecutor(pool).executor.query(request)).resolves.toEqual({
      rows: [{ result: { failedCount: 0, recoveredCount: 0 } }]
    });
    expect(client.query).toHaveBeenCalledWith({ text: rpc, values: [100] });
    expect(client.query.mock.calls[0]?.[0]).not.toHaveProperty("name");
    expect(release).toHaveBeenCalledWith();
  });

  it("rejects a non-array values container before checking out a session", async () => {
    const pool: IndexPool = { connect: vi.fn(), end: vi.fn() };
    const invalid = {
      signal: new AbortController().signal,
      text: IDENTITY_SQL,
      values: "not-an-array"
    } as unknown as IndexDatabaseQuery;

    await expect(
      createIndexDatabaseQueryExecutor(pool).executor.query(invalid)
    ).rejects.toMatchObject({
      code: "contract_violation"
    });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("requires exact session_user and current_user with an exact shape", () => {
    expect(() =>
      verifyIndexSessionRows([
        { currentUser: "unfiled_index_worker", sessionUser: "unfiled_index_worker" }
      ])
    ).not.toThrow();
    for (const rows of [
      [],
      [{ currentUser: "service_role", sessionUser: "service_role" }],
      [{ currentUser: "unfiled_index_worker", sessionUser: "unfiled_index_worker", extra: true }]
    ]) {
      expect(() => verifyIndexSessionRows(rows)).toThrow();
    }
  });

  it("closes the pool without exposing connection details", async () => {
    const pool: IndexPool = { connect: vi.fn(), end: vi.fn().mockResolvedValue(undefined) };
    await createIndexDatabaseQueryExecutor(pool).close();
    expect(pool.end).toHaveBeenCalledOnce();
  });
});
