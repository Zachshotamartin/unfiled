import {
  KEY_CLASSES,
  KEY_PURPOSES,
  KEY_STATUSES,
  KEY_WORKLOADS,
  KeyManagementErrorCode,
  keyManagementFailure,
  type AiAssistedRootKeySet,
  type IndexWorkerRootKeySet,
  type CreateIntermediateKeyRequest,
  type KeyBinding,
  type KeyClass,
  type KeyPurpose,
  type KeyReference,
  type KeyRotationMetadata,
  type KeyRotationMetadataV2,
  type KeySelector,
  type KeyStatus,
  type KeyWorkload,
  type ManagedKeyRecord,
  type ManagedKeyRecordV1,
  type ManagedKeyRecordV2,
  type RetiredRootKeySet,
  type RootKeySet,
  type VercelDeploymentEnvironment,
  type VercelSensitiveEnvironmentRetiredRootKeySet,
  type VercelSensitiveEnvironmentRootKeySet,
  type VercelSensitiveEnvironmentWorkloadRootKeySet,
  type WorkloadRootKeySet
} from "./types.js";
import { decodeBase64Url } from "./base64url.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const OWNER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KMS_KEY_ARN_PATTERN =
  /^arn:(?:aws|aws-cn|aws-us-gov):kms:[a-z]{2}(?:-gov)?-[a-z]+-\d:\d{12}:key\/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$/u;
const AWS_ROLE_ARN_PATTERN =
  /^arn:(?:aws|aws-cn|aws-us-gov):iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/u;
const AWS_REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const VERCEL_SENSITIVE_ENVIRONMENT_ROOT_KEY_ID_PATTERN =
  /^urn:unfiled:key-root:vercel-sensitive-env-v1:(preview|production):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_ENCRYPTED_KEY_BYTES = 8_192;
const VERCEL_SENSITIVE_ENVIRONMENT_ENVELOPE_BYTES = 65;
const VERCEL_SENSITIVE_ENVIRONMENT_ENVELOPE_PREFIX = Object.freeze([
  0x55, 0x46, 0x45, 0x4b, 0x01
] as const);
const MAX_KEY_VERSION = 2_147_483_647;
export const DEFAULT_WRAP_OPERATION_LIMIT = 2 ** 24;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function includes<const Values extends readonly string[]>(
  values: Values,
  value: unknown
): value is Values[number] {
  return typeof value === "string" && values.includes(value);
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 32) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function isKeyVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_KEY_VERSION;
}

function isCounter(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

function parseBindingFields(value: Readonly<Record<string, unknown>>): KeyBinding {
  if (
    typeof value.ownerId !== "string" ||
    !OWNER_ID_PATTERN.test(value.ownerId) ||
    !includes(KEY_CLASSES, value.keyClass) ||
    !includes(KEY_PURPOSES, value.purpose)
  ) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key binding is invalid");
  }
  return Object.freeze({
    ownerId: value.ownerId,
    keyClass: value.keyClass,
    purpose: value.purpose
  });
}

function parseSelectorFields(value: Readonly<Record<string, unknown>>): KeySelector {
  const binding = parseBindingFields(value);
  if (typeof value.keyId !== "string" || !IDENTIFIER_PATTERN.test(value.keyId)) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key reference is invalid");
  }
  return Object.freeze({ ...binding, keyId: value.keyId });
}

function parseRotation(value: unknown): KeyRotationMetadata {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "predecessorKeyId",
      "previousRootKeyArn",
      "rootRewrapCount",
      "lastRootRewrappedAt"
    ]) ||
    (value.predecessorKeyId !== null &&
      (typeof value.predecessorKeyId !== "string" ||
        !IDENTIFIER_PATTERN.test(value.predecessorKeyId))) ||
    (value.previousRootKeyArn !== null &&
      (typeof value.previousRootKeyArn !== "string" ||
        !KMS_KEY_ARN_PATTERN.test(value.previousRootKeyArn))) ||
    !isCounter(value.rootRewrapCount, 1_000_000) ||
    !isNullableTimestamp(value.lastRootRewrappedAt) ||
    (value.rootRewrapCount === 0
      ? value.previousRootKeyArn !== null || value.lastRootRewrappedAt !== null
      : value.previousRootKeyArn === null || value.lastRootRewrappedAt === null)
  ) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key rotation metadata is invalid");
  }
  return Object.freeze({
    predecessorKeyId: value.predecessorKeyId,
    previousRootKeyArn: value.previousRootKeyArn,
    rootRewrapCount: value.rootRewrapCount,
    lastRootRewrappedAt: value.lastRootRewrappedAt
  });
}

