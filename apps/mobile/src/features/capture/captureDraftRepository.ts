import type { ApiErrorCodeValue, CaptureCreateResponse } from "@unfiled/contracts";
import type * as SQLite from "expo-sqlite";
import { ulid } from "ulid";

import { captureDatabase as database } from "./captureRepositoryDatabase";
import type { NativeCaptureSource } from "./captureSource";
import type {
  CaptureOutboxRecord,
  CaptureOutboxRow,
  CapturePreferences,
  LocalCapture
} from "./captureOutboxTypes";

export {
  beginCaptureDeleteIntent,
  beginCaptureDeleteIntentInDatabase,
  cancelCaptureDeletion,
  captureActionIntentSucceeded,
  captureActionIntentSucceededInDatabase,
  completeCaptureDeletion,
  completeCaptureDeletionInDatabase,
  getOrCreateCaptureActionIntentInDatabase,
  getOrCreateCaptureRetryIntent,
  getOrCreateCaptureUndoIntent,
  listPendingCaptureDeleteIntents,
  markCaptureActionIntentSucceeded,
  markCaptureActionIntentSucceededInDatabase,
  removeCaptureActionIntent
} from "./captureActionIntentRepository";
export { discardCaptureDraft, loadCaptureDraft, saveCaptureDraft } from "./captureDraftStore";

export { defaultCapturePreferences } from "./captureOutboxTypes";
export type {
  CaptureDraft,
  CaptureOutboxRecord,
  CaptureOutboxState,
  CapturePreferences,
  LocalCapture
} from "./captureOutboxTypes";
export {
  assertLegacyDraftMigration,
  assertLegacyOutboxMigration,
  initializeCaptureDatabase
} from "./captureRepositoryDatabase";
export type {
  CaptureDatabaseInitializationRuntime,
  LegacyDraftMigrationSource,
  LegacyDraftMigrationTarget,
  LegacyOutboxMigrationSource,
  LegacyOutboxMigrationTarget
} from "./captureRepositoryDatabase";

function captureTimezone(): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timezone.length > 0 ? timezone : "UTC";
}

function mapOutboxRow(row: CaptureOutboxRow): CaptureOutboxRecord {
  return {
    attemptCount: row.attempt_count,
    capture: {
      clientCaptureId: row.client_capture_id,
      rawContent: row.raw_content,
      source: row.source,
      ...(row.device_id === null ? {} : { deviceId: row.device_id }),
      clientCreatedAt: row.client_created_at,
      clientTimezone: row.client_timezone,
      privacy: row.privacy,
      ...(row.explicit_destination_note_id === null
        ? {}
        : { explicitDestinationNoteId: row.explicit_destination_note_id }),
      expansionDisabled: row.expansion_disabled === 1
    },
    lastErrorCode: row.last_error_code,
    nextAttemptAt: row.next_attempt_at,
    profileId: row.profile_id,
    serverAcknowledgedAt: row.server_acknowledged_at,
    serverCaptureId: row.server_capture_id,
    serverJobId: row.server_job_id,
    state: row.sync_state
  };
}

export interface CommitCaptureInput {
  deviceId?: string;
  preferences: CapturePreferences;
  profileId: string;
  rawContent: string;
  sessionAvailable: boolean;
  source: NativeCaptureSource;
}

export interface CaptureCommitContext {
  createCaptureId(): `cap_${string}`;
  now(): string;
  timezone(): string;
}

const defaultCaptureCommitContext: CaptureCommitContext = {
  createCaptureId: () => `cap_${ulid()}`,
  now: () => new Date().toISOString(),
  timezone: captureTimezone
};

