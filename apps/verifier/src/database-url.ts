import { isIP } from "node:net";

import { VerifierConfigurationError } from "./errors.js";

const DATABASE_VARIABLE = "UNFILED_VERIFIER_DATABASE_URL";
const EXPECTED_HOST_VARIABLE = "UNFILED_VERIFIER_DATABASE_EXPECTED_HOST";
const PROJECT_REF_VARIABLE = "UNFILED_VERIFIER_DATABASE_PROJECT_REF";
const DATABASE_ROLE = "unfiled_rag_verifier" as const;
const ALLOWED_PORTS = new Set([5_432, 6_543]);
const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/u;
const SHARED_POOLER_HOST_PATTERN = /^[a-z0-9-]+\.pooler\.supabase\.com$/u;

export type VerifierDatabaseConnection = Readonly<{
  database: "postgres";
  host: string;
  password: string;
  port: 5_432 | 6_543;
  user: string;
}>;

function fail(names: readonly string[] = [DATABASE_VARIABLE]): never {
  throw new VerifierConfigurationError(names);
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

export function parseVerifierDatabaseUrl(
  input: Readonly<{ expectedHost: string; projectRef: string; url: string }>
): VerifierDatabaseConnection {
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
  const validProjectRef = PROJECT_REF_PATTERN.test(input.projectRef);
  const sharedPooler = SHARED_POOLER_HOST_PATTERN.test(parsed.hostname);
  const directOrDedicated =
    validProjectRef && parsed.hostname === `db.${input.projectRef}.supabase.co`;
  const expectedUser = sharedPooler ? `${DATABASE_ROLE}.${input.projectRef}` : DATABASE_ROLE;
  if (
    parsed.protocol !== "postgresql:" ||
    !validProjectRef ||
    (!sharedPooler && !directOrDedicated) ||
    username !== expectedUser ||
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
      !validProjectRef
        ? [DATABASE_VARIABLE, PROJECT_REF_VARIABLE]
        : parsed.hostname !== input.expectedHost
          ? [DATABASE_VARIABLE, EXPECTED_HOST_VARIABLE]
          : username !== expectedUser
            ? [DATABASE_VARIABLE, PROJECT_REF_VARIABLE]
            : [DATABASE_VARIABLE]
    );
  }
  return Object.freeze({
    database: "postgres",
    host: parsed.hostname,
    password,
    port: port as 5_432 | 6_543,
    user: expectedUser
  });
}
