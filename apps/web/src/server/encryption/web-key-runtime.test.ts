import {
  createAwsKmsEnvelopeCustodian,
  createLocalEnvironmentKeyResolver,
  createVercelOidcKmsTransport,
  createVercelSensitiveEnvironmentEnvelopeCustodian,
  createVercelSensitiveEnvironmentKmsTransport,
  type AwsKmsTransport,
  type InteractiveKeyCustodian,
  type KeyCustodyOperationOptions,
  type ManagedKeyRecordV1,
  type ManagedKeyRecordV2,
  type OwnerBoundKeyResolver
} from "@unfiled/key-management";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import { ConfigurationError } from "@/server/api/errors";

import {
  createInteractiveWebKeyRuntime,
  type AwsInteractiveWebKeyRuntime,
  type WebKeyRuntimeEnvironment
} from "./web-key-runtime";

vi.mock("@unfiled/key-management", () => ({
  createAwsKmsEnvelopeCustodian: vi.fn(),
  createLocalEnvironmentKeyResolver: vi.fn(),
  createVercelOidcKmsTransport: vi.fn(),
  createVercelSensitiveEnvironmentEnvelopeCustodian: vi.fn(),
  createVercelSensitiveEnvironmentKmsTransport: vi.fn(),
  parseVercelSensitiveEnvironmentRetiredRootKeySet: vi.fn((value: unknown): unknown => value),
  parseVercelSensitiveEnvironmentRootKeySet: vi.fn((value: unknown): unknown => value)
}));

const ACCOUNT_ID = "123456789012";
const REGION = "us-west-2";
const ROLE_ARN = `arn:aws:iam::${ACCOUNT_ID}:role/unfiled-production-web`;
const PREVIEW_ROLE_ARN = `arn:aws:iam::${ACCOUNT_ID}:role/unfiled-preview-web`;
const CONFIGURATION_CANARY = "root-configuration-canary";
const VERCEL_PROJECT_ID = "prj_UnfiledWeb123456";
const VERCEL_SENSITIVE_MODE = "vercel-sensitive-env-v1";
const VERCEL_SENSITIVE_PROVIDER = "vercel_sensitive_environment_v1";

const PAIRS = [
  ["ai_assisted", "object_wrap"],
  ["ai_assisted", "content_mac"],
  ["private_manual", "object_wrap"],
  ["private_manual", "content_mac"]
] as const;

type KeyClass = (typeof PAIRS)[number][0];
type KeyPurpose = (typeof PAIRS)[number][1];
type RootStatus = "active" | "retired" | "staged";

interface TerraformRegistryEntry {
  generation: number;
  key_class: KeyClass;
  kms_key_arn: string;
  purpose: KeyPurpose;
  status: RootStatus;
}

type TerraformRegistry = Record<string, TerraformRegistryEntry>;

const MANAGED_KEY_RECORD = Object.freeze({}) as ManagedKeyRecordV1;
const MANAGED_KEY_RECORD_V2 = Object.freeze({}) as ManagedKeyRecordV2;
const LOCAL_RESOLVER = Object.freeze({}) as OwnerBoundKeyResolver;

const createAwsCustodianMock = vi.mocked(createAwsKmsEnvelopeCustodian);
const createLocalResolverMock = vi.mocked(createLocalEnvironmentKeyResolver);
const createTransportMock = vi.mocked(createVercelOidcKmsTransport);
const createSensitiveTransportMock = vi.mocked(createVercelSensitiveEnvironmentKmsTransport);
const createSensitiveCustodianMock = vi.mocked(createVercelSensitiveEnvironmentEnvelopeCustodian);

let destroyTransport: Mock<() => void>;
let transport: AwsKmsTransport;