function parseRotationV2(value: unknown): KeyRotationMetadataV2 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "predecessorKeyId",
      "previousRootKeyId",
      "rootRewrapCount",
      "lastRootRewrappedAt"
    ]) ||
    (value.predecessorKeyId !== null &&
      (typeof value.predecessorKeyId !== "string" ||
        !IDENTIFIER_PATTERN.test(value.predecessorKeyId))) ||
    (value.previousRootKeyId !== null &&
      !isVercelSensitiveEnvironmentRootKeyId(value.previousRootKeyId)) ||
    !isCounter(value.rootRewrapCount, 1_000_000) ||
    !isNullableTimestamp(value.lastRootRewrappedAt) ||
    (value.rootRewrapCount === 0
      ? value.previousRootKeyId !== null || value.lastRootRewrappedAt !== null
      : value.previousRootKeyId === null || value.lastRootRewrappedAt === null)
  ) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key rotation metadata is invalid");
  }
  return Object.freeze({
    predecessorKeyId: value.predecessorKeyId,
    previousRootKeyId: value.previousRootKeyId,
    rootRewrapCount: value.rootRewrapCount,
    lastRootRewrappedAt: value.lastRootRewrappedAt
  });
}

function assertStatusTimestamps(
  status: KeyStatus,
  createdAt: string,
  activatedAt: string | null,
  retiredAt: string | null,
  revokedAt: string | null
): void {
  const shapeIsValid =
    (status === "pending" && activatedAt === null && retiredAt === null && revokedAt === null) ||
    (status === "active" && activatedAt !== null && retiredAt === null && revokedAt === null) ||
    (status === "retired" && activatedAt !== null && retiredAt !== null && revokedAt === null) ||
    (status === "revoked" && revokedAt !== null);
  const timestampsAreMonotonic =
    (activatedAt === null || Date.parse(activatedAt) >= Date.parse(createdAt)) &&
    (retiredAt === null ||
      (activatedAt !== null && Date.parse(retiredAt) >= Date.parse(activatedAt))) &&
    (revokedAt === null ||
      Date.parse(revokedAt) >= Date.parse(retiredAt ?? activatedAt ?? createdAt));
  if (!shapeIsValid || !timestampsAreMonotonic) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key lifecycle metadata is invalid");
  }
}

export function assertCanonicalEncryptedKeyMaterial(value: unknown): asserts value is string {
  if (typeof value !== "string" || !BASE64URL_PATTERN.test(value)) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Encrypted key material is invalid");
  }
  const bytes = decodeBase64Url(value, 1, MAX_ENCRYPTED_KEY_BYTES);
  try {
    if (bytes.length < 1 || bytes.length > MAX_ENCRYPTED_KEY_BYTES) {
      keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Encrypted key material is invalid");
    }
  } finally {
    bytes.fill(0);
  }
}

function assertCanonicalVercelSensitiveEnvironmentEnvelope(
  value: unknown
): asserts value is string {
  if (typeof value !== "string" || !BASE64URL_PATTERN.test(value)) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Encrypted key material is invalid");
  }
  const bytes = decodeBase64Url(
    value,
    VERCEL_SENSITIVE_ENVIRONMENT_ENVELOPE_BYTES,
    VERCEL_SENSITIVE_ENVIRONMENT_ENVELOPE_BYTES
  );
  try {
    if (
      VERCEL_SENSITIVE_ENVIRONMENT_ENVELOPE_PREFIX.some(
        (expected, index) => bytes[index] !== expected
      )
    ) {
      keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Encrypted key material is invalid");
    }
  } finally {
    bytes.fill(0);
  }
}

