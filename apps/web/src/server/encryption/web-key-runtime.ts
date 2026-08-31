import {
  createAwsKmsEnvelopeCustodian,
  createLocalEnvironmentKeyResolver,
  createVercelOidcKmsTransport,
  type CreateIntermediateKeyRequest,
  type InteractiveKeyCustodian,
  type KeyCustodyOperationOptions,
  type ManagedKeyRecordV1,
  type OwnerBoundKeyResolver,
  type RetiredRootKeySet,
  type RootKeySet
} from "@unfiled/key-management";

import { ConfigurationError } from "@/server/api/errors";

const ROOT_REGISTRY_VARIABLE = "UNFILED_WEB_ROOT_KEY_REGISTRY_JSON";
const MAX_ROOT_REGISTRY_BYTES = 65_536;
const MAX_ROOT_GENERATIONS = 88;
const MAX_RETIRED_ROOTS_PER_PAIR = 20;
const MAX_GENERATION = 2_147_483_647;

const KEY_CLASSES = ["ai_assisted", "private_manual"] as const;
const KEY_PURPOSES = ["object_wrap", "content_mac"] as const;
const ROOT_STATUSES = ["active", "retired", "staged"] as const;

type WebKeyClass = (typeof KEY_CLASSES)[number];
type WebKeyPurpose = (typeof KEY_PURPOSES)[number];
type WebRootStatus = (typeof ROOT_STATUSES)[number];
type PairId = `${WebKeyClass}/${WebKeyPurpose}`;

const PAIRS = Object.freeze(
  KEY_CLASSES.flatMap((keyClass) => KEY_PURPOSES.map((purpose): PairId => `${keyClass}/${purpose}`))
);

const STATIC_AWS_CREDENTIAL_VARIABLES = [
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SECURITY_TOKEN",
  "AWS_SESSION_TOKEN",
  "AWS_SHARED_CREDENTIALS_FILE"
] as const;

const LEGACY_ROOT_CONFIGURATION_VARIABLES = [
  "UNFILED_AI_ASSISTED_KEK_B64URL",
  "UNFILED_AI_CONTENT_MAC_KMS_KEY_ARN",
  "UNFILED_AI_KMS_KEY_ID",
  "UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN",
  "UNFILED_CONTENT_FINGERPRINT_KEY",
  "UNFILED_CONTENT_KEK",
  "UNFILED_CONTENT_KEK_ID",
  "UNFILED_CONTENT_RETIRED_KEKS",
  "UNFILED_PRIVATE_CONTENT_MAC_KMS_KEY_ARN",
  "UNFILED_PRIVATE_KMS_KEY_ARN",
  "UNFILED_PRIVATE_KMS_KEY_ID",
  "UNFILED_PRIVATE_MANUAL_KEK_B64URL",
  "UNFILED_PRIVATE_MANUAL_KMS_KEY_ARN",
  "UNFILED_PRIVATE_OBJECT_WRAP_KMS_KEY_ARN"
] as const;

const PUBLIC_KEY_CONFIGURATION_VARIABLES = [
  "NEXT_PUBLIC_UNFILED_AWS_ROLE_ARN",
  "NEXT_PUBLIC_UNFILED_WEB_ROOT_KEY_REGISTRY_JSON"
] as const;

const ROLE_ARN_PATTERN =
  /^arn:(aws(?:-us-gov|-cn)?):iam::([0-9]{12}):role\/[A-Za-z0-9+=,.@_/-]{1,512}$/u;
const KMS_KEY_ARN_PATTERN =
  /^arn:(aws(?:-us-gov|-cn)?):kms:([a-z]{2}(?:-gov)?-[a-z]+-[0-9]+):([0-9]{12}):key\/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$/u;
const REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]+$/u;
const REGISTRY_ID_PROPERTY_PATTERN =
  /"((?:ai_assisted|private_manual)_(?:object_wrap|content_mac)_v[0-9]+)"\s*:/gu;

export type WebKeyRuntimeEnvironment = Readonly<Record<string, string | undefined>>;

type ProductionRuntimeConfiguration = Readonly<{
  activeRoots: RootKeySet;
  environment: WebKeyRuntimeEnvironment;
  kind: "aws-oidc";
  region: string;
  retiredRoots: RetiredRootKeySet;
  roleArn: string;
}>;

