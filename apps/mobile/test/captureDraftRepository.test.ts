import type * as SQLite from "expo-sqlite";
import { describe, expect, it, vi } from "vitest";

vi.mock("expo-crypto", () => ({ getRandomBytesAsync: vi.fn() }));
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn()
}));
vi.mock("expo-sqlite", () => ({
  deleteDatabaseAsync: vi.fn(),
  openDatabaseAsync: vi.fn()
}));

import {
  assertLegacyDraftMigration,
  assertLegacyOutboxMigration,
  beginCaptureDeleteIntentInDatabase,
  captureActionIntentSucceededInDatabase,
  commitCaptureToOutboxInDatabase,
  completeCaptureDeletionInDatabase,
  getOrCreateCaptureActionIntentInDatabase,
  initializeCaptureDatabase,
  markCaptureActionIntentSucceededInDatabase,
  recoverCaptureOutboxInDatabase,
  resumeCaptureOutboxAfterSignInInDatabase,
  type LegacyDraftMigrationSource,
  type LegacyDraftMigrationTarget,
  type LegacyOutboxMigrationSource,
  type LegacyOutboxMigrationTarget
} from "../src/features/capture/captureDraftRepository";

const PROFILE_ID = "00000000-0000-4000-8000-000000000001";
const CAPTURE_ID = "cap_01J6M9Q7R5K4N3P2T1V0WXYZAB" as const;
const ACTION_SIGNATURE = `delete:${CAPTURE_ID}:source:`;

interface MemoryOutboxRow {
  lastErrorCode: string | null;
  localDeletePending: boolean;
  profileId: string;
  rawContent: string;
  source: string;
  state: string;
}

interface MemoryIntentRow {
  action_signature: string;
  action_state: "pending" | "succeeded";
  action_type: "delete" | "retry" | "undo";
  idempotency_key: string;
  profileId: string;
  request_json: string;
  target_id: string;
}

class MemoryCaptureDatabase {
  readonly drafts = new Set<string>();
  readonly events: string[] = [];
  readonly intents = new Map<string, MemoryIntentRow>();
  readonly outbox = new Map<string, MemoryOutboxRow>();
  failWhenSqlIncludes: string | null = null;
  private transactionDepth = 0;

  private intentKey(profileId: string, actionSignature: string): string {
    return `${profileId}:${actionSignature}`;
  }

  private snapshot(): Readonly<{
    drafts: Set<string>;
    intents: Map<string, MemoryIntentRow>;
    outbox: Map<string, MemoryOutboxRow>;
  }> {
    return {
      drafts: new Set(this.drafts),
      intents: new Map([...this.intents].map(([key, row]) => [key, { ...row }] as const)),
      outbox: new Map([...this.outbox].map(([key, row]) => [key, { ...row }] as const))
    };
  }

  private restore(snapshot: ReturnType<MemoryCaptureDatabase["snapshot"]>): void {
    this.drafts.clear();
    snapshot.drafts.forEach((value) => this.drafts.add(value));
    this.intents.clear();
    snapshot.intents.forEach((value, key) => this.intents.set(key, value));
    this.outbox.clear();
    snapshot.outbox.forEach((value, key) => this.outbox.set(key, value));
  }