export function parseKeyBinding(value: unknown): KeyBinding {
  if (!isRecord(value) || !hasExactKeys(value, ["ownerId", "keyClass", "purpose"])) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key binding is invalid");
  }
  return parseBindingFields(value);
}

export function parseKeySelector(value: unknown): KeySelector {
  if (!isRecord(value) || !hasExactKeys(value, ["ownerId", "keyClass", "purpose", "keyId"])) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key reference is invalid");
  }
  return parseSelectorFields(value);
}

export function parseKeyReference(value: unknown): KeyReference {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["ownerId", "keyClass", "purpose", "keyId", "keyVersion"])
  ) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key reference is invalid");
  }
  const selector = parseSelectorFields(value);
  if (!isKeyVersion(value.keyVersion)) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key reference is invalid");
  }
  return Object.freeze({ ...selector, keyVersion: value.keyVersion });
}

export function parseCreateIntermediateKeyRequest(value: unknown): CreateIntermediateKeyRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "ownerId",
      "keyClass",
      "purpose",
      "keyId",
      "keyVersion",
      "createdAt",
      "predecessorKeyId",
      "wrapOperationLimit"
    ])
  ) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key creation request is invalid");
  }
  const reference = parseKeyReference({
    ownerId: value.ownerId,
    keyClass: value.keyClass,
    purpose: value.purpose,
    keyId: value.keyId,
    keyVersion: value.keyVersion
  });
  if (
    !isTimestamp(value.createdAt) ||
    (value.predecessorKeyId !== null &&
      (typeof value.predecessorKeyId !== "string" ||
        !IDENTIFIER_PATTERN.test(value.predecessorKeyId))) ||
    !isCounter(value.wrapOperationLimit, DEFAULT_WRAP_OPERATION_LIMIT) ||
    value.wrapOperationLimit === 0 ||
    value.predecessorKeyId === value.keyId
  ) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key creation request is invalid");
  }
  return Object.freeze({
    ...reference,
    createdAt: value.createdAt,
    predecessorKeyId: value.predecessorKeyId,
    wrapOperationLimit: value.wrapOperationLimit
  });
}

export function normalizeCreateIntermediateKeyRequest(
  value: CreateIntermediateKeyRequest
): CreateIntermediateKeyRequest {
  return parseCreateIntermediateKeyRequest({
    ...value,
    wrapOperationLimit: value.wrapOperationLimit ?? DEFAULT_WRAP_OPERATION_LIMIT
  });
}

export function parseManagedKeyRecordV1(value: unknown): ManagedKeyRecordV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "ownerId",
      "keyClass",
      "purpose",
      "keyId",
      "keyVersion",
      "status",
      "encryptedKeyMaterial",
      "rootKeyArn",
      "createdAt",
      "activatedAt",
      "retiredAt",
      "revokedAt",
      "wrapOperations",
      "wrapOperationLimit",
      "rotation"
    ]) ||
    value.schemaVersion !== 1
  ) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Managed key record is invalid");
  }
  const reference = parseKeyReference({
    ownerId: value.ownerId,
    keyClass: value.keyClass,
    purpose: value.purpose,
    keyId: value.keyId,
    keyVersion: value.keyVersion
  });
  if (
    !includes(KEY_STATUSES, value.status) ||
    typeof value.rootKeyArn !== "string" ||
    !KMS_KEY_ARN_PATTERN.test(value.rootKeyArn) ||
    !isTimestamp(value.createdAt) ||
    !isNullableTimestamp(value.activatedAt) ||
    !isNullableTimestamp(value.retiredAt) ||
    !isNullableTimestamp(value.revokedAt) ||
    !isCounter(value.wrapOperations, DEFAULT_WRAP_OPERATION_LIMIT) ||
    !isCounter(value.wrapOperationLimit, DEFAULT_WRAP_OPERATION_LIMIT) ||
    value.wrapOperationLimit === 0 ||
    value.wrapOperations > value.wrapOperationLimit
  ) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Managed key record is invalid");
  }
  assertCanonicalEncryptedKeyMaterial(value.encryptedKeyMaterial);
  assertStatusTimestamps(
    value.status,
    value.createdAt,
    value.activatedAt,
    value.retiredAt,
    value.revokedAt
  );
  const rotation = parseRotation(value.rotation);
  if (
    rotation.lastRootRewrappedAt !== null &&
    (Date.parse(rotation.lastRootRewrappedAt) < Date.parse(value.createdAt) ||
      (value.revokedAt !== null &&
        Date.parse(rotation.lastRootRewrappedAt) > Date.parse(value.revokedAt)))
  ) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key rotation metadata is invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    ...reference,
    status: value.status,
    encryptedKeyMaterial: value.encryptedKeyMaterial,
    rootKeyArn: value.rootKeyArn,
    createdAt: value.createdAt,
    activatedAt: value.activatedAt,
    retiredAt: value.retiredAt,
    revokedAt: value.revokedAt,
    wrapOperations: value.wrapOperations,
    wrapOperationLimit: value.wrapOperationLimit,
    rotation
  });
}