type LocalRuntimeConfiguration = Readonly<{
  environment: WebKeyRuntimeEnvironment;
  kind: "local";
}>;

type WebKeyRuntimeConfiguration = LocalRuntimeConfiguration | ProductionRuntimeConfiguration;

export type AwsInteractiveWebKeyRuntime = Readonly<{
  kind: "aws-oidc";
  withInteractiveCustodian<Result>(
    signal: AbortSignal,
    use: (custodian: InteractiveKeyCustodian) => Promise<Result>
  ): Promise<Result>;
}>;

export type LocalInteractiveWebKeyRuntime = Readonly<{
  keyResolver: OwnerBoundKeyResolver;
  kind: "local";
}>;

export type InteractiveWebKeyRuntime = AwsInteractiveWebKeyRuntime | LocalInteractiveWebKeyRuntime;

export type InteractiveWebKeyRuntimeOptions = Readonly<{
  crypto?: Crypto;
  environment?: WebKeyRuntimeEnvironment;
}>;

type RegistryEntry = Readonly<{
  generation: number;
  keyClass: WebKeyClass;
  kmsKeyArn: string;
  purpose: WebKeyPurpose;
  status: WebRootStatus;
}>;

type ParsedArn = Readonly<{
  accountId: string;
  arn: string;
  partition: string;
  region: string;
}>;

function configurationFailure(): never {
  throw new ConfigurationError();
}

function assertSignalOpen(signal: AbortSignal): void {
  if (signal.aborted) configurationFailure();
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

function hasValue(environment: WebKeyRuntimeEnvironment, name: string): boolean {
  return (environment[name]?.trim().length ?? 0) > 0;
}

function required(environment: WebKeyRuntimeEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) configurationFailure();
  return value;
}

function includes<const Values extends readonly string[]>(
  values: Values,
  value: unknown
): value is Values[number] {
  return typeof value === "string" && values.includes(value);
}

function assertNoStaticAwsCredentials(environment: WebKeyRuntimeEnvironment): void {
  if (STATIC_AWS_CREDENTIAL_VARIABLES.some((name) => hasValue(environment, name))) {
    configurationFailure();
  }
}

function assertNoPublicKeyConfiguration(environment: WebKeyRuntimeEnvironment): void {
  const hasKnownPublicValue = PUBLIC_KEY_CONFIGURATION_VARIABLES.some((name) =>
    hasValue(environment, name)
  );
  const hasUnknownPublicKeyValue = Object.keys(environment).some(
    (name) =>
      name.startsWith("NEXT_PUBLIC_UNFILED_") &&
      /(?:^|_)(?:AWS_ROLE|KEK|KEY|ROOT)(?:_|$)/u.test(name) &&
      hasValue(environment, name)
  );
  if (hasKnownPublicValue || hasUnknownPublicKeyValue) {
    configurationFailure();
  }
}

function assertNoProductionRootBytes(environment: WebKeyRuntimeEnvironment): void {
  const hasKnownLegacyValue = LEGACY_ROOT_CONFIGURATION_VARIABLES.some((name) =>
    hasValue(environment, name)
  );
  const hasUnknownKeyMaterialValue = Object.keys(environment).some(
    (name) =>
      name !== ROOT_REGISTRY_VARIABLE &&
      name.startsWith("UNFILED_") &&
      /(?:^|_)(?:KEK|MASTER_KEY|ROOT_KEY|KEY_BYTES|KEY_MATERIAL|KEY_RING)(?:_|$)/u.test(name) &&
      hasValue(environment, name)
  );
  if (hasKnownLegacyValue || hasUnknownKeyMaterialValue) configurationFailure();
}

function partitionOwnsRegion(partition: string, region: string): boolean {
  if (partition === "aws-cn") return region.startsWith("cn-");
  if (partition === "aws-us-gov") return region.startsWith("us-gov-");
  return partition === "aws" && !region.startsWith("cn-") && !region.startsWith("us-gov-");
}

