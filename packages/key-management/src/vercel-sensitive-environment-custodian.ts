import type {
  AwsKmsTransport,
  DecryptDataKeyResponse,
  GenerateDataKeyResponse,
  ReEncryptDataKeyResponse
} from "./aws-transport.js";
import { decodeBase64Url, encodeBase64Url } from "./base64url.js";
import { keyEnvelopeContextForKey } from "./kms-context.js";
import {
  KeyManagementErrorCode,
  keyManagementFailure,
  type CreateIntermediateKeyRequest,
  type KeyBinding,
  type KeyClass,
  type KeyCustodyOperationOptions,
  type ManagedKeyRecordV2,
  type PurposeRootKeySet,
  type VercelDeploymentEnvironment,
  type VercelSensitiveEnvironmentAiAssistedRetiredRootKeySet,
  type VercelSensitiveEnvironmentAiAssistedRootKeySet,
  type VercelSensitiveEnvironmentDecryptOnlyIntermediateKeyCustodian,
  type VercelSensitiveEnvironmentIndexWorkerRetiredRootKeySet,
  type VercelSensitiveEnvironmentIndexWorkerRootKeySet,
  type VercelSensitiveEnvironmentInteractiveKeyCustodian,
  type VercelSensitiveEnvironmentIntermediateKeyCustodian,
  type VercelSensitiveEnvironmentRetiredRootKeySet,
  type VercelSensitiveEnvironmentRootKeySet,
  type VercelSensitiveEnvironmentSearchWorkerRetiredRootKeySet,
  type VercelSensitiveEnvironmentSearchWorkerRootKeySet,
  type VercelSensitiveEnvironmentWorkloadRootKeySet
} from "./types.js";
import {
  assertIsoTimestamp,
  assertWorkload,
  assertWorkloadCanAccess,
  isDecryptableStatus,
  normalizeCreateIntermediateKeyRequest,
  parseManagedKeyRecordV2,
  parseVercelSensitiveEnvironmentRetiredRootKeySet,
  parseVercelSensitiveEnvironmentWorkloadRootKeySet
} from "./validation.js";

const INTERMEDIATE_KEY_BYTES = 32;
const ENVIRONMENT_ENVELOPE_BYTES = 65;

type BaseOptions = Readonly<{
  deploymentEnvironment: VercelDeploymentEnvironment;
  transport: AwsKmsTransport;
}>;

export type VercelSensitiveEnvironmentOrganizationWorkerEnvelopeCustodianOptions = BaseOptions &
  Readonly<{
    activeRoots: VercelSensitiveEnvironmentAiAssistedRootKeySet;
    retiredRoots?: VercelSensitiveEnvironmentAiAssistedRetiredRootKeySet;
    workload: "organization_worker";
  }>;

export type VercelSensitiveEnvironmentIndexWorkerEnvelopeCustodianOptions = BaseOptions &
  Readonly<{
    activeRoots: VercelSensitiveEnvironmentIndexWorkerRootKeySet;
    retiredRoots?: VercelSensitiveEnvironmentIndexWorkerRetiredRootKeySet;
    workload: "index_worker";
  }>;

export type VercelSensitiveEnvironmentSearchWorkerEnvelopeCustodianOptions = BaseOptions &
  Readonly<{
    activeRoots: VercelSensitiveEnvironmentSearchWorkerRootKeySet;
    retiredRoots?: VercelSensitiveEnvironmentSearchWorkerRetiredRootKeySet;
    workload: "search_worker";
  }>;

export type VercelSensitiveEnvironmentInteractiveEnvelopeCustodianOptions = BaseOptions &
  Readonly<{
    activeRoots: VercelSensitiveEnvironmentRootKeySet;
    retiredRoots?: VercelSensitiveEnvironmentRetiredRootKeySet;
    workload: "interactive_api";
  }>;

export type VercelSensitiveEnvironmentEnvelopeCustodianOptions =
  | VercelSensitiveEnvironmentOrganizationWorkerEnvelopeCustodianOptions
  | VercelSensitiveEnvironmentIndexWorkerEnvelopeCustodianOptions
  | VercelSensitiveEnvironmentSearchWorkerEnvelopeCustodianOptions
  | VercelSensitiveEnvironmentInteractiveEnvelopeCustodianOptions;

