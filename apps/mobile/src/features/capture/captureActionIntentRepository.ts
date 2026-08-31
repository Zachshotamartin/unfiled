import {
  CaptureDeleteRequestSchema,
  CaptureRetryRequestSchema,
  MutationUndoRequestSchema,
  type CaptureRetryRequest,
  type MutationUndoRequest
} from "@unfiled/contracts";
import type * as SQLite from "expo-sqlite";
import { ulid } from "ulid";

import {
  actionIdempotencyKey,
  captureDeleteSignature,
  captureRetrySignature,
  captureUndoSignature,
  serializeCaptureActionRequest,
  type CaptureActionIntent,
  type CaptureActionIntentKind,
  type CaptureDeleteIntent,
  type PersistedCaptureDeleteRequest
} from "./captureActionIntents";
import { captureDatabase } from "./captureRepositoryDatabase";

interface CaptureActionIntentRow {
  action_signature: string;
  action_state: "pending" | "succeeded";
  action_type: CaptureActionIntentKind;
  idempotency_key: string;
  request_json: string;
  target_id: string;
}

type PersistedCaptureActionRequest =
  PersistedCaptureDeleteRequest | CaptureRetryRequest | MutationUndoRequest;

interface CaptureActionIntentInput<Request extends PersistedCaptureActionRequest> {
  actionSignature: string;
  actionType: CaptureActionIntentKind;
  requestForKey(idempotencyKey: string): Request;
  targetId: string;
}

function mapActionIntentRow(row: CaptureActionIntentRow, profileId: string): CaptureActionIntent {
  return {
    actionSignature: row.action_signature,
    actionType: row.action_type,
    idempotencyKey: row.idempotency_key,
    profileId,
    requestJson: row.request_json,
    state: row.action_state,
    targetId: row.target_id
  };
}

function parseStoredRequest<Request>(
  requestJson: string,
  schema: Readonly<{ parse(value: unknown): Request }>
): Request {
  try {
    return schema.parse(JSON.parse(requestJson) as unknown);
  } catch {
    throw new Error("A protected capture action intent is invalid");
  }
}

async function getOrCreateCaptureActionIntentOnConnection<
  Request extends PersistedCaptureActionRequest