function parseRootArn(value: string): ParsedArn {
  const match = KMS_KEY_ARN_PATTERN.exec(value);
  const partition = match?.[1];
  const region = match?.[2];
  const accountId = match?.[3];
  if (
    partition === undefined ||
    region === undefined ||
    accountId === undefined ||
    !partitionOwnsRegion(partition, region)
  ) {
    configurationFailure();
  }
  return Object.freeze({ accountId, arn: value, partition, region });
}

function parseRegistryEntry(registryId: string, value: unknown): RegistryEntry {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["generation", "key_class", "kms_key_arn", "purpose", "status"]) ||
    !includes(KEY_CLASSES, value.key_class) ||
    !includes(KEY_PURPOSES, value.purpose) ||
    !includes(ROOT_STATUSES, value.status) ||
    !Number.isSafeInteger(value.generation) ||
    Number(value.generation) < 1 ||
    Number(value.generation) > MAX_GENERATION ||
    typeof value.kms_key_arn !== "string"
  ) {
    configurationFailure();
  }
  const generation = Number(value.generation);
  if (registryId !== `${value.key_class}_${value.purpose}_v${generation}`) {
    configurationFailure();
  }
  parseRootArn(value.kms_key_arn);
  return Object.freeze({
    generation,
    keyClass: value.key_class,
    kmsKeyArn: value.kms_key_arn,
    purpose: value.purpose,
    status: value.status
  });
}

function parseRegistry(environment: WebKeyRuntimeEnvironment): readonly RegistryEntry[] {
  const raw = environment[ROOT_REGISTRY_VARIABLE];
  if (raw === undefined || new TextEncoder().encode(raw).byteLength > MAX_ROOT_REGISTRY_BYTES) {
    configurationFailure();
  }
  const serialized = raw.trim();
  if (serialized.length === 0) configurationFailure();
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed)) configurationFailure();
    const records = Object.entries(parsed);
    const serializedRegistryIds = [...serialized.matchAll(REGISTRY_ID_PROPERTY_PATTERN)].map(
      (match) => match[1]
    );
    if (records.length < PAIRS.length || records.length > MAX_ROOT_GENERATIONS) {
      configurationFailure();
    }
    if (
      serializedRegistryIds.length !== records.length ||
      new Set(serializedRegistryIds).size !== serializedRegistryIds.length
    ) {
      configurationFailure();
    }
    const entries = records.map(([registryId, value]) => parseRegistryEntry(registryId, value));
    const arns = new Set<string>();
    const generations = new Set<string>();
    for (const entry of entries) {
      const generationIdentity = `${entry.keyClass}/${entry.purpose}/${entry.generation}`;
      if (arns.has(entry.kmsKeyArn) || generations.has(generationIdentity)) {
        configurationFailure();
      }
      arns.add(entry.kmsKeyArn);
      generations.add(generationIdentity);
    }
    return Object.freeze(entries);
  } catch (error: unknown) {
    if (error instanceof ConfigurationError) throw error;
    configurationFailure();
  }
}

