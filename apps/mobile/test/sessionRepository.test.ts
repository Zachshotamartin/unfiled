import { describe, expect, it, vi } from "vitest";

const nativeMocks = vi.hoisted(() => ({
  deleteItemAsync: vi.fn<(key: string, options?: Record<string, unknown>) => Promise<void>>(),
  getItemAsync: vi.fn<(key: string, options?: Record<string, unknown>) => Promise<string | null>>(),
  openDatabaseAsync: vi.fn<(name: string) => Promise<AuthIdentityDatabase>>(),
  setItemAsync:
    vi.fn<(key: string, value: string, options?: Record<string, unknown>) => Promise<void>>()
}));

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
  deleteItemAsync: nativeMocks.deleteItemAsync,
  getItemAsync: nativeMocks.getItemAsync,
  setItemAsync: nativeMocks.setItemAsync
}));
vi.mock("expo-sqlite", () => ({ openDatabaseAsync: nativeMocks.openDatabaseAsync }));

import type { AuthIdentityDatabase, SecureSessionStorage } from "../src/auth/sessionRepository";
import {
  createSecureAuthSessionStore,
  secureAuthSessionStore
} from "../src/auth/sessionRepository";

const session = {
  accessToken: "access-secret",
  expiresAt: "2030-01-01T00:00:00.000Z",
  refreshToken: "refresh-secret",
  user: { email: "person@example.com", id: "a3e2aa89-f45d-45be-b2d6-56e43b599bff" }
};
const installationId = "01KTESTINSTALLATION000000000";

type IdentityRow = Record<string, string | number | null>;

class MemoryIdentityDatabase implements AuthIdentityDatabase {
  readonly events: string[];
  readonly statements: string[] = [];
  columns: string[];
  failRebuild: boolean;
  row: IdentityRow | null;

  constructor({
    columns,
    events = [],
    failRebuild = false,
    legacyRow
  }: {
    columns?: string[];
    events?: string[];
    failRebuild?: boolean;
    legacyRow?: IdentityRow;
  } = {}) {
    this.events = events;
    this.failRebuild = failRebuild;
    this.row = legacyRow ?? null;
    this.columns =
      columns ??
      (legacyRow
        ? [
            "singleton",
            "profile_id",
            "email",
            "access_token",
            "refresh_token",
            "expires_at",
            "last_profile_id",
            "last_profile_email"
          ]
        : []);
  }

  execAsync(source: string): Promise<void> {
    this.statements.push(source);
    if (source.includes("BEGIN IMMEDIATE") && this.failRebuild) {
      this.failRebuild = false;
      return Promise.reject(new Error("rebuild failed"));
    }
    if (source.includes("CREATE TABLE IF NOT EXISTS identity_state") && this.columns.length === 0) {
      this.columns = ["singleton", "installation_id", "last_profile_id", "last_profile_email"];
    }
    if (source.includes("ADD COLUMN installation_id")) {
      this.columns.push("installation_id");
      if (this.row) this.row.installation_id = null;
    }
    if (source.includes("ADD COLUMN last_profile_id")) this.columns.push("last_profile_id");
    if (source.includes("ADD COLUMN last_profile_email")) this.columns.push("last_profile_email");
    if (source.includes("ALTER TABLE identity_state_secure RENAME TO identity_state")) {
      this.events.push("db:scrub");
      this.columns = ["singleton", "installation_id", "last_profile_id", "last_profile_email"];
      this.row = this.row
        ? {
            installation_id: this.row.installation_id ?? null,
            last_profile_email: this.row.last_profile_email ?? null,
            last_profile_id: this.row.last_profile_id ?? null,
            singleton: 1
          }
        : null;
    }
    return Promise.resolve();
  }

  getAllAsync<T>(): Promise<T[]> {
    return Promise.resolve(this.columns.map((name) => ({ name }) as T));
  }

