import type { AwsKmsTransport } from "./aws-transport";
import { kmsEncryptionContextForKey } from "./kms-context";
import {
  KeyManagementError,
  KeyManagementErrorCode,
  keyManagementFailure,
  type CreateIntermediateKeyRequest,
  type IntermediateKeyCustodian,
  type ManagedKeyRecordV1
} from "./types";
import {
  assertKmsKeyArn,
  normalizeCreateIntermediateKeyRequest,
  parseManagedKeyRecord
} from "./validation";

export const KEY_CUSTODY_PROBE_CHECKS = Object.freeze([
  "ai_generate_decrypt",
  "private_object_wrap_application_guard_denied",
  "private_content_mac_application_guard_denied",
  "private_object_wrap_kms_generate_decrypt_denied",
  "private_content_mac_kms_generate_decrypt_denied",
  "wrong_context_denied",
  "report_events_content_free"
] as const);

export type KeyCustodyProbeCheck = (typeof KEY_CUSTODY_PROBE_CHECKS)[number];

export type KeyCustodyProbeEvent = Readonly<{
  check: KeyCustodyProbeCheck;
  status: "passed";
}>;

export type KeyCustodyPrivateDenialEvidence = "application_guard" | "direct_kms";

export type KeyCustodyProbeReport = Readonly<{
  checks: readonly KeyCustodyProbeEvent[];
  passed: true;
  privateDenialEvidence: KeyCustodyPrivateDenialEvidence;
}>;

export type DirectPrivateKmsProbe = Readonly<{
  rootKeyArns: Readonly<{
    content_mac: string;
    object_wrap: string;
  }>;
  transport: AwsKmsTransport;
}>;

export type KeyCustodyProbeOptions = Readonly<{
  aiKeyRequest: CreateIntermediateKeyRequest;
  custodian: IntermediateKeyCustodian;
  directPrivateKmsProbe?: DirectPrivateKmsProbe;
  emit?: (event: KeyCustodyProbeEvent) => void;
  wrongOwnerId: string;
}>;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function operationRejects(operation: () => Promise<unknown>): Promise<boolean> {
  try {
    await operation();
    return false;
  } catch {
    return true;
  }
}

function accessWasDenied(error: unknown): boolean {
  if (error instanceof KeyManagementError) {
    return error.code === KeyManagementErrorCode.ACCESS_DENIED;
  }
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AccessDeniedException"
  );
}

function reportEventsAreContentFree(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > KEY_CUSTODY_PROBE_CHECKS.length) return false;
  return value.every((event: unknown) => {
    if (typeof event !== "object" || event === null || Array.isArray(event)) return false;
    const record = event as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record).sort();
    return (
      keys.length === 2 &&
      keys[0] === "check" &&
      keys[1] === "status" &&
      typeof record.check === "string" &&
      (KEY_CUSTODY_PROBE_CHECKS as readonly string[]).includes(record.check) &&
      record.status === "passed"
    );
  });
}

function privateRequest(
  aiRequest: CreateIntermediateKeyRequest,
  purpose: "object_wrap" | "content_mac"
): CreateIntermediateKeyRequest {
  return normalizeCreateIntermediateKeyRequest({
    ...aiRequest,
    keyClass: "private_manual",
    purpose,
    keyId: `probe.private.${purpose.replaceAll("_", "-")}.v1`,
    keyVersion: 1,
    predecessorKeyId: null
  });
}

function privateDenialCheck(
  purpose: "object_wrap" | "content_mac",
  evidence: KeyCustodyPrivateDenialEvidence
): KeyCustodyProbeCheck {
  if (purpose === "object_wrap") {
    return evidence === "direct_kms"
      ? "private_object_wrap_kms_generate_decrypt_denied"
      : "private_object_wrap_application_guard_denied";
  }
  return evidence === "direct_kms"
    ? "private_content_mac_kms_generate_decrypt_denied"
    : "private_content_mac_application_guard_denied";
}

function validateDirectPrivateProbe(probe: DirectPrivateKmsProbe): void {
  const keys = Object.keys(probe.rootKeyArns).sort();
  if (keys.length !== 2 || keys[0] !== "content_mac" || keys[1] !== "object_wrap") {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key custody probe failed");
  }
  assertKmsKeyArn(probe.rootKeyArns.object_wrap);
  assertKmsKeyArn(probe.rootKeyArns.content_mac);
  if (probe.rootKeyArns.object_wrap === probe.rootKeyArns.content_mac) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key custody probe failed");
  }
}

