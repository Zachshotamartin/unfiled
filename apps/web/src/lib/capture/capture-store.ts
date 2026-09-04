import {
  CaptureDeleteRequestSchema,
  CaptureCreateRequestSchema,
  CaptureRetryRequestSchema,
  MutationUndoRequestSchema,
  PrivacyModeSchema,
  entityIdSchema,
  type ApiErrorCodeValue,
  type Capture,
  type CaptureCreateRequest,
  type CaptureDeleteRequest,
  type CaptureDeleteResponse,
  type CaptureRetryRequest,
  type EntityId,
  type MutationUndoRequest,
  type PrivacyMode
} from "@unfiled/contracts";
import {
  generateKeyEncryptionKey,
  openUtf8,
  sealUtf8,
  type ContentEnvelopeV1,
  type KeyEncryptionKey
} from "@unfiled/content-crypto";

import {
  captureActionId,
  deleteCaptureActionId,
  parseCaptureLocalAction,
  type CaptureLocalAction,
  type DeleteCaptureIntent,
  type RetryCaptureIntent,
  type UndoMutationIntent
} from "./capture-action";

export type CaptureDraft = Readonly<{
  expansionDisabled: boolean;
  explicitDestinationNoteId: EntityId<"note"> | null;
  privacy: PrivacyMode;
  rawContent: string;
  updatedAt: string;
}>;

export type DurableCaptureRequest = Readonly<{
  clientCaptureId: EntityId<"cap">;
  rawContent: string;
  source: Capture["source"];
  deviceId?: string | undefined;
  clientCreatedAt: string;
  clientTimezone: string;
  privacy: Capture["privacy"];
  explicitDestinationNoteId?: EntityId<"note"> | undefined;
  expansionDisabled: boolean;
  /**
   * The photos this capture names. Their bytes are already on the server before the capture is
   * queued, so a capture that waits for a connection still arrives carrying them. The array is
   * the contract's own shape, so a queued capture is exactly the request that will be sent.
   */
  attachmentIds?: EntityId<"att">[] | undefined;
}>;

export type CaptureOutboxState = "waiting" | "sending" | "retrying" | "permanent" | "synced";

export type CaptureOutboxUpdate = Readonly<{
  attempts: number;
  errorCode: ApiErrorCodeValue | null;
  nextAttemptAt: number | null;
  state: CaptureOutboxState;
  updatedAt: number;
}>;

export type CaptureOutboxItem = CaptureOutboxUpdate &
  Readonly<{
    createdAt: number;
    request: DurableCaptureRequest;
  }>;

export type CaptureOutboxStatus = CaptureOutboxUpdate &
  Readonly<{
    clientCaptureId: EntityId<"cap">;
    createdAt: number;
  }>;

type StoredRecordBase = Readonly<{
  createdAt: number;
  envelope: ContentEnvelopeV1;
  profileId: string;
  recordVersion: number;
  resourceId: string;
  storageKey: string;
  updatedAt: number;
}>;

export type StoredDraftRecord = StoredRecordBase & Readonly<{ kind: "draft" }>;
export type StoredOutboxRecord = StoredRecordBase &
  CaptureOutboxUpdate &
  Readonly<{ kind: "outbox" }>;
export type StoredActionRecord = StoredRecordBase & Readonly<{ kind: "action" }>;
export type StoredCaptureRecord = StoredDraftRecord | StoredOutboxRecord | StoredActionRecord;

export type StoredProfileKey = Readonly<{
  key: CryptoKey;
  keyId: string;
  profileId: string;
}>;

export interface CapturePersistence {
  getKey(profileId: string): Promise<StoredProfileKey | null>;
  addKey(record: StoredProfileKey): Promise<boolean>;
  addRecord(record: StoredCaptureRecord): Promise<boolean>;
  deleteKey(profileId: string): Promise<void>;
  getRecord(storageKey: string): Promise<StoredCaptureRecord | null>;
  putRecord(record: StoredCaptureRecord): Promise<void>;
  deleteRecord(storageKey: string): Promise<void>;
  listRecords(): Promise<readonly StoredCaptureRecord[]>;
  replaceRecords(
    deleteStorageKeys: readonly string[],
    records: readonly StoredCaptureRecord[]
  ): Promise<void>;
}

