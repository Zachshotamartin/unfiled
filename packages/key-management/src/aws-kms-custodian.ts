import type {
  AwsKmsTransport,
  DecryptDataKeyResponse,
  GenerateDataKeyResponse,
  ReEncryptDataKeyResponse
} from "./aws-transport.js";
import { decodeBase64Url, encodeBase64Url } from "./base64url.js";
import { kmsEncryptionContextForKey } from "./kms-context.js";
import {
  KeyManagementErrorCode,
  keyManagementFailure,
  type AiAssistedRetiredRootKeySet,
  type AiAssistedRootKeySet,
  type CreateIntermediateKeyRequest,
  type IntermediateKeyCustodian,
  type IndexWorkerRetiredRootKeySet,
  type IndexWorkerRootKeySet,
  type InteractiveKeyCustodian,
  type KeyBinding,
  type KeyClass,
  type KeyCustodyOperationOptions,
  type ManagedKeyRecordV1,
  type PurposeRootKeySet,
  type RetiredRootKeySet,
  type RootKeySet,
  type WorkloadRootKeySet
} from "./types.js";
import {
  assertIsoTimestamp,
  assertWorkload,
  assertWorkloadCanAccess,
  isDecryptableStatus,
  normalizeCreateIntermediateKeyRequest,
  parseManagedKeyRecord,
  parseRetiredRootKeySet,
  parseWorkloadRootKeySet
} from "./validation.js";

const INTERMEDIATE_KEY_BYTES = 32;
const MAX_KMS_CIPHERTEXT_BYTES = 8_192;

export type AwsKmsEnvelopeCustodianOptions =
  | OrganizationWorkerEnvelopeCustodianOptions
  | IndexWorkerEnvelopeCustodianOptions
  | InteractiveEnvelopeCustodianOptions;

export type OrganizationWorkerEnvelopeCustodianOptions = Readonly<{
  activeRoots: AiAssistedRootKeySet;
  retiredRoots?: AiAssistedRetiredRootKeySet;
  transport: AwsKmsTransport;
  workload: "organization_worker";
}>;

export type IndexWorkerEnvelopeCustodianOptions = Readonly<{
  activeRoots: IndexWorkerRootKeySet;
  retiredRoots?: IndexWorkerRetiredRootKeySet;
  transport: AwsKmsTransport;
  workload: "index_worker";
}>;

export type InteractiveEnvelopeCustodianOptions = Readonly<{
  activeRoots: RootKeySet;
  retiredRoots?: RetiredRootKeySet;
  transport: AwsKmsTransport;
  workload: "interactive_api";
}>;

function transportOptions(
  options: KeyCustodyOperationOptions | undefined
): Readonly<{ abortSignal: AbortSignal }> | undefined {
  const signal = options?.signal;
  return signal === undefined ? undefined : { abortSignal: signal };
}

async function callKms<Result>(
  operation: () => Promise<Result>,
  signal: AbortSignal | undefined
): Promise<Result> {
  try {
    if (signal?.aborted === true) throw new Error("aborted");
    return await operation();
  } catch {
    keyManagementFailure(KeyManagementErrorCode.KMS_UNAVAILABLE, "Key service is unavailable");
  }
}

function copyExactPlaintextKey(
  response: GenerateDataKeyResponse | DecryptDataKeyResponse
): Uint8Array {
  const plaintext = response.Plaintext;
  if (!(plaintext instanceof Uint8Array) || plaintext.length !== INTERMEDIATE_KEY_BYTES) {
    plaintext?.fill(0);
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key service response is invalid");
  }
  const copy = new Uint8Array(plaintext);
  plaintext.fill(0);
  return copy;
}

function copyCiphertext(response: GenerateDataKeyResponse | ReEncryptDataKeyResponse): Uint8Array {
  const ciphertext = response.CiphertextBlob;
  if (
    !(ciphertext instanceof Uint8Array) ||
    ciphertext.length < 1 ||
    ciphertext.length > MAX_KMS_CIPHERTEXT_BYTES
  ) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key service response is invalid");
  }
  return new Uint8Array(ciphertext);
}

