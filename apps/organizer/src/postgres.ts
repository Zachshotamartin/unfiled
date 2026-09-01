import { Pool, type PoolClient, type PoolConfig, type QueryResult } from "pg";

import {
  ORGANIZER_IDENTITY_SQL,
  ORGANIZER_RPC_SQL,
  OrganizerDatabaseContractError,
  assertOrganizerSessionRows,
  type OrganizerDatabaseExecutor,
  type OrganizerDatabaseQuery
} from "./database.js";
import { parseOrganizerDatabaseUrl } from "./database-url.js";

const ALLOWED_SQL = new Set<string>([ORGANIZER_IDENTITY_SQL, ...Object.values(ORGANIZER_RPC_SQL)]);
type OrganizerPoolClient = Readonly<{
  query(
    config: Readonly<{ text: string; values: readonly unknown[] }>
  ): Promise<Readonly<{ rows: readonly unknown[] }>>;
  release(error?: Error | boolean): void;
}>;
export type OrganizerPool = Readonly<{
  connect(): Promise<OrganizerPoolClient>;
  end(): Promise<void>;
}>;
export type PostgresOrganizerExecutor = Readonly<{
  close(): Promise<void>;
  executor: OrganizerDatabaseExecutor;
}>;

function assertSql(text: string): void {
  if (!ALLOWED_SQL.has(text)) throw new OrganizerDatabaseContractError("contract_violation");
}

async function queryWithAbort(
  client: OrganizerPoolClient,
  query: OrganizerDatabaseQuery
): Promise<Readonly<{ rows: readonly unknown[] }>> {
  if (query.signal.aborted) {
    client.release(new Error("Organizer database operation aborted."));
    throw new DOMException("The operation was aborted", "AbortError");
  }
  let released = false;
  const release = (error?: Error): void => {
    if (released) return;
    released = true;
    client.release(error);
  };
  let rejectAbort: ((reason: DOMException) => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    release(new Error("Organizer database operation aborted."));
    rejectAbort?.(new DOMException("The operation was aborted", "AbortError"));
  };
  query.signal.addEventListener("abort", onAbort, { once: true });
  const operation = client.query({ text: query.text, values: query.values });
  void operation.catch(() => undefined);
  try {
    const result = await Promise.race([operation, abort]);
    return Object.freeze({ rows: Object.freeze([...result.rows]) });
  } finally {
    query.signal.removeEventListener("abort", onAbort);
    release();
  }
}

export function createOrganizerDatabaseExecutor(pool: OrganizerPool): PostgresOrganizerExecutor {
  return Object.freeze({
    close: () => pool.end(),
    executor: Object.freeze({
      async query(query: OrganizerDatabaseQuery) {
        assertSql(query.text);
        if (!Array.isArray(query.values))
          throw new OrganizerDatabaseContractError("contract_violation");
        return queryWithAbort(await pool.connect(), query);
      }
    })
  });
}

export function createPostgresOrganizerExecutor(
  input: Readonly<{
    caPem: string;
    connectTimeoutMs: number;
    expectedHost: string;
    projectRef: string;
    statementTimeoutMs: number;
    url: string;
  }>
): PostgresOrganizerExecutor {
  const connection = parseOrganizerDatabaseUrl(input);
  const config: PoolConfig = {
    allowExitOnIdle: true,
    application_name: "unfiled-organizer-worker",
    connectionTimeoutMillis: input.connectTimeoutMs,
    database: connection.database,
    enableChannelBinding: true,
    host: connection.host,
    idleTimeoutMillis: 10_000,
    keepAlive: true,
    max: 2,
    maxLifetimeSeconds: 300,
    maxUses: 500,
    password: connection.password,
    port: connection.port,
    query_timeout: input.statementTimeoutMs + 250,
    ssl: {
      ca: input.caPem,
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
      servername: connection.host
    },
    statement_timeout: input.statementTimeoutMs,
    user: connection.user,
    verify(client: PoolClient, done: (error?: Error) => void): void {
      client
        .query({ text: ORGANIZER_IDENTITY_SQL, values: [] })
        .then((result: QueryResult) => {
          try {
            assertOrganizerSessionRows(result.rows);
            done();
          } catch {
            done(new OrganizerDatabaseContractError("identity_denied"));
          }
        })
        .catch(() => done(new OrganizerDatabaseContractError("identity_denied")));
    }
  };
  return createOrganizerDatabaseExecutor(new Pool(config));
}
