import { ApiClientError } from "@unfiled/api-client";
import type { CaptureDeleteResponse, EntityId } from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  replayPendingCaptureActions,
  runCaptureAction,
  type CaptureActionTransport
} from "./capture-action-runner";
import {
  createCaptureLocalStore,
  type CapturePersistence,
  type StoredCaptureRecord,
  type StoredProfileKey
} from "./capture-store";

const PROFILE_A = "00000000-0000-4000-8000-000000000001";
const PROFILE_B = "00000000-0000-4000-8000-000000000002";
const RETRY_KEY = "00000000-0000-4000-8000-000000000003";
const DELETE_KEY = "00000000-0000-4000-8000-000000000004";
const UNDO_KEY = "00000000-0000-4000-8000-000000000005";
const CAPTURE_ID: EntityId<"cap"> = "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const MUTATION_ID: EntityId<"mut"> = "mut_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const NOTE_ID: EntityId<"note"> = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X";

class MemoryPersistence implements CapturePersistence {
  readonly keys = new Map<string, StoredProfileKey>();
  readonly records = new Map<string, StoredCaptureRecord>();

  getKey(profileId: string): Promise<StoredProfileKey | null> {
    return Promise.resolve(this.keys.get(profileId) ?? null);
  }

  addKey(record: StoredProfileKey): Promise<boolean> {
    if (this.keys.has(record.profileId)) return Promise.resolve(false);
    this.keys.set(record.profileId, record);
    return Promise.resolve(true);
  }

  addRecord(record: StoredCaptureRecord): Promise<boolean> {
    if (this.records.has(record.storageKey)) return Promise.resolve(false);
    this.records.set(record.storageKey, record);
    return Promise.resolve(true);
  }

  deleteKey(profileId: string): Promise<void> {
    this.keys.delete(profileId);
    return Promise.resolve();
  }

  getRecord(storageKey: string): Promise<StoredCaptureRecord | null> {
    return Promise.resolve(this.records.get(storageKey) ?? null);
  }

  putRecord(record: StoredCaptureRecord): Promise<void> {
    this.records.set(record.storageKey, record);
    return Promise.resolve();
  }

  deleteRecord(storageKey: string): Promise<void> {
    this.records.delete(storageKey);
    return Promise.resolve();
  }

  listRecords(): Promise<readonly StoredCaptureRecord[]> {
    return Promise.resolve([...this.records.values()]);
  }

  replaceRecords(
    deleteStorageKeys: readonly string[],
    records: readonly StoredCaptureRecord[]
  ): Promise<void> {
    for (const storageKey of deleteStorageKeys) this.records.delete(storageKey);
    for (const record of records) this.records.set(record.storageKey, record);
    return Promise.resolve();
  }
}

function transport(overrides: Partial<CaptureActionTransport> = {}): CaptureActionTransport {
  return {
    deleteCapture: () => Promise.reject(new Error("Unexpected delete")),
    retryCapture: () => Promise.reject(new Error("Unexpected retry")),
    undoMutation: () => Promise.reject(new Error("Unexpected undo")),
    undoMutationBatch: () => Promise.reject(new Error("Unexpected batch undo")),
    ...overrides
  };
}

const deleteResponse: CaptureDeleteResponse = {
  captureId: CAPTURE_ID,
  contentRemovalMutations: [
    {
      expectedRevision: 4,
      mutationId: MUTATION_ID,
      noteId: NOTE_ID
    }
  ],
  deletedAt: "2026-08-30T19:00:00.000Z",
  removedInsertedContent: true,
  replayed: false,
  sourceRemovedFromNoteIds: [NOTE_ID]
};

