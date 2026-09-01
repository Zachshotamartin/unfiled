import type {
  AwsKmsTransport,
  DecryptDataKeyResponse,
  GenerateDataKeyResponse,
  KmsTransportOperationOptions
} from "./aws-transport.js";
import { kmsEncryptionContextForKey } from "./kms-context.js";
import {
  KEY_PURPOSES,
  KeyManagementErrorCode,
  keyManagementFailure,
  type AiAssistedRootKeySet,
  type IndexWorkerRootKeySet,
  type KeyPurpose
} from "./types.js";
import { parseWorkloadRootKeySet } from "./validation.js";

const READINESS_OWNER_ID = "00000000-0000-4000-8000-000000000001";
const INTERMEDIATE_KEY_BYTES = 32;
const MAX_KMS_CIPHERTEXT_BYTES = 8_192;

type AiAssistedReadinessTransport = Pick<AwsKmsTransport, "decryptDataKey" | "generateDataKey">;

export type AiAssistedKmsReadinessOptions = Readonly<{
  activeRoots: AiAssistedRootKeySet;
  signal?: AbortSignal;
  transport: AiAssistedReadinessTransport;
}>;

export type IndexWorkerKmsReadinessOptions = Readonly<{
  activeRoots: IndexWorkerRootKeySet;
  signal?: AbortSignal;
  transport: AiAssistedReadinessTransport;
}>;

function transportOptions(
  signal: AbortSignal | undefined
): KmsTransportOperationOptions | undefined {
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

function responsePlaintext(
  response: GenerateDataKeyResponse | DecryptDataKeyResponse,
  expectedRoot: string
): Uint8Array {
  const plaintext = response.Plaintext;
  if (
    response.KeyId !== expectedRoot ||
    !(plaintext instanceof Uint8Array) ||
    plaintext.length !== INTERMEDIATE_KEY_BYTES
  ) {
    plaintext?.fill(0);
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key service response is invalid");
  }
  const copy = new Uint8Array(plaintext);
  plaintext.fill(0);
  return copy;
}

function responseCiphertext(response: GenerateDataKeyResponse): Uint8Array {
  const ciphertext = response.CiphertextBlob;
  if (
    !(ciphertext instanceof Uint8Array) ||
    ciphertext.length < 1 ||
    ciphertext.length > MAX_KMS_CIPHERTEXT_BYTES
  ) {
    ciphertext?.fill(0);
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key service response is invalid");
  }
  const copy = new Uint8Array(ciphertext);
  ciphertext.fill(0);
  return copy;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function assertPurposeReady(
  transport: AiAssistedReadinessTransport,
  purpose: KeyPurpose,
  rootKeyArn: string,
  signal: AbortSignal | undefined
): Promise<void> {
  const context = kmsEncryptionContextForKey({
    ownerId: READINESS_OWNER_ID,
    keyClass: "ai_assisted",
    purpose,
    keyId: `readiness.ai.${purpose.replaceAll("_", "-")}.v1`,
    keyVersion: 1
  });
  let generatedPlaintext: Uint8Array | undefined;
  let ciphertext: Uint8Array | undefined;
  let decryptedPlaintext: Uint8Array | undefined;
  try {
    const generated = await callKms(
      () =>
        transport.generateDataKey(
          {
            EncryptionContext: context,
            KeyId: rootKeyArn,
            KeySpec: "AES_256"
          },
          transportOptions(signal)
        ),
      signal
    );
    generatedPlaintext = responsePlaintext(generated, rootKeyArn);
    const generatedCiphertext = responseCiphertext(generated);
    ciphertext = generatedCiphertext;
    const decrypted = await callKms(
      () =>
        transport.decryptDataKey(
          {
            CiphertextBlob: generatedCiphertext,
            EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
            EncryptionContext: context,
            KeyId: rootKeyArn
          },
          transportOptions(signal)
        ),
      signal
    );
    decryptedPlaintext = responsePlaintext(decrypted, rootKeyArn);
    if (!sameBytes(generatedPlaintext, decryptedPlaintext)) {
      keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key service response is invalid");
    }
  } finally {
    generatedPlaintext?.fill(0);
    ciphertext?.fill(0);
    decryptedPlaintext?.fill(0);
  }
}

/**
 * Proves that the worker can generate and decrypt data keys under both AI-assisted roots.
 * Resolving successfully is the proof; no reusable or forgeable readiness token is returned.
 */
export async function assertAiAssistedKmsReadiness(
  options: AiAssistedKmsReadinessOptions
): Promise<void> {
  const roots = parseWorkloadRootKeySet(
    options.activeRoots,
    "organization_worker"
  ) as AiAssistedRootKeySet;
  for (const purpose of KEY_PURPOSES) {
    await assertPurposeReady(
      options.transport,
      purpose,
      roots.ai_assisted[purpose],
      options.signal
    );
  }
}

/**
 * Proves only the index worker's active AI-assisted object-wrap root. The
 * dedicated workload has no content-MAC root in its runtime configuration.
 */
export async function assertIndexWorkerKmsReadiness(
  options: IndexWorkerKmsReadinessOptions
): Promise<void> {
  const roots = parseWorkloadRootKeySet(
    options.activeRoots,
    "index_worker"
  ) as IndexWorkerRootKeySet;
  await assertPurposeReady(
    options.transport,
    "object_wrap",
    roots.ai_assisted.object_wrap,
    options.signal
  );
}