function buildRootSets(
  entries: readonly RegistryEntry[],
  expected: Readonly<{ accountId: string; partition: string; region: string }>
): Readonly<{ activeRoots: RootKeySet; retiredRoots: RetiredRootKeySet }> {
  const byPair = new Map<PairId, RegistryEntry[]>(PAIRS.map((pair) => [pair, []]));
  for (const entry of entries) {
    const arn = parseRootArn(entry.kmsKeyArn);
    if (
      arn.partition !== expected.partition ||
      arn.region !== expected.region ||
      arn.accountId !== expected.accountId
    ) {
      configurationFailure();
    }
    byPair.get(`${entry.keyClass}/${entry.purpose}`)?.push(entry);
  }

  const activeRoots = {
    ai_assisted: { content_mac: "", object_wrap: "" },
    private_manual: { content_mac: "", object_wrap: "" }
  };
  const retiredRoots: Record<WebKeyClass, Record<WebKeyPurpose, string[]>> = {
    ai_assisted: { content_mac: [], object_wrap: [] },
    private_manual: { content_mac: [], object_wrap: [] }
  };

  for (const pair of PAIRS) {
    const [keyClass, purpose] = pair.split("/") as [WebKeyClass, WebKeyPurpose];
    const pairEntries = byPair.get(pair) ?? [];
    const active = pairEntries.filter((entry) => entry.status === "active");
    const retired = pairEntries.filter((entry) => entry.status === "retired");
    const staged = pairEntries.filter((entry) => entry.status === "staged");
    if (active.length !== 1 || retired.length > MAX_RETIRED_ROOTS_PER_PAIR || staged.length > 1) {
      configurationFailure();
    }
    const activeEntry = active[0];
    if (activeEntry === undefined) configurationFailure();
    if (
      retired.some((entry) => entry.generation >= activeEntry.generation) ||
      staged.some((entry) => entry.generation <= activeEntry.generation)
    ) {
      configurationFailure();
    }
    activeRoots[keyClass][purpose] = activeEntry.kmsKeyArn;
    retiredRoots[keyClass][purpose].push(...retired.map((entry) => entry.kmsKeyArn));
  }

  return Object.freeze({
    activeRoots: Object.freeze({
      ai_assisted: Object.freeze({ ...activeRoots.ai_assisted }),
      private_manual: Object.freeze({ ...activeRoots.private_manual })
    }),
    retiredRoots: Object.freeze({
      ai_assisted: Object.freeze({
        content_mac: Object.freeze([...retiredRoots.ai_assisted.content_mac]),
        object_wrap: Object.freeze([...retiredRoots.ai_assisted.object_wrap])
      }),
      private_manual: Object.freeze({
        content_mac: Object.freeze([...retiredRoots.private_manual.content_mac]),
        object_wrap: Object.freeze([...retiredRoots.private_manual.object_wrap])
      })
    })
  });
}

function productionConfiguration(
  environment: WebKeyRuntimeEnvironment
): ProductionRuntimeConfiguration {
  if (
    environment.NODE_ENV !== "production" ||
    environment.VERCEL !== "1" ||
    environment.VERCEL_ENV !== "production" ||
    hasValue(environment, "UNFILED_KEY_CUSTODIAN") ||
    hasValue(environment, "UNFILED_LOCAL_KEY_RING_V1")
  ) {
    configurationFailure();
  }
  assertNoProductionRootBytes(environment);

  const region = required(environment, "UNFILED_AWS_REGION");
  const roleArn = required(environment, "UNFILED_AWS_ROLE_ARN");
  const role = ROLE_ARN_PATTERN.exec(roleArn);
  const partition = role?.[1];
  const accountId = role?.[2];
  if (
    !REGION_PATTERN.test(region) ||
    partition === undefined ||
    accountId === undefined ||
    !partitionOwnsRegion(partition, region)
  ) {
    configurationFailure();
  }
  const roots = buildRootSets(parseRegistry(environment), { accountId, partition, region });
  return Object.freeze({
    ...roots,
    environment,
    kind: "aws-oidc",
    region,
    roleArn
  });
}

function loadConfiguration(environment: WebKeyRuntimeEnvironment): WebKeyRuntimeConfiguration {
  assertNoStaticAwsCredentials(environment);
  assertNoPublicKeyConfiguration(environment);

  const isExactLocalRuntime =
    (environment.NODE_ENV === "development" || environment.NODE_ENV === "test") &&
    environment.VERCEL === undefined &&
    environment.VERCEL_ENV === undefined;
  if (isExactLocalRuntime) {
    if (
      hasValue(environment, ROOT_REGISTRY_VARIABLE) ||
      hasValue(environment, "UNFILED_AWS_REGION") ||
      hasValue(environment, "UNFILED_AWS_ROLE_ARN")
    ) {
      configurationFailure();
    }
    return Object.freeze({ environment, kind: "local" });
  }
  return productionConfiguration(environment);
}

function operationSignal(
  revocationSignal: AbortSignal,
  options?: KeyCustodyOperationOptions
): AbortSignal {
  const requestedSignal = options?.signal;
  return requestedSignal === undefined
    ? revocationSignal
    : AbortSignal.any([revocationSignal, requestedSignal]);
}