function keyArn(
  keyClass: KeyClass,
  purpose: KeyPurpose,
  generation: number,
  options: Readonly<{
    accountId?: string;
    partition?: "aws" | "aws-cn" | "aws-us-gov";
    region?: string;
  }> = {}
): string {
  const pairIndex = PAIRS.findIndex(
    ([candidateClass, candidatePurpose]) =>
      candidateClass === keyClass && candidatePurpose === purpose
  );
  const suffix = String(pairIndex * 1_000 + generation).padStart(12, "0");
  return `arn:${options.partition ?? "aws"}:kms:${options.region ?? REGION}:${options.accountId ?? ACCOUNT_ID}:key/00000000-0000-0000-0000-${suffix}`;
}

function registryId(keyClass: KeyClass, purpose: KeyPurpose, generation: number): string {
  return `${keyClass}_${purpose}_v${generation}`;
}

function rootEntry(
  keyClass: KeyClass,
  purpose: KeyPurpose,
  generation: number,
  status: RootStatus,
  arn = keyArn(keyClass, purpose, generation)
): TerraformRegistryEntry {
  return {
    generation,
    key_class: keyClass,
    kms_key_arn: arn,
    purpose,
    status
  };
}

function activeRegistry(generation = 1): TerraformRegistry {
  return Object.fromEntries(
    PAIRS.map(([keyClass, purpose]) => [
      registryId(keyClass, purpose, generation),
      rootEntry(keyClass, purpose, generation, "active")
    ])
  );
}

function rotatingRegistry(): TerraformRegistry {
  return Object.fromEntries(
    PAIRS.flatMap(([keyClass, purpose]) => [
      [registryId(keyClass, purpose, 1), rootEntry(keyClass, purpose, 1, "retired")],
      [registryId(keyClass, purpose, 2), rootEntry(keyClass, purpose, 2, "active")],
      [registryId(keyClass, purpose, 3), rootEntry(keyClass, purpose, 3, "staged")]
    ])
  );
}

function cloneRegistry(registry: TerraformRegistry): TerraformRegistry {
  return Object.fromEntries(Object.entries(registry).map(([id, entry]) => [id, { ...entry }]));
}

function productionEnvironment(
  registry: TerraformRegistry = activeRegistry()
): WebKeyRuntimeEnvironment {
  return {
    NODE_ENV: "production",
    UNFILED_AWS_REGION: REGION,
    UNFILED_AWS_ROLE_ARN: ROLE_ARN,
    UNFILED_WEB_ROOT_KEY_REGISTRY_JSON: JSON.stringify(registry),
    VERCEL: "1",
    VERCEL_ENV: "production"
  };
}

function previewEnvironment(
  registry: TerraformRegistry = activeRegistry(11)
): WebKeyRuntimeEnvironment {
  return {
    ...productionEnvironment(registry),
    UNFILED_AWS_ROLE_ARN: PREVIEW_ROLE_ARN,
    VERCEL_ENV: "preview"
  };
}

function sensitiveRootId(pairIndex: number, generation: number): string {
  const suffix = String(pairIndex * 1_000 + generation).padStart(12, "0");
  return `urn:unfiled:key-root:vercel-sensitive-env-v1:production:00000000-0000-4000-8000-${suffix}`;
}

function sensitiveRegistry(generation = 1): Readonly<Record<string, unknown>> {
  return {
    version: 2,
    custodyProvider: VERCEL_SENSITIVE_PROVIDER,
    projectId: VERCEL_PROJECT_ID,
    deploymentEnvironment: "production",
    roots: Object.fromEntries(
      PAIRS.map(([keyClass, purpose], pairIndex) => [
        registryId(keyClass, purpose, generation),
        {
          generation,
          keyClass,
          purpose,
          rootKeyId: sensitiveRootId(pairIndex, generation),
          status: "active"
        }
      ])
    )
  };
}