/** Backwards-compatible V1 parser retained for every existing AWS caller. */
export function parseManagedKeyRecord(value: unknown): ManagedKeyRecordV1 {
  return parseManagedKeyRecordV1(value);
}

export function parseManagedKeyRecordV2(value: unknown): ManagedKeyRecordV2 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "custodyProvider",
      "ownerId",
      "keyClass",
      "purpose",
      "keyId",
      "keyVersion",
      "status",
      "encryptedKeyMaterial",
      "rootKeyId",
      "wrapAlgorithm",
      "createdAt",
      "activatedAt",
      "retiredAt",
      "revokedAt",
      "wrapOperations",
      "wrapOperationLimit",
      "rotation"
    ]) ||
    value.schemaVersion !== 2 ||
    value.custodyProvider !== "vercel_sensitive_environment_v1" ||
    value.wrapAlgorithm !== "AES-256-GCM"
  ) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Managed key record is invalid");
  }
  const reference = parseKeyReference({
    ownerId: value.ownerId,
    keyClass: value.keyClass,
    purpose: value.purpose,
    keyId: value.keyId,
    keyVersion: value.keyVersion
  });
  if (
    !includes(KEY_STATUSES, value.status) ||
    !isVercelSensitiveEnvironmentRootKeyId(value.rootKeyId) ||
    !isTimestamp(value.createdAt) ||
    !isNullableTimestamp(value.activatedAt) ||
    !isNullableTimestamp(value.retiredAt) ||
    !isNullableTimestamp(value.revokedAt) ||
    !isCounter(value.wrapOperations, DEFAULT_WRAP_OPERATION_LIMIT) ||
    !isCounter(value.wrapOperationLimit, DEFAULT_WRAP_OPERATION_LIMIT) ||
    value.wrapOperationLimit === 0 ||
    value.wrapOperations > value.wrapOperationLimit
  ) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Managed key record is invalid");
  }
  assertCanonicalVercelSensitiveEnvironmentEnvelope(value.encryptedKeyMaterial);
  assertStatusTimestamps(
    value.status,
    value.createdAt,
    value.activatedAt,
    value.retiredAt,
    value.revokedAt
  );
  const rotation = parseRotationV2(value.rotation);
  if (
    (rotation.previousRootKeyId !== null &&
      rootKeyDeploymentEnvironment(rotation.previousRootKeyId) !==
        rootKeyDeploymentEnvironment(value.rootKeyId)) ||
    (rotation.lastRootRewrappedAt !== null &&
      (Date.parse(rotation.lastRootRewrappedAt) < Date.parse(value.createdAt) ||
        (value.revokedAt !== null &&
          Date.parse(rotation.lastRootRewrappedAt) > Date.parse(value.revokedAt))))
  ) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key rotation metadata is invalid");
  }
  return Object.freeze({
    schemaVersion: 2,
    custodyProvider: "vercel_sensitive_environment_v1",
    ...reference,
    status: value.status,
    encryptedKeyMaterial: value.encryptedKeyMaterial,
    rootKeyId: value.rootKeyId,
    wrapAlgorithm: "AES-256-GCM",
    createdAt: value.createdAt,
    activatedAt: value.activatedAt,
    retiredAt: value.retiredAt,
    revokedAt: value.revokedAt,
    wrapOperations: value.wrapOperations,
    wrapOperationLimit: value.wrapOperationLimit,
    rotation
  });
}