function transportOptions(
  options: KeyCustodyOperationOptions | undefined
): Readonly<{ abortSignal: AbortSignal }> | undefined {
  const signal = options?.signal;
  return signal === undefined ? undefined : { abortSignal: signal };
}

async function callEnvelopeService<Result>(
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

function copyExactEnvelope(
  response: GenerateDataKeyResponse | ReEncryptDataKeyResponse
): Uint8Array {
  const ciphertext = response.CiphertextBlob;
  if (!(ciphertext instanceof Uint8Array) || ciphertext.length !== ENVIRONMENT_ENVELOPE_BYTES) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key service response is invalid");
  }
  return new Uint8Array(ciphertext);
}

function rootFor(
  activeRoots: VercelSensitiveEnvironmentWorkloadRootKeySet,
  binding: KeyBinding
): string {
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
  activeRoots: VercelSensitiveEnvironmentWorkloadRootKeySet,
  retiredRoots: VercelSensitiveEnvironmentRetiredRootKeySet,
  record: ManagedKeyRecordV2
): boolean {
  return (
    record.rootKeyId === rootFor(activeRoots, record) ||
    (retiredRoots[record.keyClass]?.[record.purpose] ?? []).includes(record.rootKeyId)
  );
}

function assertEnvelopeResponseRoot(
  actual: string | undefined,
  expected: string,
  plaintext?: Uint8Array
): void {
  if (actual !== expected) {
    plaintext?.fill(0);
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key service response is invalid");
  }
}

function latestRewrapBoundary(record: ManagedKeyRecordV2): number {
  return Math.max(
    ...[record.createdAt, record.activatedAt, record.retiredAt, record.rotation.lastRootRewrappedAt]
      .filter((value): value is string => value !== null)
      .map((value) => Date.parse(value))
  );
}