function sensitiveEnvironment(): WebKeyRuntimeEnvironment {
  const metadata = sensitiveRegistry();
  return {
    NODE_ENV: "production",
    UNFILED_KEY_CUSTODIAN: VERCEL_SENSITIVE_MODE,
    UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1: CONFIGURATION_CANARY,
    UNFILED_WEB_ROOT_KEY_REGISTRY_V2_JSON: JSON.stringify(metadata),
    VERCEL: "1",
    VERCEL_ENV: "production",
    VERCEL_PROJECT_ID
  };
}

function passthroughCustodian(): InteractiveKeyCustodian {
  return Object.freeze({
    async rewrapIntermediateKey(
      record: unknown,
      rewrappedAt: string,
      options?: KeyCustodyOperationOptions
    ): Promise<ManagedKeyRecordV1> {
      void record;
      void rewrappedAt;
      void options;
      return await Promise.resolve(MANAGED_KEY_RECORD);
    },
    async withGeneratedIntermediateKey<Result>(
      request: Parameters<InteractiveKeyCustodian["withGeneratedIntermediateKey"]>[0],
      use: (keyBytes: Uint8Array, record: ManagedKeyRecordV1) => Promise<Result>,
      options?: KeyCustodyOperationOptions
    ): Promise<Result> {
      void request;
      void options;
      return await use(new Uint8Array(32), MANAGED_KEY_RECORD);
    },
    async withUnwrappedIntermediateKey<Result>(
      record: unknown,
      use: (keyBytes: Uint8Array, record: ManagedKeyRecordV1) => Promise<Result>,
      options?: KeyCustodyOperationOptions
    ): Promise<Result> {
      void record;
      void options;
      return await use(new Uint8Array(32), MANAGED_KEY_RECORD);
    }
  });
}

function passthroughV2Custodian(): InteractiveKeyCustodian<ManagedKeyRecordV2> {
  return Object.freeze({
    async rewrapIntermediateKey(): Promise<ManagedKeyRecordV2> {
      return await Promise.resolve(MANAGED_KEY_RECORD_V2);
    },
    async withGeneratedIntermediateKey<Result>(
      _request: Parameters<
        InteractiveKeyCustodian<ManagedKeyRecordV2>["withGeneratedIntermediateKey"]
      >[0],
      use: (keyBytes: Uint8Array, record: ManagedKeyRecordV2) => Promise<Result>
    ): Promise<Result> {
      return await use(new Uint8Array(32), MANAGED_KEY_RECORD_V2);
    },
    async withUnwrappedIntermediateKey<Result>(
      _record: unknown,
      use: (keyBytes: Uint8Array, record: ManagedKeyRecordV2) => Promise<Result>
    ): Promise<Result> {
      return await use(new Uint8Array(32), MANAGED_KEY_RECORD_V2);
    }
  });
}

async function createAwsRuntime(
  environment: WebKeyRuntimeEnvironment = productionEnvironment()
): Promise<AwsInteractiveWebKeyRuntime> {
  const runtime = await createInteractiveWebKeyRuntime({ environment });
  expect(runtime.kind).toBe("aws-oidc");
  if (runtime.kind !== "aws-oidc") throw new Error("Expected the AWS runtime");
  return runtime;
}

async function expectConfigurationFailure(
  environment: WebKeyRuntimeEnvironment,
  canary?: string
): Promise<void> {
  let reason: unknown;
  try {
    await createInteractiveWebKeyRuntime({ environment });
  } catch (error: unknown) {
    reason = error;
  }
  expect(reason).toBeInstanceOf(ConfigurationError);
  if (canary !== undefined) {
    expect(String(reason)).not.toContain(canary);
    expect(JSON.stringify(reason)).not.toContain(canary);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  destroyTransport = vi.fn((): void => undefined);
  transport = Object.freeze({
    decryptDataKey: vi.fn(),
    destroy(): void {
      destroyTransport();
    },
    generateDataKey: vi.fn(),
    reEncryptDataKey: vi.fn()
  });
  createTransportMock.mockResolvedValue(transport);
  createSensitiveTransportMock.mockResolvedValue(transport);
  createAwsCustodianMock.mockReturnValue(passthroughCustodian());
  createSensitiveCustodianMock.mockReturnValue(passthroughV2Custodian());
  createLocalResolverMock.mockResolvedValue(LOCAL_RESOLVER);
});