export async function commitCaptureToOutboxInDatabase(
  db: SQLite.SQLiteDatabase,
  input: CommitCaptureInput,
  context: CaptureCommitContext = defaultCaptureCommitContext
): Promise<LocalCapture> {
  if (input.rawContent.trim().length === 0) {
    throw new TypeError("Capture cannot contain only whitespace");
  }

  const capture: LocalCapture = {
    clientCaptureId: context.createCaptureId(),
    rawContent: input.rawContent,
    source: input.source,
    ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
    clientCreatedAt: context.now(),
    clientTimezone: context.timezone(),
    privacy: input.preferences.privacy,
    ...(input.preferences.explicitDestinationNoteId === null
      ? {}
      : { explicitDestinationNoteId: input.preferences.explicitDestinationNoteId }),
    expansionDisabled:
      input.preferences.expansionDisabled || input.preferences.privacy === "private_manual",
    profileId: input.profileId
  };

  await db.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(
      `INSERT INTO capture_outbox (
        client_capture_id,
        profile_id,
        raw_content,
        source,
        device_id,
        client_created_at,
        client_timezone,
        privacy,
        explicit_destination_note_id,
        expansion_disabled,
        sync_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      capture.clientCaptureId,
      capture.profileId,
      capture.rawContent,
      capture.source,
      capture.deviceId ?? null,
      capture.clientCreatedAt,
      capture.clientTimezone,
      capture.privacy,
      capture.explicitDestinationNoteId ?? null,
      capture.expansionDisabled ? 1 : 0,
      input.sessionAvailable ? "queued" : "waiting_for_sign_in"
    );
    await transaction.runAsync(
      "DELETE FROM capture_drafts WHERE profile_id = ? AND source = ?",
      input.profileId,
      input.source
    );
  });

  return capture;
}

export async function commitCaptureToOutbox(input: CommitCaptureInput): Promise<LocalCapture> {
  return commitCaptureToOutboxInDatabase(await database(), input);
}

export async function recoverCaptureOutboxInDatabase(
  db: SQLite.SQLiteDatabase,
  profileId: string
): Promise<void> {
  await db.runAsync(
    `UPDATE capture_outbox
        SET sync_state = 'queued', next_attempt_at = NULL
      WHERE profile_id = ? AND sync_state = 'syncing'`,
    profileId
  );
}

export async function recoverCaptureOutbox(profileId: string): Promise<void> {
  return recoverCaptureOutboxInDatabase(await database(), profileId);
}

export async function resumeCaptureOutboxAfterSignInInDatabase(
  db: SQLite.SQLiteDatabase,
  profileId: string
): Promise<void> {
  await db.runAsync(
    `UPDATE capture_outbox
        SET sync_state = 'queued', next_attempt_at = NULL, last_error_code = NULL
      WHERE profile_id = ? AND sync_state = 'waiting_for_sign_in'`,
    profileId
  );
}

export async function resumeCaptureOutboxAfterSignIn(profileId: string): Promise<void> {
  return resumeCaptureOutboxAfterSignInInDatabase(await database(), profileId);
}

export async function claimNextCapture(
  profileId: string,
  now: string
): Promise<CaptureOutboxRecord | null> {
  const db = await database();
  let claimed: CaptureOutboxRecord | null = null;
  await db.withExclusiveTransactionAsync(async (transaction) => {
    const row = await transaction.getFirstAsync<CaptureOutboxRow>(
      `SELECT *
         FROM capture_outbox
        WHERE profile_id = ?
          AND local_delete_pending = 0
          AND (
            sync_state = 'queued'
            OR (sync_state = 'retry_wait' AND next_attempt_at <= ?)
          )
        ORDER BY client_created_at ASC
        LIMIT 1`,
      profileId,
      now
    );
    if (row === null) return;
    await transaction.runAsync(
      `UPDATE capture_outbox
          SET sync_state = 'syncing', attempt_count = attempt_count + 1
        WHERE client_capture_id = ? AND profile_id = ?`,
      row.client_capture_id,
      profileId
    );
    claimed = mapOutboxRow({
      ...row,
      attempt_count: row.attempt_count + 1,
      sync_state: "syncing"
    });
  });
  return claimed;
}

export async function markCaptureSynced(
  profileId: string,
  clientCaptureId: string,
  response: CaptureCreateResponse,
  acknowledgedAt = new Date().toISOString()
): Promise<void> {
  const db = await database();
  await db.runAsync(
    `UPDATE capture_outbox
        SET sync_state = 'synced',
            next_attempt_at = NULL,
            last_error_code = NULL,
            server_capture_id = ?,
            server_job_id = ?,
            server_acknowledged_at = ?
      WHERE client_capture_id = ? AND profile_id = ?`,
    response.capture.id,
    response.jobId,
    acknowledgedAt,
    clientCaptureId,
    profileId
  );
}

export async function markCaptureForRetry(
  profileId: string,
  clientCaptureId: string,
  errorCode: ApiErrorCodeValue,
  nextAttemptAt: string
): Promise<void> {
  const db = await database();
  await db.runAsync(
    `UPDATE capture_outbox
        SET sync_state = 'retry_wait', next_attempt_at = ?, last_error_code = ?
      WHERE client_capture_id = ? AND profile_id = ?`,
    nextAttemptAt,
    errorCode,
    clientCaptureId,
    profileId
  );
}

export async function markCapturePermanentFailure(
  profileId: string,
  clientCaptureId: string,
  errorCode: ApiErrorCodeValue
): Promise<void> {
  const db = await database();
  await db.runAsync(
    `UPDATE capture_outbox
        SET sync_state = 'permanent_failure', next_attempt_at = NULL, last_error_code = ?
      WHERE client_capture_id = ? AND profile_id = ?`,
    errorCode,
    clientCaptureId,
    profileId
  );
}

export async function markCaptureWaitingForSignIn(
  profileId: string,
  clientCaptureId: string
): Promise<void> {
  const db = await database();
  await db.runAsync(
    `UPDATE capture_outbox
        SET sync_state = 'waiting_for_sign_in', next_attempt_at = NULL,
            last_error_code = 'unauthorized'
      WHERE client_capture_id = ? AND profile_id = ?`,
    clientCaptureId,
    profileId
  );
}

export async function retryCapture(profileId: string, clientCaptureId: string): Promise<void> {
  const db = await database();
  await db.runAsync(
    `UPDATE capture_outbox
        SET sync_state = 'queued', attempt_count = 0, next_attempt_at = NULL,
            last_error_code = NULL
      WHERE client_capture_id = ? AND profile_id = ? AND sync_state = 'permanent_failure'`,
    clientCaptureId,
    profileId
  );
}

export async function listCaptureOutbox(profileId: string): Promise<CaptureOutboxRecord[]> {
  const db = await database();
  const rows = await db.getAllAsync<CaptureOutboxRow>(
    `SELECT * FROM capture_outbox
      WHERE profile_id = ? AND local_delete_pending = 0
      ORDER BY client_created_at DESC`,
    profileId
  );
  return rows.map(mapOutboxRow);
}

export async function pendingCaptureCount(profileId: string): Promise<number> {
  const db = await database();
  const row = await db.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) AS count
       FROM capture_outbox
      WHERE profile_id = ?
        AND sync_state IN ('queued', 'syncing', 'waiting_for_sign_in', 'retry_wait')`,
    profileId
  );
  return row?.count ?? 0;
}
