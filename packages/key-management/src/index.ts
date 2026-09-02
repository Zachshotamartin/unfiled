export {
  createAwsKmsEnvelopeCustodian,
  type AwsKmsEnvelopeCustodianOptions,
  type IndexWorkerEnvelopeCustodianOptions,
  type InteractiveEnvelopeCustodianOptions,
  type OrganizationWorkerEnvelopeCustodianOptions,
  type SearchWorkerEnvelopeCustodianOptions
} from "./aws-kms-custodian.js";
export {
  createAwsSdkKmsTransport,
  createVercelOidcKmsTransport,
  type AwsKmsTransport,
  type DecryptDataKeyRequest,
  type DecryptDataKeyResponse,
  type GenerateDataKeyRequest,
  type GenerateDataKeyResponse,
  type KmsClientLike,
  type KmsEncryptionContext,
  type KmsTransportOperationOptions,
  type ReEncryptDataKeyRequest,
  type ReEncryptDataKeyResponse,
  type VercelOidcKmsTransportOptions
} from "./aws-transport.js";
export {
  createVercelSensitiveEnvironmentKmsTransport,
  vercelSensitiveEnvironmentKeyConfiguration,
  type VercelSensitiveEnvironmentKmsTransportOptions
} from "./vercel-sensitive-environment-transport.js";
export {
  createVercelSensitiveEnvironmentEnvelopeCustodian,
  type VercelSensitiveEnvironmentEnvelopeCustodianOptions,
  type VercelSensitiveEnvironmentIndexWorkerEnvelopeCustodianOptions,
  type VercelSensitiveEnvironmentInteractiveEnvelopeCustodianOptions,
  type VercelSensitiveEnvironmentOrganizationWorkerEnvelopeCustodianOptions,
  type VercelSensitiveEnvironmentSearchWorkerEnvelopeCustodianOptions
} from "./vercel-sensitive-environment-custodian.js";
export {
  assertAiAssistedKmsReadiness,
  assertIndexWorkerKmsReadiness,
  type AiAssistedKmsReadinessOptions,
  type IndexWorkerKmsReadinessOptions
} from "./kms-readiness.js";
export {
  createLocalEnvironmentKeyResolver,
  localEnvironmentKeyConfiguration,
  type LocalEnvironmentKeyResolverForWorkload,
  type LocalEnvironmentKeyResolverOptions
} from "./local-environment.js";
export {
  KEY_CUSTODY_PROBE_CHECKS,
  runKeyCustodyProbe,
  type DirectPrivateKmsProbe,
  type KeyCustodyProbeCheck,
  type KeyCustodyProbeEvent,
  type KeyCustodyProbeOptions,
  type KeyCustodyProbeReport,
  type KeyCustodyPrivateDenialEvidence
} from "./custody-probe.js";
export { createManagedKeyResolver, type ManagedKeyResolverOptions } from "./managed-resolver.js";
export { keyEnvelopeContextForKey, kmsEncryptionContextForKey } from "./kms-context.js";
export {
  KEY_CLASSES,
  KEY_PURPOSES,
  KEY_STATUSES,
  KEY_WORKLOADS,
  VERCEL_DEPLOYMENT_ENVIRONMENTS,
  KeyManagementError,
  KeyManagementErrorCode,
  type AiAssistedRetiredRootKeySet,
  type AiAssistedRootKeySet,
  type CreateIntermediateKeyRequest,
  type DecryptOnlyIntermediateKeyCustodian,
  type DecryptOnlyOwnerBoundKeyResolver,
  type IntermediateKeyCustodian,
  type InteractiveKeyCustodian,
  type IndexWorkerRetiredRootKeySet,
  type IndexWorkerRootKeySet,
  type KeyBinding,
  type KeyClass,
  type KeyCustodyOperationOptions,
  type KeyManagementErrorCodeValue,
  type KeyPurpose,
  type KeyReference,
  type KeyRotationMetadata,
  type KeyRotationMetadataV2,
  type KeySelector,
  type KeyStatus,
  type KeyWorkload,
  type ManagedContentMacKey,
  type ManagedKeyRecord,
  type ManagedKeyRecordParser,
  type ManagedKeyRecordV1,
  type ManagedKeyRecordV2,
  type ManagedKeyStore,
  type ManagedObjectWrappingKey,
  type OwnerBoundKeyResolver,
  type PurposeRootKeySet,
  type RetiredRootKeySet,
  type RootKeySet,
  type SearchWorkerRetiredRootKeySet,
  type SearchWorkerRootKeySet,
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
  type VercelSensitiveEnvironmentWorkloadRootKeySet,
  type WorkloadRootKeySet
} from "./types.js";
export {
  DEFAULT_WRAP_OPERATION_LIMIT,
  assertCanonicalEncryptedKeyMaterial,
  assertAwsRegion,
  assertAwsRoleArn,
  assertIsoTimestamp,
  assertKmsKeyArn,
  assertVercelSensitiveEnvironmentRootKeyId,
  assertWorkloadCanAccess,
  isDecryptableStatus,
  normalizeCreateIntermediateKeyRequest,
  parseCreateIntermediateKeyRequest,
  parseKeyBinding,
  parseKeyReference,
  parseKeySelector,
  parseAnyManagedKeyRecord,
  parseManagedKeyRecord,
  parseManagedKeyRecordV1,
  parseManagedKeyRecordV2,
  parseRetiredRootKeySet,
  parseRootKeySet,
  parseWorkloadRootKeySet,
  parseVercelSensitiveEnvironmentRetiredRootKeySet,
  parseVercelSensitiveEnvironmentRootKeySet,
  parseVercelSensitiveEnvironmentWorkloadRootKeySet,
  sameBinding,
  sameSelector
} from "./validation.js";