export function parseAnyManagedKeyRecord(value: unknown): ManagedKeyRecord {
  if (!isRecord(value)) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Managed key record is invalid");
  }
  if (value.schemaVersion === 1) return parseManagedKeyRecordV1(value);
  if (value.schemaVersion === 2) return parseManagedKeyRecordV2(value);
  keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Managed key record is invalid");
}

function rootKeyDeploymentEnvironment(value: string): VercelDeploymentEnvironment | null {
  const match = VERCEL_SENSITIVE_ENVIRONMENT_ROOT_KEY_ID_PATTERN.exec(value);
  return (match?.[1] as VercelDeploymentEnvironment | undefined) ?? null;
}

function isVercelSensitiveEnvironmentRootKeyId(
  value: unknown,
  expectedEnvironment?: VercelDeploymentEnvironment
): value is string {
  if (typeof value !== "string" || value.trim() !== value) return false;
  const deploymentEnvironment = rootKeyDeploymentEnvironment(value);
  return (
    deploymentEnvironment !== null &&
    (expectedEnvironment === undefined || deploymentEnvironment === expectedEnvironment)
  );
}

export function assertVercelSensitiveEnvironmentRootKeyId(
  value: unknown,
  deploymentEnvironment?: VercelDeploymentEnvironment
): asserts value is string {
  if (!isVercelSensitiveEnvironmentRootKeyId(value, deploymentEnvironment)) {
    keyManagementFailure(
      KeyManagementErrorCode.CONFIGURATION_INVALID,
      "Vercel sensitive-environment root-key configuration is invalid"
    );
  }
}

export function assertAwsRegion(value: unknown): asserts value is string {
  if (typeof value !== "string" || !AWS_REGION_PATTERN.test(value)) {
    keyManagementFailure(
      KeyManagementErrorCode.CONFIGURATION_INVALID,
      "AWS KMS configuration is invalid"
    );
  }
}

export function assertIsoTimestamp(value: unknown): asserts value is string {
  if (!isTimestamp(value)) {
    keyManagementFailure(KeyManagementErrorCode.KEY_INVALID, "Key timestamp is invalid");
  }
}

export function assertAwsRoleArn(value: unknown): asserts value is string {
  if (typeof value !== "string" || !AWS_ROLE_ARN_PATTERN.test(value)) {
    keyManagementFailure(
      KeyManagementErrorCode.CONFIGURATION_INVALID,
      "AWS KMS configuration is invalid"
    );
  }
}

export function assertKmsKeyArn(value: unknown): asserts value is string {
  if (typeof value !== "string" || !KMS_KEY_ARN_PATTERN.test(value)) {
    keyManagementFailure(
      KeyManagementErrorCode.CONFIGURATION_INVALID,
      "AWS KMS configuration is invalid"
    );
  }
}

function parseRootKeyClasses(
  value: unknown,
  requiredClasses: readonly KeyClass[],
  requiredPurposes: readonly KeyPurpose[] = KEY_PURPOSES
): Readonly<Partial<Record<KeyClass, Readonly<Partial<Record<KeyPurpose, string>>>>>> {
  if (!isRecord(value) || !hasExactKeys(value, requiredClasses)) {
    keyManagementFailure(
      KeyManagementErrorCode.CONFIGURATION_INVALID,
      "AWS KMS root-key configuration is invalid"
    );
  }
  const output: Partial<Record<KeyClass, Partial<Record<KeyPurpose, string>>>> = {};
  const seen = new Set<string>();
  for (const keyClass of requiredClasses) {
    const purposes = value[keyClass];
    if (!isRecord(purposes) || !hasExactKeys(purposes, requiredPurposes)) {
      keyManagementFailure(
        KeyManagementErrorCode.CONFIGURATION_INVALID,
        "AWS KMS root-key configuration is invalid"
      );
    }
    const parsedPurposes: Partial<Record<KeyPurpose, string>> = {};
    for (const purpose of requiredPurposes) {
      const arn = purposes[purpose];
      assertKmsKeyArn(arn);
      if (seen.has(arn)) {
        keyManagementFailure(
          KeyManagementErrorCode.CONFIGURATION_INVALID,
          "AWS KMS root-key configuration is invalid"
        );
      }
      seen.add(arn);
      parsedPurposes[purpose] = arn;
    }
    output[keyClass] = Object.freeze(parsedPurposes);
  }
  return Object.freeze(output);
}