>(
  database: SQLite.SQLiteDatabase,
  profileId: string,
  input: CaptureActionIntentInput<Request>,
  createId: () => string = ulid
): Promise<CaptureActionIntent> {
  const existing = await database.getFirstAsync<CaptureActionIntentRow>(
    `SELECT action_signature, action_state, action_type, idempotency_key, request_json, target_id
       FROM capture_action_intents
      WHERE profile_id = ? AND action_signature = ?`,
    profileId,
    input.actionSignature
  );
  if (existing !== null) {
    if (existing.action_type !== input.actionType || existing.target_id !== input.targetId) {
      throw new Error("A protected capture action intent does not match this action");
    }
    return mapActionIntentRow(existing, profileId);
  }

  const idempotencyKey = actionIdempotencyKey(input.actionType, createId());
  const requestJson = serializeCaptureActionRequest(input.requestForKey(idempotencyKey));
  const now = new Date().toISOString();
  await database.runAsync(
    `INSERT INTO capture_action_intents (
       profile_id, action_signature, action_type, target_id, idempotency_key,
       request_json, action_state, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    profileId,
    input.actionSignature,
    input.actionType,
    input.targetId,
    idempotencyKey,
    requestJson,
    now,
    now
  );
  return {
    actionSignature: input.actionSignature,
    actionType: input.actionType,
    idempotencyKey,
    profileId,
    requestJson,
    state: "pending",
    targetId: input.targetId
  };
}

export async function getOrCreateCaptureActionIntentInDatabase<
  Request extends PersistedCaptureActionRequest
>(
  database: SQLite.SQLiteDatabase,
  profileId: string,
  input: CaptureActionIntentInput<Request>,
  createId: () => string = ulid
): Promise<CaptureActionIntent> {
  let intent!: CaptureActionIntent;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    intent = await getOrCreateCaptureActionIntentOnConnection(
      transaction,
      profileId,
      input,
      createId
    );
  });
  return intent;
}

export async function getOrCreateCaptureRetryIntent(
  profileId: string,
  captureId: `cap_${string}`,
  failureReceiptCreatedAt: string
): Promise<Readonly<{ actionSignature: string; request: CaptureRetryRequest }>> {
  const actionSignature = captureRetrySignature(captureId, failureReceiptCreatedAt);
  const intent = await getOrCreateCaptureActionIntentInDatabase(
    await captureDatabase(),
    profileId,
    {
      actionSignature,
      actionType: "retry",
      requestForKey: (idempotencyKey) => ({ idempotencyKey }),
      targetId: captureId
    }
  );
  return {
    actionSignature,
    request: parseStoredRequest(intent.requestJson, CaptureRetryRequestSchema)
  };
}

export async function getOrCreateCaptureUndoIntent(
  profileId: string,
  mutationId: `mut_${string}`,
  expectedRevision: number
): Promise<Readonly<{ actionSignature: string; request: MutationUndoRequest }>> {
  const actionSignature = captureUndoSignature(mutationId, expectedRevision);
  const intent = await getOrCreateCaptureActionIntentInDatabase(
    await captureDatabase(),
    profileId,
    {
      actionSignature,
      actionType: "undo",
      requestForKey: (idempotencyKey) => ({ expectedRevision, idempotencyKey }),
      targetId: mutationId
    }
  );
  return {
    actionSignature,
    request: parseStoredRequest(intent.requestJson, MutationUndoRequestSchema)
  };
}

export async function beginCaptureDeleteIntentInDatabase(
  database: SQLite.SQLiteDatabase,
  profileId: string,
  captureId: `cap_${string}`,
  requestWithoutKey: Omit<PersistedCaptureDeleteRequest, "idempotencyKey">,
  createId: () => string = ulid
): Promise<CaptureDeleteIntent> {
  const actionSignature = captureDeleteSignature(captureId, requestWithoutKey);
  let intent!: CaptureActionIntent;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    intent = await getOrCreateCaptureActionIntentOnConnection(
      transaction,
      profileId,
      {
        actionSignature,
        actionType: "delete",
        requestForKey: (idempotencyKey) => ({ ...requestWithoutKey, idempotencyKey }),
        targetId: captureId
      },
      createId
    );
    await transaction.runAsync(
      `UPDATE capture_outbox
          SET local_delete_pending = 1
        WHERE profile_id = ? AND client_capture_id = ?`,
      profileId,
      captureId
    );
  });
  return {
    ...intent,
    actionType: "delete",
    captureId,
    request: parseStoredRequest(intent.requestJson, CaptureDeleteRequestSchema)
  };
}

export async function beginCaptureDeleteIntent(
  profileId: string,
  captureId: `cap_${string}`,
  requestWithoutKey: Omit<PersistedCaptureDeleteRequest, "idempotencyKey">
): Promise<CaptureDeleteIntent> {
  return beginCaptureDeleteIntentInDatabase(
    await captureDatabase(),
    profileId,
    captureId,
    requestWithoutKey
  );
}

export async function captureActionIntentSucceededInDatabase(
  database: SQLite.SQLiteDatabase,
  profileId: string,
  actionSignature: string
): Promise<boolean> {
  const row = await database.getFirstAsync<{ succeeded: number }>(
    `SELECT 1 AS succeeded
       FROM capture_action_intents
      WHERE profile_id = ? AND action_signature = ? AND action_state = 'succeeded'`,
    profileId,
    actionSignature
  );
  return row?.succeeded === 1;
}

export async function captureActionIntentSucceeded(
  profileId: string,
  actionSignature: string
): Promise<boolean> {
  return captureActionIntentSucceededInDatabase(
    await captureDatabase(),
    profileId,
    actionSignature
  );
}

export async function markCaptureActionIntentSucceededInDatabase(
  database: SQLite.SQLiteDatabase,
  profileId: string,
  actionSignature: string,
  updatedAt = new Date().toISOString()
): Promise<void> {
  await database.runAsync(
    `UPDATE capture_action_intents
        SET action_state = 'succeeded', updated_at = ?
      WHERE profile_id = ? AND action_signature = ?`,
    updatedAt,
    profileId,
    actionSignature
  );
}

export async function markCaptureActionIntentSucceeded(
  profileId: string,
  actionSignature: string
): Promise<void> {
  return markCaptureActionIntentSucceededInDatabase(
    await captureDatabase(),
    profileId,
    actionSignature
  );
}

export async function removeCaptureActionIntent(
  profileId: string,
  actionSignature: string
): Promise<void> {
  await (
    await captureDatabase()
  ).runAsync(
    "DELETE FROM capture_action_intents WHERE profile_id = ? AND action_signature = ?",
    profileId,
    actionSignature
  );
}

export async function listPendingCaptureDeleteIntents(
  profileId: string
): Promise<CaptureDeleteIntent[]> {
  const rows = await (
    await captureDatabase()
  ).getAllAsync<CaptureActionIntentRow>(
    `SELECT action_signature, action_state, action_type, idempotency_key, request_json, target_id
       FROM capture_action_intents
      WHERE profile_id = ? AND action_type = 'delete' AND action_state = 'pending'
      ORDER BY created_at ASC`,
    profileId
  );
  return rows.map((row) => {
    if (row.action_type !== "delete" || !row.target_id.startsWith("cap_")) {
      throw new Error("A protected capture deletion intent is invalid");
    }
    return {
      ...mapActionIntentRow(row, profileId),
      actionType: "delete",
      captureId: row.target_id as `cap_${string}`,
      request: parseStoredRequest(row.request_json, CaptureDeleteRequestSchema)
    };
  });
}

export async function completeCaptureDeletionInDatabase(
  database: SQLite.SQLiteDatabase,
  profileId: string,
  actionSignature: string,
  captureId: `cap_${string}`
): Promise<void> {
  await database.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(
      "DELETE FROM capture_outbox WHERE profile_id = ? AND client_capture_id = ?",
      profileId,
      captureId
    );
    await transaction.runAsync(
      "DELETE FROM capture_action_intents WHERE profile_id = ? AND action_signature = ?",
      profileId,
      actionSignature
    );
  });
}

export async function completeCaptureDeletion(
  profileId: string,
  actionSignature: string,
  captureId: `cap_${string}`
): Promise<void> {
  return completeCaptureDeletionInDatabase(
    await captureDatabase(),
    profileId,
    actionSignature,
    captureId
  );
}

export async function cancelCaptureDeletion(
  profileId: string,
  actionSignature: string,
  captureId: `cap_${string}`
): Promise<void> {
  const database = await captureDatabase();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(
      `UPDATE capture_outbox
          SET local_delete_pending = 0
        WHERE profile_id = ? AND client_capture_id = ?`,
      profileId,
      captureId
    );
    await transaction.runAsync(
      "DELETE FROM capture_action_intents WHERE profile_id = ? AND action_signature = ?",
      profileId,
      actionSignature
    );
  });
}