  getFirstAsync<T>(): Promise<T | null> {
    return Promise.resolve(this.row as T | null);
  }

  runAsync(source: string, ...params: (string | number | null)[]): Promise<unknown> {
    this.statements.push(source);
    if (source.includes("singleton, installation_id")) {
      this.row ??= { singleton: 1 };
      this.row.installation_id = params[0] ?? null;
    }
    if (source.includes("last_profile_id, last_profile_email")) {
      this.row ??= { singleton: 1 };
      const profileOffset = source.includes("installation_id, last_profile_id") ? 1 : 0;
      this.row.last_profile_id = params[profileOffset] ?? null;
      this.row.last_profile_email = params[profileOffset + 1] ?? null;
    }
    if (source.startsWith("UPDATE identity_state SET")) {
      this.events.push("db:null-legacy");
      for (const column of ["profile_id", "email", "access_token", "refresh_token", "expires_at"]) {
        if (this.row && column in this.row) this.row[column] = null;
      }
    }
    return Promise.resolve({});
  }
}

function memorySecureStore(
  initialValue: string | null = null,
  events: string[] = []
): SecureSessionStorage & { value: string | null } {
  return {
    value: initialValue,
    deleteItemAsync(): Promise<void> {
      events.push("secure:delete");
      this.value = null;
      return Promise.resolve();
    },
    getItemAsync(): Promise<string | null> {
      events.push("secure:get");
      return Promise.resolve(this.value);
    },
    setItemAsync(_key, value): Promise<void> {
      events.push("secure:set");
      this.value = value;
      return Promise.resolve();
    }
  };
}

function repository(database: MemoryIdentityDatabase, secureStore: SecureSessionStorage) {
  return createSecureAuthSessionStore({
    createInstallationId: () => installationId,
    openDatabase: () => Promise.resolve(database),
    secureStore,
    secureStoreOptions: { keychainService: "test.auth.session" }
  });
}

function legacyRow(overrides: Partial<IdentityRow> = {}): IdentityRow {
  return {
    access_token: session.accessToken,
    email: session.user.email,
    expires_at: session.expiresAt,
    last_profile_email: session.user.email,
    last_profile_id: session.user.id,
    profile_id: session.user.id,
    refresh_token: session.refreshToken,
    singleton: 1,
    ...overrides
  };
}

