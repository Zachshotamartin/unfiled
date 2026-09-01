import {
  ApiErrorCode,
  type EntityId,
  type RoutingRuleCreateRequest,
  type RoutingRuleDeleteRequest,
  type RoutingRuleUpdateRequest
} from "@unfiled/contracts";
import { RoutingRuleCapacityError } from "@unfiled/ai-routing";
import { EncryptedAggregateError, EncryptedAggregateErrorCode } from "@unfiled/encrypted-aggregate";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RoutingRuleRepositoryContext } from "@/server/routing-rules/repository";

const mocks = vi.hoisted(() => ({
  clients: [] as unknown[],
  coordinatorDependencies: [] as unknown[],
  readerDependencies: [] as unknown[],
  core: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  },
  createAdapter: vi.fn(),
  createKeyRuntime: vi.fn(),
  createLibraryStore: vi.fn(),
  createServiceClient: vi.fn(),
  leaseActive: false,
  runtimes: [] as unknown[],
  signals: [] as AbortSignal[],
  withOwnerRuntime: vi.fn()
}));

type ServiceRpcClientModule = Readonly<{
  createServiceRpcClient: typeof createServiceRpcClient;
  ServiceRpcError: typeof ServiceRpcError;
  ServiceRpcErrorCode: typeof ServiceRpcErrorCode;
}>;

type WebKeyRuntimeModule = Readonly<{
  createInteractiveWebKeyRuntime: typeof createInteractiveWebKeyRuntime;
}>;

type AggregateRuntimeModule = Readonly<{
  encryptedAggregateRuntimeRpcFunctions: typeof encryptedAggregateRuntimeRpcFunctions;
  withOwnerEncryptedAggregateRuntime: typeof withOwnerEncryptedAggregateRuntime;
}>;

type LibraryStoreModule = Readonly<{
  createEncryptedLibraryRpcStore: typeof createEncryptedLibraryRpcStore;
}>;

type RoutingAdapterModule = Readonly<{
  createEncryptedRoutingRuleRpcAdapter: typeof createEncryptedRoutingRuleRpcAdapter;
  encryptedRoutingRuleRpcFunctions: typeof encryptedRoutingRuleRpcFunctions;
}>;

type RoutingReaderModule = Readonly<{
  EncryptedRoutingRuleReader: typeof EncryptedRoutingRuleReader;
}>;

type RoutingCoordinatorModule = Readonly<{
  EncryptedRoutingRuleCoordinator: typeof EncryptedRoutingRuleCoordinator;
}>;

vi.mock("./service-rpc-client", async (importOriginal) => {
  const actual = await importOriginal<ServiceRpcClientModule>();
  return { ...actual, createServiceRpcClient: mocks.createServiceClient };
});

vi.mock("./web-key-runtime", async (importOriginal) => {
  const actual = await importOriginal<WebKeyRuntimeModule>();
  return { ...actual, createInteractiveWebKeyRuntime: mocks.createKeyRuntime };
});

vi.mock("./encrypted-aggregate-runtime", async (importOriginal) => {
  const actual = await importOriginal<AggregateRuntimeModule>();
  return { ...actual, withOwnerEncryptedAggregateRuntime: mocks.withOwnerRuntime };
});

vi.mock("./encrypted-library-rpc-store", async (importOriginal) => {
  const actual = await importOriginal<LibraryStoreModule>();
  return { ...actual, createEncryptedLibraryRpcStore: mocks.createLibraryStore };
});

vi.mock("./encrypted-routing-rule-rpc-adapter", async (importOriginal) => {
  const actual = await importOriginal<RoutingAdapterModule>();
  return { ...actual, createEncryptedRoutingRuleRpcAdapter: mocks.createAdapter };
});