describe("durable browser capture actions", () => {
  it("reuses the exact remote retry key after a lost response and full reload", async () => {
    const persistence = new MemoryPersistence();
    const firstStore = createCaptureLocalStore(persistence, crypto);
    const intent = await firstStore.ensureRetryCaptureAction(
      PROFILE_A,
      CAPTURE_ID,
      { idempotencyKey: RETRY_KEY },
      100
    );
    const first = await runCaptureAction(
      firstStore,
      PROFILE_A,
      intent,
      transport({ retryCapture: () => Promise.reject(new Error("Response lost")) }),
      100,
      () => UNDO_KEY
    );
    expect(first).toMatchObject({ status: "pending" });
    expect(JSON.stringify([...persistence.records.values()])).not.toContain(RETRY_KEY);

    const reloadedStore = createCaptureLocalStore(persistence, crypto);
    const retryCapture = vi.fn<CaptureActionTransport["retryCapture"]>(() => Promise.resolve({}));
    await replayPendingCaptureActions(
      reloadedStore,
      PROFILE_A,
      transport({ retryCapture }),
      1_100,
      () => UNDO_KEY
    );

    expect(retryCapture).toHaveBeenCalledWith(CAPTURE_ID, { idempotencyKey: RETRY_KEY });
    expect(await reloadedStore.listActions(PROFILE_A)).toEqual([]);
    expect(await reloadedStore.listActions(PROFILE_B)).toEqual([]);
  });

  it("atomically clears a deleted source and intent while retaining tombstone and undo", async () => {
    const persistence = new MemoryPersistence();
    const firstStore = createCaptureLocalStore(persistence, crypto);
    await firstStore.enqueueCapture(
      PROFILE_A,
      {
        clientCaptureId: CAPTURE_ID,
        clientCreatedAt: "2026-08-30T18:30:00.000Z",
        clientTimezone: "UTC",
        expansionDisabled: false,
        privacy: "ai_assisted",
        rawContent: "buy oat milk",
        source: "web"
      },
      100
    );
    const intent = await firstStore.ensureDeleteCaptureAction(
      PROFILE_A,
      CAPTURE_ID,
      {
        expectedNoteRevisions: [{ expectedRevision: 3, noteId: NOTE_ID }],
        idempotencyKey: DELETE_KEY,
        removeInsertedContent: true
      },
      100
    );
    await runCaptureAction(
      firstStore,
      PROFILE_A,
      intent,
      transport({ deleteCapture: () => Promise.reject(new Error("Response lost")) }),
      100,
      () => UNDO_KEY
    );

    const reloadedStore = createCaptureLocalStore(persistence, crypto);
    const deleteCapture = vi.fn(() => Promise.resolve(deleteResponse));
    await replayPendingCaptureActions(
      reloadedStore,
      PROFILE_A,
      transport({ deleteCapture }),
      1_100,
      () => UNDO_KEY
    );

    expect(deleteCapture).toHaveBeenCalledWith(
      CAPTURE_ID,
      expect.objectContaining({ idempotencyKey: DELETE_KEY })
    );
    expect(await reloadedStore.listOutbox(PROFILE_A)).toEqual([]);
    const completedActions = await reloadedStore.listActions(PROFILE_A);
    expect(completedActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actionType: "capture_tombstone", captureId: CAPTURE_ID }),
        expect.objectContaining({
          actionType: "undo_mutation",
          mutationId: MUTATION_ID,
          request: { expectedRevision: 4, idempotencyKey: UNDO_KEY },
          source: "delete_content",
          state: "available"
        })
      ])
    );
    expect(completedActions.some((action) => action.actionType === "delete_capture")).toBe(false);

    const availableUndo = completedActions.find((action) => action.actionType === "undo_mutation");
    if (availableUndo?.actionType !== "undo_mutation") {
      throw new Error("Expected a durable content-removal undo");
    }
    const pendingUndo = await reloadedStore.resumeAction(PROFILE_A, availableUndo, 1_200);
    await runCaptureAction(
      reloadedStore,
      PROFILE_A,
      pendingUndo,
      transport({ undoMutation: () => Promise.reject(new Error("Response lost")) }),
      1_200,
      () => DELETE_KEY
    );

    const secondReload = createCaptureLocalStore(persistence, crypto);
    const undoMutation = vi.fn<CaptureActionTransport["undoMutation"]>(() => Promise.resolve({}));
    await replayPendingCaptureActions(
      secondReload,
      PROFILE_A,
      transport({ undoMutation }),
      2_200,
      () => DELETE_KEY
    );
    expect(undoMutation).toHaveBeenCalledWith(MUTATION_ID, {
      expectedRevision: 4,
      idempotencyKey: UNDO_KEY
    });
    expect(await secondReload.listActions(PROFILE_A)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionType: "undo_mutation",
          source: "delete_content",
          state: "consumed"
        })
      ])
    );
  });

  it("treats authoritative delete 404 as complete but restores on definitive rejection", async () => {
    const completedPersistence = new MemoryPersistence();
    const completedStore = createCaptureLocalStore(completedPersistence, crypto);
    const missingIntent = await completedStore.ensureDeleteCaptureAction(
      PROFILE_A,
      CAPTURE_ID,
      { expectedNoteRevisions: [], idempotencyKey: DELETE_KEY, removeInsertedContent: false },
      100
    );
    const missing = new ApiClientError(404, {
      code: "not_found",
      message: "Capture not found",
      requestId: "request-1"
    });
    await runCaptureAction(
      completedStore,
      PROFILE_A,
      missingIntent,
      transport({ deleteCapture: () => Promise.reject(missing) }),
      100,
      () => UNDO_KEY
    );
    expect(await completedStore.listActions(PROFILE_A)).toEqual([
      expect.objectContaining({ actionType: "capture_tombstone", captureId: CAPTURE_ID })
    ]);

    const rejectedPersistence = new MemoryPersistence();
    const rejectedStore = createCaptureLocalStore(rejectedPersistence, crypto);
    const rejectedIntent = await rejectedStore.ensureDeleteCaptureAction(
      PROFILE_A,
      CAPTURE_ID,
      { expectedNoteRevisions: [], idempotencyKey: DELETE_KEY, removeInsertedContent: false },
      100
    );
    const rejected = new ApiClientError(400, {
      code: "validation_failed",
      message: "Rejected",
      requestId: "request-2"
    });
    const result = await runCaptureAction(
      rejectedStore,
      PROFILE_A,
      rejectedIntent,
      transport({ deleteCapture: () => Promise.reject(rejected) }),
      100,
      () => UNDO_KEY
    );
    expect(result.status).toBe("rejected");
    expect(await rejectedStore.listActions(PROFILE_A)).toEqual([]);
  });

  it("persists a lost-response undo as consumed and never executes it again", async () => {
    const persistence = new MemoryPersistence();
    const firstStore = createCaptureLocalStore(persistence, crypto);
    const intent = await firstStore.ensureUndoMutationAction(
      PROFILE_A,
      CAPTURE_ID,
      MUTATION_ID,
      NOTE_ID,
      "receipt",
      { expectedRevision: 4, idempotencyKey: UNDO_KEY },
      100
    );
    await runCaptureAction(
      firstStore,
      PROFILE_A,
      intent,
      transport({ undoMutationBatch: () => Promise.reject(new Error("Response lost")) }),
      100,
      () => DELETE_KEY
    );

    const reloadedStore = createCaptureLocalStore(persistence, crypto);
    const undoMutationBatch = vi.fn<CaptureActionTransport["undoMutationBatch"]>(() =>
      Promise.resolve({})
    );
    const undoMutation = vi.fn<CaptureActionTransport["undoMutation"]>(() => Promise.resolve({}));
    await replayPendingCaptureActions(
      reloadedStore,
      PROFILE_A,
      transport({ undoMutation, undoMutationBatch }),
      1_100,
      () => DELETE_KEY
    );
    await replayPendingCaptureActions(
      reloadedStore,
      PROFILE_A,
      transport({ undoMutation, undoMutationBatch }),
      2_100,
      () => DELETE_KEY
    );

    expect(undoMutationBatch).toHaveBeenCalledTimes(1);
    expect(undoMutationBatch).toHaveBeenCalledWith(MUTATION_ID, {
      expectedRevision: 4,
      idempotencyKey: UNDO_KEY
    });
    expect(undoMutation).not.toHaveBeenCalled();
    expect(await reloadedStore.listActions(PROFILE_A)).toEqual([
      expect.objectContaining({ actionType: "undo_mutation", state: "consumed" })
    ]);
  });
});
