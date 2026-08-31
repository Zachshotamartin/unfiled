import type { ApiErrorCodeValue, CaptureSource, PrivacyMode } from "@unfiled/contracts";
import * as SQLite from "expo-sqlite";

import { getCaptureDatabaseKey } from "./captureDatabaseKey";
import type { CaptureOutboxState } from "./captureOutboxTypes";
import type { NativeCaptureSource } from "./captureSource";

const DATABASE_NAME = "unfiled-captures-encrypted-v1.db";
const LEGACY_DATABASE_NAME = "unfiled-captures.db";
const LEGACY_MIGRATION_KEY = "legacy_plaintext_migrated";

const CREATE_ACTION_INTENTS_SQL = `
  CREATE TABLE IF NOT EXISTS capture_action_intents (
    profile_id TEXT NOT NULL,
    action_signature TEXT NOT NULL,
    action_type TEXT NOT NULL CHECK (action_type IN ('retry', 'delete', 'undo')),
    target_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_json TEXT NOT NULL,
    action_state TEXT NOT NULL DEFAULT 'pending' CHECK (action_state IN ('pending', 'succeeded')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (profile_id, action_signature),
    UNIQUE (profile_id, idempotency_key)
  );
`;

const CREATE_OUTBOX_SQL = `
  CREATE TABLE capture_outbox (
    client_capture_id TEXT PRIMARY KEY NOT NULL,
    profile_id TEXT NOT NULL,
    raw_content TEXT NOT NULL,
    source TEXT NOT NULL,
    device_id TEXT,
    client_created_at TEXT NOT NULL,
    client_timezone TEXT NOT NULL,
    privacy TEXT NOT NULL CHECK (privacy IN ('ai_assisted', 'private_manual')),
    explicit_destination_note_id TEXT,
    expansion_disabled INTEGER NOT NULL DEFAULT 0 CHECK (expansion_disabled IN (0, 1)),
    sync_state TEXT NOT NULL DEFAULT 'queued' CHECK (
      sync_state IN (
        'queued',
        'syncing',
        'waiting_for_sign_in',
        'retry_wait',
        'synced',
        'permanent_failure'
      )
    ),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error_code TEXT,
    server_capture_id TEXT,
    server_job_id TEXT,
    server_acknowledged_at TEXT,
    local_delete_pending INTEGER NOT NULL DEFAULT 0 CHECK (local_delete_pending IN (0, 1))
  );
`;

let databasePromise: Promise<SQLite.SQLiteDatabase> | undefined;

export interface LegacyDraftMigrationSource {
  body: string;
  expansion_disabled?: number;
  explicit_destination_note_id?: `note_${string}` | null;
  privacy?: PrivacyMode;
  profile_id: string;
  source: NativeCaptureSource;
  updated_at: string;
}

export interface LegacyOutboxMigrationSource {
  attempt_count: number;
  client_capture_id: `cap_${string}`;
  client_created_at: string;
  client_timezone?: string;
  device_id?: string | null;
  expansion_disabled?: number;
  explicit_destination_note_id?: `note_${string}` | null;
  last_error_code: ApiErrorCodeValue | null;
  next_attempt_at?: string | null;
  privacy?: PrivacyMode;
  profile_id: string;
  raw_content: string;
  server_acknowledged_at?: string | null;
  server_capture_id?: `cap_${string}` | null;
  server_job_id?: `job_${string}` | null;
  source: CaptureSource;
  sync_state: CaptureOutboxState | "failed";
}

export interface LegacyDraftMigrationTarget {
  body: string;
  expansion_disabled: number;
  explicit_destination_note_id: `note_${string}` | null;
  privacy: PrivacyMode;
  profile_id: string;
  source: NativeCaptureSource;
  updated_at: string;
}

export interface LegacyOutboxMigrationTarget {
  attempt_count: number;
  client_capture_id: `cap_${string}`;
  client_created_at: string;
  client_timezone: string;
  device_id: string | null;
  expansion_disabled: number;
  explicit_destination_note_id: `note_${string}` | null;
  last_error_code: ApiErrorCodeValue | null;
  local_delete_pending: number;
  next_attempt_at: string | null;
  privacy: PrivacyMode;
  profile_id: string;
  raw_content: string;
  server_acknowledged_at: string | null;
  server_capture_id: `cap_${string}` | null;
  server_job_id: `job_${string}` | null;
  source: CaptureSource;
  sync_state: CaptureOutboxState;
}

