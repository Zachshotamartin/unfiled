import { ApiErrorCode, type EntityId } from "@unfiled/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HttpError } from "@/server/api/errors";
import type {
  CaptureRepositoryContext,
  NormalizedCaptureCreateInput,
  NormalizedCaptureDeleteInput
} from "@/server/captures/repository";

const mocks = vi.hoisted(() => ({
  aggregateDependencies: [] as unknown[],
  clients: [] as unknown[],
  core: {
    createCapture: vi.fn(),
    deleteCapture: vi.fn(),
    getCapture: vi.fn(),
    getReceipt: vi.fn(),
    listCaptures: vi.fn(),
    retryCapture: vi.fn()
  },
  createCaptureAdapter: vi.fn(),
  createKeyRuntime: vi.fn(),
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

type CaptureAdapterModule = Readonly<{
  createEncryptedCaptureRpcAdapter: typeof createEncryptedCaptureRpcAdapter;
  encryptedCaptureRpcFunctions: typeof encryptedCaptureRpcFunctions;
}>;

type CaptureAggregateModule = Readonly<{
  EncryptedCaptureAggregateRepository: typeof EncryptedCaptureAggregateRepository;
  EncryptedCaptureOperationUnavailableError: typeof EncryptedCaptureOperationUnavailableError;
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

vi.mock("./encrypted-capture-rpc-adapter", async (importOriginal) => {
  const actual = await importOriginal<CaptureAdapterModule>();
  return { ...actual, createEncryptedCaptureRpcAdapter: mocks.createCaptureAdapter };
});

vi.mock("./encrypted-capture-aggregate-repository", async (importOriginal) => {
  const actual = await importOriginal<CaptureAggregateModule>();
  return {
    ...actual,
    EncryptedCaptureAggregateRepository: function MockEncryptedCaptureAggregateRepository(
      dependencies: unknown
    ) {
      mocks.aggregateDependencies.push(dependencies);
      return mocks.core;
    }
  };
});

import {
  encryptedAggregateRuntimeRpcFunctions,
  type OwnerEncryptedAggregateRuntime,
  type withOwnerEncryptedAggregateRuntime
} from "./encrypted-aggregate-runtime";
import {
  type EncryptedCaptureAggregateRepository,
  EncryptedCaptureOperationUnavailableError
} from "./encrypted-capture-aggregate-repository";
import {
  type createEncryptedCaptureRpcAdapter,
  encryptedCaptureRpcFunctions
} from "./encrypted-capture-rpc-adapter";
import { encryptedNoteReadRpcFunctions } from "./encrypted-note-read-rpc-adapter";
import {
  captureServiceRpcErrorToHttpError,
  ManagedEncryptedCaptureCapabilityUnavailableError,
  ManagedEncryptedCaptureRepository,
  managedEncryptedCaptureRpcFunctions
} from "./managed-encrypted-capture-repository";
import {
  type createServiceRpcClient,
  ServiceRpcError,
  ServiceRpcErrorCode,
  type ServiceRpcClient
} from "./service-rpc-client";
import type { createInteractiveWebKeyRuntime, InteractiveWebKeyRuntime } from "./web-key-runtime";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const UPPERCASE_OWNER_ID = OWNER_ID.toUpperCase();
const ACCESS_TOKEN = "authenticated-access-token";
const CONTEXT: CaptureRepositoryContext = Object.freeze({
  accessToken: ACCESS_TOKEN,
  userId: OWNER_ID
});
const CAPTURE_ID = "cap_01J00000000000000000000000" as EntityId<"cap">;
const NOTE_ID = "note_01J00000000000000000000000" as EntityId<"note">;
const IDEMPOTENCY_KEY = "test-operation-00000001";
const CANARY = "private capture: summer house alarm code";
const RESULT = Object.freeze({ result: "encrypted-capture-core-result" });
const CREATE_INPUT: NormalizedCaptureCreateInput = Object.freeze({
  clientCaptureId: CAPTURE_ID,
  rawContent: "Buy tea",
  source: "web",
  deviceId: "browser-1",
  clientCreatedAt: "2026-08-31T12:00:00.000Z",
  clientTimezone: "America/Los_Angeles",
  privacy: "private_manual",
  explicitDestinationNoteId: NOTE_ID,
  expansionDisabled: true
});
const DELETE_INPUT: NormalizedCaptureDeleteInput = Object.freeze({
  idempotencyKey: IDEMPOTENCY_KEY,
  removeInsertedContent: false,
  expectedNoteRevisions: Object.freeze([])
});
const LIST_QUERY = Object.freeze({ limit: 25, status: "inbox" as const });

function resetCore(): void {
  for (const operation of Object.values(mocks.core)) {
    operation.mockReset();
    operation.mockResolvedValue(RESULT);
  }
}

beforeEach(() => {
  mocks.aggregateDependencies.length = 0;
  mocks.clients.length = 0;
  mocks.runtimes.length = 0;
  mocks.signals.length = 0;
  mocks.leaseActive = false;
  mocks.createCaptureAdapter.mockReset();
  mocks.createKeyRuntime.mockReset();
  mocks.createServiceClient.mockReset();
  mocks.withOwnerRuntime.mockReset();
  resetCore();

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
  mocks.createCaptureAdapter.mockImplementation((client: unknown) =>
    Object.freeze({ kind: "strict-capture", client })
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
          service: Object.freeze({ kind: "aggregate-service" })
        }) as unknown as OwnerEncryptedAggregateRuntime
      );
    } finally {
      mocks.leaseActive = false;
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("managed encrypted capture repository", () => {
  it("uses the exact duplicate-free runtime/capture RPC capability composition", () => {
    expect(managedEncryptedCaptureRpcFunctions).toEqual([
      ...encryptedAggregateRuntimeRpcFunctions,
      ...encryptedCaptureRpcFunctions,
      ...encryptedNoteReadRpcFunctions
    ]);
    expect(new Set(managedEncryptedCaptureRpcFunctions).size).toBe(
      managedEncryptedCaptureRpcFunctions.length
    );
    expect(Object.isFrozen(managedEncryptedCaptureRpcFunctions)).toBe(true);
  });

  it("creates and closes a fresh managed custody scope and service client per call", async () => {
    const environment = Object.freeze({ NODE_ENV: "test" });
    const request = vi.fn() as unknown as typeof fetch;
    const repository = new ManagedEncryptedCaptureRepository({ environment, fetch: request });
    const uppercaseContext = Object.freeze({
      accessToken: ACCESS_TOKEN,
      userId: UPPERCASE_OWNER_ID
    });
    mocks.core.getCapture.mockImplementation(() => {
      expect(mocks.leaseActive).toBe(true);
      return Promise.resolve(RESULT);
    });

    await expect(repository.getCapture(uppercaseContext, CAPTURE_ID)).resolves.toBe(RESULT);
    await expect(repository.getCapture(uppercaseContext, CAPTURE_ID)).resolves.toBe(RESULT);

    expect(mocks.createServiceClient).toHaveBeenCalledTimes(2);
    expect(mocks.createKeyRuntime).toHaveBeenCalledTimes(2);
    expect(mocks.withOwnerRuntime).toHaveBeenCalledTimes(2);
    expect(mocks.createCaptureAdapter).toHaveBeenCalledTimes(2);
    expect(mocks.aggregateDependencies).toHaveLength(2);
    expect(mocks.clients[0]).not.toBe(mocks.clients[1]);
    expect(mocks.runtimes[0]).not.toBe(mocks.runtimes[1]);
    expect(mocks.signals[0]).not.toBe(mocks.signals[1]);
    expect(mocks.signals.every(({ aborted }) => aborted)).toBe(true);
    expect(mocks.leaseActive).toBe(false);

    for (const [index, dependencies] of mocks.aggregateDependencies.entries()) {
      expect(Object.keys(dependencies as object).sort()).toEqual([
        "access",
        "adapter",
        "aggregate",
        "noteReads",
        "ownerId",
        "signal"
      ]);
      expect(dependencies).toMatchObject({
        ownerId: OWNER_ID,
        adapter: { kind: "strict-capture", client: mocks.clients[index] }
      });
    }
    expect(mocks.createServiceClient).toHaveBeenNthCalledWith(1, {
      allowedFunctions: managedEncryptedCaptureRpcFunctions,
      environment,
      fetch: request,
      signal: mocks.signals[0]
    });
    expect(mocks.createKeyRuntime).toHaveBeenNthCalledWith(1, { environment });
    expect(JSON.stringify(mocks.createServiceClient.mock.calls)).not.toContain(ACCESS_TOKEN);
  });

  it("fails closed when caller cancellation wins and detaches the parent signal", async () => {
    const parent = new AbortController();
    const remove = vi.spyOn(parent.signal, "removeEventListener");
    const repository = new ManagedEncryptedCaptureRepository({
      signalForOperation: () => parent.signal
    });
    let release: ((value: unknown) => void) | undefined;
    mocks.core.getCapture.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );

    const pending = repository.getCapture(CONTEXT, CAPTURE_ID);
    await vi.waitFor(() => expect(mocks.signals).toHaveLength(1));
    expect(mocks.signals[0]?.aborted).toBe(false);
    parent.abort();
    expect(mocks.signals[0]?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({
      status: 503,
      code: ApiErrorCode.PROVIDER_UNAVAILABLE
    } satisfies Partial<HttpError>);
    release?.(RESULT);
    await vi.waitFor(() => expect(mocks.leaseActive).toBe(false));
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("rejects pre-aborted operations before creating a privileged capability", async () => {
    const parent = new AbortController();
    parent.abort();
    const preAborted = new ManagedEncryptedCaptureRepository({
      signalForOperation: () => parent.signal
    });
    await expect(preAborted.getCapture(CONTEXT, CAPTURE_ID)).rejects.toMatchObject({
      status: 503,
      code: ApiErrorCode.PROVIDER_UNAVAILABLE
    } satisfies Partial<HttpError>);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.createKeyRuntime).not.toHaveBeenCalled();
    expect(mocks.withOwnerRuntime).not.toHaveBeenCalled();
  });

  it("fails closed at the operation deadline even if the repository later resolves", async () => {
    vi.useFakeTimers();
    const repository = new ManagedEncryptedCaptureRepository();
    let release: ((value: unknown) => void) | undefined;
    mocks.core.getCapture.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const pending = repository.getCapture(CONTEXT, CAPTURE_ID);
    const rejected = expect(pending).rejects.toMatchObject({
      status: 503,
      code: ApiErrorCode.PROVIDER_UNAVAILABLE
    } satisfies Partial<HttpError>);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.signals.at(-1)?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.signals.at(-1)?.aborted).toBe(true);
    await rejected;
    release?.(RESULT);
    await vi.runAllTimersAsync();
    expect(mocks.leaseActive).toBe(false);
  });

  it("delegates the complete CaptureRepository surface inside separate scopes", async () => {
    const repository = new ManagedEncryptedCaptureRepository();
    const calls: readonly Readonly<{
      invoke(): Promise<unknown>;
      operation: keyof typeof mocks.core;
      expected: readonly unknown[];
    }>[] = [
      {
        operation: "createCapture",
        expected: [CONTEXT, CREATE_INPUT],
        invoke: () => repository.createCapture(CONTEXT, CREATE_INPUT)
      },
      {
        operation: "deleteCapture",
        expected: [CONTEXT, CAPTURE_ID, DELETE_INPUT],
        invoke: () => repository.deleteCapture(CONTEXT, CAPTURE_ID, DELETE_INPUT)
      },
      {
        operation: "getCapture",
        expected: [CONTEXT, CAPTURE_ID],
        invoke: () => repository.getCapture(CONTEXT, CAPTURE_ID)
      },
      {
        operation: "getReceipt",
        expected: [CONTEXT, CAPTURE_ID],
        invoke: () => repository.getReceipt(CONTEXT, CAPTURE_ID)
      },
      {
        operation: "listCaptures",
        expected: [CONTEXT, LIST_QUERY],
        invoke: () => repository.listCaptures(CONTEXT, LIST_QUERY)
      },
      {
        operation: "retryCapture",
        expected: [CONTEXT, CAPTURE_ID, IDEMPOTENCY_KEY],
        invoke: () => repository.retryCapture(CONTEXT, CAPTURE_ID, IDEMPOTENCY_KEY)
      }
    ];

    for (const call of calls) {
      await expect(call.invoke()).resolves.toBe(RESULT);
      expect(mocks.core[call.operation]).toHaveBeenLastCalledWith(...call.expected);
      expect(mocks.leaseActive).toBe(false);
      expect(mocks.signals.at(-1)?.aborted).toBe(true);
    }
    expect(mocks.createServiceClient).toHaveBeenCalledTimes(calls.length);
    expect(mocks.createKeyRuntime).toHaveBeenCalledTimes(calls.length);
    expect(mocks.aggregateDependencies).toHaveLength(calls.length);
  });

  it("rejects malformed owners and tokens before creating privileged capabilities", async () => {
    const repository = new ManagedEncryptedCaptureRepository();
    const invalidContexts: readonly unknown[] = [
      null,
      [],
      { accessToken: "", userId: OWNER_ID },
      { accessToken: ` ${ACCESS_TOKEN}`, userId: OWNER_ID },
      { accessToken: `${ACCESS_TOKEN} `, userId: OWNER_ID },
      { accessToken: `${ACCESS_TOKEN}\0`, userId: OWNER_ID },
      { accessToken: "x".repeat(16_385), userId: OWNER_ID },
      { accessToken: ACCESS_TOKEN, userId: "not-an-owner" },
      { accessToken: ACCESS_TOKEN, userId: "11111111-1111-0111-8111-111111111111" }
    ];

    for (const context of invalidContexts) {
      await expect(
        repository.getCapture(context as CaptureRepositoryContext, CAPTURE_ID)
      ).rejects.toMatchObject({
        status: 401,
        code: ApiErrorCode.UNAUTHORIZED,
        message: "Sign in to continue."
      } satisfies Partial<HttpError>);
    }
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.createKeyRuntime).not.toHaveBeenCalled();
    expect(mocks.withOwnerRuntime).not.toHaveBeenCalled();
    expect(mocks.createCaptureAdapter).not.toHaveBeenCalled();
    expect(mocks.aggregateDependencies).toHaveLength(0);
  });

  it("maps the complete ServiceRpcError set to stable content-free HTTP errors", () => {
    const cases = [
      [
        ServiceRpcErrorCode.FORBIDDEN,
        403,
        ApiErrorCode.FORBIDDEN,
        "You do not have access to that item."
      ],
      [
        ServiceRpcErrorCode.INVALID_IDEMPOTENCY_KEY,
        409,
        ApiErrorCode.INVALID_IDEMPOTENCY_KEY,
        "That action key was already used for something different."
      ],
      [
        ServiceRpcErrorCode.KEY_UNAVAILABLE,
        503,
        ApiErrorCode.PROVIDER_UNAVAILABLE,
        "Encrypted storage is temporarily unavailable. Try again."
      ],
      [ServiceRpcErrorCode.NOT_FOUND, 404, ApiErrorCode.NOT_FOUND, "That item was not found."],
      [
        ServiceRpcErrorCode.PROVIDER_UNAVAILABLE,
        503,
        ApiErrorCode.PROVIDER_UNAVAILABLE,
        "Encrypted storage could not complete that action. Try again."
      ],
      [
        ServiceRpcErrorCode.STALE_REVISION,
        409,
        ApiErrorCode.STALE_REVISION,
        "This capture changed somewhere else. Review the latest version."
      ],
      [ServiceRpcErrorCode.UNAUTHORIZED, 401, ApiErrorCode.UNAUTHORIZED, "Sign in to continue."],
      [
        ServiceRpcErrorCode.VALIDATION_FAILED,
        400,
        ApiErrorCode.VALIDATION_FAILED,
        "Check this request and try again."
      ]
    ] as const;

    for (const [serviceCode, status, apiCode, message] of cases) {
      const serviceError = new ServiceRpcError(serviceCode);
      Object.defineProperty(serviceError, "message", { value: CANARY });
      const mapped = captureServiceRpcErrorToHttpError(serviceError);
      expect(mapped).toMatchObject({ status, code: apiCode, message });
      expect(mapped.message).not.toContain(CANARY);
    }
  });

  it("translates scoped service failures only after revoking the custody scope", async () => {
    const repository = new ManagedEncryptedCaptureRepository();
    const serviceError = new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
    Object.defineProperty(serviceError, "message", { value: CANARY });
    mocks.core.getReceipt.mockRejectedValue(serviceError);

    const error = await repository
      .getReceipt(CONTEXT, CAPTURE_ID)
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      status: 503,
      code: ApiErrorCode.PROVIDER_UNAVAILABLE,
      message: "Encrypted storage could not complete that action. Try again."
    } satisfies Partial<HttpError>);
    expect(String(error)).not.toContain(CANARY);
    expect(mocks.leaseActive).toBe(false);
    expect(mocks.signals[0]?.aborted).toBe(true);
  });

  it("keeps encrypted retry and delete fail-closed without any legacy fallback", async () => {
    const repository = new ManagedEncryptedCaptureRepository();
    const retryFailure = new EncryptedCaptureOperationUnavailableError("retry");
    const deleteFailure = new EncryptedCaptureOperationUnavailableError("delete");
    Object.defineProperty(retryFailure, "message", { value: CANARY });
    Object.defineProperty(deleteFailure, "message", { value: CANARY });
    mocks.core.retryCapture.mockRejectedValue(retryFailure);
    mocks.core.deleteCapture.mockRejectedValue(deleteFailure);

    for (const invoke of [
      () => repository.retryCapture(CONTEXT, CAPTURE_ID, IDEMPOTENCY_KEY),
      () => repository.deleteCapture(CONTEXT, CAPTURE_ID, DELETE_INPUT)
    ]) {
      const error = await invoke().catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(ManagedEncryptedCaptureCapabilityUnavailableError);
      expect(error).toMatchObject({
        status: 503,
        code: ApiErrorCode.PROVIDER_UNAVAILABLE,
        message: "That encrypted capture capability is not available yet."
      } satisfies Partial<HttpError>);
      expect(String(error)).not.toContain(CANARY);
      expect(mocks.leaseActive).toBe(false);
      expect(mocks.signals.at(-1)?.aborted).toBe(true);
    }

    expect(mocks.core.retryCapture).toHaveBeenCalledWith(CONTEXT, CAPTURE_ID, IDEMPOTENCY_KEY);
    expect(mocks.core.deleteCapture).toHaveBeenCalledWith(CONTEXT, CAPTURE_ID, DELETE_INPUT);
    expect(mocks.aggregateDependencies).toHaveLength(2);
    expect(
      mocks.aggregateDependencies.every(
        (dependencies) => !("legacy" in (dependencies as Readonly<Record<string, unknown>>))
      )
    ).toBe(true);
  });

  it("does not translate unknown failures and still closes their scope", async () => {
    const repository = new ManagedEncryptedCaptureRepository();
    const unknownFailure = new Error("programmer failure");
    mocks.core.listCaptures.mockRejectedValue(unknownFailure);

    await expect(repository.listCaptures(CONTEXT, LIST_QUERY)).rejects.toBe(unknownFailure);
    expect(mocks.leaseActive).toBe(false);
    expect(mocks.signals[0]?.aborted).toBe(true);
  });
});
