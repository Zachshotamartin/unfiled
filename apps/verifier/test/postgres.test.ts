import { beforeEach, describe, expect, it, vi } from "vitest";

import type { VerifierDatabaseQuery } from "../src/database";

const mocks = vi.hoisted<{
  config: unknown;
  connect: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}>(() => ({ config: undefined, connect: vi.fn(), end: vi.fn() }));

vi.mock("pg", () => ({
  Pool: class {
    constructor(config: unknown) {
      mocks.config = config;
    }

    connect = mocks.connect;
    end = mocks.end;
  }
}));

import {
  createPostgresVerifierExecutor,
  createVerifierDatabaseQueryExecutor,
  type VerifierPool,
  verifyVerifierSessionRows
} from "../src/postgres";

const PROJECT_REF = "abcdefghijklmnopqrst";
const HOST = "aws-0-us-west-2.pooler.supabase.com";
const USER = `unfiled_rag_verifier.${PROJECT_REF}`;
const URL = `postgresql://${USER}:dedicated-verifier-password@${HOST}:6543/postgres?sslmode=verify-full`;
const identitySql =
  'select session_user::text as "sessionUser", current_user::text as "currentUser"';

describe("verifier PostgreSQL boundary", () => {
  beforeEach(() => {
    mocks.config = undefined;
    mocks.connect.mockReset();
    mocks.end.mockReset().mockResolvedValue(undefined);
  });

  it("pins exact TLS, role, pool, statement, and connection verification", async () => {
    const postgres = createPostgresVerifierExecutor({
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
      application_name: "unfiled-rag-verifier",
      connectionTimeoutMillis: 2_000,
      database: "postgres",
      enableChannelBinding: true,
      host: HOST,
      max: 1,
      password: "dedicated-verifier-password",
      port: 6_543,
      query_timeout: 500,
      statement_timeout: 250,
      user: USER
    });
    expect(config.ssl).toMatchObject({
      ca: "test-ca",
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
      servername: HOST
    });
    const verify = config.verify as (
      client: { query: ReturnType<typeof vi.fn> },
      done: (error?: Error) => void
    ) => void;
    const done = vi.fn();
    verify(
      {
        query: vi.fn().mockResolvedValue({
          rows: [{ sessionUser: "unfiled_rag_verifier", currentUser: "unfiled_rag_verifier" }]
        })
      },
      done
    );
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith());
    await postgres.close();
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it("sanitizes connection identity verification failures", async () => {
    createPostgresVerifierExecutor({
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
      vi.fn().mockResolvedValue({ rows: [{ sessionUser: "postgres", currentUser: "postgres" }] }),
      vi.fn().mockRejectedValue(new Error("credential-secret-canary"))
    ]) {
      const done = vi.fn();
      verify({ query }, done);
      await vi.waitFor(() => expect(done).toHaveBeenCalledWith(expect.any(Error)));
      expect(String(done.mock.calls[0]?.[0])).not.toContain("credential-secret-canary");
    }
  });

  it("allows only identity and the exact two RPC statements", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [{ result: {} }] }),
      release: vi.fn()
    };
    const connect = vi.fn(() => Promise.resolve(client));
    const boundary = createVerifierDatabaseQueryExecutor({
      connect,
      end: () => Promise.resolve()
    });
    const signal = new AbortController().signal;
    for (const text of [
      identitySql,
      "select public.list_building_note_rag_index($1::uuid) as result",
      "select public.verify_rag_index_generation($1::uuid) as result"
    ]) {
      await expect(boundary.executor.query({ text, values: [], signal })).resolves.toMatchObject({
        rows: [{ result: {} }]
      });
    }
    for (const text of [
      "select * from public.note_rag_index",
      "select public.activate_rag_index_generation($1::uuid) as result",
      "set role postgres",
      "select public.verify_rag_index_generation($1::uuid); select 1 as result"
    ]) {
      await expect(boundary.executor.query({ text, values: [], signal })).rejects.toMatchObject({
        code: "contract_violation"
      });
    }
    expect(connect).toHaveBeenCalledOnce();
    expect(client.release).not.toHaveBeenCalled();
    await boundary.close();
    expect(client.release).toHaveBeenCalledWith();
  });

  it("destroys a checked-out client on abort and releases it normally otherwise", async () => {
    const controller = new AbortController();
    let resolveQuery: ((value: { rows: readonly unknown[] }) => void) | undefined;
    const client = {
      query: vi.fn(
        () =>
          new Promise<{ rows: readonly unknown[] }>((resolve) => {
            resolveQuery = resolve;
          })
      ),
      release: vi.fn()
    };
    const boundary = createVerifierDatabaseQueryExecutor({
      connect: () => Promise.resolve(client),
      end: () => Promise.resolve()
    });
    const pending = boundary.executor.query({
      text: identitySql,
      values: [],
      signal: controller.signal
    });
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
    resolveQuery?.({ rows: [] });

    const released = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
    const normal = createVerifierDatabaseQueryExecutor({
      connect: () => Promise.resolve(released),
      end: () => Promise.resolve()
    });
    const normalSignal = new AbortController().signal;
    await normal.executor.query({
      text: identitySql,
      values: [],
      signal: normalSignal
    });
    expect(released.release).not.toHaveBeenCalled();
    normal.executor.releaseSession?.(normalSignal);
    expect(released.release).toHaveBeenCalledWith();
  });

  it("reuses one checked-out client and caps reconnects at two per verification signal", async () => {
    const first = {
      query: vi.fn().mockRejectedValue(new Error("first-connection-failed")),
      release: vi.fn()
    };
    const second = {
      query: vi.fn().mockRejectedValue(new Error("second-connection-failed")),
      release: vi.fn()
    };
    const connect = vi
      .fn<VerifierPool["connect"]>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const boundary = createVerifierDatabaseQueryExecutor({
      connect,
      end: () => Promise.resolve()
    });
    const signal = new AbortController().signal;
    const request = { text: identitySql, values: [], signal };

    await expect(boundary.executor.query(request)).rejects.toThrow("first-connection-failed");
    await expect(boundary.executor.query(request)).rejects.toThrow("second-connection-failed");
    await expect(boundary.executor.query(request)).rejects.toMatchObject({
      code: "contract_violation"
    });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(first.release).toHaveBeenCalledWith(expect.any(Error));
    expect(second.release).toHaveBeenCalledWith(expect.any(Error));
  });

  it("rejects pre-aborted requests, invalid values, and wrong session rows", async () => {
    const released = { query: vi.fn(), release: vi.fn() };
    const boundary = createVerifierDatabaseQueryExecutor({
      connect: () => Promise.resolve(released),
      end: () => Promise.resolve()
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      boundary.executor.query({ text: identitySql, values: [], signal: controller.signal })
    ).rejects.toThrow("aborted");
    expect(released.query).not.toHaveBeenCalled();
    expect(released.release).not.toHaveBeenCalled();

    await expect(
      boundary.executor.query({
        text: identitySql,
        values: {} as VerifierDatabaseQuery["values"],
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: "contract_violation" });

    expect(() => verifyVerifierSessionRows([])).toThrow();
    expect(() =>
      verifyVerifierSessionRows([{ sessionUser: "unfiled_rag_verifier", currentUser: "postgres" }])
    ).toThrow();
    expect(() =>
      verifyVerifierSessionRows([
        { sessionUser: "unfiled_rag_verifier", currentUser: "unfiled_rag_verifier" }
      ])
    ).not.toThrow();
  });
});
