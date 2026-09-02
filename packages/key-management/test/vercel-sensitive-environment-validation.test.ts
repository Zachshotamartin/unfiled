import { describe, expect, it } from "vitest";

import {
  KeyManagementError,
  KeyManagementErrorCode,
  assertVercelSensitiveEnvironmentRootKeyId,
  parseAnyManagedKeyRecord,
  parseManagedKeyRecord,
  parseManagedKeyRecordV1,
  parseManagedKeyRecordV2,
  parseVercelSensitiveEnvironmentRetiredRootKeySet,
  parseVercelSensitiveEnvironmentRootKeySet,
  parseVercelSensitiveEnvironmentWorkloadRootKeySet
} from "../src/index";
import {
  CREATED_AT,
  REWRAPPED_AT,
  ROOTS,
  VERCEL_RETIRED_AI_OBJECT_ROOT,
  VERCEL_ROOTS,
  environmentEnvelope,
  managedRecord,
  managedRecordV2
} from "./fixtures";

const PREVIEW_ROOT =
  "urn:unfiled:key-root:vercel-sensitive-env-v1:preview:66666666-6666-4666-8666-666666666666";

function expectCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof KeyManagementError && error.code === code;
}

function expectFailure(action: () => unknown, code: string): void {
  let failure: unknown;
  try {
    action();
  } catch (error: unknown) {
    failure = error;
  }
  expect(failure).toSatisfy(expectCode(code));
}

