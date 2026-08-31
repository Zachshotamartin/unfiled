import {
  CaptureLocalStoreError,
  type CapturePersistence,
  type StoredCaptureRecord,
  type StoredProfileKey
} from "./capture-store";

const DATABASE_NAME = "unfiled-browser-capture";
const DATABASE_VERSION = 1;
const KEY_STORE = "profile-keys";
const RECORD_STORE = "encrypted-records";

function unavailable(message: string): CaptureLocalStoreError {
  return new CaptureLocalStoreError("local_record_invalid", message);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? unavailable("Browser storage failed"));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? unavailable("Browser storage aborted"));
    transaction.onerror = () => reject(transaction.error ?? unavailable("Browser storage failed"));
  });
}

async function readValue<T>(
  database: IDBDatabase,
  storeName: string,
  key: IDBValidKey
): Promise<T | null> {
  const transaction = database.transaction(storeName, "readonly");
  const completion = transactionComplete(transaction);
  const value: unknown = await requestResult<unknown>(transaction.objectStore(storeName).get(key));
  await completion;
  return (value as T | undefined) ?? null;
}

async function writeValue(database: IDBDatabase, storeName: string, value: unknown): Promise<void> {
  const transaction = database.transaction(storeName, "readwrite");
  const completion = transactionComplete(transaction);
  await requestResult(transaction.objectStore(storeName).put(value));
  await completion;
}

async function deleteValue(
  database: IDBDatabase,
  storeName: string,
  key: IDBValidKey
): Promise<void> {
  const transaction = database.transaction(storeName, "readwrite");
  const completion = transactionComplete(transaction);
  await requestResult(transaction.objectStore(storeName).delete(key));
  await completion;
}

async function readAll<T>(database: IDBDatabase, storeName: string): Promise<readonly T[]> {
  const transaction = database.transaction(storeName, "readonly");
  const completion = transactionComplete(transaction);
  const values = await requestResult(transaction.objectStore(storeName).getAll());
  await completion;
  return values as T[];
}

function addValue(database: IDBDatabase, storeName: string, value: unknown): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    let added = false;
    transaction.oncomplete = () => resolve(added);
    transaction.onabort = () => reject(transaction.error ?? unavailable("Browser storage aborted"));
    transaction.onerror = () => reject(transaction.error ?? unavailable("Browser storage failed"));
    const request = transaction.objectStore(storeName).add(value);
    request.onsuccess = () => {
      added = true;
    };
    request.onerror = (event) => {
      if (request.error?.name !== "ConstraintError") {
        reject(request.error ?? unavailable("Browser storage failed"));
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
  });
}

async function replaceValues(
  database: IDBDatabase,
  storeName: string,
  deleteKeys: readonly IDBValidKey[],
  values: readonly unknown[]
): Promise<void> {
  const transaction = database.transaction(storeName, "readwrite");
  const completion = transactionComplete(transaction);
  const store = transaction.objectStore(storeName);
  await Promise.all([
    ...deleteKeys.map((key) => requestResult(store.delete(key))),
    ...values.map((value) => requestResult(store.put(value)))
  ]);
  await completion;
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(KEY_STORE)) {
        database.createObjectStore(KEY_STORE, { keyPath: "profileId" });
      }
      if (!database.objectStoreNames.contains(RECORD_STORE)) {
        database.createObjectStore(RECORD_STORE, { keyPath: "storageKey" });
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () =>
      reject(request.error ?? unavailable("Encrypted browser storage failed"));
    request.onblocked = () => reject(unavailable("Close other Unfiled tabs and try again"));
  });
}

export function createIndexedDbCapturePersistence(
  providedFactory?: IDBFactory
): CapturePersistence {
  let databasePromise: Promise<IDBDatabase> | undefined;
  const database = (): Promise<IDBDatabase> => {
    const factory =
      providedFactory ?? (globalThis as Readonly<{ indexedDB?: IDBFactory }>).indexedDB;
    if (factory === undefined) {
      return Promise.reject(unavailable("This browser does not support encrypted local storage"));
    }
    databasePromise ??= openDatabase(factory);
    return databasePromise;
  };

  return Object.freeze({
    async getKey(profileId: string) {
      return readValue<StoredProfileKey>(await database(), KEY_STORE, profileId);
    },
    async addKey(record: StoredProfileKey) {
      return addValue(await database(), KEY_STORE, record);
    },
    async addRecord(record: StoredCaptureRecord) {
      return addValue(await database(), RECORD_STORE, record);
    },
    async deleteKey(profileId: string) {
      await deleteValue(await database(), KEY_STORE, profileId);
    },
    async getRecord(storageKey: string) {
      return readValue<StoredCaptureRecord>(await database(), RECORD_STORE, storageKey);
    },
    async putRecord(record: StoredCaptureRecord) {
      await writeValue(await database(), RECORD_STORE, record);
    },
    async deleteRecord(storageKey: string) {
      await deleteValue(await database(), RECORD_STORE, storageKey);
    },
    async listRecords() {
      return readAll<StoredCaptureRecord>(await database(), RECORD_STORE);
    },
    async replaceRecords(
      deleteStorageKeys: readonly string[],
      records: readonly StoredCaptureRecord[]
    ) {
      await replaceValues(await database(), RECORD_STORE, deleteStorageKeys, records);
    }
  });
}
