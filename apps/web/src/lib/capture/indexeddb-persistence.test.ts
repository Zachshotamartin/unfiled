import { describe, expect, it } from "vitest";
import { sealUtf8 } from "@unfiled/content-crypto";

import type { StoredCaptureRecord, StoredProfileKey } from "./capture-store";
import { createIndexedDbCapturePersistence } from "./indexeddb-persistence";

interface MutableRequest<T> {
  error: DOMException | null;
  onerror: ((event: Event) => void) | null;
  onsuccess: ((event: Event) => void) | null;
  result: T;
}

interface MutableTransaction {
  error: DOMException | null;
  onabort: ((event: Event) => void) | null;
  oncomplete: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
}

function successfulRequest<T>(result: T, transaction: MutableTransaction): IDBRequest<T> {
  const request: MutableRequest<T> = {
    error: null,
    onerror: null,
    onsuccess: null,
    result
  };
  queueMicrotask(() => {
    request.onsuccess?.(new Event("success"));
    transaction.oncomplete?.(new Event("complete"));
  });
  return request as unknown as IDBRequest<T>;
}

function duplicateRequest(transaction: MutableTransaction): IDBRequest<IDBValidKey> {
  const request: MutableRequest<IDBValidKey> = {
    error: new DOMException("Duplicate", "ConstraintError"),
    onerror: null,
    onsuccess: null,
    result: ""
  };
  queueMicrotask(() => {
    const event = new Event("error", { cancelable: true });
    request.onerror?.(event);
    if (event.defaultPrevented) transaction.oncomplete?.(new Event("complete"));
    else transaction.onerror?.(event);
  });
  return request as unknown as IDBRequest<IDBValidKey>;
}

function createMemoryIndexedDb(): IDBFactory {
  const stores = new Map<string, Map<IDBValidKey, unknown>>();
  const keyPaths = new Map<string, string>();
  const database = {
    close: () => undefined,
    createObjectStore: (name: string, options?: IDBObjectStoreParameters) => {
      stores.set(name, new Map());
      if (typeof options?.keyPath === "string") keyPaths.set(name, options.keyPath);
      return {} as IDBObjectStore;
    },
    objectStoreNames: {
      contains: (name: string) => stores.has(name)
    },
    onversionchange: null as ((event: IDBVersionChangeEvent) => void) | null,
    transaction: (storeName: string) => {
      const transaction: MutableTransaction = {
        error: null,
        onabort: null,
        oncomplete: null,
        onerror: null
      };
      const store = stores.get(storeName);
      if (store === undefined) throw new DOMException("Missing store", "NotFoundError");
      const keyFor = (value: unknown): IDBValidKey => {
        const keyPath = keyPaths.get(storeName);
        if (keyPath === undefined || value === null || typeof value !== "object") {
          throw new DOMException("Missing key", "DataError");
        }
        const key = (value as Readonly<Record<string, unknown>>)[keyPath];
        if (typeof key !== "string") throw new DOMException("Invalid key", "DataError");
        return key;
      };
      const objectStore = {
        add: (value: unknown) => {
          const key = keyFor(value);
          if (store.has(key)) return duplicateRequest(transaction);
          store.set(key, value);
          return successfulRequest(key, transaction);
        },
        delete: (key: IDBValidKey) => {
          store.delete(key);
          return successfulRequest(undefined, transaction);
        },
        get: (key: IDBValidKey) => successfulRequest(store.get(key), transaction),
        getAll: () => successfulRequest([...store.values()], transaction),
        put: (value: unknown) => {
          const key = keyFor(value);
          store.set(key, value);
          return successfulRequest(key, transaction);
        }
      };
      return Object.assign(transaction, {
        objectStore: () => objectStore
      }) as unknown as IDBTransaction;
    }
  };
  const factory = {
    open: () => {
      const request = {
        error: null as DOMException | null,
        onblocked: null as ((event: Event) => void) | null,
        onerror: null as ((event: Event) => void) | null,
        onsuccess: null as ((event: Event) => void) | null,
        onupgradeneeded: null as ((event: IDBVersionChangeEvent) => void) | null,
        result: database
      };
      queueMicrotask(() => {
        request.onupgradeneeded?.(new Event("upgradeneeded") as IDBVersionChangeEvent);
        request.onsuccess?.(new Event("success"));
      });
      return request as unknown as IDBOpenDBRequest;
    }
  };
  return factory as unknown as IDBFactory;
}

describe("IndexedDB capture persistence", () => {
  it("structured-clones profile keys and encrypted records through separate stores", async () => {
    const persistence = createIndexedDbCapturePersistence(createMemoryIndexedDb());
    const key = await crypto.subtle.generateKey({ length: 256, name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt"
    ]);
    const storedKey: StoredProfileKey = { key, keyId: "web.profile-a", profileId: "profile-a" };
    expect(await persistence.addKey(storedKey)).toBe(true);
    expect(await persistence.addKey(storedKey)).toBe(false);
    expect(await persistence.getKey("profile-a")).toEqual(storedKey);

    const envelope = await sealUtf8(
      "private capture",
      {
        kind: "outbox",
        recordVersion: 1,
        resourceId: "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X",
        tenantId: "profile-a"
      },
      storedKey
    );
    const record = {
      attempts: 0,
      createdAt: 100,
      envelope,
      errorCode: null,
      kind: "outbox",
      nextAttemptAt: 100,
      profileId: "profile-a",
      recordVersion: 1,
      resourceId: "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      state: "waiting",
      storageKey: "profile-a:outbox:cap_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      updatedAt: 100
    } as const satisfies StoredCaptureRecord;
    expect(await persistence.addRecord(record)).toBe(true);
    expect(await persistence.addRecord(record)).toBe(false);
    expect(await persistence.getRecord(record.storageKey)).toEqual(record);
    expect(await persistence.listRecords()).toEqual([record]);

    await persistence.putRecord({ ...record, updatedAt: 200 });
    expect(await persistence.getRecord(record.storageKey)).toMatchObject({ updatedAt: 200 });

    await persistence.replaceRecords([record.storageKey], []);
    await persistence.deleteKey("profile-a");
    expect(await persistence.getRecord(record.storageKey)).toBeNull();
    expect(await persistence.getKey("profile-a")).toBeNull();
  });

  it("fails closed when IndexedDB is unavailable", async () => {
    const original = (globalThis as Readonly<{ indexedDB?: IDBFactory }>).indexedDB;
    expect(original).toBeUndefined();
    await expect(createIndexedDbCapturePersistence().listRecords()).rejects.toMatchObject({
      code: "local_record_invalid"
    });
  });
});
