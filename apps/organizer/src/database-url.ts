import { isIP } from "node:net";

import { OrganizerConfigurationError } from "./errors.js";

const ROLE = "unfiled_organizer_worker";
const PORTS = new Set([5_432, 6_543]);
const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/u;
const SHARED_POOLER = /^[a-z0-9-]+\.pooler\.supabase\.com$/u;

export type OrganizerDatabaseConnection = Readonly<{
  database: "postgres";
  host: string;
  password: string;
  port: 5_432 | 6_543;
  user: string;
}>;

function fail(names: readonly string[] = ["UNFILED_ORGANIZER_DATABASE_URL"]): never {
  throw new OrganizerConfigurationError(names);
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return fail();
  }
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

export function parseOrganizerDatabaseUrl(
  input: Readonly<{
    expectedHost: string;
    projectRef: string;
    url: string;
  }>
): OrganizerDatabaseConnection {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return fail();
  }
  const shared = SHARED_POOLER.test(url.hostname);
  const direct = url.hostname === `db.${input.projectRef}.supabase.co`;
  const expectedUser = shared ? `${ROLE}.${input.projectRef}` : ROLE;
  const username = decode(url.username);
  const password = decode(url.password);
  const port = Number(url.port);
  const parameters = [...url.searchParams.entries()];
  const parameter = parameters.at(0);
  if (
    url.protocol !== "postgresql:" ||
    !PROJECT_REF_PATTERN.test(input.projectRef) ||
    (!shared && !direct) ||
    url.hostname !== input.expectedHost ||
    isIP(url.hostname) !== 0 ||
    username !== expectedUser ||
    password.length < 20 ||
    password.length > 512 ||
    containsControlCharacter(password) ||
    !PORTS.has(port) ||
    url.pathname !== "/postgres" ||
    parameters.length !== 1 ||
    parameter?.[0] !== "sslmode" ||
    parameter[1] !== "verify-full" ||
    url.hash.length !== 0
  )
    fail();
  return Object.freeze({
    database: "postgres",
    host: url.hostname,
    password,
    port: port as 5_432 | 6_543,
    user: expectedUser
  });
}