export function createVercelSensitiveEnvironmentEnvelopeCustodian(
  options:
    | VercelSensitiveEnvironmentOrganizationWorkerEnvelopeCustodianOptions
    | VercelSensitiveEnvironmentIndexWorkerEnvelopeCustodianOptions
): VercelSensitiveEnvironmentIntermediateKeyCustodian;
export function createVercelSensitiveEnvironmentEnvelopeCustodian(
  options: VercelSensitiveEnvironmentSearchWorkerEnvelopeCustodianOptions
): VercelSensitiveEnvironmentDecryptOnlyIntermediateKeyCustodian;
export function createVercelSensitiveEnvironmentEnvelopeCustodian(
  options: VercelSensitiveEnvironmentInteractiveEnvelopeCustodianOptions
): VercelSensitiveEnvironmentInteractiveKeyCustodian;
export function createVercelSensitiveEnvironmentEnvelopeCustodian(
  options: VercelSensitiveEnvironmentEnvelopeCustodianOptions
):
  | VercelSensitiveEnvironmentDecryptOnlyIntermediateKeyCustodian
  | VercelSensitiveEnvironmentIntermediateKeyCustodian
  | VercelSensitiveEnvironmentInteractiveKeyCustodian {
  assertWorkload(options.workload);
  const activeRoots = parseVercelSensitiveEnvironmentWorkloadRootKeySet(
    options.activeRoots,
    options.workload,
    options.deploymentEnvironment
  );
  const retiredRoots = parseVercelSensitiveEnvironmentRetiredRootKeySet(
    options.retiredRoots,
    activeRoots,
    options.deploymentEnvironment
  );

  const runtimeCustodian: VercelSensitiveEnvironmentIntermediateKeyCustodian = {
    async withGeneratedIntermediateKey<Result>(
      requestValue: CreateIntermediateKeyRequest,
      use: (keyBytes: Uint8Array, record: ManagedKeyRecordV2) => Promise<Result>,
      operationOptions?: KeyCustodyOperationOptions
    ): Promise<Result> {
      const request = normalizeCreateIntermediateKeyRequest(requestValue);
      assertWorkloadCanAccess(options.workload, request.keyClass, request.purpose);
      const rootKeyId = rootFor(activeRoots, request);
      const response = await callEnvelopeService(
        () =>
          options.transport.generateDataKey(
            {
              EncryptionContext: keyEnvelopeContextForKey(request),
              KeyId: rootKeyId,
              KeySpec: "AES_256"
            },
            transportOptions(operationOptions)
          ),
        operationOptions?.signal
      );
      assertEnvelopeResponseRoot(response.KeyId, rootKeyId, response.Plaintext);
      const plaintext = copyExactPlaintextKey(response);
      let encrypted: Uint8Array | undefined;
      try {
        encrypted = copyExactEnvelope(response);
        const record = parseManagedKeyRecordV2({
          schemaVersion: 2,
          custodyProvider: "vercel_sensitive_environment_v1",
          ownerId: request.ownerId,
          keyClass: request.keyClass,
          purpose: request.purpose,
          keyId: request.keyId,
          keyVersion: request.keyVersion,
          status: "pending",
          encryptedKeyMaterial: encodeBase64Url(encrypted),
          rootKeyId,
          wrapAlgorithm: "AES-256-GCM",
          createdAt: request.createdAt,
          activatedAt: null,
          retiredAt: null,
          revokedAt: null,
          wrapOperations: 0,
          wrapOperationLimit: request.wrapOperationLimit,
          rotation: {
            predecessorKeyId: request.predecessorKeyId,
            previousRootKeyId: null,
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
      use: (keyBytes: Uint8Array, record: ManagedKeyRecordV2) => Promise<Result>,
      operationOptions?: KeyCustodyOperationOptions
    ): Promise<Result> {
      const record = parseManagedKeyRecordV2(recordValue);
      assertWorkloadCanAccess(options.workload, record.keyClass, record.purpose);
      if (
        !isDecryptableStatus(record.status) ||
        !rootIsDecryptable(activeRoots, retiredRoots, record)
      ) {
        keyManagementFailure(KeyManagementErrorCode.KEY_STATE_INVALID, "Key is unavailable");
      }
      const ciphertext = decodeBase64Url(
        record.encryptedKeyMaterial,
        ENVIRONMENT_ENVELOPE_BYTES,
        ENVIRONMENT_ENVELOPE_BYTES
      );
      try {
        const response = await callEnvelopeService(
          () =>
            options.transport.decryptDataKey(
              {
                CiphertextBlob: ciphertext,
                EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
                EncryptionContext: keyEnvelopeContextForKey(record),
                KeyId: record.rootKeyId
              },
              transportOptions(operationOptions)
            ),
          operationOptions?.signal
        );
        assertEnvelopeResponseRoot(response.KeyId, record.rootKeyId, response.Plaintext);
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

  if (options.workload === "search_worker") {
    return Object.freeze({
      withUnwrappedIntermediateKey: runtimeCustodian.withUnwrappedIntermediateKey
    });
  }
  if (options.workload !== "interactive_api") return Object.freeze(runtimeCustodian);

  return Object.freeze({
    ...runtimeCustodian,
    async rewrapIntermediateKey(
      recordValue: unknown,
      rewrappedAt: string,
      operationOptions?: KeyCustodyOperationOptions
    ): Promise<ManagedKeyRecordV2> {
      const record = parseManagedKeyRecordV2(recordValue);
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
      if (record.rootKeyId === destinationRoot) return record;
      const ciphertext = decodeBase64Url(
        record.encryptedKeyMaterial,
        ENVIRONMENT_ENVELOPE_BYTES,
        ENVIRONMENT_ENVELOPE_BYTES
      );
      try {
        const context = keyEnvelopeContextForKey(record);
        const response = await callEnvelopeService(
          () =>
            options.transport.reEncryptDataKey(
              {
                CiphertextBlob: ciphertext,
                DestinationEncryptionAlgorithm: "SYMMETRIC_DEFAULT",
                DestinationEncryptionContext: context,
                DestinationKeyId: destinationRoot,
                SourceEncryptionAlgorithm: "SYMMETRIC_DEFAULT",
                SourceEncryptionContext: context,
                SourceKeyId: record.rootKeyId
              },
              transportOptions(operationOptions)
            ),
          operationOptions?.signal
        );
        assertEnvelopeResponseRoot(response.SourceKeyId, record.rootKeyId);
        assertEnvelopeResponseRoot(response.KeyId, destinationRoot);
        const encrypted = copyExactEnvelope(response);
        try {
          return parseManagedKeyRecordV2({
            ...record,
            encryptedKeyMaterial: encodeBase64Url(encrypted),
            rootKeyId: destinationRoot,
            rotation: {
              ...record.rotation,
              previousRootKeyId: record.rootKeyId,
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