  async withExclusiveTransactionAsync(
    task: (transaction: SQLite.SQLiteDatabase) => Promise<void>
  ): Promise<void> {
    const snapshot = this.snapshot();
    this.transactionDepth += 1;
    this.events.push("transaction:begin");
    try {
      await task(this.asSqlite());
      this.events.push("transaction:commit");
    } catch (error) {
      this.restore(snapshot);
      this.events.push("transaction:rollback");
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  getFirstAsync<T>(source: string, ...params: (string | number | null)[]): Promise<T | null> {
    this.events.push(`query:${this.transactionDepth}:${source.trim().split("\n")[0]}`);
    if (source.includes("FROM capture_action_intents")) {
      const row = this.intents.get(this.intentKey(String(params[0]), String(params[1]))) ?? null;
      if (source.includes("SELECT 1 AS succeeded")) {
        return Promise.resolve(
          (row?.action_state === "succeeded" ? { succeeded: 1 } : null) as T | null
        );
      }
      return Promise.resolve(row as T | null);
    }
    return Promise.resolve(null);
  }

  runAsync(
    source: string,
    ...params: (string | number | null)[]
  ): Promise<Readonly<Record<string, never>>> {
    const summary = source.trim().split("\n")[0] ?? "";
    this.events.push(`write:${this.transactionDepth}:${summary}`);
    if (this.failWhenSqlIncludes !== null && source.includes(this.failWhenSqlIncludes)) {
      throw new Error("simulated storage failure");
    }
    if (source.includes("INSERT INTO capture_outbox")) {
      this.outbox.set(String(params[0]), {
        lastErrorCode: null,
        localDeletePending: false,
        profileId: String(params[1]),
        rawContent: String(params[2]),
        source: String(params[3]),
        state: String(params[10])
      });
    } else if (source.includes("INSERT INTO capture_action_intents")) {
      const row: MemoryIntentRow = {
        action_signature: String(params[1]),
        action_state: "pending",
        action_type: String(params[2]) as MemoryIntentRow["action_type"],
        idempotency_key: String(params[4]),
        profileId: String(params[0]),
        request_json: String(params[5]),
        target_id: String(params[3])
      };
      this.intents.set(this.intentKey(row.profileId, row.action_signature), row);
    } else if (source.includes("DELETE FROM capture_drafts")) {
      this.drafts.delete(`${String(params[0])}:${String(params[1])}`);
    } else if (source.includes("DELETE FROM capture_outbox")) {
      const captureId = String(params[1]);
      const row = this.outbox.get(captureId);
      if (row?.profileId === params[0]) this.outbox.delete(captureId);
    } else if (source.includes("DELETE FROM capture_action_intents")) {
      this.intents.delete(this.intentKey(String(params[0]), String(params[1])));
    } else if (source.includes("SET action_state = 'succeeded'")) {
      const row = this.intents.get(this.intentKey(String(params[1]), String(params[2])));
      if (row !== undefined) row.action_state = "succeeded";
    } else if (source.includes("SET local_delete_pending = 1")) {
      const row = this.outbox.get(String(params[1]));
      if (row !== undefined && row.profileId === params[0]) row.localDeletePending = true;
    } else if (source.includes("sync_state = 'syncing'")) {
      for (const row of this.outbox.values()) {
        if (row.profileId === params[0] && row.state === "syncing") row.state = "queued";
      }
    } else if (source.includes("sync_state = 'waiting_for_sign_in'")) {
      for (const row of this.outbox.values()) {
        if (row.profileId === params[0] && row.state === "waiting_for_sign_in") {
          row.lastErrorCode = null;
          row.state = "queued";
        }
      }
    }
    return Promise.resolve({});
  }

  asSqlite(): SQLite.SQLiteDatabase {
    return this as unknown as SQLite.SQLiteDatabase;
  }
}

function committedInput() {
  return {
    preferences: {
      expansionDisabled: false,
      explicitDestinationNoteId: null,
      privacy: "ai_assisted" as const
    },
    profileId: PROFILE_ID,
    rawContent: "  Keep the exact capture whitespace.  ",
    sessionAvailable: false,
    source: "mobile" as const
  };
}

function deterministicCommitContext() {
  return {
    createCaptureId: () => CAPTURE_ID,
    now: () => "2026-08-30T18:30:00.000Z",
    timezone: () => "America/Los_Angeles"
  };
}

describe("encrypted capture repository seams", () => {
  it("sets and verifies the SQLCipher key before any schema query", async () => {
    const events: string[] = [];
    const database = { closeAsync: vi.fn(() => Promise.resolve()) };

    await expect(
      initializeCaptureDatabase({
        configure: () => {
          events.push("query:schema");
          return Promise.resolve();
        },
        loadKey: () => {
          events.push("vault:key");
          return Promise.resolve("protected-key");
        },
        open: () => {
          events.push("database:open");
          return Promise.resolve(database);
        },
        readCipherVersion: () => {
          events.push("query:cipher-version");
          return Promise.resolve("4.6.1");
        },
        setKey: (_database, key) => {
          events.push(`database:key:${key}`);
          return Promise.resolve();
        }
      })
    ).resolves.toBe(database);

    expect(events).toEqual([
      "vault:key",
      "database:open",
      "database:key:protected-key",
      "query:cipher-version",
      "query:schema"
    ]);
    expect(database.closeAsync).not.toHaveBeenCalled();
  });

  it("fails closed and closes the handle when SQLCipher is unavailable", async () => {
    const database = { closeAsync: vi.fn(() => Promise.resolve()) };
    const configure = vi.fn(() => Promise.resolve());

    await expect(
      initializeCaptureDatabase({
        configure,
        loadKey: () => Promise.resolve("protected-key"),
        open: () => Promise.resolve(database),
        readCipherVersion: () => Promise.resolve(null),
        setKey: () => Promise.resolve()
      })
    ).rejects.toThrow("Encrypted capture storage is unavailable");

    expect(configure).not.toHaveBeenCalled();
    expect(database.closeAsync).toHaveBeenCalledOnce();
  });

  it("atomically moves an exact draft into the durable outbox and rolls back on interruption", async () => {
    const database = new MemoryCaptureDatabase();
    database.drafts.add(`${PROFILE_ID}:mobile`);

    const capture = await commitCaptureToOutboxInDatabase(
      database.asSqlite(),
      committedInput(),
      deterministicCommitContext()
    );

    expect(capture.rawContent).toBe("  Keep the exact capture whitespace.  ");
    expect(database.drafts).not.toContain(`${PROFILE_ID}:mobile`);
    expect(database.outbox.get(CAPTURE_ID)).toMatchObject({
      rawContent: capture.rawContent,
      state: "waiting_for_sign_in"
    });
    expect(database.events.filter((event) => event.startsWith("write:"))).toEqual([
      "write:1:INSERT INTO capture_outbox (",
      "write:1:DELETE FROM capture_drafts WHERE profile_id = ? AND source = ?"
    ]);

    const interrupted = new MemoryCaptureDatabase();
    interrupted.drafts.add(`${PROFILE_ID}:mobile`);
    interrupted.failWhenSqlIncludes = "DELETE FROM capture_drafts";
    await expect(
      commitCaptureToOutboxInDatabase(
        interrupted.asSqlite(),
        committedInput(),
        deterministicCommitContext()
      )
    ).rejects.toThrow("simulated storage failure");
    expect(interrupted.outbox.size).toBe(0);
    expect(interrupted.drafts).toContain(`${PROFILE_ID}:mobile`);
    expect(interrupted.events.at(-1)).toBe("transaction:rollback");
  });

  it("recovers an interrupted sync lease and resumes only the signed-in owner's waiting rows", async () => {
    const database = new MemoryCaptureDatabase();
    database.outbox.set(CAPTURE_ID, {
      lastErrorCode: "offline",
      localDeletePending: false,
      profileId: PROFILE_ID,
      rawContent: "owner capture",
      source: "mobile",
      state: "syncing"
    });
    database.outbox.set("cap_other", {
      lastErrorCode: "unauthorized",
      localDeletePending: false,
      profileId: "00000000-0000-4000-8000-000000000002",
      rawContent: "other capture",
      source: "mobile",
      state: "waiting_for_sign_in"
    });

    await recoverCaptureOutboxInDatabase(database.asSqlite(), PROFILE_ID);
    expect(database.outbox.get(CAPTURE_ID)?.state).toBe("queued");
    expect(database.outbox.get("cap_other")?.state).toBe("waiting_for_sign_in");

    const ownerCapture = database.outbox.get(CAPTURE_ID);
    if (ownerCapture === undefined) throw new Error("owner capture missing from test database");
    ownerCapture.state = "waiting_for_sign_in";
    ownerCapture.lastErrorCode = "unauthorized";
    await resumeCaptureOutboxAfterSignInInDatabase(database.asSqlite(), PROFILE_ID);
    expect(database.outbox.get(CAPTURE_ID)).toMatchObject({
      lastErrorCode: null,
      state: "queued"
    });
    expect(database.outbox.get("cap_other")?.state).toBe("waiting_for_sign_in");
  });

  it("persists retry action keys across repository reconstruction", async () => {
    const database = new MemoryCaptureDatabase();
    const input = {
      actionSignature: `retry:${CAPTURE_ID}:2026-08-30T18:30:00.000Z`,
      actionType: "retry" as const,
      requestForKey: (idempotencyKey: string) => ({ idempotencyKey }),
      targetId: CAPTURE_ID
    };

    const created = await getOrCreateCaptureActionIntentInDatabase(
      database.asSqlite(),
      PROFILE_ID,
      input,
      () => "01J6M9Q7R5K4N3P2T1V0WXYZAB"
    );
    const restarted = await getOrCreateCaptureActionIntentInDatabase(
      database.asSqlite(),
      PROFILE_ID,
      input,
      () => {
        throw new Error("a restart must not mint another key");
      }
    );

    expect(restarted).toEqual(created);
    expect(JSON.parse(restarted.requestJson)).toEqual({
      idempotencyKey: created.idempotencyKey
    });
    expect(database.intents.size).toBe(1);
  });

  it("persists an undo key and its consumed state so a restart cannot offer it twice", async () => {
    const database = new MemoryCaptureDatabase();
    const actionSignature = "undo:mut_01J6M9Q7R5K4N3P2T1V0WXYZAB:7";
    const input = {
      actionSignature,
      actionType: "undo" as const,
      requestForKey: (idempotencyKey: string) => ({ expectedRevision: 7, idempotencyKey }),
      targetId: "mut_01J6M9Q7R5K4N3P2T1V0WXYZAB"
    };

    const created = await getOrCreateCaptureActionIntentInDatabase(
      database.asSqlite(),
      PROFILE_ID,
      input,
      () => "01J6M9Q7R5K4N3P2T1V0WXYZAB"
    );
    await markCaptureActionIntentSucceededInDatabase(
      database.asSqlite(),
      PROFILE_ID,
      actionSignature,
      "2026-08-30T18:31:00.000Z"
    );

    await expect(
      captureActionIntentSucceededInDatabase(database.asSqlite(), PROFILE_ID, actionSignature)
    ).resolves.toBe(true);
    const restarted = await getOrCreateCaptureActionIntentInDatabase(
      database.asSqlite(),
      PROFILE_ID,
      input,
      () => {
        throw new Error("a consumed undo must not mint another key");
      }
    );
    expect(restarted).toMatchObject({
      idempotencyKey: created.idempotencyKey,
      state: "succeeded"
    });
  });

  it("atomically tombstones deletion, reuses its key after restart, and removes all local recovery state", async () => {
    const database = new MemoryCaptureDatabase();
    database.outbox.set(CAPTURE_ID, {
      lastErrorCode: null,
      localDeletePending: false,
      profileId: PROFILE_ID,
      rawContent: "encrypted source",
      source: "mobile",
      state: "synced"
    });
    const request = { expectedNoteRevisions: [], removeInsertedContent: false };

    const started = await beginCaptureDeleteIntentInDatabase(
      database.asSqlite(),
      PROFILE_ID,
      CAPTURE_ID,
      request,
      () => "01J6M9Q7R5K4N3P2T1V0WXYZAB"
    );
    expect(database.outbox.get(CAPTURE_ID)?.localDeletePending).toBe(true);
    expect(database.intents.size).toBe(1);

    const restarted = await beginCaptureDeleteIntentInDatabase(
      database.asSqlite(),
      PROFILE_ID,
      CAPTURE_ID,
      request,
      () => {
        throw new Error("a restart must reuse the delete key");
      }
    );
    expect(restarted.request).toEqual(started.request);

    await completeCaptureDeletionInDatabase(
      database.asSqlite(),
      PROFILE_ID,
      ACTION_SIGNATURE,
      CAPTURE_ID
    );
    expect(database.outbox.has(CAPTURE_ID)).toBe(false);
    expect(database.intents.size).toBe(0);
  });

  it("rolls back local deletion if either encrypted row cannot be removed", async () => {
    const database = new MemoryCaptureDatabase();
    database.outbox.set(CAPTURE_ID, {
      lastErrorCode: null,
      localDeletePending: true,
      profileId: PROFILE_ID,
      rawContent: "encrypted source",
      source: "mobile",
      state: "synced"
    });
    database.intents.set(`${PROFILE_ID}:${ACTION_SIGNATURE}`, {
      action_signature: ACTION_SIGNATURE,
      action_state: "pending",
      action_type: "delete",
      idempotency_key: "mobile-delete:01J6M9Q7R5K4N3P2T1V0WXYZAB",
      profileId: PROFILE_ID,
      request_json: "{}",
      target_id: CAPTURE_ID
    });
    database.failWhenSqlIncludes = "DELETE FROM capture_action_intents";

    await expect(
      completeCaptureDeletionInDatabase(
        database.asSqlite(),
        PROFILE_ID,
        ACTION_SIGNATURE,
        CAPTURE_ID
      )
    ).rejects.toThrow("simulated storage failure");
    expect(database.outbox.has(CAPTURE_ID)).toBe(true);
    expect(database.intents.has(`${PROFILE_ID}:${ACTION_SIGNATURE}`)).toBe(true);
  });
});

describe("legacy plaintext migration verification", () => {
  const draftSource: LegacyDraftMigrationSource = {
    body: "exact legacy draft",
    profile_id: PROFILE_ID,
    source: "mobile",
    updated_at: "2026-08-30T18:30:00.000Z"
  };
  const draftTarget: LegacyDraftMigrationTarget = {
    body: draftSource.body,
    expansion_disabled: 0,
    explicit_destination_note_id: null,
    privacy: "ai_assisted",
    profile_id: PROFILE_ID,
    source: "mobile",
    updated_at: draftSource.updated_at
  };
  const outboxSource: LegacyOutboxMigrationSource = {
    attempt_count: 3,
    client_capture_id: CAPTURE_ID,
    client_created_at: "2026-08-30T18:30:00.000Z",
    last_error_code: "offline",
    profile_id: PROFILE_ID,
    raw_content: "exact legacy capture",
    source: "mobile",
    sync_state: "failed"
  };
  const outboxTarget: LegacyOutboxMigrationTarget = {
    attempt_count: 3,
    client_capture_id: CAPTURE_ID,
    client_created_at: outboxSource.client_created_at,
    client_timezone: "UTC",
    device_id: null,
    expansion_disabled: 0,
    explicit_destination_note_id: null,
    last_error_code: "offline",
    local_delete_pending: 0,
    next_attempt_at: null,
    privacy: "ai_assisted",
    profile_id: PROFILE_ID,
    raw_content: outboxSource.raw_content,
    server_acknowledged_at: null,
    server_capture_id: null,
    server_job_id: null,
    source: "mobile",
    sync_state: "permanent_failure"
  };

  it("accepts only a field-for-field encrypted copy with explicit safe defaults", () => {
    expect(() => assertLegacyDraftMigration(draftSource, draftTarget)).not.toThrow();
    expect(() => assertLegacyOutboxMigration(outboxSource, outboxTarget)).not.toThrow();
  });

  it("fails verification before plaintext cleanup when any copied content differs", () => {
    expect(() =>
      assertLegacyDraftMigration(draftSource, { ...draftTarget, body: "different" })
    ).toThrow("Encrypted draft migration verification failed");
    expect(() =>
      assertLegacyOutboxMigration(outboxSource, {
        ...outboxTarget,
        raw_content: "different"
      })
    ).toThrow("Encrypted outbox migration verification failed");
    expect(() => assertLegacyOutboxMigration(outboxSource, null)).toThrow(
      "Encrypted outbox migration verification failed"
    );
  });
});