async function tableExists(database: SQLite.SQLiteDatabase, tableName: string): Promise<boolean> {
  const row = await database.getFirstAsync<{ present: number }>(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    tableName
  );
  return row?.present === 1;
}

function migratedState(state: LegacyOutboxMigrationSource["sync_state"]): CaptureOutboxState {
  return state === "failed" ? "permanent_failure" : state;
}

export function assertLegacyDraftMigration(
  source: LegacyDraftMigrationSource,
  target: LegacyDraftMigrationTarget | null
): void {
  if (target === null) throw new Error("Encrypted draft migration verification failed");
  if (
    target.profile_id !== source.profile_id ||
    target.source !== source.source ||
    target.body !== source.body ||
    target.updated_at !== source.updated_at ||
    target.privacy !== (source.privacy ?? "ai_assisted") ||
    target.explicit_destination_note_id !== (source.explicit_destination_note_id ?? null) ||
    target.expansion_disabled !== (source.expansion_disabled === 1 ? 1 : 0)
  ) {
    throw new Error("Encrypted draft migration verification failed");
  }
}

export function assertLegacyOutboxMigration(
  source: LegacyOutboxMigrationSource,
  target: LegacyOutboxMigrationTarget | null
): void {
  if (target === null) throw new Error("Encrypted outbox migration verification failed");
  if (
    target.client_capture_id !== source.client_capture_id ||
    target.profile_id !== source.profile_id ||
    target.raw_content !== source.raw_content ||
    target.source !== source.source ||
    target.device_id !== (source.device_id ?? null) ||
    target.client_created_at !== source.client_created_at ||
    target.client_timezone !== (source.client_timezone ?? "UTC") ||
    target.privacy !== (source.privacy ?? "ai_assisted") ||
    target.explicit_destination_note_id !== (source.explicit_destination_note_id ?? null) ||
    target.expansion_disabled !== (source.expansion_disabled === 1 ? 1 : 0) ||
    target.sync_state !== migratedState(source.sync_state) ||
    target.attempt_count !== source.attempt_count ||
    target.next_attempt_at !== (source.next_attempt_at ?? null) ||
    target.last_error_code !== source.last_error_code ||
    target.server_capture_id !== (source.server_capture_id ?? null) ||
    target.server_job_id !== (source.server_job_id ?? null) ||
    target.server_acknowledged_at !== (source.server_acknowledged_at ?? null) ||
    target.local_delete_pending !== 0
  ) {
    throw new Error("Encrypted outbox migration verification failed");
  }
}

