import { AuthSessionSchema, AuthUserSchema } from "@unfiled/contracts";
import * as SecureStore from "expo-secure-store";
import * as SQLite from "expo-sqlite";
import { ulid } from "ulid";

import type { AuthSession, AuthSessionStore, PersistedAuthState } from "./session";

const DATABASE_NAME = "unfiled-identity.db";
const SECURE_SESSION_KEY = "unfiled.auth.session.v1";
const SECURE_SESSION_VERSION = 1;
const LEGACY_SESSION_COLUMNS = [
  "profile_id",
  "email",
  "access_token",
  "refresh_token",
  "expires_at"
] as const;

type SqlValue = string | number | null;

export interface AuthIdentityDatabase {
  execAsync(source: string): Promise<void>;
  getAllAsync<T>(source: string): Promise<T[]>;
  getFirstAsync<T>(source: string): Promise<T | null>;
  runAsync(source: string, ...params: SqlValue[]): Promise<unknown>;
}

export interface SecureSessionStorage {
  deleteItemAsync(key: string, options?: SecureStore.SecureStoreOptions): Promise<void>;
  getItemAsync(key: string, options?: SecureStore.SecureStoreOptions): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: SecureStore.SecureStoreOptions): Promise<void>;
}

interface AuthSessionStoreDependencies {
  createInstallationId?: () => string;
  openDatabase: () => Promise<AuthIdentityDatabase>;
  secureStore: SecureSessionStorage;
  secureStoreOptions?: SecureStore.SecureStoreOptions;
}

interface DatabaseState {
  columns: Set<string>;
  database: AuthIdentityDatabase;
  installationId: string;
}

type IdentityRow = Record<string, unknown>;

interface ProfileHint {
  email: string | null;
  id: string | null;
}

interface ParsedSecureSession {
  malformed: boolean;
  session: AuthSession | null;
}

function hasLegacySessionColumns(columns: Set<string>): boolean {
  return LEGACY_SESSION_COLUMNS.some((column) => columns.has(column));
}

function serializeSession(session: AuthSession, installationId: string): string {
  return JSON.stringify({ installationId, session, version: SECURE_SESSION_VERSION });
}

function parseSecureSession(value: string | null, installationId: string): ParsedSecureSession {
  if (value === null) return { malformed: false, session: null };
  try {
    const envelope = JSON.parse(value) as unknown;
    if (typeof envelope !== "object" || envelope === null) {
      return { malformed: true, session: null };
    }
    const record = envelope as Record<string, unknown>;
    if (record.version !== SECURE_SESSION_VERSION || record.installationId !== installationId) {
      return { malformed: true, session: null };
    }
    const parsed = AuthSessionSchema.safeParse(record.session);
    return parsed.success
      ? { malformed: false, session: parsed.data }
      : { malformed: true, session: null };
  } catch {
    return { malformed: true, session: null };
  }
}

function parseLegacySession(row: IdentityRow | null): AuthSession | null {
  if (row === null) return null;
  const parsed = AuthSessionSchema.safeParse({
    accessToken: row.access_token,
    expiresAt: row.expires_at,
    refreshToken: row.refresh_token,
    user: { email: row.email, id: row.profile_id }
  });
  return parsed.success ? parsed.data : null;
}

function parseProfileHint(id: unknown, email: unknown): ProfileHint | null {
  const parsed = AuthUserSchema.safeParse({ email, id });
  return parsed.success ? parsed.data : null;
}

function profileHintFromRow(row: IdentityRow | null): ProfileHint {
  if (row === null) return { email: null, id: null };
  return (
    parseProfileHint(row.last_profile_id, row.last_profile_email) ??
    parseProfileHint(row.profile_id, row.email) ?? { email: null, id: null }
  );
}