describe("Vercel sensitive-environment V2 validation", () => {
  it("parses exact V1 and V2 records without weakening the legacy V1 parser", () => {
    const v1 = managedRecord();
    const v2 = managedRecordV2();
    expect(parseManagedKeyRecord(v1)).toEqual(v1);
    expect(parseManagedKeyRecordV1(v1)).toEqual(v1);
    expect(parseManagedKeyRecordV2(v2)).toEqual(v2);
    expect(parseAnyManagedKeyRecord(v1)).toEqual(v1);
    expect(parseAnyManagedKeyRecord(v2)).toEqual(v2);
    expect(() => parseManagedKeyRecord(v2)).toThrow(KeyManagementError);
    expect(() => parseManagedKeyRecordV2(v1)).toThrow(KeyManagementError);
  });

  it("requires the honest provider, algorithm, root ID, and versioned 65-byte envelope", () => {
    const record = managedRecordV2();
    const malformed = [
      { ...record, extra: true },
      { ...record, schemaVersion: 1 },
      { ...record, schemaVersion: 3 },
      { ...record, custodyProvider: "aws_kms_v1" },
      { ...record, wrapAlgorithm: "SYMMETRIC_DEFAULT" },
      { ...record, rootKeyId: ROOTS.ai_assisted.object_wrap },
      { ...record, rootKeyId: `${record.rootKeyId} ` },
      { ...record, encryptedKeyMaterial: "AQIDBA" },
      { ...record, encryptedKeyMaterial: environmentEnvelope(1).slice(0, -2) },
      { ...record, encryptedKeyMaterial: `${environmentEnvelope(1)}=` },
      (() => {
        const bytes = Buffer.from(environmentEnvelope(1), "base64url");
        bytes[0] = 0;
        return { ...record, encryptedKeyMaterial: bytes.toString("base64url") };
      })(),
      { ...record, status: "active", activatedAt: null },
      { ...record, wrapOperations: record.wrapOperationLimit + 1 },
      {
        ...record,
        rotation: { ...record.rotation, previousRootKeyId: VERCEL_RETIRED_AI_OBJECT_ROOT }
      },
      {
        ...record,
        rotation: {
          ...record.rotation,
          previousRootKeyId: PREVIEW_ROOT,
          rootRewrapCount: 1,
          lastRootRewrappedAt: REWRAPPED_AT
        }
      },
      {
        ...record,
        rotation: {
          ...record.rotation,
          previousRootKeyId: VERCEL_RETIRED_AI_OBJECT_ROOT,
          rootRewrapCount: 1,
          lastRootRewrappedAt: "2026-08-29T12:00:00.000Z"
        }
      }
    ];
    for (const value of malformed) {
      expectFailure(() => parseManagedKeyRecordV2(value), KeyManagementErrorCode.KEY_INVALID);
    }
    for (const value of [null, [], {}, { schemaVersion: 3 }]) {
      expectFailure(() => parseAnyManagedKeyRecord(value), KeyManagementErrorCode.KEY_INVALID);
    }
  });

  it("accepts a same-environment audited root rewrap", () => {
    const value = managedRecordV2({
      rootKeyId: VERCEL_ROOTS.ai_assisted.object_wrap,
      rotation: {
        predecessorKeyId: null,
        previousRootKeyId: VERCEL_RETIRED_AI_OBJECT_ROOT,
        rootRewrapCount: 1,
        lastRootRewrappedAt: REWRAPPED_AT
      }
    });
    expect(parseManagedKeyRecordV2(value)).toEqual(value);
  });

  it("parses exact workload root shapes and binds every ID to the deployment environment", () => {
    expect(parseVercelSensitiveEnvironmentRootKeySet(VERCEL_ROOTS, "production")).toEqual(
      VERCEL_ROOTS
    );
    expect(
      parseVercelSensitiveEnvironmentWorkloadRootKeySet(
        { ai_assisted: VERCEL_ROOTS.ai_assisted },
        "organization_worker",
        "production"
      )
    ).toEqual({ ai_assisted: VERCEL_ROOTS.ai_assisted });
    const indexRoots = {
      ai_assisted: { object_wrap: VERCEL_ROOTS.ai_assisted.object_wrap }
    };
    expect(
      parseVercelSensitiveEnvironmentWorkloadRootKeySet(indexRoots, "index_worker", "production")
    ).toEqual(indexRoots);
    expect(
      parseVercelSensitiveEnvironmentWorkloadRootKeySet(indexRoots, "search_worker", "production")
    ).toEqual(indexRoots);

    for (const action of [
      () => parseVercelSensitiveEnvironmentRootKeySet(VERCEL_ROOTS, "preview"),
      () =>
        parseVercelSensitiveEnvironmentRootKeySet(
          {
            ...VERCEL_ROOTS,
            private_manual: {
              ...VERCEL_ROOTS.private_manual,
              object_wrap: VERCEL_ROOTS.ai_assisted.object_wrap
            }
          },
          "production"
        ),
      () =>
        parseVercelSensitiveEnvironmentRootKeySet(
          {
            ...VERCEL_ROOTS,
            private_manual: {
              ...VERCEL_ROOTS.private_manual,
              object_wrap: ROOTS.private_manual.object_wrap
            }
          },
          "production"
        ),
      () =>
        parseVercelSensitiveEnvironmentWorkloadRootKeySet(
          VERCEL_ROOTS,
          "index_worker",
          "production"
        ),
      () =>
        parseVercelSensitiveEnvironmentWorkloadRootKeySet(
          { ai_assisted: VERCEL_ROOTS.ai_assisted },
          "interactive_api",
          "production"
        ),
      () => parseVercelSensitiveEnvironmentRootKeySet(VERCEL_ROOTS, "development" as "production")
    ]) {
      expectFailure(action, KeyManagementErrorCode.CONFIGURATION_INVALID);
    }
  });

  it("validates bounded, non-overlapping retired provider roots", () => {
    const active = parseVercelSensitiveEnvironmentRootKeySet(VERCEL_ROOTS, "production");
    expect(
      parseVercelSensitiveEnvironmentRetiredRootKeySet(
        { ai_assisted: { object_wrap: [VERCEL_RETIRED_AI_OBJECT_ROOT] } },
        active,
        "production"
      )
    ).toEqual({ ai_assisted: { object_wrap: [VERCEL_RETIRED_AI_OBJECT_ROOT] } });
    expect(
      parseVercelSensitiveEnvironmentRetiredRootKeySet(undefined, active, "production")
    ).toEqual({});

    for (const retired of [
      { ai_assisted: { object_wrap: [VERCEL_ROOTS.ai_assisted.object_wrap] } },
      {
        ai_assisted: {
          object_wrap: [VERCEL_RETIRED_AI_OBJECT_ROOT, VERCEL_RETIRED_AI_OBJECT_ROOT]
        }
      },
      { ai_assisted: { object_wrap: [PREVIEW_ROOT] } },
      { ai_assisted: { object_wrap: [ROOTS.ai_assisted.object_wrap] } },
      { other: { object_wrap: [VERCEL_RETIRED_AI_OBJECT_ROOT] } },
      { ai_assisted: { other: [VERCEL_RETIRED_AI_OBJECT_ROOT] } },
      { ai_assisted: { object_wrap: Array(21).fill(VERCEL_RETIRED_AI_OBJECT_ROOT) } }
    ]) {
      expectFailure(
        () => parseVercelSensitiveEnvironmentRetiredRootKeySet(retired, active, "production"),
        KeyManagementErrorCode.CONFIGURATION_INVALID
      );
    }
  });

  it("validates provider root identifiers without reflecting rejected input", () => {
    expect(() =>
      assertVercelSensitiveEnvironmentRootKeyId(VERCEL_ROOTS.ai_assisted.object_wrap, "production")
    ).not.toThrow();
    for (const value of [
      PREVIEW_ROOT,
      ROOTS.ai_assisted.object_wrap,
      "urn:unfiled:key-root:vercel-sensitive-env-v1:production:not-a-uuid"
    ]) {
      try {
        assertVercelSensitiveEnvironmentRootKeyId(value, "production");
        throw new Error("expected failure");
      } catch (error: unknown) {
        expect(error).toSatisfy(expectCode(KeyManagementErrorCode.CONFIGURATION_INVALID));
        expect(String(error)).not.toContain(value);
      }
    }
  });

  it("keeps timestamp validation identical to V1", () => {
    const record = managedRecordV2({
      status: "revoked",
      activatedAt: CREATED_AT,
      retiredAt: REWRAPPED_AT,
      revokedAt: "2026-09-01T12:00:00.000Z"
    });
    expect(parseManagedKeyRecordV2(record).status).toBe("revoked");
  });
});