export function parseRootKeySet(value: unknown): RootKeySet {
  return parseRootKeyClasses(value, KEY_CLASSES) as RootKeySet;
}

export function parseWorkloadRootKeySet(value: unknown, workload: KeyWorkload): WorkloadRootKeySet {
  assertWorkload(workload);
  if (workload === "index_worker" || workload === "search_worker") {
    return parseRootKeyClasses(value, ["ai_assisted"], ["object_wrap"]) as IndexWorkerRootKeySet;
  }
  if (workload === "organization_worker") {
    return parseRootKeyClasses(value, ["ai_assisted"]) as AiAssistedRootKeySet;
  }
  return parseRootKeySet(value);
}

export function parseRetiredRootKeySet(
  value: RetiredRootKeySet | undefined,
  active: WorkloadRootKeySet
): RetiredRootKeySet {
  if (value === undefined) return Object.freeze({});
  const activeByClass = active as Readonly<
    Partial<Record<KeyClass, Readonly<Partial<Record<KeyPurpose, string>>>>>
  >;
  const activeClasses = KEY_CLASSES.filter((keyClass) => activeByClass[keyClass] !== undefined);
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !activeClasses.includes(key as KeyClass))
  ) {
    keyManagementFailure(
      KeyManagementErrorCode.CONFIGURATION_INVALID,
      "AWS KMS retired root-key configuration is invalid"
    );
  }
  const activePurposesByClass = Object.fromEntries(
    activeClasses.map((keyClass) => [
      keyClass,
      KEY_PURPOSES.filter((purpose) => activeByClass[keyClass]?.[purpose] !== undefined)
    ])
  ) as Readonly<Partial<Record<KeyClass, readonly KeyPurpose[]>>>;
  const activeArns = new Set(
    activeClasses.flatMap((keyClass) =>
      (activePurposesByClass[keyClass] ?? []).flatMap((purpose) => {
        const arn = activeByClass[keyClass]?.[purpose];
        return arn === undefined ? [] : [arn];
      })
    )
  );
  const allRetired = new Set<string>();
  const output: Partial<Record<KeyClass, Partial<Record<KeyPurpose, readonly string[]>>>> = {};
  for (const keyClass of activeClasses) {
    const purposes = value[keyClass];
    if (purposes === undefined) continue;
    const allowedPurposes = activePurposesByClass[keyClass] ?? [];
    if (
      !isRecord(purposes) ||
      Object.keys(purposes).some((key) => !includes(allowedPurposes, key))
    ) {
      keyManagementFailure(
        KeyManagementErrorCode.CONFIGURATION_INVALID,
        "AWS KMS retired root-key configuration is invalid"
      );
    }
    const parsedPurposes: Partial<Record<KeyPurpose, readonly string[]>> = {};
    for (const purpose of allowedPurposes) {
      const arns = purposes[purpose];
      if (arns === undefined) continue;
      if (!Array.isArray(arns) || arns.length > 20) {
        keyManagementFailure(
          KeyManagementErrorCode.CONFIGURATION_INVALID,
          "AWS KMS retired root-key configuration is invalid"
        );
      }
      const parsedArns = arns.map((arn) => {
        assertKmsKeyArn(arn);
        if (activeArns.has(arn) || allRetired.has(arn)) {
          keyManagementFailure(
            KeyManagementErrorCode.CONFIGURATION_INVALID,
            "AWS KMS retired root-key configuration is invalid"
          );
        }
        allRetired.add(arn);
        return arn;
      });
      parsedPurposes[purpose] = Object.freeze(parsedArns);
    }
    output[keyClass] = Object.freeze(parsedPurposes);
  }
  return Object.freeze(output);
}

