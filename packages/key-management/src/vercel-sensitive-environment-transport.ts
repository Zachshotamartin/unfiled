import { decodeBase64Url } from "./base64url.js";
import type {
  AwsKmsTransport,
  DecryptDataKeyRequest,
  DecryptDataKeyResponse,
  GenerateDataKeyRequest,
  GenerateDataKeyResponse,
  KmsEncryptionContext,
  KmsTransportOperationOptions,
  ReEncryptDataKeyRequest,
  ReEncryptDataKeyResponse
} from "./aws-transport.js";
import {
  KeyManagementErrorCode,
  keyManagementFailure,
  type VercelDeploymentEnvironment
} from "./types.js";

const CUSTODIAN_MODE = "vercel-sensitive-env-v1";
const CUSTODIAN_MODE_VARIABLE = "UNFILED_KEY_CUSTODIAN";
const ROOT_KEY_RING_VARIABLE = "UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1";
const LOCAL_KEY_RING_VARIABLE = "UNFILED_LOCAL_KEY_RING_V1";
const ROOT_KEY_BYTES = 32;
const DATA_KEY_BYTES = 32;
const IV_BYTES = 12;
const GCM_TAG_BITS = 128;
const GCM_TAG_BYTES = GCM_TAG_BITS / 8;
const MAX_KEY_RING_BYTES = 32_768;
const MAX_ROOT_KEYS = 100;
const MAX_CONTEXT_VALUE_BYTES = 512;
const ENVELOPE_PREFIX = Uint8Array.of(0x55, 0x46, 0x45, 0x4b, 0x01); // UFEK + v1
const ENVELOPE_BYTES = ENVELOPE_PREFIX.byteLength + IV_BYTES + DATA_KEY_BYTES + GCM_TAG_BYTES;
const VERCEL_PROJECT_ID_PATTERN = /^prj_[A-Za-z0-9]{6,100}$/u;
const ROOT_KEY_ID_PATTERN =
  /^urn:unfiled:key-root:vercel-sensitive-env-v1:(preview|production):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTEXT_KEYS = Object.freeze([
  "UnfiledKeyClass",
  "UnfiledKeyPurpose",
  "UnfiledKeyRecordId",
  "UnfiledOwnerId"
] as const);
const STATIC_AWS_CREDENTIAL_VARIABLES = Object.freeze([
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
  "AWS_ROLE_ARN",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SECURITY_TOKEN",
  "AWS_SESSION_TOKEN",
  "AWS_SHARED_CREDENTIALS_FILE"
] as const);

type EnvironmentRecord = Readonly<Record<string, string | undefined>>;
type RuntimeCrypto = Pick<Crypto, "getRandomValues" | "subtle">;
type OwnedBytes = Uint8Array<ArrayBuffer>;

type RootKeyRingEntry = Readonly<{
  keyMaterial: string;
  rootKeyId: string;
}>;

type RootKeyRing = Readonly<{
  deploymentEnvironment: VercelDeploymentEnvironment;
  projectId: string;
  roots: readonly RootKeyRingEntry[];
  version: 1;
}>;

export type VercelSensitiveEnvironmentKmsTransportOptions = Readonly<{
  crypto?: Crypto;
  environment?: EnvironmentRecord;
  expectedRootKeyIds: readonly string[];
}>;

type LoadedRootKey = Readonly<{
  key: CryptoKey;
  rootKeyId: string;
}>;

function configurationFailure(): never {
  return keyManagementFailure(
    KeyManagementErrorCode.CONFIGURATION_INVALID,
    "Vercel sensitive-environment key configuration is invalid"
  );
}

function operationFailure(): never {
  return keyManagementFailure(KeyManagementErrorCode.KMS_UNAVAILABLE, "Key service is unavailable");
}

