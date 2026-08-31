import type { CaptureCreateRequest, EntityId } from "@unfiled/contracts";
import type { ContentEnvelopeV1 } from "@unfiled/content-crypto";
import { describe, expect, it } from "vitest";

import {
  CaptureLocalStoreError,
  createCaptureLocalStore,
  type CapturePersistence,
  type StoredCaptureRecord,
  type StoredProfileKey
} from "./capture-store";

const PROFILE_A = "00000000-0000-4000-8000-000000000001";
const PROFILE_B = "00000000-0000-4000-8000-000000000002";
const CAPTURE_ID = "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X" as EntityId<"cap">;

const request: CaptureCreateRequest = {
  clientCaptureId: CAPTURE_ID,
  rawContent: "buy oat milk",
  source: "web",
  clientCreatedAt: "2026-08-30T18:30:00.000Z",
  clientTimezone: "America/Los_Angeles",
  privacy: "ai_assisted",
  expansionDisabled: false
};

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

  deleteKey(profileId: string): Promise<void> {
    this.keys.delete(profileId);
    return Promise.resolve();
  }
}

describe("encrypted browser capture storage", () => {
  it("stores only ciphertext while restoring an isolated profile draft", async () => {
    const persistence = new MemoryPersistence();
    const store = createCaptureLocalStore(persistence, crypto);
    await store.saveDraft(PROFILE_A, {
      expansionDisabled: false,
      explicitDestinationNoteId: null,
      privacy: "ai_assisted",
      rawContent: "private draft words",
      updatedAt: "2026-08-30T18:29:00.000Z"
    });

    const persisted = [...persistence.records.values()][0];
    expect(JSON.stringify(persisted)).not.toContain("private draft words");
    expect(persisted).not.toHaveProperty("rawContent");
    expect(await store.loadDraft(PROFILE_A)).toMatchObject({ rawContent: "private draft words" });
    expect(await store.loadDraft(PROFILE_B)).toBeNull();
    expect(persistence.keys.get(PROFILE_A)?.key.extractable).toBe(false);
  });

  it("keeps one stable encrypted outbox item across crash-safe replay", async () => {
    const persistence = new MemoryPersistence();
    const store = createCaptureLocalStore(persistence, crypto);

    const first = await store.enqueueCapture(
      PROFILE_A,
      request,
      Date.parse(request.clientCreatedAt)
    );
    const replay = await store.enqueueCapture(
      PROFILE_A,
      request,
      Date.parse(request.clientCreatedAt)
    );
    expect(replay).toEqual(first);
    expect((await store.listOutbox(PROFILE_A)).map((item) => item.request)).toEqual([request]);
    expect(JSON.stringify([...persistence.records.values()])).not.toContain(request.rawContent);

    await expect(
      store.enqueueCapture(PROFILE_A, { ...request, rawContent: "different payload" }, Date.now())
    ).rejects.toMatchObject({ code: "capture_id_reused" });
  });

  it("recovers an interrupted send without changing its capture identity", async () => {
    const persistence = new MemoryPersistence();
    const store = createCaptureLocalStore(persistence, crypto);
    await store.enqueueCapture(PROFILE_A, request, 100);
    await store.updateOutbox(PROFILE_A, CAPTURE_ID, {
      attempts: 1,
      errorCode: null,
      nextAttemptAt: null,
      state: "sending",
      updatedAt: 110
    });

    await store.recoverInterrupted(PROFILE_A, 200);
    expect(await store.listOutbox(PROFILE_A)).toMatchObject([
      { request: { clientCaptureId: CAPTURE_ID }, state: "waiting", nextAttemptAt: 200 }
    ]);
  });

  it("supports manual retry, draft deletion, synced cleanup, and profile clearing", async () => {
    const persistence = new MemoryPersistence();
    const store = createCaptureLocalStore(persistence, crypto);
    await store.saveDraft(PROFILE_A, {
      expansionDisabled: true,
      explicitDestinationNoteId: null,
      privacy: "private_manual",
      rawContent: "draft",
      updatedAt: "2026-08-30T18:29:00.000Z"
    });
    await store.enqueueCapture(PROFILE_A, request, 100);
    await store.updateOutbox(PROFILE_A, CAPTURE_ID, {
      attempts: 5,
      errorCode: "provider_unavailable",
      nextAttemptAt: null,
      state: "permanent",
      updatedAt: 150
    });
    await store.manualRetry(PROFILE_A, CAPTURE_ID, 200);
    expect(await store.listOutbox(PROFILE_A)).toMatchObject([
      { attempts: 0, errorCode: null, nextAttemptAt: 200, state: "waiting" }
    ]);

    await store.deleteDraft(PROFILE_A);
    expect(await store.loadDraft(PROFILE_A)).toBeNull();
    await store.deleteOutbox(PROFILE_A, CAPTURE_ID);
    expect(await store.listOutbox(PROFILE_A)).toEqual([]);
    await store.clearProfile(PROFILE_A);
    expect(persistence.keys.has(PROFILE_A)).toBe(false);
  });

  it("refuses malformed, extractable, missing, or cross-profile key state", async () => {
    const extractable = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt"
    ]);
    const persistence = new MemoryPersistence();
    persistence.keys.set(PROFILE_A, {
      key: extractable,
      keyId: `web.${PROFILE_A}`,
      profileId: PROFILE_A
    });
    const store = createCaptureLocalStore(persistence, crypto);
    await expect(
      store.saveDraft(PROFILE_A, {
        expansionDisabled: false,
        explicitDestinationNoteId: null,
        privacy: "ai_assisted",
        rawContent: "cannot save",
        updatedAt: "2026-08-30T18:29:00.000Z"
      })
    ).rejects.toBeInstanceOf(CaptureLocalStoreError);

    const orphaned = new MemoryPersistence();
    orphaned.records.set(`${PROFILE_A}:draft:current`, {
      createdAt: 100,
      envelope: {} as ContentEnvelopeV1,
      kind: "draft",
      profileId: PROFILE_A,
      recordVersion: 1,
      resourceId: "current",
      storageKey: `${PROFILE_A}:draft:current`,
      updatedAt: 100
    });
    await expect(
      createCaptureLocalStore(orphaned, crypto).loadDraft(PROFILE_A)
    ).rejects.toMatchObject({
      code: "local_key_unavailable"
    });
  });
});