function rootFor(activeRoots: WorkloadRootKeySet, binding: KeyBinding): string {
  const roots = (
    activeRoots as Readonly<
      Partial<Record<KeyClass, Readonly<Partial<Record<keyof PurposeRootKeySet, string>>>>>
    >
  )[binding.keyClass];
  const root = roots?.[binding.purpose];
  if (root === undefined) {
    keyManagementFailure(KeyManagementErrorCode.ACCESS_DENIED, "Key access is denied");
  }
  return root;
}

function rootIsDecryptable(
  activeRoots: WorkloadRootKeySet,
  retiredRoots: RetiredRootKeySet,
  record: ManagedKeyRecordV1
): boolean {
  return (
    record.rootKeyArn === rootFor(activeRoots, record) ||
    (retiredRoots[record.keyClass]?.[record.purpose] ?? []).includes(record.rootKeyArn)
  );
}

function assertKmsResponseKey(
  actual: string | undefined,
  expected: string,
  plaintext?: Uint8Array
): void {
  if (actual !== expected) {
    plaintext?.fill(0);
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key service response is invalid");
  }
}

function latestRewrapBoundary(record: ManagedKeyRecordV1): number {
  return Math.max(
    ...[record.createdAt, record.activatedAt, record.retiredAt, record.rotation.lastRootRewrappedAt]
      .filter((value): value is string => value !== null)
      .map((value) => Date.parse(value))
  );
}