export type CaptureLocalStoreErrorCode =
  "capture_id_reused" | "local_key_unavailable" | "local_record_invalid" | "outbox_item_missing";

export class CaptureLocalStoreError extends Error {
  readonly code: CaptureLocalStoreErrorCode;

  constructor(code: CaptureLocalStoreErrorCode, message: string) {
    super(message);
    this.name = "CaptureLocalStoreError";
    this.code = code;
  }
}

function fail(code: CaptureLocalStoreErrorCode, message: string): never {
  throw new CaptureLocalStoreError(code, message);
}

type StoredRecordKind = StoredCaptureRecord["kind"];

function storageKey(profileId: string, kind: StoredRecordKind, resourceId: string): string {
  return `${profileId}:${kind}:${resourceId}`;
}

function encryptionKind(kind: StoredRecordKind): "draft" | "outbox" {
  return kind === "draft" ? "draft" : "outbox";
}

function keyId(profileId: string): string {
  return `web.${profileId}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseDraft(value: unknown): CaptureDraft {
  if (!isRecord(value)) fail("local_record_invalid", "The saved draft is invalid");
  const expectedKeys = [
    "expansionDisabled",
    "explicitDestinationNoteId",
    "privacy",
    "rawContent",
    "updatedAt"
  ];
  const destination =
    value.explicitDestinationNoteId === null
      ? null
      : entityIdSchema("note").safeParse(value.explicitDestinationNoteId);
  const privacy = PrivacyModeSchema.safeParse(value.privacy);
  if (
    typeof value.rawContent !== "string" ||
    value.rawContent.length > 10_000 ||
    typeof value.expansionDisabled !== "boolean" ||
    typeof value.updatedAt !== "string" ||
    Number.isNaN(Date.parse(value.updatedAt)) ||
    (destination !== null && !destination.success) ||
    !privacy.success ||
    Object.keys(value).some((key) => !expectedKeys.includes(key))
  ) {
    fail("local_record_invalid", "The saved draft is invalid");
  }
  if (privacy.data === "private_manual" && !value.expansionDisabled) {
    fail("local_record_invalid", "Private drafts must disable expansion");
  }
  return {
    expansionDisabled: value.expansionDisabled,
    explicitDestinationNoteId: destination === null ? null : destination.data,
    privacy: privacy.data,
    rawContent: value.rawContent,
    updatedAt: value.updatedAt
  };
}

function parseRequest(value: unknown): DurableCaptureRequest {
  const parsed = CaptureCreateRequestSchema.safeParse(value);
  if (!parsed.success) fail("local_record_invalid", "The queued capture is invalid");
  if (parsed.data.privacy === "private_manual" && !parsed.data.expansionDisabled) {
    fail("local_record_invalid", "Private captures must disable expansion");
  }
  return parsed.data;
}

function parseJson(serialized: string): unknown {
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    fail("local_record_invalid", "Encrypted browser content is invalid");
  }
}

function assertStoredKey(record: StoredProfileKey, profileId: string): KeyEncryptionKey {
  const algorithm = record.key.algorithm;
  if (
    record.profileId !== profileId ||
    record.keyId !== keyId(profileId) ||
    algorithm.name !== "AES-GCM" ||
    !("length" in algorithm) ||
    algorithm.length !== 256 ||
    record.key.extractable ||
    !record.key.usages.includes("encrypt") ||
    !record.key.usages.includes("decrypt")
  ) {
    fail("local_key_unavailable", "The encrypted browser key is unavailable");
  }
  return { key: record.key, keyId: record.keyId };
}

function assertRecord(
  record: StoredCaptureRecord,
  profileId: string,
  kind: StoredRecordKind,
  resourceId: string
): void {
  if (
    record.profileId !== profileId ||
    record.kind !== kind ||
    record.resourceId !== resourceId ||
    record.storageKey !== storageKey(profileId, kind, resourceId) ||
    !Number.isSafeInteger(record.recordVersion) ||
    record.recordVersion < 1
  ) {
    fail("local_record_invalid", "The encrypted browser record is invalid");
  }
}

export function createCaptureLocalStore(
  persistence: CapturePersistence,
  cryptoImplementation: Crypto = globalThis.crypto
) {
  const pendingKeys = new Map<string, Promise<KeyEncryptionKey>>();

  async function ensureKey(profileId: string): Promise<KeyEncryptionKey> {
    const pending = pendingKeys.get(profileId);
    if (pending !== undefined) return pending;
    const next = (async () => {
      const existing = await persistence.getKey(profileId);
      if (existing !== null) return assertStoredKey(existing, profileId);
      const hasOrphanedContent = (await persistence.listRecords()).some(
        (record) => record.profileId === profileId
      );
      if (hasOrphanedContent) {
        fail("local_key_unavailable", "The encrypted browser key is unavailable");
      }
      const generated = await generateKeyEncryptionKey(keyId(profileId), cryptoImplementation);
      const candidate = { profileId, ...generated };
      if (await persistence.addKey(candidate)) return generated;
      const winner = await persistence.getKey(profileId);
      if (winner === null)
        fail("local_key_unavailable", "The encrypted browser key is unavailable");
      return assertStoredKey(winner, profileId);
    })();
    pendingKeys.set(profileId, next);
    try {
      return await next;
    } finally {
      pendingKeys.delete(profileId);
    }
  }

  async function decryptRecord(record: StoredCaptureRecord, profileId: string): Promise<unknown> {
    const key = await ensureKey(profileId);
    const serialized = await openUtf8(
      record.envelope,
      {
        kind: encryptionKind(record.kind),
        recordVersion: record.recordVersion,
        resourceId: record.resourceId,
        tenantId: profileId
      },
      key,
      cryptoImplementation
    );
    return parseJson(serialized);
  }

  async function encrypt(
    profileId: string,
    resourceId: string,
    kind: StoredRecordKind,
    recordVersion: number,
    value: unknown
  ): Promise<ContentEnvelopeV1> {
    return sealUtf8(
      JSON.stringify(value),
      { kind: encryptionKind(kind), recordVersion, resourceId, tenantId: profileId },
      await ensureKey(profileId),
      cryptoImplementation
    );
  }

  async function loadDraft(profileId: string): Promise<CaptureDraft | null> {
    const key = storageKey(profileId, "draft", "current");
    const record = await persistence.getRecord(key);
    if (record === null) return null;
    assertRecord(record, profileId, "draft", "current");
    return parseDraft(await decryptRecord(record, profileId));
  }

  async function saveDraft(profileId: string, draft: CaptureDraft): Promise<void> {
    const parsedDraft = parseDraft(draft);
    const key = storageKey(profileId, "draft", "current");
    const existing = await persistence.getRecord(key);
    if (existing !== null) assertRecord(existing, profileId, "draft", "current");
    const recordVersion = existing === null ? 1 : existing.recordVersion + 1;
    const envelope = await encrypt(profileId, "current", "draft", recordVersion, parsedDraft);
    const timestamp = Date.parse(parsedDraft.updatedAt);
    await persistence.putRecord({
      createdAt: existing?.createdAt ?? timestamp,
      envelope,
      kind: "draft",
      profileId,
      recordVersion,
      resourceId: "current",
      storageKey: key,
      updatedAt: timestamp
    });
  }

  async function enqueueCapture(
    profileId: string,
    input: CaptureCreateRequest,
    now: number
  ): Promise<CaptureOutboxItem> {
    const request = parseRequest(input);
    const resourceId = request.clientCaptureId;
    const key = storageKey(profileId, "outbox", resourceId);
    const existing = await persistence.getRecord(key);
    if (existing !== null) {
      assertRecord(existing, profileId, "outbox", resourceId);
      if (existing.kind !== "outbox") {
        fail("local_record_invalid", "The encrypted browser record is invalid");
      }
      const currentRequest = parseRequest(await decryptRecord(existing, profileId));
      if (JSON.stringify(currentRequest) !== JSON.stringify(request)) {
        fail("capture_id_reused", "A capture identifier cannot be reused for different content");
      }
      return {
        attempts: existing.attempts,
        createdAt: existing.createdAt,
        errorCode: existing.errorCode,
        nextAttemptAt: existing.nextAttemptAt,
        request: currentRequest,
        state: existing.state,
        updatedAt: existing.updatedAt
      };
    }
    const envelope = await encrypt(profileId, resourceId, "outbox", 1, request);
    const record: StoredOutboxRecord = {
      attempts: 0,
      createdAt: now,
      envelope,
      errorCode: null,
      kind: "outbox",
      nextAttemptAt: now,
      profileId,
      recordVersion: 1,
      resourceId,
      state: "waiting",
      storageKey: key,
      updatedAt: now
    };
    await persistence.putRecord(record);
    return {
      attempts: record.attempts,
      createdAt: record.createdAt,
      errorCode: record.errorCode,
      nextAttemptAt: record.nextAttemptAt,
      request,
      state: record.state,
      updatedAt: record.updatedAt
    };
  }

  async function listOutbox(profileId: string): Promise<readonly CaptureOutboxItem[]> {
    const records = (await persistence.listRecords())
      .filter(
        (record): record is StoredOutboxRecord =>
          record.profileId === profileId && record.kind === "outbox"
      )
      .sort((left, right) => right.createdAt - left.createdAt);
    return Promise.all(
      records.map(async (record) => {
        assertRecord(record, profileId, "outbox", record.resourceId);
        return { ...record, request: parseRequest(await decryptRecord(record, profileId)) };
      })
    );
  }

  async function listOutboxStatus(profileId: string): Promise<readonly CaptureOutboxStatus[]> {
    return (await persistence.listRecords())
      .filter(
        (record): record is StoredOutboxRecord =>
          record.profileId === profileId && record.kind === "outbox"
      )
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((record) => ({
        attempts: record.attempts,
        clientCaptureId: entityIdSchema("cap").parse(record.resourceId),
        createdAt: record.createdAt,
        errorCode: record.errorCode,
        nextAttemptAt: record.nextAttemptAt,
        state: record.state,
        updatedAt: record.updatedAt
      }));
  }

  async function updateOutbox(
    profileId: string,
    captureId: EntityId<"cap">,
    update: CaptureOutboxUpdate
  ): Promise<void> {
    const key = storageKey(profileId, "outbox", captureId);
    const record = await persistence.getRecord(key);
    if (record === null) fail("outbox_item_missing", "The queued capture is unavailable");
    assertRecord(record, profileId, "outbox", captureId);
    await persistence.putRecord({ ...record, ...update });
  }

  async function recoverInterrupted(profileId: string, now: number): Promise<void> {
    const interrupted = (await persistence.listRecords()).filter(
      (record): record is StoredOutboxRecord =>
        record.profileId === profileId && record.kind === "outbox" && record.state === "sending"
    );
    await Promise.all(
      interrupted.map((record) =>
        persistence.putRecord({
          ...record,
          nextAttemptAt: now,
          state: "waiting",
          updatedAt: now
        })
      )
    );
  }

  async function manualRetry(
    profileId: string,
    captureId: EntityId<"cap">,
    now: number
  ): Promise<void> {
    await updateOutbox(profileId, captureId, {
      attempts: 0,
      errorCode: null,
      nextAttemptAt: now,
      state: "waiting",
      updatedAt: now
    });
  }

  async function readActionById(
    profileId: string,
    actionId: string
  ): Promise<CaptureLocalAction | null> {
    const record = await persistence.getRecord(storageKey(profileId, "action", actionId));
    if (record === null) return null;
    assertRecord(record, profileId, "action", actionId);
    const action = parseCaptureLocalAction(await decryptRecord(record, profileId));
    if (action === null || captureActionId(action) !== actionId) {
      fail("local_record_invalid", "The encrypted browser action is invalid");
    }
    return action;
  }

  async function actionRecord(
    profileId: string,
    action: CaptureLocalAction,
    recordVersion: number
  ): Promise<StoredActionRecord> {
    const resourceId = captureActionId(action);
    return {
      createdAt: action.createdAt,
      envelope: await encrypt(profileId, resourceId, "action", recordVersion, action),
      kind: "action",
      profileId,
      recordVersion,
      resourceId,
      storageKey: storageKey(profileId, "action", resourceId),
      updatedAt: action.updatedAt
    };
  }

  async function addAction(
    profileId: string,
    candidate: CaptureLocalAction
  ): Promise<CaptureLocalAction> {
    const actionId = captureActionId(candidate);
    const existing = await readActionById(profileId, actionId);
    if (existing !== null) return existing;
    const record = await actionRecord(profileId, candidate, 1);
    if (await persistence.addRecord(record)) return candidate;
    const winner = await readActionById(profileId, actionId);
    if (winner === null)
      fail("local_record_invalid", "The encrypted browser action is unavailable");
    return winner;
  }

  async function saveAction(profileId: string, action: CaptureLocalAction): Promise<void> {
    const actionId = captureActionId(action);
    const key = storageKey(profileId, "action", actionId);
    const existing = await persistence.getRecord(key);
    if (existing === null)
      fail("local_record_invalid", "The encrypted browser action is unavailable");
    assertRecord(existing, profileId, "action", actionId);
    await persistence.putRecord(await actionRecord(profileId, action, existing.recordVersion + 1));
  }

  async function listActions(profileId: string): Promise<readonly CaptureLocalAction[]> {
    const records = (await persistence.listRecords())
      .filter(
        (record): record is StoredActionRecord =>
          record.profileId === profileId && record.kind === "action"
      )
      .sort((left, right) => right.createdAt - left.createdAt);
    return Promise.all(
      records.map(async (record) => {
        assertRecord(record, profileId, "action", record.resourceId);
        const action = parseCaptureLocalAction(await decryptRecord(record, profileId));
        if (action === null || captureActionId(action) !== record.resourceId) {
          fail("local_record_invalid", "The encrypted browser action is invalid");
        }
        return action;
      })
    );
  }

  async function ensureRetryCaptureAction(
    profileId: string,
    captureId: EntityId<"cap">,
    input: CaptureRetryRequest,
    now: number
  ): Promise<RetryCaptureIntent> {
    const request = CaptureRetryRequestSchema.parse(input);
    const action = await addAction(profileId, {
      actionType: "retry_capture",
      attempts: 0,
      captureId,
      createdAt: now,
      errorCode: null,
      nextAttemptAt: now,
      request,
      state: "pending",
      updatedAt: now
    });
    if (action.actionType !== "retry_capture") {
      fail("local_record_invalid", "The encrypted browser action is invalid");
    }
    return action;
  }

  async function ensureDeleteCaptureAction(
    profileId: string,
    captureId: EntityId<"cap">,
    input: CaptureDeleteRequest,
    now: number
  ): Promise<DeleteCaptureIntent> {
    const request = CaptureDeleteRequestSchema.parse(input);
    const action = await addAction(profileId, {
      actionType: "delete_capture",
      attempts: 0,
      captureId,
      createdAt: now,
      errorCode: null,
      nextAttemptAt: now,
      request,
      state: "pending",
      updatedAt: now
    });
    if (action.actionType !== "delete_capture") {
      fail("local_record_invalid", "The encrypted browser action is invalid");
    }
    return action;
  }

  async function ensureUndoMutationAction(
    profileId: string,
    captureId: EntityId<"cap">,
    mutationId: EntityId<"mut">,
    noteId: EntityId<"note"> | null,
    source: UndoMutationIntent["source"],
    input: MutationUndoRequest,
    now: number
  ): Promise<UndoMutationIntent> {
    const request = MutationUndoRequestSchema.parse(input);
    const action = await addAction(profileId, {
      actionType: "undo_mutation",
      attempts: 0,
      captureId,
      createdAt: now,
      errorCode: null,
      mutationId,
      nextAttemptAt: now,
      noteId,
      request,
      source,
      state: "pending",
      updatedAt: now
    });
    if (action.actionType !== "undo_mutation") {
      fail("local_record_invalid", "The encrypted browser action is invalid");
    }
    return action;
  }

  async function resumeAction(
    profileId: string,
    action: RetryCaptureIntent | DeleteCaptureIntent | UndoMutationIntent,
    now: number
  ): Promise<typeof action> {
    if (action.actionType === "undo_mutation" && action.state === "consumed") return action;
    const resumed = {
      ...action,
      attempts: 0,
      errorCode: null,
      nextAttemptAt: now,
      state: "pending" as const,
      updatedAt: now
    };
    await saveAction(profileId, resumed);
    return resumed;
  }

  async function removeAction(profileId: string, action: CaptureLocalAction): Promise<void> {
    await persistence.deleteRecord(storageKey(profileId, "action", captureActionId(action)));
  }

  async function completeCaptureDeletion(
    profileId: string,
    captureId: EntityId<"cap">,
    response: CaptureDeleteResponse | null,
    now: number,
    createKey: () => string
  ): Promise<void> {
    const tombstone: CaptureLocalAction = {
      actionType: "capture_tombstone",
      captureId,
      createdAt: now,
      deletedAt: response?.deletedAt ?? new Date(now).toISOString(),
      updatedAt: now
    };
    const undoActions: UndoMutationIntent[] = (response?.contentRemovalMutations ?? []).map(
      (mutation) => ({
        actionType: "undo_mutation",
        attempts: 0,
        captureId,
        createdAt: now,
        errorCode: null,
        mutationId: mutation.mutationId,
        nextAttemptAt: null,
        noteId: mutation.noteId,
        request: MutationUndoRequestSchema.parse({
          expectedRevision: mutation.expectedRevision,
          idempotencyKey: createKey()
        }),
        source: "delete_content",
        state: "available",
        updatedAt: now
      })
    );
    const records = await Promise.all(
      [tombstone, ...undoActions].map((action) => actionRecord(profileId, action, 1))
    );
    await persistence.replaceRecords(
      [
        storageKey(profileId, "outbox", captureId),
        storageKey(profileId, "action", deleteCaptureActionId(captureId))
      ],
      records
    );
  }

  async function clearProfile(profileId: string): Promise<void> {
    const records = (await persistence.listRecords()).filter(
      (record) => record.profileId === profileId
    );
    await Promise.all(records.map((record) => persistence.deleteRecord(record.storageKey)));
    await persistence.deleteKey(profileId);
  }

  return Object.freeze({
    clearProfile,
    deleteDraft: (profileId: string) =>
      persistence.deleteRecord(storageKey(profileId, "draft", "current")),
    deleteOutbox: (profileId: string, captureId: EntityId<"cap">) =>
      persistence.deleteRecord(storageKey(profileId, "outbox", captureId)),
    enqueueCapture,
    ensureDeleteCaptureAction,
    ensureRetryCaptureAction,
    ensureUndoMutationAction,
    listOutbox,
    listOutboxStatus,
    listActions,
    loadDraft,
    manualRetry,
    completeCaptureDeletion,
    recoverInterrupted,
    removeAction,
    resumeAction,
    saveAction,
    saveDraft,
    updateOutbox
  });
}

export type CaptureLocalStore = ReturnType<typeof createCaptureLocalStore>;