function assertVercelDeploymentEnvironment(
  value: unknown
): asserts value is VercelDeploymentEnvironment {
  if (value !== "preview" && value !== "production") {
    keyManagementFailure(
      KeyManagementErrorCode.CONFIGURATION_INVALID,
      "Vercel sensitive-environment root-key configuration is invalid"
    );
  }
}

function parseVercelSensitiveEnvironmentRootKeyClasses(
  value: unknown,
  requiredClasses: readonly KeyClass[],
  deploymentEnvironment: VercelDeploymentEnvironment,
  requiredPurposes: readonly KeyPurpose[] = KEY_PURPOSES
): Readonly<Partial<Record<KeyClass, Readonly<Partial<Record<KeyPurpose, string>>>>>> {
  assertVercelDeploymentEnvironment(deploymentEnvironment);
  if (!isRecord(value) || !hasExactKeys(value, requiredClasses)) {
    keyManagementFailure(
      KeyManagementErrorCode.CONFIGURATION_INVALID,
      "Vercel sensitive-environment root-key configuration is invalid"
    );
  }
  const output: Partial<Record<KeyClass, Partial<Record<KeyPurpose, string>>>> = {};
  const seen = new Set<string>();
  for (const keyClass of requiredClasses) {
    const purposes = value[keyClass];
    if (!isRecord(purposes) || !hasExactKeys(purposes, requiredPurposes)) {
      keyManagementFailure(
        KeyManagementErrorCode.CONFIGURATION_INVALID,
        "Vercel sensitive-environment root-key configuration is invalid"
      );
    }
    const parsedPurposes: Partial<Record<KeyPurpose, string>> = {};
    for (const purpose of requiredPurposes) {
      const rootKeyId = purposes[purpose];
      assertVercelSensitiveEnvironmentRootKeyId(rootKeyId, deploymentEnvironment);
      if (seen.has(rootKeyId)) {
        keyManagementFailure(
          KeyManagementErrorCode.CONFIGURATION_INVALID,
          "Vercel sensitive-environment root-key configuration is invalid"
        );
      }
      seen.add(rootKeyId);
      parsedPurposes[purpose] = rootKeyId;
    }
    output[keyClass] = Object.freeze(parsedPurposes);
  }
  return Object.freeze(output);
}

export function parseVercelSensitiveEnvironmentRootKeySet(
  value: unknown,
  deploymentEnvironment: VercelDeploymentEnvironment
): VercelSensitiveEnvironmentRootKeySet {
  return parseVercelSensitiveEnvironmentRootKeyClasses(
    value,
    KEY_CLASSES,
    deploymentEnvironment
  ) as VercelSensitiveEnvironmentRootKeySet;
}

export function parseVercelSensitiveEnvironmentWorkloadRootKeySet(
  value: unknown,
  workload: KeyWorkload,
  deploymentEnvironment: VercelDeploymentEnvironment
): VercelSensitiveEnvironmentWorkloadRootKeySet {
  assertWorkload(workload);
  if (workload === "index_worker" || workload === "search_worker") {
    return parseVercelSensitiveEnvironmentRootKeyClasses(
      value,
      ["ai_assisted"],
      deploymentEnvironment,
      ["object_wrap"]
    ) as VercelSensitiveEnvironmentWorkloadRootKeySet;
  }
  if (workload === "organization_worker") {
    return parseVercelSensitiveEnvironmentRootKeyClasses(
      value,
      ["ai_assisted"],
      deploymentEnvironment
    ) as VercelSensitiveEnvironmentWorkloadRootKeySet;
  }
  return parseVercelSensitiveEnvironmentRootKeySet(value, deploymentEnvironment);
}

