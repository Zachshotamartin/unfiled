import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SearchDatabaseQuery } from "../src/database.js";

const mocks = vi.hoisted<{
  config: unknown;
  connect: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}>(() => ({ config: undefined, connect: vi.fn(), end: vi.fn() }));

vi.mock("pg", () => ({
  Pool: class {
    public constructor(config: unknown) {
      mocks.config = config;
    }

    public connect = mocks.connect;
    public end = mocks.end;
  }
}));

import { SEARCH_IDENTITY_SQL, SEARCH_RPC_SQL, assertSearchSessionRows } from "../src/database.js";
import {
  createPostgresSearchExecutor,
  createSearchDatabaseExecutor,
  type SearchPool
} from "../src/postgres.js";

const PROJECT_REF = "abcdefghijklmnopqrst";
const HOST = "aws-0-us-west-2.pooler.supabase.com";
const USER = `unfiled_search_worker.${PROJECT_REF}`;
const URL = `postgresql://${USER}:dedicated-search-worker-password@${HOST}:6543/postgres?sslmode=verify-full`;

describe("search PostgreSQL boundary", () => {
  beforeEach(() => {
    mocks.config = undefined;
    mocks.connect.mockReset();
    mocks.end.mockReset().mockResolvedValue(undefined);
  });

  it("pins the dedicated role, bounded pool, timeouts, and hostname-verified TLS", async () => {
    const postgres = createPostgresSearchExecutor({
      caPem: "test-ca",
      connectTimeoutMs: 2_000,
      expectedHost: HOST,
      projectRef: PROJECT_REF,
      statementTimeoutMs: 250,
      url: URL
    });
    const config = mocks.config as Record<string, unknown>;
    expect(config).toMatchObject({
      allowExitOnIdle: true,
      application_name: "unfiled-search-worker",
      connectionTimeoutMillis: 2_000,
      database: "postgres",
      enableChannelBinding: true,
      host: HOST,
      idleTimeoutMillis: 10_000,
      keepAlive: true,
      max: 2,
      maxLifetimeSeconds: 300,
      maxUses: 500,
      password: "dedicated-search-worker-password",
      port: 6_543,
      query_timeout: 500,
      statement_timeout: 250,
      user: USER
    });
    expect(config.ssl).toEqual({
      ca: "test-ca",
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
      servername: HOST
    });
    await postgres.close();
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it("verifies both session identities with only the frozen identity statement", async () => {
    createPostgresSearchExecutor({
      caPem: "test-ca",
      connectTimeoutMs: 2_000,
      expectedHost: HOST,
      projectRef: PROJECT_REF,
      statementTimeoutMs: 250,
      url: URL
    });
    const verify = (mocks.config as Record<string, unknown>).verify as (
      client: { query: ReturnType<typeof vi.fn> },
      done: (error?: Error) => void
    ) => void;
    const query = vi.fn().mockResolvedValue({
      rows: [{ currentUser: "unfiled_search_worker", sessionUser: "unfiled_search_worker" }]
    });
    const done = vi.fn();

    verify({ query }, done);

    await vi.waitFor(() => expect(done).toHaveBeenCalledWith());
    expect(query).toHaveBeenCalledWith({ text: SEARCH_IDENTITY_SQL, values: [] });
  });

  it("sanitizes wrong-role, malformed, and query-failure identity checks", async () => {
    createPostgresSearchExecutor({
      caPem: "test-ca",
      connectTimeoutMs: 2_000,
      expectedHost: HOST,
      projectRef: PROJECT_REF,
      statementTimeoutMs: 250,
      url: URL
    });
    const verify = (mocks.config as Record<string, unknown>).verify as (
      client: { query: ReturnType<typeof vi.fn> },
      done: (error?: Error) => void
    ) => void;
    for (const query of [
      vi.fn().mockResolvedValue({
        rows: [{ currentUser: "postgres", sessionUser: "unfiled_search_worker" }]
      }),
      vi.fn().mockResolvedValue({ rows: [{ currentUser: "unfiled_search_worker" }] }),
      vi.fn().mockRejectedValue(new Error("database-secret-canary"))
    ]) {
      const done = vi.fn();
      verify({ query }, done);
      await vi.waitFor(() => expect(done).toHaveBeenCalledWith(expect.any(Error)));
      expect(done.mock.calls[0]?.[0]).toMatchObject({ code: "identity_denied" });
      expect(String(done.mock.calls[0]?.[0])).not.toContain("database-secret-canary");
    }
  });

  it("allows identity plus exactly the five frozen search RPC statements", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [{ result: {} }] }),
      release: vi.fn()
    };
    const connect = vi.fn<SearchPool["connect"]>().mockResolvedValue(client);
    const boundary = createSearchDatabaseExecutor({ connect, end: () => Promise.resolve() });
    const signal = new AbortController().signal;
    const allowed = [SEARCH_IDENTITY_SQL, ...Object.values(SEARCH_RPC_SQL)];

    for (const text of allowed) {
      await expect(boundary.executor.query({ signal, text, values: [] })).resolves.toEqual({
        rows: [{ result: {} }]
      });
    }
    expect(connect).toHaveBeenCalledTimes(allowed.length);
    expect(client.release).toHaveBeenCalledTimes(allowed.length);

    for (const text of [
      "select * from public.note_rag_index",
      "select public.begin_encrypted_user_search($1::uuid, $2::text, $3::jsonb, $4::text) as result",
      `${SEARCH_RPC_SQL.claim} `,
      SEARCH_RPC_SQL.claim.replace("claim_encrypted", "public.claim_encrypted"),
      `${SEARCH_RPC_SQL.page}; select 1`,
      "set role postgres"
    ]) {
      await expect(boundary.executor.query({ signal, text, values: [] })).rejects.toMatchObject({
        code: "contract_violation"
      });
    }
    expect(connect).toHaveBeenCalledTimes(allowed.length);
  });

  it("destroys a checked-out client on pre-abort and in-flight abort", async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const preClient = { query: vi.fn(), release: vi.fn() };
    const preBoundary = createSearchDatabaseExecutor({
      connect: () => Promise.resolve(preClient),
      end: () => Promise.resolve()
    });
    await expect(
      preBoundary.executor.query({
        signal: preAborted.signal,
        text: SEARCH_IDENTITY_SQL,
        values: []
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(preClient.query).not.toHaveBeenCalled();
    expect(preClient.release).toHaveBeenCalledOnce();
    expect(preClient.release).toHaveBeenCalledWith(expect.any(Error));

    const controller = new AbortController();
    let resolveQuery: ((result: { rows: readonly unknown[] }) => void) | undefined;
    const client = {
      query: vi.fn(
        () =>
          new Promise<{ rows: readonly unknown[] }>((resolve) => {
            resolveQuery = resolve;
          })
      ),
      release: vi.fn()
    };
    const boundary = createSearchDatabaseExecutor({
      connect: () => Promise.resolve(client),
      end: () => Promise.resolve()
    });
    const pending = boundary.executor.query({
      signal: controller.signal,
      text: SEARCH_RPC_SQL.claim,
      values: []
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(client.release).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
    resolveQuery?.({ rows: [] });
  });

  it("releases normally, forwards immutable row copies, rejects non-arrays, and closes", async () => {
    const databaseRows = [{ result: { state: "claimed" } }];
    const client = { query: vi.fn().mockResolvedValue({ rows: databaseRows }), release: vi.fn() };
    const end = vi.fn().mockResolvedValue(undefined);
    const boundary = createSearchDatabaseExecutor({
      connect: () => Promise.resolve(client),
      end
    });
    const signal = new AbortController().signal;
    const result = await boundary.executor.query({
      signal,
      text: SEARCH_RPC_SQL.claim,
      values: ["one"]
    });
    databaseRows.push({ result: { state: "mutated" } });
    expect(result.rows).toEqual([{ result: { state: "claimed" } }]);
    expect(Object.isFrozen(result.rows)).toBe(true);
    expect(client.release).toHaveBeenCalledWith(undefined);

    await expect(
      boundary.executor.query({
        signal,
        text: SEARCH_RPC_SQL.claim,
        values: {} as SearchDatabaseQuery["values"]
      })
    ).rejects.toMatchObject({ code: "contract_violation" });
    await boundary.close();
    expect(end).toHaveBeenCalledOnce();
  });

  it("accepts only one exact dedicated-role identity row", () => {
    expect(() =>
      assertSearchSessionRows([
        { currentUser: "unfiled_search_worker", sessionUser: "unfiled_search_worker" }
      ])
    ).not.toThrow();
    for (const rows of [
      [],
      [
        { currentUser: "unfiled_search_worker", sessionUser: "unfiled_search_worker" },
        { currentUser: "unfiled_search_worker", sessionUser: "unfiled_search_worker" }
      ],
      [{ currentUser: "postgres", sessionUser: "unfiled_search_worker" }],
      [{ currentUser: "unfiled_search_worker", sessionUser: "postgres" }],
      [
        {
          currentUser: "unfiled_search_worker",
          extra: true,
          sessionUser: "unfiled_search_worker"
        }
      ]
    ]) {
      expect(() => assertSearchSessionRows(rows)).toThrow();
    }
  });
});
