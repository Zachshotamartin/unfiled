import type { CaptureSource } from "@unfiled/contracts";
import * as SQLite from "expo-sqlite";
import { ulid } from "ulid";

import type { NativeCaptureSource } from "./captureSource";

const DATABASE_NAME = "unfiled-captures.db";
const DRAFT_RESTORE_WINDOW_MS = 30 * 60 * 1000;

export interface CaptureDraft {
  body: string;
  source: NativeCaptureSource;
  updatedAt: string;
}

export interface LocalCapture {
  clientCaptureId: `cap_${string}`;
  clientCreatedAt: string;
  rawContent: string;
  source: CaptureSource;
}

let databasePromise: Promise<SQLite.SQLiteDatabase> | undefined;

async function openDatabase(): Promise<SQLite.SQLiteDatabase> {
  const database = await SQLite.openDatabaseAsync(DATABASE_NAME);
  await database.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS capture_drafts (
      profile_id TEXT NOT NULL,
      source TEXT NOT NULL,
      body TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, source)
    );
    CREATE TABLE IF NOT EXISTS capture_outbox (
      client_capture_id TEXT PRIMARY KEY NOT NULL,
      profile_id TEXT NOT NULL,
      raw_content TEXT NOT NULL,
      source TEXT NOT NULL,
      client_created_at TEXT NOT NULL,
      sync_state TEXT NOT NULL DEFAULT 'queued' CHECK (sync_state IN ('queued', 'syncing', 'waiting_for_sign_in', 'failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT
    );
    CREATE INDEX IF NOT EXISTS capture_outbox_profile_state_idx
      ON capture_outbox (profile_id, sync_state, client_created_at);
  `);
  return database;
}

function database(): Promise<SQLite.SQLiteDatabase> {
  databasePromise ??= openDatabase();
  return databasePromise;
}

export async function loadCaptureDraft(
  profileId: string,
  source: NativeCaptureSource,
  now = Date.now()
): Promise<CaptureDraft | null> {
  const db = await database();
  const row = await db.getFirstAsync<{ body: string; updated_at: string }>(
    "SELECT body, updated_at FROM capture_drafts WHERE profile_id = ? AND source = ?",
    profileId,
    source
  );
  if (row === null) return null;

  const age = now - Date.parse(row.updated_at);
  if (source === "ios_lock_screen_widget" && age > DRAFT_RESTORE_WINDOW_MS) return null;
  return { body: row.body, source, updatedAt: row.updated_at };
}

export async function saveCaptureDraft(
  profileId: string,
  source: NativeCaptureSource,
  body: string
): Promise<void> {
  const db = await database();
  await db.runAsync(
    `INSERT INTO capture_drafts (profile_id, source, body, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(profile_id, source) DO UPDATE SET
       body = excluded.body,
       updated_at = excluded.updated_at`,
    profileId,
    source,
    body,
    new Date().toISOString()
  );
}

export async function discardCaptureDraft(
  profileId: string,
  source: NativeCaptureSource
): Promise<void> {
  const db = await database();
  await db.runAsync(
    "DELETE FROM capture_drafts WHERE profile_id = ? AND source = ?",
    profileId,
    source
  );
}

export async function commitCaptureToOutbox(
  profileId: string,
  source: NativeCaptureSource,
  rawContent: string,
  sessionAvailable: boolean
): Promise<LocalCapture> {
  if (rawContent.trim().length === 0) throw new TypeError("Capture cannot contain only whitespace");

  const db = await database();
  const capture: LocalCapture = {
    clientCaptureId: `cap_${ulid()}`,
    clientCreatedAt: new Date().toISOString(),
    rawContent,
    source
  };

  await db.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(
      `INSERT INTO capture_outbox (
        client_capture_id, profile_id, raw_content, source, client_created_at, sync_state
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      capture.clientCaptureId,
      profileId,
      capture.rawContent,
      capture.source,
      capture.clientCreatedAt,
      sessionAvailable ? "queued" : "waiting_for_sign_in"
    );
    await transaction.runAsync(
      "DELETE FROM capture_drafts WHERE profile_id = ? AND source = ?",
      profileId,
      source
    );
  });

  return capture;
}

export async function pendingCaptureCount(profileId: string): Promise<number> {
  const db = await database();
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM capture_outbox WHERE profile_id = ?",
    profileId
  );
  return row?.count ?? 0;
}