export function parseVercelSensitiveEnvironmentRetiredRootKeySet(
  value: VercelSensitiveEnvironmentRetiredRootKeySet | undefined,
  active: VercelSensitiveEnvironmentWorkloadRootKeySet,
  deploymentEnvironment: VercelDeploymentEnvironment
): VercelSensitiveEnvironmentRetiredRootKeySet {
  assertVercelDeploymentEnvironment(deploymentEnvironment);
  if (value === undefined) return Object.freeze({});
  const activeByClass = active as Readonly<
    Partial<Record<KeyClass, Readonly<Partial<Record<KeyPurpose, string>>>>>
  >;
  const activeClasses = KEY_CLASSES.filter((keyClass) => activeByClass[keyClass] !== undefined);
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !activeClasses.includes(key as KeyClass))
  ) {
    keyManagementFailure(
      KeyManagementErrorCode.CONFIGURATION_INVALID,
      "Vercel sensitive-environment retired root-key configuration is invalid"
    );
  }
  const activePurposesByClass = Object.fromEntries(
    activeClasses.map((keyClass) => [
      keyClass,
      KEY_PURPOSES.filter((purpose) => activeByClass[keyClass]?.[purpose] !== undefined)
    ])
  ) as Readonly<Partial<Record<KeyClass, readonly KeyPurpose[]>>>;
  const activeRootKeyIds = new Set(
    activeClasses.flatMap((keyClass) =>
      (activePurposesByClass[keyClass] ?? []).flatMap((purpose) => {
        const rootKeyId = activeByClass[keyClass]?.[purpose];
        return rootKeyId === undefined ? [] : [rootKeyId];
      })
    )
  );
  const allRetired = new Set<string>();
  const output: Partial<Record<KeyClass, Partial<Record<KeyPurpose, readonly string[]>>>> = {};
  for (const keyClass of activeClasses) {
    const purposes = value[keyClass];
    if (purposes === undefined) continue;
    const allowedPurposes = activePurposesByClass[keyClass] ?? [];
    if (
      !isRecord(purposes) ||
      Object.keys(purposes).some((key) => !includes(allowedPurposes, key))
    ) {
      keyManagementFailure(
        KeyManagementErrorCode.CONFIGURATION_INVALID,
        "Vercel sensitive-environment retired root-key configuration is invalid"
      );
    }
    const parsedPurposes: Partial<Record<KeyPurpose, readonly string[]>> = {};
    for (const purpose of allowedPurposes) {
      const rootKeyIds = purposes[purpose];
      if (rootKeyIds === undefined) continue;
      if (!Array.isArray(rootKeyIds) || rootKeyIds.length > 20) {
        keyManagementFailure(
          KeyManagementErrorCode.CONFIGURATION_INVALID,
          "Vercel sensitive-environment retired root-key configuration is invalid"
        );
      }
      const parsedRootKeyIds = rootKeyIds.map((rootKeyId) => {
        assertVercelSensitiveEnvironmentRootKeyId(rootKeyId, deploymentEnvironment);
        if (activeRootKeyIds.has(rootKeyId) || allRetired.has(rootKeyId)) {
          keyManagementFailure(
            KeyManagementErrorCode.CONFIGURATION_INVALID,
            "Vercel sensitive-environment retired root-key configuration is invalid"
          );
        }
        allRetired.add(rootKeyId);
        return rootKeyId;
      });
      parsedPurposes[purpose] = Object.freeze(parsedRootKeyIds);
    }
    output[keyClass] = Object.freeze(parsedPurposes);
  }
  return Object.freeze(output);
}

export function assertWorkload(value: unknown): asserts value is KeyWorkload {
  if (!includes(KEY_WORKLOADS, value)) {
    keyManagementFailure(
      KeyManagementErrorCode.CONFIGURATION_INVALID,
      "Key workload configuration is invalid"
    );
  }
}

export function assertWorkloadCanAccess(
  workload: KeyWorkload,
  keyClass: KeyClass,
  purpose?: KeyPurpose
): void {
  assertWorkload(workload);
  if (
    (workload === "organization_worker" && keyClass === "private_manual") ||
    ((workload === "index_worker" || workload === "search_worker") &&
      (keyClass !== "ai_assisted" || purpose !== "object_wrap"))
  ) {
    keyManagementFailure(KeyManagementErrorCode.ACCESS_DENIED, "Key access is denied");
  }
}

export function sameBinding(left: KeyBinding, right: KeyBinding): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.keyClass === right.keyClass &&
    left.purpose === right.purpose
  );
}

export function sameSelector(left: KeySelector, right: KeySelector): boolean {
  return sameBinding(left, right) && left.keyId === right.keyId;
}

export function isDecryptableStatus(status: KeyStatus): boolean {
  return status === "active" || status === "retired";
}
