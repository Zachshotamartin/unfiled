import type {
  ApiErrorCodeValue,
  CaptureCreateRequest,
  CaptureSource,
  PrivacyMode
} from "@unfiled/contracts";

import type { NativeCaptureSource } from "./captureSource";

export type CaptureOutboxState =
  "queued" | "syncing" | "waiting_for_sign_in" | "retry_wait" | "synced" | "permanent_failure";

export interface CapturePreferences {
  expansionDisabled: boolean;
  explicitDestinationNoteId: `note_${string}` | null;
  privacy: PrivacyMode;
}

export const defaultCapturePreferences: CapturePreferences = Object.freeze({
  expansionDisabled: false,
  explicitDestinationNoteId: null,
  privacy: "ai_assisted"
});

export interface CaptureDraft extends CapturePreferences {
  body: string;
  source: NativeCaptureSource;
  updatedAt: string;
}

export interface LocalCapture extends Omit<
  CaptureCreateRequest,
  "clientCaptureId" | "expansionDisabled" | "privacy"
> {
  clientCaptureId: `cap_${string}`;
  expansionDisabled: boolean;
  privacy: PrivacyMode;
  profileId: string;
}

export interface CaptureOutboxRecord {
  attemptCount: number;
  capture: Omit<LocalCapture, "profileId">;
  lastErrorCode: ApiErrorCodeValue | null;
  nextAttemptAt: string | null;
  profileId: string;
  serverAcknowledgedAt: string | null;
  serverCaptureId: `cap_${string}` | null;
  serverJobId: `job_${string}` | null;
  state: CaptureOutboxState;
}

export interface CaptureOutboxRow {
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
