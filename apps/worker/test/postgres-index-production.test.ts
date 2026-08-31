import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted<{
  config: unknown;
  connect: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}>(() => ({
  config: undefined,
  connect: vi.fn(),
  end: vi.fn()
}));

vi.mock("pg", () => ({
  Pool: class {
    constructor(config: unknown) {
      mocks.config = config;
    }

    connect = mocks.connect;
    end = mocks.end;
  }
}));

import { createPostgresIndexExecutor } from "../src/postgres-index-executor";

const PROJECT_REF = "abcdefghijklmnopqrst";
const HOST = "aws-0-us-west-2.pooler.supabase.com";
const TRANSPORT_USER = `unfiled_index_worker.${PROJECT_REF}`;
const URL = `postgresql://${TRANSPORT_USER}:dedicated-capability-secret@${HOST}:6543/postgres?sslmode=verify-full`;

describe("production PostgreSQL pool composition", () => {
  beforeEach(() => {
    mocks.config = undefined;
    mocks.connect.mockReset();
    mocks.end.mockReset().mockResolvedValue(undefined);
  });

  it("pins verified TLS, channel binding, bounded pool/timeouts, and connection verification", async () => {
    const postgres = createPostgresIndexExecutor({
      caPem: "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n",
      connectTimeoutMs: 5_000,
      expectedHost: HOST,
      projectRef: PROJECT_REF,
      statementTimeoutMs: 15_000,
      url: URL
    });
    const config = mocks.config as Record<string, unknown>;

    expect(config).toMatchObject({
      allowExitOnIdle: true,
      application_name: "unfiled-index-worker",
      connectionTimeoutMillis: 5_000,
      database: "postgres",
      enableChannelBinding: true,
      host: HOST,
      max: 2,
      password: "dedicated-capability-secret",
      port: 6_543,
      query_timeout: 15_250,
      statement_timeout: 15_000,
      user: TRANSPORT_USER
    });
    expect(config.ssl).toMatchObject({
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
          rows: [{ currentUser: "unfiled_index_worker", sessionUser: "unfiled_index_worker" }]
        })
      },
      done
    );
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith());
    await postgres.close();
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it("destroys a new connection when identity verification fails or errors", async () => {
    createPostgresIndexExecutor({
      caPem: "test-ca",
      connectTimeoutMs: 5_000,
      expectedHost: HOST,
      projectRef: PROJECT_REF,
      statementTimeoutMs: 15_000,
      url: URL
    });
    const verify = (mocks.config as Record<string, unknown>).verify as (
      client: { query: ReturnType<typeof vi.fn> },
      done: (error?: Error) => void
    ) => void;

    for (const query of [
      vi.fn().mockResolvedValue({ rows: [{ currentUser: "postgres", sessionUser: "postgres" }] }),
      vi.fn().mockRejectedValue(new Error("credential-canary"))
    ]) {
      const done = vi.fn();
      verify({ query }, done);
      await vi.waitFor(() => expect(done).toHaveBeenCalledWith(expect.any(Error)));
      expect(String(done.mock.calls[0]?.[0])).not.toContain("credential-canary");
    }
  });
});
