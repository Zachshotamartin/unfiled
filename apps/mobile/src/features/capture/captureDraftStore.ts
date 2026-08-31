import type { PrivacyMode } from "@unfiled/contracts";

import { captureDatabase } from "./captureRepositoryDatabase";
import {
  defaultCapturePreferences,
  type CaptureDraft,
  type CapturePreferences
} from "./captureOutboxTypes";
import type { NativeCaptureSource } from "./captureSource";

const DRAFT_RESTORE_WINDOW_MS = 30 * 60 * 1000;

export async function loadCaptureDraft(
  profileId: string,
  source: NativeCaptureSource,
  now = Date.now()
): Promise<CaptureDraft | null> {
  const database = await captureDatabase();
  const row = await database.getFirstAsync<{
    body: string;
    expansion_disabled: number;
    explicit_destination_note_id: `note_${string}` | null;
    privacy: PrivacyMode;
    updated_at: string;
  }>(
    `SELECT body, expansion_disabled, explicit_destination_note_id, privacy, updated_at
       FROM capture_drafts
      WHERE profile_id = ? AND source = ?`,
    profileId,
    source
  );
  if (row === null) return null;

  const age = now - Date.parse(row.updated_at);
  if (source === "ios_lock_screen_widget" && age > DRAFT_RESTORE_WINDOW_MS) return null;
  return {
    body: row.body,
    expansionDisabled: row.expansion_disabled === 1,
    explicitDestinationNoteId: row.explicit_destination_note_id,
    privacy: row.privacy,
    source,
    updatedAt: row.updated_at
  };
}

export async function saveCaptureDraft(
  profileId: string,
  source: NativeCaptureSource,
  body: string,
  preferences: CapturePreferences = defaultCapturePreferences
): Promise<void> {
  const database = await captureDatabase();
  await database.runAsync(
    `INSERT INTO capture_drafts (
       profile_id,
       source,
       body,
       updated_at,
       privacy,
       explicit_destination_note_id,
       expansion_disabled
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id, source) DO UPDATE SET
       body = excluded.body,
       updated_at = excluded.updated_at,
       privacy = excluded.privacy,
       explicit_destination_note_id = excluded.explicit_destination_note_id,
       expansion_disabled = excluded.expansion_disabled`,
    profileId,
    source,
    body,
    new Date().toISOString(),
    preferences.privacy,
    preferences.explicitDestinationNoteId,
    preferences.expansionDisabled ? 1 : 0
  );
}

export async function discardCaptureDraft(
  profileId: string,
  source: NativeCaptureSource
): Promise<void> {
  const database = await captureDatabase();
  await database.runAsync(
    "DELETE FROM capture_drafts WHERE profile_id = ? AND source = ?",
    profileId,
    source
  );
}
