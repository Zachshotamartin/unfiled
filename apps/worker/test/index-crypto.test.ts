import { importKeyEncryptionKey, sealBytes } from "@unfiled/content-crypto";
import type { ManagedKeyRecordV1 } from "@unfiled/key-management";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  custodian: {
    withGeneratedIntermediateKey: vi.fn(),
    withUnwrappedIntermediateKey: vi.fn()
  },
  custodianForAuthority: vi.fn()
}));

vi.mock("../src/key-management-adapter", async () => {
  const { parseManagedKeyRecordV1 } = await import("@unfiled/key-management");
  return {
    custodianForAiAssistedAuthority: mocks.custodianForAuthority,
    managedKeyRecordParserForAiAssistedAuthority: () => parseManagedKeyRecordV1
  };
});

import { createManagedIndexCryptoFactory, type IndexCryptoJob } from "../src/index-crypto";

const OWNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ULID = "01J6M9Q7G4BMKB33GSG3NJ6D1X";
const NOTE_ID = `note_${ULID}`;
const INDEX_ID = `irw_${ULID}`;
const SOURCE_KEY_ID = "ai.object.source.v1";
const TARGET_KEY_ID = "ai.object.target.v2";
const RESERVATION_ID = "22222222-2222-4222-8222-222222222222";
const RAW_KEY = new Uint8Array(32).fill(17);

function key(
  keyId: string,
  keyVersion: number,
  overrides: Partial<ManagedKeyRecordV1> = {}
): ManagedKeyRecordV1 {
  return {
    activatedAt: "2026-08-30T12:00:00.000Z",
    createdAt: "2026-08-30T12:00:00.000Z",
    encryptedKeyMaterial: "AQIDBA",
    keyClass: "ai_assisted",
    keyId,
    keyVersion,
    ownerId: OWNER_ID,
    purpose: "object_wrap",
    retiredAt: null,
    revokedAt: null,
    rootKeyArn: "arn:aws:kms:us-west-2:123456789012:key/11111111-1111-4111-8111-111111111111",
    rotation: {
      lastRootRewrappedAt: null,
      predecessorKeyId: null,
      previousRootKeyArn: null,
      rootRewrapCount: 0
    },
    schemaVersion: 1,
    status: "active",
    wrapOperationLimit: 16_777_216,
    wrapOperations: 2,
    ...overrides
  };
}

async function validJob(overrides: Partial<IndexCryptoJob> = {}): Promise<IndexCryptoJob> {
  const sourceKey = key(SOURCE_KEY_ID, 1);
  const targetKey = key(TARGET_KEY_ID, 2);
  const sourceKek = await importKeyEncryptionKey(SOURCE_KEY_ID, RAW_KEY);
  const payload = new TextEncoder().encode(
    JSON.stringify({
      bodyMarkdown: "# Groceries\nMilk",
      schemaVersion: 1,
      structuredData: { schemaVersion: 1 },
      title: "Shopping"
    })
  );
  const envelope = await sealBytes(
    payload,
    {
      kind: "note_content",
      recordVersion: 2,
      resourceId: NOTE_ID,
      tenantId: OWNER_ID
    },
    sourceKek
  );
  payload.fill(0);
  return {
    indexResourceId: INDEX_ID,
    noteId: NOTE_ID,
    reservation: {
      consumed: false,
      keyClass: "ai_assisted",
      keyId: TARGET_KEY_ID,
      keyPurpose: "object_wrap",
      keyVersion: 2,
      operationCount: 1,
      reservationId: RESERVATION_ID
    },
    sourceKey,
    sourceNoteCipher: {
      envelope,
      keyClass: "ai_assisted",
      keyId: SOURCE_KEY_ID,
      keyPurpose: "object_wrap",
      keyVersion: 1
    },
    targetKey,
    targetRevision: 2,
    userId: OWNER_ID,
    ...overrides
  };
}

describe("claim-local managed index crypto", () => {
  beforeEach(() => {
    mocks.custodianForAuthority.mockReset().mockReturnValue(mocks.custodian);
    mocks.custodian.withUnwrappedIntermediateKey
      .mockReset()
      .mockImplementation(
        (
          record: ManagedKeyRecordV1,
          use: (bytes: Uint8Array, parsed: ManagedKeyRecordV1) => unknown
        ) => Promise.resolve().then(() => use(Uint8Array.from(RAW_KEY), record))
      );
  });

  it("opens only the claimed note and seals with the exact one-use reservation", async () => {
    const job = await validJob();
    const session = createManagedIndexCryptoFactory({} as never).forJob(job);

    await expect(session.openNote()).resolves.toMatchObject({
      bodyMarkdown: "# Groceries\nMilk",
      title: "Shopping"
    });
    const sealed = await session.sealIndex(
      { schemaVersion: 1, value: "ciphertext only" },
      {
        parse(value: unknown) {
          return value as { schemaVersion: number; value: string };
        }
      }
    );

    expect(sealed).toMatchObject({
      keyClass: "ai_assisted",
      keyId: TARGET_KEY_ID,
      keyVersion: 2,
      ownerId: OWNER_ID,
      reservationId: RESERVATION_ID,
      resourceId: INDEX_ID
    });
    await expect(
      session.sealIndex({ schemaVersion: 1 }, { parse: (value) => value })
    ).rejects.toMatchObject({ code: "reservation_invalid" });
    expect(mocks.custodian.withUnwrappedIntermediateKey).toHaveBeenCalledTimes(2);
  });

  it("supports one shared active source/target key without widening the store", async () => {
    const base = await validJob();
    const shared = key(SOURCE_KEY_ID, 1);
    const session = createManagedIndexCryptoFactory({} as never).forJob({
      ...base,
      reservation: { ...base.reservation, keyId: SOURCE_KEY_ID, keyVersion: 1 },
      sourceKey: shared,
      targetKey: shared
    });
    await expect(session.openNote()).resolves.toMatchObject({ title: "Shopping" });
  });

  it("rejects every cross-bound or non-AI claim before asking the custodian", async () => {
    const base = await validJob();
    const invalid: IndexCryptoJob[] = [
      { ...base, sourceNoteCipher: { ...base.sourceNoteCipher, keyId: "wrong" } },
      {
        ...base,
        sourceKey: { ...base.sourceKey, ownerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }
      },
      {
        ...base,
        sourceKey: { ...base.sourceKey, status: "revoked", revokedAt: "2026-08-31T00:00:00.000Z" }
      },
      {
        ...base,
        targetKey: { ...base.targetKey, status: "retired", retiredAt: "2026-08-31T00:00:00.000Z" }
      },
      { ...base, reservation: { ...base.reservation, keyId: "wrong" } },
      { ...base, reservation: { ...base.reservation, consumed: true as false } }
    ];
    const factory = createManagedIndexCryptoFactory({} as never);
    for (const candidate of invalid) expect(() => factory.forJob(candidate)).toThrow("binding");
    expect(mocks.custodian.withUnwrappedIntermediateKey).not.toHaveBeenCalled();
  });

  it("rejects owner-invalid access and missing claim-local keys without a fallback", async () => {
    const base = await validJob();
    expect(() =>
      createManagedIndexCryptoFactory({} as never).forJob({ ...base, userId: "not-a-uuid" })
    ).toThrow();

    const session = createManagedIndexCryptoFactory({} as never).forJob(base);
    mocks.custodian.withUnwrappedIntermediateKey.mockRejectedValueOnce(
      new Error("kms unavailable")
    );
    await expect(session.openNote()).rejects.toMatchObject({ code: "key_unavailable" });
  });
});