async function expectPrivatePurposeDenied(
  options: KeyCustodyProbeOptions,
  request: CreateIntermediateKeyRequest
): Promise<void> {
  const expectAccessDenied = async (
    operation: () => Promise<Readonly<{ Plaintext?: Uint8Array }>>
  ): Promise<void> => {
    try {
      const response = await operation();
      response.Plaintext?.fill(0);
    } catch (error: unknown) {
      if (accessWasDenied(error)) return;
      keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key custody probe failed");
    }
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key custody probe failed");
  };

  const directProbe = options.directPrivateKmsProbe;
  if (directProbe === undefined) {
    await expectAccessDenied(() =>
      options.custodian.withGeneratedIntermediateKey(request, () => Promise.resolve({}))
    );
    return;
  }
  const rootKeyArn = directProbe.rootKeyArns[request.purpose];
  const context = kmsEncryptionContextForKey(request);
  await expectAccessDenied(() =>
    directProbe.transport.generateDataKey({
      EncryptionContext: context,
      KeyId: rootKeyArn,
      KeySpec: "AES_256"
    })
  );
  await expectAccessDenied(() =>
    directProbe.transport.decryptDataKey({
      CiphertextBlob: new Uint8Array([0]),
      EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
      EncryptionContext: context,
      KeyId: rootKeyArn
    })
  );
}

export async function runKeyCustodyProbe(
  options: KeyCustodyProbeOptions
): Promise<KeyCustodyProbeReport> {
  const aiRequest = normalizeCreateIntermediateKeyRequest(options.aiKeyRequest);
  if (aiRequest.keyClass !== "ai_assisted" || aiRequest.purpose !== "object_wrap") {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key custody probe failed");
  }
  if (options.wrongOwnerId === aiRequest.ownerId) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key custody probe failed");
  }
  if (options.directPrivateKmsProbe !== undefined) {
    validateDirectPrivateProbe(options.directPrivateKmsProbe);
  }

  const checks: KeyCustodyProbeEvent[] = [];
  const privateDenialEvidence =
    options.directPrivateKmsProbe === undefined ? "application_guard" : "direct_kms";
  const passed = (check: KeyCustodyProbeCheck): void => {
    const event = Object.freeze({ check, status: "passed" as const });
    checks.push(event);
    options.emit?.(event);
  };

  await options.custodian.withGeneratedIntermediateKey(aiRequest, async (generated, pending) => {
    const active = parseManagedKeyRecord({
      ...pending,
      status: "active",
      activatedAt: pending.createdAt
    });
    const expected = new Uint8Array(generated);
    try {
      const decrypted = await options.custodian.withUnwrappedIntermediateKey(active, (unwrapped) =>
        Promise.resolve(sameBytes(expected, unwrapped))
      );
      if (!decrypted) {
        keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key custody probe failed");
      }
      passed("ai_generate_decrypt");

      await expectPrivatePurposeDenied(options, privateRequest(aiRequest, "object_wrap"));
      passed(privateDenialCheck("object_wrap", privateDenialEvidence));
      await expectPrivatePurposeDenied(options, privateRequest(aiRequest, "content_mac"));
      passed(privateDenialCheck("content_mac", privateDenialEvidence));

      const wrongContextRecord: ManagedKeyRecordV1 = parseManagedKeyRecord({
        ...active,
        ownerId: options.wrongOwnerId
      });
      const wrongContextRejected = await operationRejects(() =>
        options.custodian.withUnwrappedIntermediateKey(wrongContextRecord, () => Promise.resolve())
      );
      if (!wrongContextRejected) {
        keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key custody probe failed");
      }
      passed("wrong_context_denied");
    } finally {
      expected.fill(0);
    }
  });

  const contentFreeEvent = Object.freeze({
    check: "report_events_content_free" as const,
    status: "passed" as const
  });
  checks.push(contentFreeEvent);
  if (!reportEventsAreContentFree(checks)) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key custody probe failed");
  }
  options.emit?.(contentFreeEvent);
  return Object.freeze({
    checks: Object.freeze(checks),
    passed: true,
    privateDenialEvidence
  });
}
