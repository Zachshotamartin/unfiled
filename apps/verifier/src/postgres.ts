import { Pool, type PoolClient, type PoolConfig, type QueryResult } from "pg";

import { verifierDatabaseQueryCancelGraceMs, type VerifierDatabaseConfig } from "./config.js";
import { RAG_VERIFICATION_DATABASE_CONNECTION_ATTEMPTS } from "./capacity.js";
import {
  VerifierDatabaseContractError,
  VERIFIER_RPC_NAMES,
  type VerifierDatabaseQuery,
  type VerifierDatabaseQueryExecutor,
  type VerifierDatabaseQueryResult
} from "./database.js";
import { parseVerifierDatabaseUrl } from "./database-url.js";

const EXPECTED_ROLE = "unfiled_rag_verifier";
const IDENTITY_SQL =
  'select session_user::text as "sessionUser", current_user::text as "currentUser"';
const RPC_NAME_PATTERN = /^select public\.([a-z_]+)\([^;]*\) as result$/u;

type VerifierPoolClient = Readonly<{
  query(
    config: Readonly<{ text: string; values: readonly unknown[] }>
  ): Promise<Readonly<{ rows: readonly unknown[] }>>;
  release(error?: Error | boolean): void;
}>;

export type VerifierPool = Readonly<{
  connect(): Promise<VerifierPoolClient>;
  end(): Promise<void>;
}>;

export type PostgresVerifierExecutor = Readonly<{
  close(): Promise<void>;
  executor: VerifierDatabaseQueryExecutor;
}>;

interface VerificationSession {
  client?: VerifierPoolClient;
  connectionAttempts: number;
}

function assertAllowedSql(text: string): void {
  if (text === IDENTITY_SQL) return;
  const name = RPC_NAME_PATTERN.exec(text)?.[1];
  if (name === undefined || !(VERIFIER_RPC_NAMES as readonly string[]).includes(name)) {
    throw new VerifierDatabaseContractError("contract_violation");
  }
}

export function verifyVerifierSessionRows(rows: readonly unknown[]): void {
  if (rows.length !== 1) throw new VerifierDatabaseContractError("identity_denied");
  const row = rows[0];
  if (
    row === null ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    Object.keys(row).sort().join(",") !== "currentUser,sessionUser" ||
    (row as Record<string, unknown>).sessionUser !== EXPECTED_ROLE ||
    (row as Record<string, unknown>).currentUser !== EXPECTED_ROLE
  ) {
    throw new VerifierDatabaseContractError("identity_denied");
  }
}

async function queryWithAbort(
  client: VerifierPoolClient,
  query: VerifierDatabaseQuery,
  discard: (client: VerifierPoolClient, error: Error | boolean) => void
): Promise<VerifierDatabaseQueryResult> {
  if (query.signal.aborted) {
    discard(client, new Error("Verifier database operation aborted."));
    throw new DOMException("The operation was aborted", "AbortError");
  }
  let rejectAbort: ((reason: DOMException) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    discard(client, new Error("Verifier database operation aborted."));
    rejectAbort?.(new DOMException("The operation was aborted", "AbortError"));
  };
  query.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await Promise.race([
      client.query({ text: query.text, values: query.values }),
      aborted
    ]);
    return Object.freeze({ rows: Object.freeze([...result.rows]) });
  } catch (error: unknown) {
    discard(client, error instanceof Error ? error : true);
    throw error;
  } finally {
    query.signal.removeEventListener("abort", onAbort);
  }
}

export function createVerifierDatabaseQueryExecutor(pool: VerifierPool): PostgresVerifierExecutor {
  const sessions = new Map<AbortSignal, VerificationSession>();

  function releaseSession(signal: AbortSignal): void {
    const session = sessions.get(signal);
    if (session === undefined) return;
    sessions.delete(signal);
    session.client?.release();
    delete session.client;
  }

  function discardClient(
    signal: AbortSignal,
    client: VerifierPoolClient,
    error: Error | boolean
  ): void {
    const session = sessions.get(signal);
    if (session?.client !== client) return;
    delete session.client;
    client.release(error);
  }

  async function clientFor(signal: AbortSignal): Promise<VerifierPoolClient> {
    if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
    let session = sessions.get(signal);
    if (session === undefined) {
      session = { connectionAttempts: 0 };
      sessions.set(signal, session);
    }
    if (session.client !== undefined) return session.client;
    if (session.connectionAttempts >= RAG_VERIFICATION_DATABASE_CONNECTION_ATTEMPTS) {
      throw new VerifierDatabaseContractError("contract_violation");
    }
    session.connectionAttempts += 1;
    const client = await pool.connect();
    try {
      signal.throwIfAborted();
    } catch {
      client.release(new Error("Verifier database operation aborted."));
      throw new DOMException("The operation was aborted", "AbortError");
    }
    session.client = client;
    return client;
  }

  const executor: VerifierDatabaseQueryExecutor = Object.freeze({
    async query(query: VerifierDatabaseQuery): Promise<VerifierDatabaseQueryResult> {
      assertAllowedSql(query.text);
      if (!Array.isArray(query.values)) {
        throw new VerifierDatabaseContractError("contract_violation");
      }
      const client = await clientFor(query.signal);
      return queryWithAbort(client, query, (discarded, error) =>
        discardClient(query.signal, discarded, error)
      );
    },
    releaseSession
  });

  return Object.freeze({
    async close(): Promise<void> {
      for (const signal of [...sessions.keys()]) releaseSession(signal);
      return pool.end();
    },
    executor
  });
}

export function createPostgresVerifierExecutor(
  config: VerifierDatabaseConfig
): PostgresVerifierExecutor {
  const connection = parseVerifierDatabaseUrl(config);
  const poolConfig: PoolConfig = {
    allowExitOnIdle: true,
    application_name: "unfiled-rag-verifier",
    connectionTimeoutMillis: config.connectTimeoutMs,
    database: connection.database,
    enableChannelBinding: true,
    host: connection.host,
    idleTimeoutMillis: 10_000,
    keepAlive: true,
    max: 1,
    maxLifetimeSeconds: 300,
    maxUses: 500,
    password: connection.password,
    port: connection.port,
    query_timeout: config.statementTimeoutMs + verifierDatabaseQueryCancelGraceMs,
    ssl: {
      ca: config.caPem,
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
      servername: connection.host
    },
    statement_timeout: config.statementTimeoutMs,
    user: connection.user,
    verify(client: PoolClient, done: (error?: Error) => void): void {
      client
        .query({ text: IDENTITY_SQL, values: [] })
        .then((result: QueryResult) => {
          try {
            verifyVerifierSessionRows(result.rows);
            done();
          } catch {
            done(new VerifierDatabaseContractError("identity_denied"));
          }
        })
        .catch(() => done(new VerifierDatabaseContractError("identity_denied")));
    }
  };
  return createVerifierDatabaseQueryExecutor(new Pool(poolConfig));
}