function revocableCustodian(
  underlying: InteractiveKeyCustodian,
  scopeSignal: AbortSignal
): Readonly<{ custodian: InteractiveKeyCustodian; revoke(): void }> {
  let open = true;
  const revocation = new AbortController();
  const assertOpen = (): void => {
    if (!open || scopeSignal.aborted || revocation.signal.aborted) configurationFailure();
  };

  const custodian: InteractiveKeyCustodian = Object.freeze({
    async rewrapIntermediateKey(
      record: unknown,
      rewrappedAt: string,
      options?: KeyCustodyOperationOptions
    ): Promise<ManagedKeyRecordV1> {
      assertOpen();
      const result = await underlying.rewrapIntermediateKey(record, rewrappedAt, {
        signal: operationSignal(revocation.signal, options)
      });
      assertOpen();
      return result;
    },
    async withGeneratedIntermediateKey<Result>(
      request: CreateIntermediateKeyRequest,
      use: (keyBytes: Uint8Array, record: ManagedKeyRecordV1) => Promise<Result>,
      options?: KeyCustodyOperationOptions
    ): Promise<Result> {
      assertOpen();
      const result = await underlying.withGeneratedIntermediateKey(
        request,
        async (keyBytes, record) => {
          assertOpen();
          return use(keyBytes, record);
        },
        { signal: operationSignal(revocation.signal, options) }
      );
      assertOpen();
      return result;
    },
    async withUnwrappedIntermediateKey<Result>(
      record: unknown,
      use: (keyBytes: Uint8Array, parsedRecord: ManagedKeyRecordV1) => Promise<Result>,
      options?: KeyCustodyOperationOptions
    ): Promise<Result> {
      assertOpen();
      const result = await underlying.withUnwrappedIntermediateKey(
        record,
        async (keyBytes, parsedRecord) => {
          assertOpen();
          return use(keyBytes, parsedRecord);
        },
        { signal: operationSignal(revocation.signal, options) }
      );
      assertOpen();
      return result;
    }
  });

  return Object.freeze({
    custodian,
    revoke(): void {
      if (!open) return;
      open = false;
      revocation.abort();
    }
  });
}

function awsRuntime(configuration: ProductionRuntimeConfiguration): AwsInteractiveWebKeyRuntime {
  return Object.freeze({
    kind: "aws-oidc",
    async withInteractiveCustodian<Result>(
      signal: AbortSignal,
      use: (custodian: InteractiveKeyCustodian) => Promise<Result>
    ): Promise<Result> {
      assertSignalOpen(signal);
      let transport: Awaited<ReturnType<typeof createVercelOidcKmsTransport>>;
      try {
        transport = await createVercelOidcKmsTransport({
          environment: configuration.environment,
          region: configuration.region,
          roleArn: configuration.roleArn,
          workload: "interactive_api"
        });
      } catch {
        configurationFailure();
      }

      let lease: ReturnType<typeof revocableCustodian>;
      try {
        lease = revocableCustodian(
          createAwsKmsEnvelopeCustodian({
            activeRoots: configuration.activeRoots,
            retiredRoots: configuration.retiredRoots,
            transport,
            workload: "interactive_api"
          }),
          signal
        );
      } catch {
        try {
          transport.destroy();
        } catch {
          // Destruction is best-effort after a failed composition.
        }
        configurationFailure();
      }

      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        lease.revoke();
        try {
          transport.destroy();
        } catch {
          // Never replace the request outcome with a provider cleanup detail.
        }
      };
      signal.addEventListener("abort", close, { once: true });
      try {
        assertSignalOpen(signal);
        const result = await use(lease.custodian);
        assertSignalOpen(signal);
        return result;
      } finally {
        signal.removeEventListener("abort", close);
        close();
      }
    }
  });
}

/**
 * Creates the interactive server custody boundary. Production is accepted only
 * in Vercel's exact Production runtime and can never fall back to local keys.
 */
export async function createInteractiveWebKeyRuntime(
  options: InteractiveWebKeyRuntimeOptions = {}
): Promise<InteractiveWebKeyRuntime> {
  const configuration = loadConfiguration(options.environment ?? process.env);
  if (configuration.kind === "aws-oidc") return awsRuntime(configuration);
  try {
    const keyResolver = await createLocalEnvironmentKeyResolver({
      ...(options.crypto === undefined ? {} : { crypto: options.crypto }),
      environment: configuration.environment,
      workload: "interactive_api"
    });
    return Object.freeze({ keyResolver, kind: "local" });
  } catch {
    configurationFailure();
  }
}