function hasValue(environment: EnvironmentRecord, name: string): boolean {
  return (environment[name]?.trim().length ?? 0) > 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function ownedBytes(value: Uint8Array): OwnedBytes {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function runtimeCrypto(provided?: Crypto): RuntimeCrypto {
  const candidate =
    (provided as Partial<Crypto> | undefined) ??
    (globalThis as unknown as { crypto?: Partial<Crypto> }).crypto;
  if (
    candidate?.subtle === undefined ||
    typeof candidate.subtle.importKey !== "function" ||
    typeof candidate.subtle.encrypt !== "function" ||
    typeof candidate.subtle.decrypt !== "function" ||
    typeof candidate.getRandomValues !== "function"
  ) {
    configurationFailure();
  }
  return candidate as RuntimeCrypto;
}

function assertDeploymentIdentity(
  environment: EnvironmentRecord
): Readonly<{ deploymentEnvironment: VercelDeploymentEnvironment; projectId: string }> {
  const deploymentEnvironment = environment.VERCEL_ENV?.trim();
  const projectId = environment.VERCEL_PROJECT_ID?.trim();
  const hasPublicKeyMaterial = Object.keys(environment).some(
    (name) =>
      name.startsWith("NEXT_PUBLIC_") &&
      /(?:^|_)(?:KEK|MASTER_KEY|ROOT_KEY|KEY_BYTES|KEY_MATERIAL|KEY_RING)(?:_|$)/u.test(name) &&
      hasValue(environment, name)
  );
  const hasAwsWorkloadRole = Object.keys(environment).some(
    (name) => /^UNFILED_(?:[A-Z0-9]+_)*AWS_ROLE_ARN$/u.test(name) && hasValue(environment, name)
  );
  if (
    environment.NODE_ENV !== "production" ||
    environment.VERCEL !== "1" ||
    (deploymentEnvironment !== "preview" && deploymentEnvironment !== "production") ||
    environment.VERCEL_ENV !== deploymentEnvironment ||
    projectId === undefined ||
    environment.VERCEL_PROJECT_ID !== projectId ||
    !VERCEL_PROJECT_ID_PATTERN.test(projectId) ||
    environment[CUSTODIAN_MODE_VARIABLE] !== CUSTODIAN_MODE ||
    hasValue(environment, LOCAL_KEY_RING_VARIABLE) ||
    STATIC_AWS_CREDENTIAL_VARIABLES.some((name) => hasValue(environment, name)) ||
    hasAwsWorkloadRole ||
    hasPublicKeyMaterial
  ) {
    configurationFailure();
  }
  return Object.freeze({ deploymentEnvironment, projectId });
}

function parseExpectedRootKeyIds(
  values: readonly string[],
  deploymentEnvironment: VercelDeploymentEnvironment
): readonly string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_ROOT_KEYS) {
    configurationFailure();
  }
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (
      typeof value !== "string" ||
      value.trim() !== value ||
      ROOT_KEY_ID_PATTERN.exec(value)?.[1] !== deploymentEnvironment ||
      seen.has(value)
    ) {
      configurationFailure();
    }
    seen.add(value);
    roots.push(value);
  }
  return Object.freeze(roots);
}

function parseRootEntry(value: unknown): RootKeyRingEntry {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["keyMaterial", "rootKeyId"]) ||
    typeof value.rootKeyId !== "string" ||
    !ROOT_KEY_ID_PATTERN.test(value.rootKeyId) ||
    typeof value.keyMaterial !== "string"
  ) {
    configurationFailure();
  }
  try {
    const bytes = decodeBase64Url(value.keyMaterial, ROOT_KEY_BYTES, ROOT_KEY_BYTES);
    bytes.fill(0);
  } catch {
    configurationFailure();
  }
  return Object.freeze({ keyMaterial: value.keyMaterial, rootKeyId: value.rootKeyId });
}

