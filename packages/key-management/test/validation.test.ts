import { describe, expect, it } from "vitest";

import {
  DEFAULT_WRAP_OPERATION_LIMIT,
  KeyManagementError,
  KeyManagementErrorCode,
  assertAwsRegion,
  assertAwsRoleArn,
  assertIsoTimestamp,
  assertKmsKeyArn,
  assertWorkloadCanAccess,
  normalizeCreateIntermediateKeyRequest,
  parseKeyBinding,
  parseKeyReference,
  parseKeySelector,
  parseManagedKeyRecord,
  parseRetiredRootKeySet,
  parseRootKeySet,
  parseWorkloadRootKeySet,
  sameBinding,
  sameSelector
} from "../src/index";
import {
  AI_ROOTS,
  CREATED_AT,
  OWNER_A,
  RETIRED_AI_OBJECT_ROOT,
  ROOTS,
  managedRecord
} from "./fixtures";

function expectCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof KeyManagementError && error.code === code;
}

describe("key-management validation", () => {
  it("strictly parses owner-bound key identities", () => {
    const binding = parseKeyBinding({
      ownerId: OWNER_A,
      keyClass: "ai_assisted",
      purpose: "object_wrap"
    });
    const selector = parseKeySelector({ ...binding, keyId: "ai.object.v1" });
    const reference = parseKeyReference({ ...selector, keyVersion: 1 });

    expect(reference).toEqual({ ...selector, keyVersion: 1 });
    expect(sameBinding(reference, binding)).toBe(true);
    expect(sameSelector(reference, selector)).toBe(true);
    expect(sameBinding(reference, { ...binding, purpose: "content_mac" })).toBe(false);
    expect(sameSelector(reference, { ...selector, keyId: "other" })).toBe(false);
  });

  it("rejects malformed identities and extra keys", () => {
    for (const value of [
      { ownerId: "not-a-user", keyClass: "ai_assisted", purpose: "object_wrap" },
      { ownerId: OWNER_A, keyClass: "other", purpose: "object_wrap" },
      { ownerId: OWNER_A, keyClass: "ai_assisted", purpose: "other" },
      { ownerId: OWNER_A, keyClass: "ai_assisted", purpose: "object_wrap", extra: true }
    ]) {
      expect(() => parseKeyBinding(value)).toThrow(KeyManagementError);
    }
    expect(() =>
      parseKeySelector({
        ownerId: OWNER_A,
        keyClass: "ai_assisted",
        purpose: "object_wrap",
        keyId: "bad key"
      })
    ).toThrow(KeyManagementError);
    expect(() =>
      parseKeyReference({
        ownerId: OWNER_A,
        keyClass: "ai_assisted",
        purpose: "object_wrap",
        keyId: "valid",
        keyVersion: 0
      })
    ).toThrow(KeyManagementError);
  });

  it("normalizes rotation creation metadata with a conservative wrap limit", () => {
    const request = normalizeCreateIntermediateKeyRequest({
      ownerId: OWNER_A,
      keyClass: "ai_assisted",
      purpose: "object_wrap",
      keyId: "ai.object.v2",
      keyVersion: 2,
      createdAt: CREATED_AT,
      predecessorKeyId: "ai.object.v1"
    });
    expect(request.wrapOperationLimit).toBe(DEFAULT_WRAP_OPERATION_LIMIT);

    for (const malformed of [
      { ...request, createdAt: "yesterday" },
      { ...request, predecessorKeyId: request.keyId },
      { ...request, wrapOperationLimit: 0 },
      { ...request, wrapOperationLimit: DEFAULT_WRAP_OPERATION_LIMIT + 1 }
    ]) {
      expect(() => normalizeCreateIntermediateKeyRequest(malformed)).toThrow(KeyManagementError);
    }
  });

  it("validates lifecycle, operation, ciphertext, and rotation metadata", () => {
    expect(parseManagedKeyRecord(managedRecord())).toEqual(managedRecord());
    expect(
      parseManagedKeyRecord(
        managedRecord({
          status: "revoked",
          activatedAt: CREATED_AT,
          retiredAt: "2026-08-31T12:00:00.000Z",
          revokedAt: "2026-09-01T12:00:00.000Z"
        })
      ).status
    ).toBe("revoked");
    const invalid = [
      { ...managedRecord(), extra: true },
      { ...managedRecord(), encryptedKeyMaterial: "AQI=" },
      { ...managedRecord(), encryptedKeyMaterial: "AB" },
      { ...managedRecord(), status: "active", activatedAt: null },
      { ...managedRecord(), status: "retired", retiredAt: null },
      { ...managedRecord(), status: "pending", activatedAt: CREATED_AT },
      { ...managedRecord(), activatedAt: "2026-08-29T12:00:00.000Z" },
      {
        ...managedRecord(),
        status: "retired",
        retiredAt: "2026-08-29T12:00:00.000Z"
      },
      {
        ...managedRecord(),
        status: "revoked",
        activatedAt: null,
        revokedAt: "2026-08-29T12:00:00.000Z"
      },
      { ...managedRecord(), wrapOperations: DEFAULT_WRAP_OPERATION_LIMIT + 1 },
      { ...managedRecord(), wrapOperations: 3, wrapOperationLimit: 2 },
      {
        ...managedRecord(),
        rotation: { ...managedRecord().rotation, rootRewrapCount: 1 }
      },
      {
        ...managedRecord(),
        rotation: {
          predecessorKeyId: null,
          previousRootKeyArn: RETIRED_AI_OBJECT_ROOT,
          rootRewrapCount: 1,
          lastRootRewrappedAt: "2026-08-29T12:00:00.000Z"
        }
      },
      {
        ...managedRecord(),
        status: "revoked",
        revokedAt: "2026-09-01T12:00:00.000Z",
        rotation: {
          predecessorKeyId: null,
          previousRootKeyArn: RETIRED_AI_OBJECT_ROOT,
          rootRewrapCount: 1,
          lastRootRewrappedAt: "2026-09-02T12:00:00.000Z"
        }
      }
    ];
    for (const value of invalid)
      expect(() => parseManagedKeyRecord(value)).toThrow(KeyManagementError);
  });

  it("requires four distinct fully qualified KMS key ARNs", () => {
    expect(parseRootKeySet(ROOTS)).toEqual(ROOTS);
    expect(() =>
      parseRootKeySet({
        ...ROOTS,
        private_manual: { ...ROOTS.private_manual, object_wrap: ROOTS.ai_assisted.object_wrap }
      })
    ).toThrow(KeyManagementError);
    expect(() =>
      parseRootKeySet({
        ...ROOTS,
        private_manual: { ...ROOTS.private_manual, object_wrap: "alias/unfiled-private" }
      })
    ).toThrow(KeyManagementError);
    expect(() => parseRootKeySet({ ai_assisted: ROOTS.ai_assisted })).toThrow(KeyManagementError);
  });

  it("requires only AI roots for workers and keeps private roots out of worker configuration", () => {
    expect(parseWorkloadRootKeySet(AI_ROOTS, "organization_worker")).toEqual(AI_ROOTS);
    expect(() => parseWorkloadRootKeySet(ROOTS, "organization_worker")).toThrow(KeyManagementError);
    expect(() => parseWorkloadRootKeySet(AI_ROOTS, "interactive_api")).toThrow(KeyManagementError);
    expect(() =>
      parseRetiredRootKeySet(
        { private_manual: { object_wrap: [RETIRED_AI_OBJECT_ROOT] } },
        AI_ROOTS
      )
    ).toThrow(KeyManagementError);
  });

  it("validates bounded, non-overlapping retired roots", () => {
    expect(
      parseRetiredRootKeySet({ ai_assisted: { object_wrap: [RETIRED_AI_OBJECT_ROOT] } }, ROOTS)
    ).toEqual({ ai_assisted: { object_wrap: [RETIRED_AI_OBJECT_ROOT] } });
    for (const retired of [
      { ai_assisted: { object_wrap: [ROOTS.ai_assisted.object_wrap] } },
      { ai_assisted: { object_wrap: [RETIRED_AI_OBJECT_ROOT, RETIRED_AI_OBJECT_ROOT] } },
      { other: { object_wrap: [RETIRED_AI_OBJECT_ROOT] } },
      { ai_assisted: { other: [RETIRED_AI_OBJECT_ROOT] } }
    ]) {
      expect(() => parseRetiredRootKeySet(retired, ROOTS)).toThrow(KeyManagementError);
    }
  });

  it("validates AWS configuration primitives without echoing input", () => {
    expect(() => assertAwsRegion("us-west-2")).not.toThrow();
    expect(() =>
      assertAwsRoleArn("arn:aws:iam::123456789012:role/vercel/unfiled-interactive")
    ).not.toThrow();
    expect(() => assertKmsKeyArn(ROOTS.ai_assisted.object_wrap)).not.toThrow();
    expect(() => assertIsoTimestamp(CREATED_AT)).not.toThrow();

    for (const action of [
      () => assertAwsRegion("localhost"),
      () => assertAwsRoleArn("admin"),
      () => assertKmsKeyArn("alias/key"),
      () => assertIsoTimestamp("2026-08-30")
    ]) {
      expect(action).toThrow(KeyManagementError);
    }
  });

  it("denies private-manual access to the organization workload", () => {
    expect(() => assertWorkloadCanAccess("organization_worker", "ai_assisted")).not.toThrow();
    expect(() => assertWorkloadCanAccess("interactive_api", "private_manual")).not.toThrow();
    try {
      assertWorkloadCanAccess("organization_worker", "private_manual");
      throw new Error("expected access denial");
    } catch (error: unknown) {
      expect(error).toSatisfy(expectCode(KeyManagementErrorCode.ACCESS_DENIED));
    }
  });
});
