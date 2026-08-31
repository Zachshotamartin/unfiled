import { Pool, type PoolClient, type PoolConfig, type QueryResult } from "pg";

import type {
  IndexDatabaseQuery,
  IndexDatabaseQueryExecutor,
  IndexDatabaseQueryResult
} from "./index-database";
import { IndexDatabaseContractError, NOTE_INDEX_RPC_NAMES } from "./index-database";
import { parseIndexWorkerDatabaseUrl } from "./index-database-url";
import { INDEX_DATABASE_QUERY_CANCEL_GRACE_MS } from "./config";

const EXPECTED_ROLE = "unfiled_index_worker";
const IDENTITY_SQL =
  'select session_user::text as "sessionUser", current_user::text as "currentUser"';
const RPC_NAME_PATTERN = /^select public\.([a-z_]+)\([^;]*\) as result$/u;

type IndexPoolClient = Readonly<{
  query(
    config: Readonly<{ text: string; values: readonly unknown[] }>
  ): Promise<Readonly<{ rows: readonly unknown[] }>>;
  release(error?: Error | boolean): void;
}>;

export type IndexPool = Readonly<{
  connect(): Promise<IndexPoolClient>;
  end(): Promise<void>;
}>;

export type PostgresIndexExecutor = Readonly<{
  close(): Promise<void>;
  executor: IndexDatabaseQueryExecutor;
}>;

function assertAllowedSql(text: string): void {
  if (text === IDENTITY_SQL) return;
  const name = RPC_NAME_PATTERN.exec(text)?.[1];
  if (name === undefined || !(NOTE_INDEX_RPC_NAMES as readonly string[]).includes(name)) {
    throw new IndexDatabaseContractError("contract_violation");
  }
}

export function verifyIndexSessionRows(rows: readonly unknown[]): void {
  if (rows.length !== 1) throw new IndexDatabaseContractError("identity_denied");
  const row = rows[0];
  if (
    row === null ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    Object.keys(row).sort().join(",") !== "currentUser,sessionUser" ||
    (row as Record<string, unknown>).sessionUser !== EXPECTED_ROLE ||
    (row as Record<string, unknown>).currentUser !== EXPECTED_ROLE
  ) {
    throw new IndexDatabaseContractError("identity_denied");
  }
}

async function queryWithAbort(
  client: IndexPoolClient,
  query: IndexDatabaseQuery
): Promise<IndexDatabaseQueryResult> {
  if (query.signal.aborted) {
    client.release(new Error("Index database operation aborted."));
    throw new DOMException("The operation was aborted", "AbortError");
  }
  let released = false;
  let rejectAbort: ((reason: DOMException) => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const releaseOnce = (error?: Error | boolean): void => {
    if (released) return;
    released = true;
    if (error === undefined) client.release();
    else client.release(error);
  };
  const onAbort = (): void => {
    releaseOnce(new Error("Index database operation aborted."));
    rejectAbort?.(new DOMException("The operation was aborted", "AbortError"));
  };
  query.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await Promise.race([
      client.query({ text: query.text, values: query.values }),
      abort
    ]);
    return Object.freeze({ rows: Object.freeze([...result.rows]) });
  } finally {
    query.signal.removeEventListener("abort", onAbort);
    releaseOnce();
  }
}

export function createIndexDatabaseQueryExecutor(pool: IndexPool): PostgresIndexExecutor {
  return Object.freeze({
    async close(): Promise<void> {
      await pool.end();
    },
    executor: Object.freeze({
      async query(query: IndexDatabaseQuery): Promise<IndexDatabaseQueryResult> {
        assertAllowedSql(query.text);
        if (!Array.isArray(query.values)) {
          throw new IndexDatabaseContractError("contract_violation");
        }
        const client = await pool.connect();
        return queryWithAbort(client, query);
      }
    })
  });
}

export function createPostgresIndexExecutor(
  input: Readonly<{
    caPem: string;
    connectTimeoutMs: number;
    expectedHost: string;
    projectRef: string;
    statementTimeoutMs: number;
    url: string;
  }>
): PostgresIndexExecutor {
  const connection = parseIndexWorkerDatabaseUrl({
    expectedHost: input.expectedHost,
    projectRef: input.projectRef,
    url: input.url
  });
  const poolConfig: PoolConfig = {
    allowExitOnIdle: true,
    application_name: "unfiled-index-worker",
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
    query_timeout: input.statementTimeoutMs + INDEX_DATABASE_QUERY_CANCEL_GRACE_MS,
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
        .query({ text: IDENTITY_SQL, values: [] })
        .then((result: QueryResult) => {
          try {
            verifyIndexSessionRows(result.rows);
            done();
          } catch {
            done(new IndexDatabaseContractError("identity_denied"));
          }
        })
        .catch(() => done(new IndexDatabaseContractError("identity_denied")));
    }
  };
  return createIndexDatabaseQueryExecutor(new Pool(poolConfig));
}