function parseRootKeyRing(
  environment: EnvironmentRecord,
  identity: Readonly<{
    deploymentEnvironment: VercelDeploymentEnvironment;
    projectId: string;
  }>,
  expectedRootKeyIds: readonly string[]
): RootKeyRing {
  const raw = environment[ROOT_KEY_RING_VARIABLE];
  if (
    raw === undefined ||
    raw.length > MAX_KEY_RING_BYTES ||
    raw.trim() !== raw ||
    new TextEncoder().encode(raw).byteLength > MAX_KEY_RING_BYTES
  ) {
    configurationFailure();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    configurationFailure();
  }
  if (JSON.stringify(parsed) !== raw) configurationFailure();
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ["deploymentEnvironment", "projectId", "roots", "version"]) ||
    parsed.version !== 1 ||
    parsed.deploymentEnvironment !== identity.deploymentEnvironment ||
    parsed.projectId !== identity.projectId ||
    !Array.isArray(parsed.roots) ||
    parsed.roots.length < 1 ||
    parsed.roots.length > MAX_ROOT_KEYS
  ) {
    configurationFailure();
  }
  const roots = parsed.roots.map(parseRootEntry);
  const expected = new Set(expectedRootKeyIds);
  const identifiers = new Set<string>();
  const materials = new Set<string>();
  for (const root of roots) {
    if (
      !expected.has(root.rootKeyId) ||
      ROOT_KEY_ID_PATTERN.exec(root.rootKeyId)?.[1] !== identity.deploymentEnvironment ||
      identifiers.has(root.rootKeyId) ||
      materials.has(root.keyMaterial)
    ) {
      configurationFailure();
    }
    identifiers.add(root.rootKeyId);
    materials.add(root.keyMaterial);
  }
  if (identifiers.size !== expected.size) configurationFailure();
  return Object.freeze({
    deploymentEnvironment: identity.deploymentEnvironment,
    projectId: identity.projectId,
    roots: Object.freeze(roots),
    version: 1
  });
}

async function importRoots(
  ring: RootKeyRing,
  cryptoImplementation: RuntimeCrypto
): Promise<Map<string, LoadedRootKey>> {
  const loaded = new Map<string, LoadedRootKey>();
  try {
    for (const entry of ring.roots) {
      const bytes = decodeBase64Url(entry.keyMaterial, ROOT_KEY_BYTES, ROOT_KEY_BYTES);
      const importBytes = ownedBytes(bytes);
      try {
        const key = await cryptoImplementation.subtle.importKey(
          "raw",
          importBytes,
          { name: "AES-GCM", length: 256 },
          false,
          ["decrypt", "encrypt"]
        );
        loaded.set(entry.rootKeyId, Object.freeze({ key, rootKeyId: entry.rootKeyId }));
      } finally {
        bytes.fill(0);
        importBytes.fill(0);
      }
    }
    return loaded;
  } catch {
    loaded.clear();
    configurationFailure();
  }
}

function assertOpen(open: boolean, signal: AbortSignal | undefined): void {
  if (!open || signal?.aborted === true) operationFailure();
}

function hasUnsafeContextCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

function contextAdditionalData(rootKeyId: string, context: KmsEncryptionContext): OwnedBytes {
  if (!isRecord(context) || !hasExactKeys(context, CONTEXT_KEYS)) operationFailure();
  const ordered: [string, string][] = [];
  for (const key of CONTEXT_KEYS) {
    const value = context[key];
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      new TextEncoder().encode(value).byteLength > MAX_CONTEXT_VALUE_BYTES ||
      value.trim() !== value ||
      hasUnsafeContextCharacter(value)
    ) {
      operationFailure();
    }
    ordered.push([key, value]);
  }
  return ownedBytes(
    new TextEncoder().encode(
      JSON.stringify(["unfiled-environment-root-envelope", 1, rootKeyId, ordered])
    )
  );
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function parseEnvelope(value: Uint8Array): Readonly<{ ciphertext: OwnedBytes; iv: OwnedBytes }> {
  if (!(value instanceof Uint8Array) || value.byteLength !== ENVELOPE_BYTES) operationFailure();
  const prefix = value.subarray(0, ENVELOPE_PREFIX.byteLength);
  if (!sameBytes(prefix, ENVELOPE_PREFIX)) operationFailure();
  return Object.freeze({
    ciphertext: ownedBytes(value.subarray(ENVELOPE_PREFIX.byteLength + IV_BYTES)),
    iv: ownedBytes(
      value.subarray(ENVELOPE_PREFIX.byteLength, ENVELOPE_PREFIX.byteLength + IV_BYTES)
    )
  });
}