vi.mock("@/server/routing-rules/encrypted-routing-rule-reader", async (importOriginal) => {
  const actual = await importOriginal<RoutingReaderModule>();
  return {
    ...actual,
    EncryptedRoutingRuleReader: function MockRoutingRuleReader(dependencies: unknown) {
      mocks.readerDependencies.push(dependencies);
      return Object.freeze({ kind: "routing-rule-reader" });
    }
  };
});

vi.mock("@/server/routing-rules/encrypted-routing-rule-coordinator", async (importOriginal) => {
  const actual = await importOriginal<RoutingCoordinatorModule>();
  return {
    ...actual,
    EncryptedRoutingRuleCoordinator: function MockRoutingRuleCoordinator(dependencies: unknown) {
      mocks.coordinatorDependencies.push(dependencies);
      return mocks.core;
    }
  };
});

import {
  encryptedAggregateRuntimeRpcFunctions,
  type OwnerEncryptedAggregateRuntime,
  type withOwnerEncryptedAggregateRuntime
} from "./encrypted-aggregate-runtime";
import type { createEncryptedLibraryRpcStore } from "./encrypted-library-rpc-store";
import {
  type createEncryptedRoutingRuleRpcAdapter,
  encryptedRoutingRuleRpcFunctions
} from "./encrypted-routing-rule-rpc-adapter";
import {
  ManagedEncryptedRoutingRuleRepository,
  managedEncryptedRoutingRuleRpcFunctions
} from "./managed-encrypted-routing-rule-repository";
import {
  type createServiceRpcClient,
  ServiceRpcError,
  ServiceRpcErrorCode,
  type ServiceRpcClient
} from "./service-rpc-client";
import type { createInteractiveWebKeyRuntime, InteractiveWebKeyRuntime } from "./web-key-runtime";
import type { EncryptedRoutingRuleCoordinator } from "@/server/routing-rules/encrypted-routing-rule-coordinator";
import type { EncryptedRoutingRuleReader } from "@/server/routing-rules/encrypted-routing-rule-reader";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const CONTEXT: RoutingRuleRepositoryContext = Object.freeze({
  accessToken: "authenticated-access-token",
  userId: OWNER_ID
});
const RULE_ID = "rule_01J6M9Q7G4BMKB33GSG3NJ6D1X" as EntityId<"rule">;
const NOTE_ID = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X" as EntityId<"note">;
const PRIVATE_CANARY = "private routing condition 3d9f2a";
const CREATE: RoutingRuleCreateRequest = Object.freeze({
  idempotencyKey: "create-rule-1",
  enabled: true,
  ruleType: "prefix",
  condition: PRIVATE_CANARY,
  destination: { type: "note" as const, noteId: NOTE_ID },
  priority: 900
});
const UPDATE: RoutingRuleUpdateRequest = Object.freeze({
  expectedRevision: 1,
  idempotencyKey: "update-rule-1",
  enabled: false
});
const DELETE: RoutingRuleDeleteRequest = Object.freeze({
  expectedRevision: 2,
  idempotencyKey: "delete-rule-1"
});
const RESULTS = Object.freeze({
  list: Object.freeze({ kind: "list-result" }),
  create: Object.freeze({ kind: "create-result" }),
  update: Object.freeze({ kind: "update-result" }),
  delete: Object.freeze({ kind: "delete-result" })
});

