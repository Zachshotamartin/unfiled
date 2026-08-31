import { isIP } from "node:net";

import { WorkerConfigurationError } from "./errors";

const DATABASE_VARIABLE = "UNFILED_WORKER_DATABASE_URL";
const EXPECTED_HOST_VARIABLE = "UNFILED_WORKER_DATABASE_EXPECTED_HOST";
const PROJECT_REF_VARIABLE = "UNFILED_WORKER_DATABASE_PROJECT_REF";
const DATABASE_ROLE = "unfiled_index_worker" as const;
const ALLOWED_PORTS = new Set([5_432, 6_543]);
const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/u;
const SHARED_POOLER_HOST_PATTERN = /^[a-z0-9-]+\.pooler\.supabase\.com$/u;

export type IndexWorkerDatabaseConnection = Readonly<{
  database: "postgres";
  host: string;
  password: string;
  port: 5_432 | 6_543;
  user: string;
}>;

function fail(names: readonly string[] = [DATABASE_VARIABLE]): never {
  throw new WorkerConfigurationError(names);
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    fail();
  }
}

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

export function parseIndexWorkerDatabaseUrl(
  input: Readonly<{
    expectedHost: string;
    projectRef: string;
    url: string;
  }>
): IndexWorkerDatabaseConnection {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    fail();
  }
  const username = decoded(parsed.username);
  const password = decoded(parsed.password);
  const port = Number(parsed.port);
  const parameters = [...parsed.searchParams.entries()];
  const hasValidProjectRef = PROJECT_REF_PATTERN.test(input.projectRef);
  const isSharedPooler = SHARED_POOLER_HOST_PATTERN.test(parsed.hostname);
  const isProjectDirectOrDedicatedPooler =
    hasValidProjectRef && parsed.hostname === `db.${input.projectRef}.supabase.co`;
  const expectedTransportUser = isSharedPooler
    ? `${DATABASE_ROLE}.${input.projectRef}`
    : DATABASE_ROLE;
  if (
    parsed.protocol !== "postgresql:" ||
    !hasValidProjectRef ||
    (!isSharedPooler && !isProjectDirectOrDedicatedPooler) ||
    username !== expectedTransportUser ||
    password.length < 20 ||
    password.length > 512 ||
    hasAsciiControlCharacter(password) ||
    parsed.hostname !== input.expectedHost ||
    isIP(parsed.hostname) !== 0 ||
    !ALLOWED_PORTS.has(port) ||
    parsed.pathname !== "/postgres" ||
    parameters.length !== 1 ||
    parameters[0]?.[0] !== "sslmode" ||
    parameters[0][1] !== "verify-full" ||
    parsed.hash.length !== 0
  ) {
    fail(
      !hasValidProjectRef
        ? [DATABASE_VARIABLE, PROJECT_REF_VARIABLE]
        : parsed.hostname !== input.expectedHost
          ? [DATABASE_VARIABLE, EXPECTED_HOST_VARIABLE]
          : username !== expectedTransportUser
            ? [DATABASE_VARIABLE, PROJECT_REF_VARIABLE]
            : [DATABASE_VARIABLE]
    );
  }
  return Object.freeze({
    database: "postgres",
    host: parsed.hostname,
    password,
    port: port as 5_432 | 6_543,
    user: expectedTransportUser
  });
}