export function createAwsKmsEnvelopeCustodian(
  options: OrganizationWorkerEnvelopeCustodianOptions | IndexWorkerEnvelopeCustodianOptions
): IntermediateKeyCustodian;
export function createAwsKmsEnvelopeCustodian(
  options: InteractiveEnvelopeCustodianOptions
): InteractiveKeyCustodian;
export function createAwsKmsEnvelopeCustodian(
  options: AwsKmsEnvelopeCustodianOptions
): IntermediateKeyCustodian | InteractiveKeyCustodian {
  assertWorkload(options.workload);
  const activeRoots = parseWorkloadRootKeySet(options.activeRoots, options.workload);
  const retiredRoots = parseRetiredRootKeySet(options.retiredRoots, activeRoots);

  const runtimeCustodian: IntermediateKeyCustodian = {
    async withGeneratedIntermediateKey<Result>(
      requestValue: CreateIntermediateKeyRequest,
      use: (keyBytes: Uint8Array, record: ManagedKeyRecordV1) => Promise<Result>,
      operationOptions?: KeyCustodyOperationOptions
    ): Promise<Result> {
      const request = normalizeCreateIntermediateKeyRequest(requestValue);
      assertWorkloadCanAccess(options.workload, request.keyClass, request.purpose);
      const rootKeyArn = rootFor(activeRoots, request);
      const response = await callKms(
        () =>
          options.transport.generateDataKey(
            {
              EncryptionContext: kmsEncryptionContextForKey(request),
              KeyId: rootKeyArn,
              KeySpec: "AES_256"
            },
            transportOptions(operationOptions)
          ),
        operationOptions?.signal
      );
      assertKmsResponseKey(response.KeyId, rootKeyArn, response.Plaintext);
      const plaintext = copyExactPlaintextKey(response);
      let encrypted: Uint8Array | undefined;
      try {
        encrypted = copyCiphertext(response);
        const record = parseManagedKeyRecord({
          schemaVersion: 1,
          ownerId: request.ownerId,
          keyClass: request.keyClass,
          purpose: request.purpose,
          keyId: request.keyId,
          keyVersion: request.keyVersion,
          status: "pending",
          encryptedKeyMaterial: encodeBase64Url(encrypted),
          rootKeyArn,
          createdAt: request.createdAt,
          activatedAt: null,
          retiredAt: null,
          revokedAt: null,
          wrapOperations: 0,
          wrapOperationLimit: request.wrapOperationLimit,
          rotation: {
            predecessorKeyId: request.predecessorKeyId,
            previousRootKeyArn: null,
            rootRewrapCount: 0,
            lastRootRewrappedAt: null
          }
        });
        return await use(plaintext, record);
      } finally {
        plaintext.fill(0);
        encrypted?.fill(0);
      }
    },

    async withUnwrappedIntermediateKey<Result>(
      recordValue: unknown,
      use: (keyBytes: Uint8Array, record: ManagedKeyRecordV1) => Promise<Result>,
      operationOptions?: KeyCustodyOperationOptions
    ): Promise<Result> {
      const record = parseManagedKeyRecord(recordValue);
      assertWorkloadCanAccess(options.workload, record.keyClass, record.purpose);
      if (
        !isDecryptableStatus(record.status) ||
        !rootIsDecryptable(activeRoots, retiredRoots, record)
      ) {
        keyManagementFailure(KeyManagementErrorCode.KEY_STATE_INVALID, "Key is unavailable");
      }
      const ciphertext = decodeBase64Url(record.encryptedKeyMaterial, 1, MAX_KMS_CIPHERTEXT_BYTES);
      try {
        const response = await callKms(
          () =>
            options.transport.decryptDataKey(
              {
                CiphertextBlob: ciphertext,
                EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
                EncryptionContext: kmsEncryptionContextForKey(record),
                KeyId: record.rootKeyArn
              },
              transportOptions(operationOptions)
            ),
          operationOptions?.signal
        );
        assertKmsResponseKey(response.KeyId, record.rootKeyArn, response.Plaintext);
        const plaintext = copyExactPlaintextKey(response);
        try {
          return await use(plaintext, record);
        } finally {
          plaintext.fill(0);
        }
      } finally {
        ciphertext.fill(0);
      }
    }
  };
  if (options.workload !== "interactive_api") {
    return Object.freeze(runtimeCustodian);
  }
  return Object.freeze({
    ...runtimeCustodian,
    async rewrapIntermediateKey(
      recordValue: unknown,
      rewrappedAt: string,
      operationOptions?: KeyCustodyOperationOptions
    ): Promise<ManagedKeyRecordV1> {
      const record = parseManagedKeyRecord(recordValue);
      assertIsoTimestamp(rewrappedAt);
      assertWorkloadCanAccess(options.workload, record.keyClass, record.purpose);
      if (
        record.status === "revoked" ||
        record.rotation.rootRewrapCount >= 1_000_000 ||
        Date.parse(rewrappedAt) < latestRewrapBoundary(record) ||
        !rootIsDecryptable(activeRoots, retiredRoots, record)
      ) {
        keyManagementFailure(KeyManagementErrorCode.KEY_STATE_INVALID, "Key is unavailable");
      }
      const destinationRoot = rootFor(activeRoots, record);
      if (record.rootKeyArn === destinationRoot) return record;
      const ciphertext = decodeBase64Url(record.encryptedKeyMaterial, 1, MAX_KMS_CIPHERTEXT_BYTES);
      try {
        const context = kmsEncryptionContextForKey(record);
        const response = await callKms(
          () =>
            options.transport.reEncryptDataKey(
              {
                CiphertextBlob: ciphertext,
                DestinationEncryptionAlgorithm: "SYMMETRIC_DEFAULT",
                DestinationEncryptionContext: context,
                DestinationKeyId: destinationRoot,
                SourceEncryptionAlgorithm: "SYMMETRIC_DEFAULT",
                SourceEncryptionContext: context,
                SourceKeyId: record.rootKeyArn
              },
              transportOptions(operationOptions)
            ),
          operationOptions?.signal
        );
        assertKmsResponseKey(response.SourceKeyId, record.rootKeyArn);
        assertKmsResponseKey(response.KeyId, destinationRoot);
        const encrypted = copyCiphertext(response);
        try {
          return parseManagedKeyRecord({
            ...record,
            encryptedKeyMaterial: encodeBase64Url(encrypted),
            rootKeyArn: destinationRoot,
            rotation: {
              ...record.rotation,
              previousRootKeyArn: record.rootKeyArn,
              rootRewrapCount: record.rotation.rootRewrapCount + 1,
              lastRootRewrappedAt: rewrappedAt
            }
          });
        } finally {
          encrypted.fill(0);
        }
      } finally {
        ciphertext.fill(0);
      }
    }
  });
}