beforeEach(() => {
  mocks.clients.length = 0;
  mocks.coordinatorDependencies.length = 0;
  mocks.readerDependencies.length = 0;
  mocks.runtimes.length = 0;
  mocks.signals.length = 0;
  mocks.leaseActive = false;
  mocks.createAdapter.mockReset();
  mocks.createKeyRuntime.mockReset();
  mocks.createLibraryStore.mockReset();
  mocks.createServiceClient.mockReset();
  mocks.withOwnerRuntime.mockReset();
  mocks.core.list.mockReset().mockResolvedValue(RESULTS.list);
  mocks.core.create.mockReset().mockResolvedValue(RESULTS.create);
  mocks.core.update.mockReset().mockResolvedValue(RESULTS.update);
  mocks.core.delete.mockReset().mockResolvedValue(RESULTS.delete);

  mocks.createServiceClient.mockImplementation(() => {
    const client = Object.freeze({ rpc: vi.fn() }) satisfies ServiceRpcClient;
    mocks.clients.push(client);
    return client;
  });
  mocks.createKeyRuntime.mockImplementation(() => {
    const runtime = Object.freeze({ kind: "test-runtime", id: mocks.runtimes.length + 1 });
    mocks.runtimes.push(runtime);
    return Promise.resolve(runtime);
  });
  mocks.createLibraryStore.mockImplementation((client: unknown) =>
    Object.freeze({ kind: "strict-library-store", client })
  );
  mocks.createAdapter.mockImplementation((client: unknown) =>
    Object.freeze({ kind: "strict-routing-rule-adapter", client })
  );
  mocks.withOwnerRuntime.mockImplementation(async (...parameters: unknown[]) => {
    const runtime = parameters[0] as InteractiveWebKeyRuntime;
    const client = parameters[1] as ServiceRpcClient;
    const ownerId = parameters[2] as string;
    const options = parameters[3] as Readonly<{ signal: AbortSignal }>;
    const use = parameters[4] as (runtime: OwnerEncryptedAggregateRuntime) => Promise<unknown>;
    expect(runtime).toBe(mocks.runtimes.at(-1));
    expect(client).toBe(mocks.clients.at(-1));
    expect(ownerId).toBe(OWNER_ID);
    expect(mocks.leaseActive).toBe(false);
    mocks.signals.push(options.signal);
    mocks.leaseActive = true;
    try {
      return await use(
        Object.freeze({
          access: Object.freeze({ ownerId }),
          createPreparedService: vi.fn(),
          service: Object.freeze({ kind: "aggregate-service" })
        }) as unknown as OwnerEncryptedAggregateRuntime
      );
    } finally {
      mocks.leaseActive = false;
    }
  });
});