async function migrateLegacyPlaintextDatabase(
  encryptedDatabase: SQLite.SQLiteDatabase
): Promise<void> {
  const migrated = await encryptedDatabase.getFirstAsync<{ value: string }>(
    "SELECT value FROM capture_security_state WHERE key = ?",
    LEGACY_MIGRATION_KEY
  );
  if (migrated?.value === "complete") return;

  const legacy = await SQLite.openDatabaseAsync(LEGACY_DATABASE_NAME, { useNewConnection: true });
  try {
    const drafts = (await tableExists(legacy, "capture_drafts"))
      ? await legacy.getAllAsync<LegacyDraftMigrationSource>("SELECT * FROM capture_drafts")
      : [];
    const outbox = (await tableExists(legacy, "capture_outbox"))
      ? await legacy.getAllAsync<LegacyOutboxMigrationSource>("SELECT * FROM capture_outbox")
      : [];

    await encryptedDatabase.withExclusiveTransactionAsync(async (transaction) => {
      for (const draft of drafts) {
        await transaction.runAsync(
          `INSERT OR IGNORE INTO capture_drafts (
             profile_id, source, body, updated_at, privacy,
             explicit_destination_note_id, expansion_disabled
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          draft.profile_id,
          draft.source,
          draft.body,
          draft.updated_at,
          draft.privacy ?? "ai_assisted",
          draft.explicit_destination_note_id ?? null,
          draft.expansion_disabled === 1 ? 1 : 0
        );
      }
      for (const entry of outbox) {
        await transaction.runAsync(
          `INSERT OR IGNORE INTO capture_outbox (
             client_capture_id, profile_id, raw_content, source, device_id,
             client_created_at, client_timezone, privacy,
             explicit_destination_note_id, expansion_disabled, sync_state,
             attempt_count, next_attempt_at, last_error_code, server_capture_id,
             server_job_id, server_acknowledged_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          entry.client_capture_id,
          entry.profile_id,
          entry.raw_content,
          entry.source,
          entry.device_id ?? null,
          entry.client_created_at,
          entry.client_timezone ?? "UTC",
          entry.privacy ?? "ai_assisted",
          entry.explicit_destination_note_id ?? null,
          entry.expansion_disabled === 1 ? 1 : 0,
          migratedState(entry.sync_state),
          entry.attempt_count,
          entry.next_attempt_at ?? null,
          entry.last_error_code,
          entry.server_capture_id ?? null,
          entry.server_job_id ?? null,
          entry.server_acknowledged_at ?? null
        );
      }
    });

    for (const draft of drafts) {
      const copied = await encryptedDatabase.getFirstAsync<LegacyDraftMigrationTarget>(
        `SELECT profile_id, source, body, updated_at, privacy,
                explicit_destination_note_id, expansion_disabled
           FROM capture_drafts
          WHERE profile_id = ? AND source = ?`,
        draft.profile_id,
        draft.source
      );
      assertLegacyDraftMigration(draft, copied);
    }
    for (const entry of outbox) {
      const copied = await encryptedDatabase.getFirstAsync<LegacyOutboxMigrationTarget>(
        `SELECT client_capture_id, profile_id, raw_content, source, device_id,
                client_created_at, client_timezone, privacy,
                explicit_destination_note_id, expansion_disabled, sync_state,
                attempt_count, next_attempt_at, last_error_code, server_capture_id,
                server_job_id, server_acknowledged_at, local_delete_pending
           FROM capture_outbox
          WHERE client_capture_id = ?`,
        entry.client_capture_id
      );
      assertLegacyOutboxMigration(entry, copied);
    }

    if (await tableExists(legacy, "capture_drafts")) {
      await legacy.execAsync("PRAGMA secure_delete = ON; DELETE FROM capture_drafts;");
    }
    if (await tableExists(legacy, "capture_outbox")) {
      await legacy.execAsync("PRAGMA secure_delete = ON; DELETE FROM capture_outbox;");
    }
    await legacy.execAsync("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
  } finally {
    await legacy.closeAsync();
  }
  await SQLite.deleteDatabaseAsync(LEGACY_DATABASE_NAME);
  await encryptedDatabase.runAsync(
    `INSERT INTO capture_security_state (key, value) VALUES (?, 'complete')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    LEGACY_MIGRATION_KEY
  );
}

async function ensureDraftColumns(database: SQLite.SQLiteDatabase): Promise<void> {
  const rows = await database.getAllAsync<{ name: string }>("PRAGMA table_info(capture_drafts)");
  const columns = new Set(rows.map(({ name }) => name));
  if (!columns.has("privacy")) {
    await database.execAsync(
      "ALTER TABLE capture_drafts ADD COLUMN privacy TEXT NOT NULL DEFAULT 'ai_assisted';"
    );
  }
  if (!columns.has("explicit_destination_note_id")) {
    await database.execAsync(
      "ALTER TABLE capture_drafts ADD COLUMN explicit_destination_note_id TEXT;"
    );
  }
  if (!columns.has("expansion_disabled")) {
    await database.execAsync(
      "ALTER TABLE capture_drafts ADD COLUMN expansion_disabled INTEGER NOT NULL DEFAULT 0;"
    );
  }
}

async function ensureOutboxSchema(database: SQLite.SQLiteDatabase): Promise<void> {
  const existing = await database.getFirstAsync<{ sql: string | null }>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'capture_outbox'"
  );
  if (existing === null) {
    await database.execAsync(CREATE_OUTBOX_SQL);
  } else if (
    existing.sql === null ||
    !existing.sql.includes("retry_wait") ||
    !existing.sql.includes("server_acknowledged_at")
  ) {
    await database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.execAsync("DROP INDEX IF EXISTS capture_outbox_profile_state_idx;");
      await transaction.execAsync("ALTER TABLE capture_outbox RENAME TO capture_outbox_legacy;");
      await transaction.execAsync(CREATE_OUTBOX_SQL);
      await transaction.execAsync(`
        INSERT INTO capture_outbox (
          client_capture_id,
          profile_id,
          raw_content,
          source,
          client_created_at,
          client_timezone,
          privacy,
          expansion_disabled,
          sync_state,
          attempt_count,
          last_error_code
        )
        SELECT
          client_capture_id,
          profile_id,
          raw_content,
          source,
          client_created_at,
          'UTC',
          'ai_assisted',
          0,
          CASE sync_state
            WHEN 'failed' THEN 'permanent_failure'
            ELSE sync_state
          END,
          attempt_count,
          last_error_code
        FROM capture_outbox_legacy;
        DROP TABLE capture_outbox_legacy;
      `);
    });
  }
  await database.execAsync(`
    CREATE INDEX IF NOT EXISTS capture_outbox_profile_state_idx
      ON capture_outbox (profile_id, sync_state, next_attempt_at, client_created_at);
  `);
}

async function ensureOutboxColumns(database: SQLite.SQLiteDatabase): Promise<void> {
  const rows = await database.getAllAsync<{ name: string }>("PRAGMA table_info(capture_outbox)");
  const columns = new Set(rows.map(({ name }) => name));
  if (!columns.has("local_delete_pending")) {
    await database.execAsync(
      "ALTER TABLE capture_outbox ADD COLUMN local_delete_pending INTEGER NOT NULL DEFAULT 0 CHECK (local_delete_pending IN (0, 1));"
    );
  }
}

export interface CaptureDatabaseInitializationRuntime<Database> {
  configure(database: Database): Promise<void>;
  loadKey(): Promise<string>;
  open(): Promise<Database>;
  readCipherVersion(database: Database): Promise<string | null>;
  setKey(database: Database, key: string): Promise<void>;
}

type ClosableDatabase = Readonly<{ closeAsync(): Promise<void> }>;

export async function initializeCaptureDatabase<Database extends ClosableDatabase>(
  runtime: CaptureDatabaseInitializationRuntime<Database>
): Promise<Database> {
  const key = await runtime.loadKey();
  const database = await runtime.open();
  try {
    await runtime.setKey(database, key);
    const cipherVersion = await runtime.readCipherVersion(database);
    if (cipherVersion === null || cipherVersion.length === 0) {
      throw new Error("Encrypted capture storage is unavailable in this build");
    }
    await runtime.configure(database);
    return database;
  } catch (error) {
    await database.closeAsync().catch(() => undefined);
    throw error;
  }
}

async function configureDatabase(database: SQLite.SQLiteDatabase): Promise<void> {
  await database.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA secure_delete = ON;
    PRAGMA cipher_memory_security = ON;
    CREATE TABLE IF NOT EXISTS capture_security_state (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS capture_drafts (
      profile_id TEXT NOT NULL,
      source TEXT NOT NULL,
      body TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      privacy TEXT NOT NULL DEFAULT 'ai_assisted',
      explicit_destination_note_id TEXT,
      expansion_disabled INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (profile_id, source)
    );
    ${CREATE_ACTION_INTENTS_SQL}
  `);
  await ensureDraftColumns(database);
  await ensureOutboxSchema(database);
  await ensureOutboxColumns(database);
  await migrateLegacyPlaintextDatabase(database);
}

async function openDatabase(): Promise<SQLite.SQLiteDatabase> {
  return initializeCaptureDatabase({
    configure: configureDatabase,
    loadKey: getCaptureDatabaseKey,
    open: () => SQLite.openDatabaseAsync(DATABASE_NAME),
    readCipherVersion: async (database) =>
      (await database.getFirstAsync<{ cipher_version: string }>("PRAGMA cipher_version"))
        ?.cipher_version ?? null,
    setKey: (database, key) => database.execAsync(`PRAGMA key = '${key}';`)
  });
}

export function captureDatabase(): Promise<SQLite.SQLiteDatabase> {
  databasePromise ??= openDatabase();
  return databasePromise;
}
