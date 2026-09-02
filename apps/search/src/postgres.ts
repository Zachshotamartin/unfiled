import { Pool, type PoolClient, type PoolConfig, type QueryResult } from "pg";

import {
  SEARCH_IDENTITY_SQL,
  SEARCH_RPC_SQL,
  SearchDatabaseContractError,
  assertSearchSessionRows,
  type SearchDatabaseExecutor,
  type SearchDatabaseQuery
} from "./database.js";
import { parseSearchDatabaseUrl } from "./database-url.js";

const ALLOWED_SQL = new Set<string>([SEARCH_IDENTITY_SQL, ...Object.values(SEARCH_RPC_SQL)]);

type SearchPoolClient = Readonly<{
  query(
    config: Readonly<{ text: string; values: readonly unknown[] }>
  ): Promise<Readonly<{ rows: readonly unknown[] }>>;
  release(error?: Error | boolean): void;
}>;

export type SearchPool = Readonly<{
  connect(): Promise<SearchPoolClient>;
  end(): Promise<void>;
}>;

export type PostgresSearchExecutor = Readonly<{
  close(): Promise<void>;
  executor: SearchDatabaseExecutor;
}>;

function assertSql(text: string): void {
  if (!ALLOWED_SQL.has(text)) throw new SearchDatabaseContractError("contract_violation");
}

async function queryWithAbort(
  client: SearchPoolClient,
  query: SearchDatabaseQuery
): Promise<Readonly<{ rows: readonly unknown[] }>> {
  if (query.signal.aborted) {
    client.release(new Error("Search database operation aborted."));
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
    release(new Error("Search database operation aborted."));
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

export function createSearchDatabaseExecutor(pool: SearchPool): PostgresSearchExecutor {
  return Object.freeze({
    close: () => pool.end(),
    executor: Object.freeze({
      async query(query: SearchDatabaseQuery) {
        assertSql(query.text);
        if (!Array.isArray(query.values)) {
          throw new SearchDatabaseContractError("contract_violation");
        }
        return queryWithAbort(await pool.connect(), query);
      }
    })
  });
}

export function createPostgresSearchExecutor(
  input: Readonly<{
    caPem: string;
    connectTimeoutMs: number;
    expectedHost: string;
    projectRef: string;
    statementTimeoutMs: number;
    url: string;
  }>
): PostgresSearchExecutor {
  const connection = parseSearchDatabaseUrl(input);
  const config: PoolConfig = {
    allowExitOnIdle: true,
    application_name: "unfiled-search-worker",
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
        .query({ text: SEARCH_IDENTITY_SQL, values: [] })
        .then((result: QueryResult) => {
          try {
            assertSearchSessionRows(result.rows);
            done();
          } catch {
            done(new SearchDatabaseContractError("identity_denied"));
          }
        })
        .catch(() => done(new SearchDatabaseContractError("identity_denied")));
    }
  };
  return createSearchDatabaseExecutor(new Pool(config));
}