describe("interactive web key runtime", () => {
  it("composes the production OIDC transport with all active and retired roots, never staged roots", async () => {
    const registry = rotatingRegistry();
    const stagedArns = Object.values(registry)
      .filter((entry) => entry.status === "staged")
      .map((entry) => entry.kms_key_arn);
    const runtime = await createAwsRuntime(productionEnvironment(registry));

    expect(createTransportMock).not.toHaveBeenCalled();
    await expect(
      runtime.withInteractiveCustodian(new AbortController().signal, () =>
        Promise.resolve("result")
      )
    ).resolves.toBe("result");

    expect(createTransportMock).toHaveBeenCalledWith({
      environment: productionEnvironment(registry),
      region: REGION,
      roleArn: ROLE_ARN,
      workload: "interactive_api"
    });
    expect(createAwsCustodianMock).toHaveBeenCalledOnce();
    const options = createAwsCustodianMock.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      activeRoots: {
        ai_assisted: {
          content_mac: keyArn("ai_assisted", "content_mac", 2),
          object_wrap: keyArn("ai_assisted", "object_wrap", 2)
        },
        private_manual: {
          content_mac: keyArn("private_manual", "content_mac", 2),
          object_wrap: keyArn("private_manual", "object_wrap", 2)
        }
      },
      retiredRoots: {
        ai_assisted: {
          content_mac: [keyArn("ai_assisted", "content_mac", 1)],
          object_wrap: [keyArn("ai_assisted", "object_wrap", 1)]
        },
        private_manual: {
          content_mac: [keyArn("private_manual", "content_mac", 1)],
          object_wrap: [keyArn("private_manual", "object_wrap", 1)]
        }
      },
      transport,
      workload: "interactive_api"
    });
    for (const arn of stagedArns) expect(JSON.stringify(options)).not.toContain(arn);
    expect(createLocalResolverMock).not.toHaveBeenCalled();
    expect(destroyTransport).toHaveBeenCalledOnce();
  });

  it("composes Preview with its separately configured managed role and roots", async () => {
    const environment = previewEnvironment();
    const runtime = await createAwsRuntime(environment);

    await expect(
      runtime.withInteractiveCustodian(new AbortController().signal, () =>
        Promise.resolve("preview-result")
      )
    ).resolves.toBe("preview-result");

    expect(createTransportMock).toHaveBeenCalledWith({
      environment,
      region: REGION,
      roleArn: PREVIEW_ROLE_ARN,
      workload: "interactive_api"
    });
    expect(createLocalResolverMock).not.toHaveBeenCalled();
  });

  it("composes the explicit Production-only Vercel sensitive-environment V2 custodian", async () => {
    const environment = sensitiveEnvironment();
    const crypto = {} as Crypto;
    const runtime = await createInteractiveWebKeyRuntime({ crypto, environment });
    expect(runtime.kind).toBe("vercel-sensitive-env-v1");
    if (runtime.kind !== "vercel-sensitive-env-v1") throw new Error("Expected V2 runtime");

    await expect(
      runtime.withInteractiveCustodian(new AbortController().signal, () =>
        Promise.resolve("v2-result")
      )
    ).resolves.toBe("v2-result");

    const expectedRootKeyIds = PAIRS.map((_pair, index) => sensitiveRootId(index, 1));
    expect(createSensitiveTransportMock).toHaveBeenCalledWith({
      crypto,
      environment,
      expectedRootKeyIds
    });
    expect(createSensitiveCustodianMock).toHaveBeenCalledWith({
      activeRoots: {
        ai_assisted: {
          content_mac: sensitiveRootId(1, 1),
          object_wrap: sensitiveRootId(0, 1)
        },
        private_manual: {
          content_mac: sensitiveRootId(3, 1),
          object_wrap: sensitiveRootId(2, 1)
        }
      },
      deploymentEnvironment: "production",
      retiredRoots: {
        ai_assisted: { content_mac: [], object_wrap: [] },
        private_manual: { content_mac: [], object_wrap: [] }
      },
      transport,
      workload: "interactive_api"
    });
    expect(createTransportMock).not.toHaveBeenCalled();
    expect(createAwsCustodianMock).not.toHaveBeenCalled();
    expect(createLocalResolverMock).not.toHaveBeenCalled();
    expect(destroyTransport).toHaveBeenCalledOnce();
  });

  it("never infers or previews the Vercel sensitive-environment custody path", async () => {
    const exact = sensitiveEnvironment();
    const invalid = [
      { ...exact, VERCEL_ENV: "preview" },
      { ...exact, UNFILED_KEY_CUSTODIAN: undefined },
      { ...exact, UNFILED_KEY_CUSTODIAN: `${VERCEL_SENSITIVE_MODE} ` },
      { ...exact, UNFILED_AWS_REGION: REGION },
      { ...exact, UNFILED_AWS_ROLE_ARN: ROLE_ARN },
      { ...exact, UNFILED_WEB_ROOT_KEY_REGISTRY_JSON: JSON.stringify(activeRegistry()) },
      { ...exact, UNFILED_LOCAL_KEY_RING_V1: CONFIGURATION_CANARY }
    ];

    for (const environment of invalid) {
      await expectConfigurationFailure(environment, CONFIGURATION_CANARY);
    }
    expect(createSensitiveTransportMock).not.toHaveBeenCalled();
    expect(createSensitiveCustodianMock).not.toHaveBeenCalled();
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  it("revokes the callback-scoped facade and destroys its transport on normal completion", async () => {
    const runtime = await createAwsRuntime();
    let leakedCustodian: InteractiveKeyCustodian | undefined;
    const result = await runtime.withInteractiveCustodian(
      new AbortController().signal,
      (custodian) => {
        leakedCustodian = custodian;
        return Promise.resolve("done");
      }
    );

    expect(result).toBe("done");
    expect(destroyTransport).toHaveBeenCalledOnce();
    expect(leakedCustodian).toBeDefined();
    await expect(
      leakedCustodian?.withUnwrappedIntermediateKey({}, () => Promise.resolve("escaped"))
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("aborts in-flight custody before transport destruction when the request is aborted", async () => {
    let operationSignal: AbortSignal | undefined;
    let resolveStarted: (() => void) | undefined;
    let destroyCallsWhenAborted = -1;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const underlying = passthroughCustodian();
    const blockingCustodian: InteractiveKeyCustodian = Object.freeze({
      ...underlying,
      async withUnwrappedIntermediateKey<Result>(
        record: unknown,
        use: (keyBytes: Uint8Array, record: ManagedKeyRecordV1) => Promise<Result>,
        options?: KeyCustodyOperationOptions
      ): Promise<Result> {
        void record;
        void use;
        operationSignal = options?.signal;
        resolveStarted?.();
        return await new Promise<Result>((_resolve, reject) => {
          operationSignal?.addEventListener(
            "abort",
            () => {
              destroyCallsWhenAborted = destroyTransport.mock.calls.length;
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true }
          );
        });
      }
    });
    createAwsCustodianMock.mockReturnValue(blockingCustodian);
    const runtime = await createAwsRuntime();
    const request = new AbortController();
    const pending = runtime.withInteractiveCustodian(request.signal, (custodian) =>
      custodian.withUnwrappedIntermediateKey({}, () => Promise.resolve("not reached"))
    );

    await started;
    request.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(operationSignal?.aborted).toBe(true);
    expect(destroyCallsWhenAborted).toBe(0);
    expect(destroyTransport).toHaveBeenCalledOnce();
  });

  it("does not return a late callback result after the custody scope is aborted", async () => {
    const runtime = await createAwsRuntime();
    const request = new AbortController();
    let release: ((value: string) => void) | undefined;
    const pending = runtime.withInteractiveCustodian(
      request.signal,
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        })
    );

    await vi.waitFor(() => expect(release).toBeDefined());
    request.abort();
    release?.("late success");

    await expect(pending).rejects.toBeInstanceOf(ConfigurationError);
    expect(destroyTransport).toHaveBeenCalledOnce();
  });

  it("maps composition failures to a value-free error and still destroys allocated transports", async () => {
    const runtime = await createAwsRuntime();
    createAwsCustodianMock.mockImplementation(() => {
      throw new Error(CONFIGURATION_CANARY);
    });

    let reason: unknown;
    try {
      await runtime.withInteractiveCustodian(new AbortController().signal, () =>
        Promise.resolve(undefined)
      );
    } catch (error: unknown) {
      reason = error;
    }
    expect(reason).toBeInstanceOf(ConfigurationError);
    expect(String(reason)).not.toContain(CONFIGURATION_CANARY);
    expect(JSON.stringify(reason)).not.toContain(CONFIGURATION_CANARY);
    expect(destroyTransport).toHaveBeenCalledOnce();

    createTransportMock.mockRejectedValueOnce(new Error(CONFIGURATION_CANARY));
    await expect(
      runtime.withInteractiveCustodian(new AbortController().signal, () =>
        Promise.resolve(undefined)
      )
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("uses only the local resolver in an exact local or test runtime", async () => {
    const environment = {
      NODE_ENV: "test",
      UNFILED_KEY_CUSTODIAN: "local",
      UNFILED_LOCAL_KEY_RING_V1: CONFIGURATION_CANARY
    } as const;
    const crypto = {} as Crypto;
    const runtime = await createInteractiveWebKeyRuntime({ crypto, environment });

    expect(runtime).toEqual({ keyResolver: LOCAL_RESOLVER, kind: "local" });
    expect(createLocalResolverMock).toHaveBeenCalledWith({
      crypto,
      environment,
      workload: "interactive_api"
    });
    expect(createTransportMock).not.toHaveBeenCalled();
    expect(createAwsCustodianMock).not.toHaveBeenCalled();
  });

  it("rejects non-cloud Vercel and partial managed runtime identities", async () => {
    const exactProduction = productionEnvironment();
    const invalidEnvironments: WebKeyRuntimeEnvironment[] = [
      { ...exactProduction, VERCEL_ENV: "development" },
      { ...exactProduction, VERCEL: "0" },
      { ...exactProduction, VERCEL: undefined },
      { ...exactProduction, NODE_ENV: "test" },
      { ...exactProduction, NODE_ENV: "development" },
      { ...exactProduction, UNFILED_KEY_CUSTODIAN: "local" },
      { ...exactProduction, UNFILED_LOCAL_KEY_RING_V1: CONFIGURATION_CANARY },
      { NODE_ENV: "test", UNFILED_KEY_CUSTODIAN: "local", VERCEL: "1" },
      { NODE_ENV: "test", UNFILED_KEY_CUSTODIAN: "local", VERCEL: "0" },
      { NODE_ENV: "test", UNFILED_KEY_CUSTODIAN: "local", VERCEL_ENV: "preview" },
      {
        NODE_ENV: "test",
        UNFILED_KEY_CUSTODIAN: "local",
        UNFILED_WEB_ROOT_KEY_REGISTRY_JSON: exactProduction.UNFILED_WEB_ROOT_KEY_REGISTRY_JSON
      }
    ];

    for (const environment of invalidEnvironments) {
      await expectConfigurationFailure(environment, CONFIGURATION_CANARY);
    }
    expect(createLocalResolverMock).not.toHaveBeenCalled();
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  it("rejects static AWS credentials, root bytes, and client-exposed custody settings", async () => {
    const forbiddenVariables = [
      "AWS_ACCESS_KEY_ID",
      "AWS_PROFILE",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SECURITY_TOKEN",
      "AWS_SESSION_TOKEN",
      "AWS_SHARED_CREDENTIALS_FILE",
      "UNFILED_AI_ASSISTED_KEK_B64URL",
      "UNFILED_CONTENT_FINGERPRINT_KEY",
      "UNFILED_CONTENT_KEK",
      "UNFILED_PRIVATE_MANUAL_KEK_B64URL",
      "UNFILED_ROOT_KEY_B64URL",
      "UNFILED_OTHER_KEY_BYTES",
      "UNFILED_OTHER_KEY_MATERIAL",
      "NEXT_PUBLIC_UNFILED_AWS_ROLE_ARN",
      "NEXT_PUBLIC_UNFILED_WEB_ROOT_KEY_REGISTRY_JSON",
      "NEXT_PUBLIC_UNFILED_WEB_ROOT_KEY_REGISTRY_V2_JSON",
      "NEXT_PUBLIC_UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1",
      "NEXT_PUBLIC_UNFILED_ROOT_KEY_BYTES"
    ];

    for (const name of forbiddenVariables) {
      await expectConfigurationFailure(
        { ...productionEnvironment(), [name]: CONFIGURATION_CANARY },
        CONFIGURATION_CANARY
      );
    }
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  it("requires one active root for every pair and bounds the retired and staged lifecycle", async () => {
    const missingPair = activeRegistry();
    delete missingPair.ai_assisted_object_wrap_v1;

    const secondActive = activeRegistry();
    secondActive.ai_assisted_object_wrap_v2 = rootEntry("ai_assisted", "object_wrap", 2, "active");

    const allStaged = activeRegistry();
    for (const entry of Object.values(allStaged)) entry.status = "staged";

    const staleStaged = activeRegistry(2);
    staleStaged.ai_assisted_object_wrap_v1 = rootEntry("ai_assisted", "object_wrap", 1, "staged");

    const futureRetired = activeRegistry();
    futureRetired.ai_assisted_object_wrap_v2 = rootEntry(
      "ai_assisted",
      "object_wrap",
      2,
      "retired"
    );

    const twoStaged = activeRegistry();
    twoStaged.ai_assisted_object_wrap_v2 = rootEntry("ai_assisted", "object_wrap", 2, "staged");
    twoStaged.ai_assisted_object_wrap_v3 = rootEntry("ai_assisted", "object_wrap", 3, "staged");

    const tooManyRetired = activeRegistry();
    delete tooManyRetired.ai_assisted_object_wrap_v1;
    tooManyRetired.ai_assisted_object_wrap_v22 = rootEntry(
      "ai_assisted",
      "object_wrap",
      22,
      "active"
    );
    for (let generation = 1; generation <= 21; generation += 1) {
      tooManyRetired[registryId("ai_assisted", "object_wrap", generation)] = rootEntry(
        "ai_assisted",
        "object_wrap",
        generation,
        "retired"
      );
    }

    for (const registry of [
      missingPair,
      secondActive,
      allStaged,
      staleStaged,
      futureRetired,
      twoStaged,
      tooManyRetired
    ]) {
      await expectConfigurationFailure(productionEnvironment(registry));
    }
  });

  it("rejects duplicate ARNs, duplicate generation metadata, and duplicate JSON properties", async () => {
    const duplicateArn = activeRegistry();
    duplicateArn.private_manual_content_mac_v1 = rootEntry(
      "private_manual",
      "content_mac",
      1,
      "active",
      keyArn("ai_assisted", "object_wrap", 1)
    );

    const duplicateGeneration = activeRegistry();
    duplicateGeneration.ai_assisted_object_wrap_alias = rootEntry(
      "ai_assisted",
      "object_wrap",
      1,
      "retired",
      keyArn("ai_assisted", "object_wrap", 99)
    );

    await expectConfigurationFailure(productionEnvironment(duplicateArn));
    await expectConfigurationFailure(productionEnvironment(duplicateGeneration));

    const valid = activeRegistry();
    const [firstId, firstEntry] = Object.entries(valid)[0] ?? [];
    expect(firstId).toBeDefined();
    expect(firstEntry).toBeDefined();
    const remaining = Object.entries(valid).slice(1);
    const duplicateJson = `{${JSON.stringify(firstId)}:${JSON.stringify(firstEntry)},${JSON.stringify(firstId)}:${JSON.stringify(firstEntry)},${remaining
      .map(([id, entry]) => `${JSON.stringify(id)}:${JSON.stringify(entry)}`)
      .join(",")}}`;
    await expectConfigurationFailure({
      ...productionEnvironment(),
      UNFILED_WEB_ROOT_KEY_REGISTRY_JSON: duplicateJson
    });
  });

  it("rejects malformed, non-canonical, and oversized registry documents", async () => {
    const extraField = cloneRegistry(activeRegistry());
    const entryWithExtra = extraField.ai_assisted_object_wrap_v1 as TerraformRegistryEntry & {
      extra?: string;
    };
    entryWithExtra.extra = CONFIGURATION_CANARY;

    const missingField = cloneRegistry(activeRegistry());
    delete (missingField.ai_assisted_object_wrap_v1 as Partial<TerraformRegistryEntry>).status;

    const invalidDocuments: string[] = [
      "{",
      "[]",
      "null",
      "{}",
      JSON.stringify(extraField),
      JSON.stringify(missingField),
      JSON.stringify({
        ...activeRegistry(),
        ai_assisted_object_wrap_v1: {
          ...activeRegistry().ai_assisted_object_wrap_v1,
          generation: 1.5
        }
      }),
      JSON.stringify({
        ...activeRegistry(),
        ai_assisted_object_wrap_v1: {
          ...activeRegistry().ai_assisted_object_wrap_v1,
          status: "pending"
        }
      }),
      JSON.stringify({
        ...activeRegistry(),
        ai_assisted_object_wrap_v1: {
          ...activeRegistry().ai_assisted_object_wrap_v1,
          kms_key_arn: `alias/${CONFIGURATION_CANARY}`
        }
      })
    ];

    for (const document of invalidDocuments) {
      await expectConfigurationFailure(
        {
          ...productionEnvironment(),
          UNFILED_WEB_ROOT_KEY_REGISTRY_JSON: document
        },
        CONFIGURATION_CANARY
      );
    }

    const oversized = `${JSON.stringify(activeRegistry())}${" ".repeat(65_536)}`;
    await expectConfigurationFailure({
      ...productionEnvironment(),
      UNFILED_WEB_ROOT_KEY_REGISTRY_JSON: oversized
    });
  });

  it("rejects root ARNs outside the role account, configured region, or partition", async () => {
    const cases = [
      { accountId: "999999999999" },
      { region: "us-east-1" },
      { partition: "aws-cn" as const, region: "cn-north-1" },
      { partition: "aws-us-gov" as const, region: "us-gov-west-1" }
    ];

    for (const arnOptions of cases) {
      const registry = activeRegistry();
      registry.ai_assisted_object_wrap_v1 = rootEntry(
        "ai_assisted",
        "object_wrap",
        1,
        "active",
        keyArn("ai_assisted", "object_wrap", 1, arnOptions)
      );
      await expectConfigurationFailure(productionEnvironment(registry));
    }

    await expectConfigurationFailure(
      {
        ...productionEnvironment(),
        UNFILED_AWS_ROLE_ARN: `arn:aws-cn:iam::${ACCOUNT_ID}:role/${CONFIGURATION_CANARY}`
      },
      CONFIGURATION_CANARY
    );
  });
});