describe("secure mobile session repository", () => {
  it("uses the Expo SQLite and platform vault adapters with device-bound options", async () => {
    const database = new MemoryIdentityDatabase();
    let secureValue: string | null = null;
    nativeMocks.openDatabaseAsync.mockResolvedValue(database);
    nativeMocks.setItemAsync.mockImplementation((_key, value) => {
      secureValue = value;
      return Promise.resolve();
    });
    nativeMocks.getItemAsync.mockImplementation(() => Promise.resolve(secureValue));
    nativeMocks.deleteItemAsync.mockImplementation(() => {
      secureValue = null;
      return Promise.resolve();
    });

    await secureAuthSessionStore.saveSession(session);
    await expect(secureAuthSessionStore.load()).resolves.toMatchObject({ session });

    expect(nativeMocks.openDatabaseAsync.mock.calls).toEqual([["unfiled-identity.db"]]);
    const options = nativeMocks.setItemAsync.mock.calls[0]?.[2];
    expect(options).toMatchObject({
      keychainAccessible: 6,
      keychainService: "unfiled.auth.session.v1",
      requireAuthentication: false
    });
    expect(options).not.toHaveProperty("accessGroup");
  });

  it("stores the complete session in SecureStore and only profile hints in SQLite", async () => {
    const database = new MemoryIdentityDatabase();
    const secureStore = memorySecureStore();
    const store = repository(database, secureStore);

    await store.saveSession(session);

    expect(secureStore.value).not.toBeNull();
    expect(JSON.parse(secureStore.value ?? "null")).toEqual({
      installationId,
      session,
      version: 1
    });
    expect(database.columns).toEqual([
      "singleton",
      "installation_id",
      "last_profile_id",
      "last_profile_email"
    ]);
    expect(database.row).toEqual({
      installation_id: installationId,
      last_profile_email: session.user.email,
      last_profile_id: session.user.id,
      singleton: 1
    });
    expect(database.statements.join("\n")).not.toContain(session.accessToken);
    expect(database.statements.join("\n")).not.toContain(session.refreshToken);
    await expect(store.load()).resolves.toEqual({
      lastProfileEmail: session.user.email,
      lastProfileId: session.user.id,
      session
    });
  });

  it("migrates a valid legacy SQLite session before physically removing token columns", async () => {
    const events: string[] = [];
    const database = new MemoryIdentityDatabase({ events, legacyRow: legacyRow() });
    const secureStore = memorySecureStore(null, events);
    const store = repository(database, secureStore);

    await expect(store.load()).resolves.toEqual({
      lastProfileEmail: session.user.email,
      lastProfileId: session.user.id,
      session
    });

    expect(events.indexOf("secure:set")).toBeLessThan(events.indexOf("db:null-legacy"));
    expect(database.columns).toEqual([
      "singleton",
      "installation_id",
      "last_profile_id",
      "last_profile_email"
    ]);
    expect(database.row).not.toHaveProperty("access_token");
    expect(database.row).not.toHaveProperty("refresh_token");
    const scrubSql = database.statements.join("\n");
    expect(scrubSql).toContain("PRAGMA secure_delete = ON");
    expect(scrubSql).toContain("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(scrubSql).toContain("VACUUM");

    const rotated = { ...session, accessToken: "rotated-access" };
    await store.saveSession(rotated);
    await expect(store.load()).resolves.toMatchObject({ session: rotated });
    expect(database.statements.at(-1)).not.toContain("access_token");
  });

  it("rejects and scrubs an incomplete legacy token pair without manufacturing a session", async () => {
    const database = new MemoryIdentityDatabase({
      legacyRow: legacyRow({ refresh_token: null })
    });
    const secureStore = memorySecureStore();

    await expect(repository(database, secureStore).load()).resolves.toEqual({
      lastProfileEmail: session.user.email,
      lastProfileId: session.user.id,
      session: null
    });
    expect(secureStore.value).toBeNull();
    expect(database.columns).not.toContain("access_token");
    expect(database.columns).not.toContain("refresh_token");
  });

  it("deletes malformed SecureStore state and safely falls back to signed out", async () => {
    const events: string[] = [];
    const database = new MemoryIdentityDatabase();
    const secureStore = memorySecureStore('{"version":1,"session":{"accessToken":7}}', events);

    await expect(repository(database, secureStore).load()).resolves.toEqual({
      lastProfileEmail: null,
      lastProfileId: null,
      session: null
    });
    expect(events).toEqual(["secure:get", "secure:delete"]);
    expect(secureStore.value).toBeNull();
  });

  it("rejects corrupt JSON and an unsupported secure envelope version", async () => {
    const database = new MemoryIdentityDatabase();
    const secureStore = memorySecureStore("not-json");
    const store = repository(database, secureStore);
    await expect(store.load()).resolves.toMatchObject({ session: null });

    secureStore.value = JSON.stringify({ installationId, session, version: 99 });
    await expect(store.load()).resolves.toMatchObject({ session: null });
    expect(secureStore.value).toBeNull();
  });

  it("upgrades the oldest identity schema and recovers its current-profile hint", async () => {
    const database = new MemoryIdentityDatabase({
      columns: ["singleton", "profile_id", "email", "access_token", "refresh_token", "expires_at"],
      legacyRow: legacyRow({ last_profile_email: null, last_profile_id: null })
    });

    await expect(repository(database, memorySecureStore()).load()).resolves.toEqual({
      lastProfileEmail: session.user.email,
      lastProfileId: session.user.id,
      session
    });
    const statements = database.statements.join("\n");
    expect(statements).toContain("ADD COLUMN installation_id");
    expect(statements).toContain("ADD COLUMN last_profile_id");
    expect(statements).toContain("ADD COLUMN last_profile_email");
  });

  it("rolls back a failed physical schema rebuild while preserving the verified vault session", async () => {
    const database = new MemoryIdentityDatabase({
      failRebuild: true,
      legacyRow: legacyRow()
    });
    const secureStore = memorySecureStore();

    await expect(repository(database, secureStore).load()).rejects.toThrow("rebuild failed");
    expect(secureStore.value).not.toBeNull();
    expect(database.statements).toContain("ROLLBACK;");
  });

  it("treats the secure session as authoritative when legacy metadata is inconsistent", async () => {
    const secureStore = memorySecureStore(JSON.stringify({ installationId, session, version: 1 }));
    const database = new MemoryIdentityDatabase({
      legacyRow: legacyRow({
        last_profile_email: "someone-else@example.com",
        last_profile_id: "4a2bc4df-571f-4211-9154-b07fe01ca228"
      })
    });

    await expect(repository(database, secureStore).load()).resolves.toEqual({
      lastProfileEmail: session.user.email,
      lastProfileId: session.user.id,
      session
    });
    expect(database.row).toMatchObject({
      last_profile_email: session.user.email,
      last_profile_id: session.user.id
    });
  });

  it("clears secure credentials while preserving non-secret last-profile recovery hints", async () => {
    const database = new MemoryIdentityDatabase();
    const secureStore = memorySecureStore();
    const store = repository(database, secureStore);
    await store.saveSession(session);

    await store.clearSession();

    expect(secureStore.value).toBeNull();
    await expect(store.load()).resolves.toEqual({
      lastProfileEmail: session.user.email,
      lastProfileId: session.user.id,
      session: null
    });
  });

  it("retains a legacy session for a later migration retry when SecureStore is unavailable", async () => {
    const database = new MemoryIdentityDatabase({ legacyRow: legacyRow() });
    const secureStore = memorySecureStore();
    secureStore.setItemAsync = vi.fn(() => Promise.reject(new Error("keychain unavailable")));

    await expect(repository(database, secureStore).load()).rejects.toThrow("keychain unavailable");
    expect(database.columns).toContain("access_token");
    expect(database.columns).toContain("refresh_token");
    expect(database.row?.access_token).toBe(session.accessToken);
    expect(database.row?.refresh_token).toBe(session.refreshToken);
  });

  it("rejects a Keychain session left behind by a previous app installation", async () => {
    const events: string[] = [];
    const secureStore = memorySecureStore(
      JSON.stringify({ installationId: "previous-install", session, version: 1 }),
      events
    );

    await expect(repository(new MemoryIdentityDatabase(), secureStore).load()).resolves.toEqual({
      lastProfileEmail: null,
      lastProfileId: null,
      session: null
    });
    expect(events).toContain("secure:delete");
  });

  it("removes an unverifiable SecureStore write instead of rehydrating it later", async () => {
    const events: string[] = [];
    const secureStore = memorySecureStore(null, events);
    secureStore.getItemAsync = vi.fn(() => Promise.resolve("different-value"));

    await expect(
      repository(new MemoryIdentityDatabase(), secureStore).saveSession(session)
    ).rejects.toThrow("verification failed");
    expect(events).toContain("secure:delete");
    expect(secureStore.value).toBeNull();
  });

  it("rejects malformed sessions before writing either storage boundary", async () => {
    const database = new MemoryIdentityDatabase();
    const secureStore = memorySecureStore();

    await expect(
      repository(database, secureStore).saveSession({ ...session, refreshToken: "" })
    ).rejects.toThrow();
    expect(secureStore.value).toBeNull();
    expect(database.row).toBeNull();
  });
});