async function initializeDatabase(
  openDatabase: () => Promise<AuthIdentityDatabase>,
  createInstallationId: () => string
): Promise<DatabaseState> {
  const database = await openDatabase();
  await database.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS identity_state (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
      installation_id TEXT,
      last_profile_id TEXT,
      last_profile_email TEXT
    );
  `);
  const columnRows = await database.getAllAsync<{ name: string }>(
    "PRAGMA table_info(identity_state)"
  );
  const columns = new Set(columnRows.map((column) => column.name));
  if (!columns.has("installation_id")) {
    await database.execAsync("ALTER TABLE identity_state ADD COLUMN installation_id TEXT;");
    columns.add("installation_id");
  }
  if (!columns.has("last_profile_id")) {
    await database.execAsync("ALTER TABLE identity_state ADD COLUMN last_profile_id TEXT;");
    columns.add("last_profile_id");
  }
  if (!columns.has("last_profile_email")) {
    await database.execAsync("ALTER TABLE identity_state ADD COLUMN last_profile_email TEXT;");
    columns.add("last_profile_email");
  }
  const row = await database.getFirstAsync<IdentityRow>(
    "SELECT * FROM identity_state WHERE singleton = 1"
  );
  const persistedInstallationId = row?.installation_id;
  const installationId =
    typeof persistedInstallationId === "string" && persistedInstallationId.length > 0
      ? persistedInstallationId
      : createInstallationId();
  if (installationId !== persistedInstallationId) {
    await database.runAsync(
      `INSERT INTO identity_state (singleton, installation_id) VALUES (1, ?)
       ON CONFLICT(singleton) DO UPDATE SET installation_id = excluded.installation_id`,
      installationId
    );
  }
  return { columns, database, installationId };
}

async function readIdentityRow(state: DatabaseState): Promise<IdentityRow | null> {
  return state.database.getFirstAsync<IdentityRow>(
    "SELECT * FROM identity_state WHERE singleton = 1"
  );
}

async function saveProfileHint(state: DatabaseState, profile: ProfileHint): Promise<void> {
  await state.database.runAsync(
    `INSERT INTO identity_state (
       singleton, installation_id, last_profile_id, last_profile_email
     ) VALUES (1, ?, ?, ?)
     ON CONFLICT(singleton) DO UPDATE SET
       last_profile_id = excluded.last_profile_id,
       last_profile_email = excluded.last_profile_email`,
    state.installationId,
    profile.id,
    profile.email
  );
}

async function scrubLegacySessionSchema(
  state: DatabaseState,
  preservedProfile: ProfileHint
): Promise<void> {
  if (!hasLegacySessionColumns(state.columns)) {
    await saveProfileHint(state, preservedProfile);
    return;
  }

  await saveProfileHint(state, preservedProfile);
  const obsoleteColumns = LEGACY_SESSION_COLUMNS.filter((column) => state.columns.has(column));
  if (obsoleteColumns.length > 0) {
    await state.database.runAsync(
      `UPDATE identity_state SET ${obsoleteColumns
        .map((column) => `${column} = NULL`)
        .join(", ")} WHERE singleton = 1`
    );
  }
  try {
    await state.database.execAsync(`
      BEGIN IMMEDIATE;
      DROP TABLE IF EXISTS identity_state_secure;
      CREATE TABLE identity_state_secure (
        singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
        installation_id TEXT NOT NULL,
        last_profile_id TEXT,
        last_profile_email TEXT
      );
      INSERT INTO identity_state_secure (
        singleton, installation_id, last_profile_id, last_profile_email
      ) SELECT singleton, installation_id, last_profile_id, last_profile_email
        FROM identity_state;
      DROP TABLE identity_state;
      ALTER TABLE identity_state_secure RENAME TO identity_state;
      COMMIT;
    `);
  } catch (cause) {
    try {
      await state.database.execAsync("ROLLBACK;");
    } catch {
      // Preserve the original migration error; a later app start will retry initialization.
    }
    throw cause;
  }
  state.columns = new Set([
    "singleton",
    "installation_id",
    "last_profile_id",
    "last_profile_email"
  ]);
  await state.database.execAsync("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
}

async function storeAndVerifySecureSession(
  secureStore: SecureSessionStorage,
  options: SecureStore.SecureStoreOptions,
  session: AuthSession,
  installationId: string
): Promise<void> {
  const serialized = serializeSession(session, installationId);
  await secureStore.setItemAsync(SECURE_SESSION_KEY, serialized, options);
  const verification = await secureStore.getItemAsync(SECURE_SESSION_KEY, options);
  if (verification !== serialized) {
    await secureStore.deleteItemAsync(SECURE_SESSION_KEY, options);
    throw new Error("Secure session storage verification failed");
  }
}

export function createSecureAuthSessionStore({
  createInstallationId = ulid,
  openDatabase,
  secureStore,
  secureStoreOptions = {}
}: AuthSessionStoreDependencies): AuthSessionStore {
  let databasePromise: Promise<DatabaseState> | undefined;
  let operationTail: Promise<void> = Promise.resolve();
  const database = (): Promise<DatabaseState> => {
    databasePromise ??= initializeDatabase(openDatabase, createInstallationId);
    return databasePromise;
  };
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  return {
    clearSession: () =>
      serialize(async (): Promise<void> => {
        await secureStore.deleteItemAsync(SECURE_SESSION_KEY, secureStoreOptions);
        const state = await database();
        const profile = profileHintFromRow(await readIdentityRow(state));
        await scrubLegacySessionSchema(state, profile);
      }),

    load: () =>
      serialize(async (): Promise<PersistedAuthState> => {
        const state = await database();
        const row = await readIdentityRow(state);
        const storedValue = await secureStore.getItemAsync(SECURE_SESSION_KEY, secureStoreOptions);
        const secure = parseSecureSession(storedValue, state.installationId);
        if (secure.malformed) {
          await secureStore.deleteItemAsync(SECURE_SESSION_KEY, secureStoreOptions);
        }

        const legacySession = parseLegacySession(row);
        const session = secure.session ?? legacySession;
        if (secure.session === null && legacySession !== null) {
          await storeAndVerifySecureSession(
            secureStore,
            secureStoreOptions,
            legacySession,
            state.installationId
          );
        }

        const rowProfile = profileHintFromRow(row);
        const profile =
          session === null ? rowProfile : { email: session.user.email, id: session.user.id };
        await scrubLegacySessionSchema(state, profile);
        return {
          lastProfileEmail: profile.email,
          lastProfileId: profile.id,
          session
        };
      }),

    saveSession: (candidate) =>
      serialize(async (): Promise<void> => {
        const session = AuthSessionSchema.parse(candidate);
        const state = await database();
        await storeAndVerifySecureSession(
          secureStore,
          secureStoreOptions,
          session,
          state.installationId
        );
        await scrubLegacySessionSchema(state, {
          email: session.user.email,
          id: session.user.id
        });
      })
  };
}

async function openIdentityDatabase(): Promise<AuthIdentityDatabase> {
  const database = await SQLite.openDatabaseAsync(DATABASE_NAME);
  return {
    execAsync: (source) => database.execAsync(source),
    getAllAsync: <T>(source: string) => database.getAllAsync<T>(source),
    getFirstAsync: <T>(source: string) => database.getFirstAsync<T>(source),
    runAsync: (source, ...params) => database.runAsync(source, ...params)
  };
}

export const secureAuthSessionStore = createSecureAuthSessionStore({
  openDatabase: openIdentityDatabase,
  secureStore: SecureStore,
  secureStoreOptions: {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    keychainService: SECURE_SESSION_KEY,
    requireAuthentication: false
  }
});