describe("managed encrypted routing-rule repository", () => {
  it("uses an exact duplicate-free encrypted RPC capability set", () => {
    expect(managedEncryptedRoutingRuleRpcFunctions).toEqual([
      ...encryptedAggregateRuntimeRpcFunctions,
      "list_encrypted_library_objects",
      ...encryptedRoutingRuleRpcFunctions
    ]);
    expect(new Set(managedEncryptedRoutingRuleRpcFunctions).size).toBe(
      managedEncryptedRoutingRuleRpcFunctions.length
    );
    expect(Object.isFrozen(managedEncryptedRoutingRuleRpcFunctions)).toBe(true);
  });

  it("creates a fresh bounded owner custody scope for every operation", async () => {
    const environment = Object.freeze({ NODE_ENV: "test" });
    const fetcher = vi.fn() as unknown as typeof fetch;
    const repository = new ManagedEncryptedRoutingRuleRepository({
      environment,
      fetch: fetcher
    });
    const uppercaseContext = Object.freeze({
      accessToken: CONTEXT.accessToken,
      userId: OWNER_ID.toUpperCase()
    });

    await expect(repository.list(uppercaseContext)).resolves.toBe(RESULTS.list);
    await expect(repository.create(uppercaseContext, CREATE)).resolves.toBe(RESULTS.create);
    await expect(repository.update(uppercaseContext, RULE_ID, UPDATE)).resolves.toBe(
      RESULTS.update
    );
    await expect(repository.delete(uppercaseContext, RULE_ID, DELETE)).resolves.toBe(
      RESULTS.delete
    );

    expect(mocks.createServiceClient).toHaveBeenCalledTimes(4);
    expect(mocks.createKeyRuntime).toHaveBeenCalledTimes(4);
    expect(mocks.withOwnerRuntime).toHaveBeenCalledTimes(4);
    expect(mocks.createLibraryStore).toHaveBeenCalledTimes(4);
    expect(mocks.createAdapter).toHaveBeenCalledTimes(4);
    expect(mocks.readerDependencies).toHaveLength(4);
    expect(mocks.coordinatorDependencies).toHaveLength(4);
    expect(mocks.signals.every(({ aborted }) => aborted)).toBe(true);
    expect(mocks.leaseActive).toBe(false);

    for (const [index, dependencies] of mocks.coordinatorDependencies.entries()) {
      expect(Object.keys(dependencies as object).sort()).toEqual([
        "access",
        "adapter",
        "aggregate",
        "createPreparedService",
        "ownerId",
        "reader",
        "signal"
      ]);
      expect(dependencies).toMatchObject({
        ownerId: OWNER_ID,
        adapter: { kind: "strict-routing-rule-adapter", client: mocks.clients[index] },
        reader: { kind: "routing-rule-reader" }
      });
    }
    expect(mocks.core.list).toHaveBeenCalledWith({});
    expect(mocks.core.create).toHaveBeenCalledWith(CREATE);
    expect(mocks.core.update).toHaveBeenCalledWith(RULE_ID, UPDATE);
    expect(mocks.core.delete).toHaveBeenCalledWith(RULE_ID, DELETE);
    for (const [options] of mocks.createServiceClient.mock.calls) {
      expect(options).toMatchObject({
        allowedFunctions: managedEncryptedRoutingRuleRpcFunctions,
        environment,
        fetch: fetcher
      });
      expect(JSON.stringify(options)).not.toContain(CONTEXT.accessToken);
      expect(JSON.stringify(options)).not.toContain(PRIVATE_CANARY);
    }
  });

  it.each([
    null,
    {},
    { accessToken: "", userId: OWNER_ID },
    { accessToken: " padded ", userId: OWNER_ID },
    { accessToken: "bad\0token", userId: OWNER_ID },
    { accessToken: "token", userId: "not-a-user" }
  ])("rejects invalid auth before creating privileged capabilities", async (value) => {
    const operation = new ManagedEncryptedRoutingRuleRepository().list(
      value as unknown as RoutingRuleRepositoryContext
    );

    await expect(operation).rejects.toMatchObject({
      status: 401,
      code: ApiErrorCode.UNAUTHORIZED
    });
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.createKeyRuntime).not.toHaveBeenCalled();
  });

  it("maps rule capacity and encrypted-service failures without reflecting plaintext", async () => {
    mocks.core.create.mockRejectedValueOnce(
      new RoutingRuleCapacityError("active_rule_limit_exceeded", 256, 257)
    );
    const repository = new ManagedEncryptedRoutingRuleRepository();
    await expect(repository.create(CONTEXT, CREATE)).rejects.toMatchObject({
      status: 429,
      code: ApiErrorCode.RATE_LIMITED
    });

    mocks.core.create.mockRejectedValueOnce(
      new EncryptedAggregateError(
        EncryptedAggregateErrorCode.INTEGRITY_CHECK_FAILED,
        PRIVATE_CANARY
      )
    );
    const aggregateFailure = repository.create(CONTEXT, CREATE);
    await expect(aggregateFailure).rejects.toMatchObject({
      status: 503,
      code: ApiErrorCode.PROVIDER_UNAVAILABLE
    });
    await aggregateFailure.catch((error: unknown) => {
      expect(String(error)).not.toContain(PRIVATE_CANARY);
    });

    mocks.core.create.mockRejectedValueOnce(new ServiceRpcError(ServiceRpcErrorCode.NOT_FOUND));
    const serviceFailure = repository.create(CONTEXT, CREATE);
    await expect(serviceFailure).rejects.toMatchObject({
      status: 404,
      code: ApiErrorCode.NOT_FOUND
    });
    await serviceFailure.catch((error: unknown) => {
      expect(String(error)).not.toContain(PRIVATE_CANARY);
    });
  });
});