function buildEnvelope(iv: Uint8Array, ciphertext: Uint8Array): OwnedBytes {
  if (iv.byteLength !== IV_BYTES || ciphertext.byteLength !== DATA_KEY_BYTES + GCM_TAG_BYTES) {
    operationFailure();
  }
  const envelope = new Uint8Array(ENVELOPE_BYTES);
  envelope.set(ENVELOPE_PREFIX, 0);
  envelope.set(iv, ENVELOPE_PREFIX.byteLength);
  envelope.set(ciphertext, ENVELOPE_PREFIX.byteLength + IV_BYTES);
  return envelope;
}

/**
 * Creates a KMS-compatible envelope transport backed by project-scoped Vercel
 * Sensitive Environment Variables. Its provider-neutral root identifiers are
 * deliberately not AWS ARNs; integrating this mode therefore requires an
 * explicit provider-neutral managed-key record/storage version and cannot
 * silently masquerade as AWS KMS custody.
 *
 * This is an explicitly bounded private-beta custody mode. It preserves
 * application-layer encryption against a database-only disclosure, but unlike
 * managed KMS its root keys are exportable and present in the function process.
 */
export async function createVercelSensitiveEnvironmentKmsTransport(
  options: VercelSensitiveEnvironmentKmsTransportOptions
): Promise<AwsKmsTransport> {
  const environment = options.environment ?? process.env;
  const identity = assertDeploymentIdentity(environment);
  const expectedRootKeyIds = parseExpectedRootKeyIds(
    options.expectedRootKeyIds,
    identity.deploymentEnvironment
  );
  const ring = parseRootKeyRing(environment, identity, expectedRootKeyIds);
  const cryptoImplementation = runtimeCrypto(options.crypto);
  const roots = await importRoots(ring, cryptoImplementation);
  let open = true;

  function root(rootKeyId: string): LoadedRootKey {
    const value = roots.get(rootKeyId);
    if (value === undefined) operationFailure();
    return value;
  }

  async function encryptDataKey(
    key: LoadedRootKey,
    context: KmsEncryptionContext,
    plaintext: OwnedBytes,
    signal: AbortSignal | undefined
  ): Promise<OwnedBytes> {
    assertOpen(open, signal);
    if (plaintext.byteLength !== DATA_KEY_BYTES) operationFailure();
    let iv: OwnedBytes | undefined;
    let additionalData: OwnedBytes | undefined;
    let ciphertext: OwnedBytes | undefined;
    try {
      iv = cryptoImplementation.getRandomValues(new Uint8Array(IV_BYTES));
      additionalData = contextAdditionalData(key.rootKeyId, context);
      ciphertext = new Uint8Array(
        await cryptoImplementation.subtle.encrypt(
          { additionalData, iv, name: "AES-GCM", tagLength: GCM_TAG_BITS },
          key.key,
          plaintext
        )
      );
      assertOpen(open, signal);
      return buildEnvelope(iv, ciphertext);
    } catch {
      return operationFailure();
    } finally {
      iv?.fill(0);
      additionalData?.fill(0);
      ciphertext?.fill(0);
    }
  }

  async function decryptDataKey(
    key: LoadedRootKey,
    context: KmsEncryptionContext,
    envelopeBytes: Uint8Array,
    signal: AbortSignal | undefined
  ): Promise<OwnedBytes> {
    assertOpen(open, signal);
    const envelope = parseEnvelope(envelopeBytes);
    const additionalData = contextAdditionalData(key.rootKeyId, context);
    let plaintext: OwnedBytes | undefined;
    try {
      plaintext = new Uint8Array(
        await cryptoImplementation.subtle.decrypt(
          { additionalData, iv: envelope.iv, name: "AES-GCM", tagLength: GCM_TAG_BITS },
          key.key,
          envelope.ciphertext
        )
      );
      assertOpen(open, signal);
      if (plaintext.byteLength !== DATA_KEY_BYTES) operationFailure();
      const result = ownedBytes(plaintext);
      return result;
    } catch {
      return operationFailure();
    } finally {
      envelope.iv.fill(0);
      envelope.ciphertext.fill(0);
      additionalData.fill(0);
      plaintext?.fill(0);
    }
  }

  return Object.freeze({
    async decryptDataKey(
      input: DecryptDataKeyRequest,
      operationOptions?: KmsTransportOperationOptions
    ): Promise<DecryptDataKeyResponse> {
      const encryptionAlgorithm: unknown = input.EncryptionAlgorithm;
      if (encryptionAlgorithm !== "SYMMETRIC_DEFAULT") operationFailure();
      const selectedRoot = root(input.KeyId);
      const plaintext = await decryptDataKey(
        selectedRoot,
        input.EncryptionContext,
        input.CiphertextBlob,
        operationOptions?.abortSignal
      );
      return Object.freeze({ KeyId: selectedRoot.rootKeyId, Plaintext: plaintext });
    },

    destroy(): void {
      if (!open) return;
      open = false;
      roots.clear();
    },

    async generateDataKey(
      input: GenerateDataKeyRequest,
      operationOptions?: KmsTransportOperationOptions
    ): Promise<GenerateDataKeyResponse> {
      const keySpec: unknown = input.KeySpec;
      if (keySpec !== "AES_256") operationFailure();
      assertOpen(open, operationOptions?.abortSignal);
      const selectedRoot = root(input.KeyId);
      let plaintext: OwnedBytes | undefined;
      try {
        plaintext = cryptoImplementation.getRandomValues(new Uint8Array(DATA_KEY_BYTES));
        const ciphertext = await encryptDataKey(
          selectedRoot,
          input.EncryptionContext,
          plaintext,
          operationOptions?.abortSignal
        );
        return Object.freeze({
          CiphertextBlob: ciphertext,
          KeyId: selectedRoot.rootKeyId,
          Plaintext: ownedBytes(plaintext)
        });
      } catch {
        operationFailure();
      } finally {
        plaintext?.fill(0);
      }
    },

    async reEncryptDataKey(
      input: ReEncryptDataKeyRequest,
      operationOptions?: KmsTransportOperationOptions
    ): Promise<ReEncryptDataKeyResponse> {
      const sourceEncryptionAlgorithm: unknown = input.SourceEncryptionAlgorithm;
      const destinationEncryptionAlgorithm: unknown = input.DestinationEncryptionAlgorithm;
      if (
        sourceEncryptionAlgorithm !== "SYMMETRIC_DEFAULT" ||
        destinationEncryptionAlgorithm !== "SYMMETRIC_DEFAULT"
      ) {
        operationFailure();
      }
      const sourceRoot = root(input.SourceKeyId);
      const destinationRoot = root(input.DestinationKeyId);
      const plaintext = await decryptDataKey(
        sourceRoot,
        input.SourceEncryptionContext,
        input.CiphertextBlob,
        operationOptions?.abortSignal
      );
      try {
        const ciphertext = await encryptDataKey(
          destinationRoot,
          input.DestinationEncryptionContext,
          plaintext,
          operationOptions?.abortSignal
        );
        return Object.freeze({
          CiphertextBlob: ciphertext,
          KeyId: destinationRoot.rootKeyId,
          SourceKeyId: sourceRoot.rootKeyId
        });
      } catch {
        operationFailure();
      } finally {
        plaintext.fill(0);
      }
    }
  });
}

export const vercelSensitiveEnvironmentKeyConfiguration = Object.freeze({
  keyRingVariable: ROOT_KEY_RING_VARIABLE,
  mode: CUSTODIAN_MODE,
  modeVariable: CUSTODIAN_MODE_VARIABLE,
  rootKeyIdPrefix: "urn:unfiled:key-root:vercel-sensitive-env-v1:"
});
