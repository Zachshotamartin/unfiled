import {
  ApiErrorCode,
  type DecisionCorrectionRequest,
  type EntityId,
  type MutationUndoRequest,
  type ReviewResolveRequest
} from "@unfiled/contracts";
import { DomainError } from "@unfiled/domain";
import { EncryptedAggregateError, EncryptedAggregateErrorCode } from "@unfiled/encrypted-aggregate";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OwnerInteractionRepositoryContext } from "@/server/owner-interactions/repository";

const mocks = vi.hoisted(() => ({
  adapters: [] as unknown[],
  captureAdapters: [] as unknown[],
  clients: [] as unknown[],
  coordinatorDependencies: [] as unknown[],
  routingCoordinatorDependencies: [] as unknown[],
  core: {
    correctDecision: vi.fn(),
    resolveReviewItem: vi.fn(),
    undoMutationBatch: vi.fn()
  },
  createAdapter: vi.fn(),
  createCaptureAdapter: vi.fn(),
  createKeyRuntime: vi.fn(),
  createPreparedService: vi.fn(),
  createServiceClient: vi.fn(),
  getCaptureDetail: vi.fn(),
  leaseActive: false,
  observeCorrection: vi.fn(),
  openCapture: vi.fn(),
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

type InteractionAdapterModule = Readonly<{
  createEncryptedOwnerInteractionRpcAdapter: typeof createEncryptedOwnerInteractionRpcAdapter;
  encryptedOwnerInteractionRpcFunctions: typeof encryptedOwnerInteractionRpcFunctions;
}>;

type CaptureAdapterModule = Readonly<{
  createEncryptedCaptureRpcAdapter: typeof createEncryptedCaptureRpcAdapter;
}>;

type CoordinatorModule = Readonly<{
  EncryptedOwnerInteractionCoordinator: typeof EncryptedOwnerInteractionCoordinator;
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

vi.mock("./encrypted-owner-interaction-rpc-adapter", async (importOriginal) => {
  const actual = await importOriginal<InteractionAdapterModule>();
  return { ...actual, createEncryptedOwnerInteractionRpcAdapter: mocks.createAdapter };
});

vi.mock("./encrypted-capture-rpc-adapter", async (importOriginal) => {
  const actual = await importOriginal<CaptureAdapterModule>();
  return { ...actual, createEncryptedCaptureRpcAdapter: mocks.createCaptureAdapter };
});

vi.mock(
  "@/server/owner-interactions/encrypted-owner-interaction-coordinator",
  async (importOriginal) => {
    const actual = await importOriginal<CoordinatorModule>();
    return {
      ...actual,
      EncryptedOwnerInteractionCoordinator: function MockCoordinator(dependencies: unknown) {
        mocks.coordinatorDependencies.push(dependencies);
        return mocks.core;
      }
    };
  }
);

vi.mock("@/server/routing-rules/encrypted-routing-rule-coordinator", async (importOriginal) => {
  const actual = await importOriginal<RoutingCoordinatorModule>();
  return {
    ...actual,
    EncryptedRoutingRuleCoordinator: function MockRoutingRuleCoordinator(dependencies: unknown) {
      mocks.routingCoordinatorDependencies.push(dependencies);
      return Object.freeze({ observeCorrection: mocks.observeCorrection });
    }
  };
});

import {
  encryptedAggregateRuntimeRpcFunctions,
  type OwnerEncryptedAggregateRuntime,
  type withOwnerEncryptedAggregateRuntime
} from "./encrypted-aggregate-runtime";
import type { createEncryptedCaptureRpcAdapter } from "./encrypted-capture-rpc-adapter";
import {
  type createEncryptedOwnerInteractionRpcAdapter,
  encryptedOwnerInteractionRpcFunctions
} from "./encrypted-owner-interaction-rpc-adapter";
import { encryptedRoutingRuleRpcFunctions } from "./encrypted-routing-rule-rpc-adapter";
import {
  ManagedEncryptedOwnerInteractionRepository,
  managedEncryptedOwnerInteractionRpcFunctions
} from "./managed-encrypted-owner-interaction-repository";
import {
  type createServiceRpcClient,
  ServiceRpcError,
  ServiceRpcErrorCode,
  type ServiceRpcClient
} from "./service-rpc-client";
import type { createInteractiveWebKeyRuntime, InteractiveWebKeyRuntime } from "./web-key-runtime";
import type { EncryptedOwnerInteractionCoordinator } from "@/server/owner-interactions/encrypted-owner-interaction-coordinator";
import type { EncryptedOwnerInteractionCoordinatorDependencies } from "@/server/owner-interactions/encrypted-owner-interaction-coordinator";
import type { EncryptedRoutingRuleCoordinator } from "@/server/routing-rules/encrypted-routing-rule-coordinator";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const CONTEXT: OwnerInteractionRepositoryContext = Object.freeze({
  accessToken: "authenticated-access-token",
  userId: OWNER_ID
});
const DECISION_ID = "dec_01J6M9Q7G4BMKB33GSG3NJ6D1X" as EntityId<"dec">;
const REVIEW_ID = "rvw_01J6M9Q7G4BMKB33GSG3NJ6D1X" as EntityId<"rvw">;
const MUTATION_ID = "mut_01J6M9Q7G4BMKB33GSG3NJ6D1X" as EntityId<"mut">;
const CAPTURE_ID = "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X" as EntityId<"cap">;
const FEEDBACK_ID = "fbk_01J6M9Q7G4BMKB33GSG3NJ6D1X" as EntityId<"fbk">;
const NOTE_A = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X" as EntityId<"note">;
const NOTE_B = "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y" as EntityId<"note">;
const PRIVATE_CANARY = "private owner interaction title 7fcb9e";

const CORRECTION: DecisionCorrectionRequest = Object.freeze({
  idempotencyKey: "managed-correction-01",
  source: { noteId: NOTE_A, expectedRevision: 2 },
  destination: { type: "existing_note" as const, noteId: NOTE_B, expectedRevision: 4 }
});
const REVIEW_RESOLUTION: ReviewResolveRequest = Object.freeze({
  idempotencyKey: "managed-review-01",
  resolution: {
    type: "create" as const,
    title: PRIVATE_CANARY,
    noteType: "generic" as const,
    spaceId: null
  }
});
const BATCH_UNDO: MutationUndoRequest = Object.freeze({
  expectedRevision: 5,
  idempotencyKey: "managed-batch-undo-01"
});

const RESULTS = Object.freeze({
  correction: Object.freeze({ kind: "correction-result" }),
  review: Object.freeze({ kind: "review-result" }),
  undo: Object.freeze({ kind: "undo-result" })
});

function resetCore(): void {
  mocks.core.correctDecision.mockReset().mockResolvedValue(RESULTS.correction);
  mocks.core.resolveReviewItem.mockReset().mockResolvedValue(RESULTS.review);
  mocks.core.undoMutationBatch.mockReset().mockResolvedValue(RESULTS.undo);
}

beforeEach(() => {
  mocks.adapters.length = 0;
  mocks.captureAdapters.length = 0;
  mocks.clients.length = 0;
  mocks.coordinatorDependencies.length = 0;
  mocks.routingCoordinatorDependencies.length = 0;
  mocks.runtimes.length = 0;
  mocks.signals.length = 0;
  mocks.leaseActive = false;
  mocks.createAdapter.mockReset();
  mocks.createCaptureAdapter.mockReset();
  mocks.createKeyRuntime.mockReset();
  mocks.createPreparedService.mockReset();
  mocks.createServiceClient.mockReset();
  mocks.getCaptureDetail.mockReset();
  mocks.observeCorrection.mockReset().mockResolvedValue(undefined);
  mocks.openCapture.mockReset();
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
  mocks.createAdapter.mockImplementation((client: unknown) => {
    const adapter = Object.freeze({ kind: "strict-owner-interaction", client });
    mocks.adapters.push(adapter);
    return adapter;
  });
  mocks.createCaptureAdapter.mockImplementation((client: unknown) => {
    const adapter = Object.freeze({ client, getCaptureDetail: mocks.getCaptureDetail });
    mocks.captureAdapters.push(adapter);
    return adapter;
  });
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
          createPreparedService: mocks.createPreparedService,
          service: Object.freeze({ kind: "aggregate-service", openCapture: mocks.openCapture })
        }) as unknown as OwnerEncryptedAggregateRuntime
      );
    } finally {
      mocks.leaseActive = false;
    }
  });
});

describe("managed encrypted owner-interaction repository", () => {
  it("uses the exact duplicate-free aggregate and interaction RPC capabilities", () => {
    expect(managedEncryptedOwnerInteractionRpcFunctions).toEqual([
      ...encryptedAggregateRuntimeRpcFunctions,
      ...encryptedOwnerInteractionRpcFunctions,
      "get_encrypted_capture_detail",
      "get_encrypted_generated_blocks",
      "list_encrypted_library_objects",
      ...encryptedRoutingRuleRpcFunctions
    ]);
    expect(new Set(managedEncryptedOwnerInteractionRpcFunctions).size).toBe(
      managedEncryptedOwnerInteractionRpcFunctions.length
    );
    expect(Object.isFrozen(managedEncryptedOwnerInteractionRpcFunctions)).toBe(true);
  });

  it("creates a fresh bounded custody scope and coordinator for every operation", async () => {
    const environment = Object.freeze({ NODE_ENV: "test" });
    const fetcher = vi.fn() as unknown as typeof fetch;
    const repository = new ManagedEncryptedOwnerInteractionRepository({
      environment,
      fetch: fetcher
    });
    const uppercaseContext = Object.freeze({
      accessToken: CONTEXT.accessToken,
      userId: OWNER_ID.toUpperCase()
    });

    await expect(
      repository.correctDecision(uppercaseContext, DECISION_ID, CORRECTION)
    ).resolves.toBe(RESULTS.correction);
    await expect(
      repository.resolveReviewItem(uppercaseContext, REVIEW_ID, REVIEW_RESOLUTION)
    ).resolves.toBe(RESULTS.review);
    await expect(
      repository.undoMutationBatch(uppercaseContext, MUTATION_ID, BATCH_UNDO)
    ).resolves.toBe(RESULTS.undo);

    expect(mocks.createServiceClient).toHaveBeenCalledTimes(3);
    expect(mocks.createKeyRuntime).toHaveBeenCalledTimes(3);
    expect(mocks.withOwnerRuntime).toHaveBeenCalledTimes(3);
    expect(mocks.createAdapter).toHaveBeenCalledTimes(3);
    expect(mocks.coordinatorDependencies).toHaveLength(3);
    expect(mocks.clients[0]).not.toBe(mocks.clients[1]);
    expect(mocks.runtimes[0]).not.toBe(mocks.runtimes[1]);
    expect(mocks.signals.every(({ aborted }) => aborted)).toBe(true);
    expect(mocks.leaseActive).toBe(false);

    for (const [index, dependencies] of mocks.coordinatorDependencies.entries()) {
      const coordinatorDependencies =
        dependencies as EncryptedOwnerInteractionCoordinatorDependencies;
      expect(Object.keys(dependencies as object).sort()).toEqual([
        "access",
        "adapter",
        "aggregate",
        "createPreparedService",
        "observeRoutingRuleCorrection",
        "ownerId",
        "routingRuleObservationDeadlineAt",
        "signal"
      ]);
      expect(coordinatorDependencies).toMatchObject({
        ownerId: OWNER_ID,
        adapter: { kind: "strict-owner-interaction", client: mocks.clients[index] }
      });
      expect(typeof coordinatorDependencies.routingRuleObservationDeadlineAt).toBe("number");
    }
    expect(mocks.core.correctDecision).toHaveBeenCalledWith(DECISION_ID, CORRECTION);
    expect(mocks.core.resolveReviewItem).toHaveBeenCalledWith(REVIEW_ID, REVIEW_RESOLUTION);
    expect(mocks.core.undoMutationBatch).toHaveBeenCalledWith(MUTATION_ID, BATCH_UNDO);

    for (const [options] of mocks.createServiceClient.mock.calls) {
      expect(options).toMatchObject({
        allowedFunctions: managedEncryptedOwnerInteractionRpcFunctions,
        environment,
        fetch: fetcher
      });
      expect(JSON.stringify(options)).not.toContain(CONTEXT.accessToken);
      expect(JSON.stringify(options)).not.toContain(PRIVATE_CANARY);
    }
  });

  it("reopens the authenticated source capture when a correction replay resumes rule learning", async () => {
    const captureText = "shopping: oat milk and batteries";
    const contentCipher = Object.freeze({ kind: "capture-cipher" });
    const contentMac = Object.freeze({ kind: "capture-mac" });
    mocks.getCaptureDetail.mockResolvedValue(
      Object.freeze({
        captureId: CAPTURE_ID,
        recordVersion: 1,
        privacy: "ai_assisted",
        contentLength: captureText.length,
        contentCipher,
        contentMac
      })
    );
    mocks.openCapture.mockResolvedValue({ schemaVersion: 1, rawContent: captureText });
    mocks.core.correctDecision.mockImplementationOnce(async () => {
      const dependencies = mocks.coordinatorDependencies.at(
        -1
      ) as EncryptedOwnerInteractionCoordinatorDependencies;
      await dependencies.observeRoutingRuleCorrection({
        feedbackEventId: FEEDBACK_ID,
        captureId: CAPTURE_ID,
        captureText: null,
        destination: { type: "note", noteId: NOTE_B }
      });
      return RESULTS.correction;
    });

    await expect(
      new ManagedEncryptedOwnerInteractionRepository().correctDecision(
        CONTEXT,
        DECISION_ID,
        CORRECTION
      )
    ).resolves.toBe(RESULTS.correction);

    expect(mocks.getCaptureDetail).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      captureId: CAPTURE_ID
    });
    expect(mocks.openCapture).toHaveBeenCalledWith(
      { ownerId: OWNER_ID },
      { encrypted: contentCipher, contentMac },
      { captureId: CAPTURE_ID, recordVersion: 1, privacy: "ai_assisted" }
    );
    expect(mocks.observeCorrection).toHaveBeenCalledWith({
      feedbackEventId: FEEDBACK_ID,
      captureText,
      destination: { type: "note", noteId: NOTE_B }
    });
    expect(mocks.signals[0]?.aborted).toBe(true);
  });

  it.each([
    null,
    {},
    { accessToken: "", userId: OWNER_ID },
    { accessToken: " padded ", userId: OWNER_ID },
    { accessToken: "bad\0token", userId: OWNER_ID },
    { accessToken: "token", userId: "not-a-user" }
  ])(
    "rejects an invalid authenticated context before creating privileged capabilities",
    async (value) => {
      const repository = new ManagedEncryptedOwnerInteractionRepository();
      const operation = repository.correctDecision(
        value as unknown as OwnerInteractionRepositoryContext,
        DECISION_ID,
        CORRECTION
      );

      await expect(operation).rejects.toMatchObject({
        status: 401,
        code: ApiErrorCode.UNAUTHORIZED
      });
      expect(mocks.createServiceClient).not.toHaveBeenCalled();
      expect(mocks.createKeyRuntime).not.toHaveBeenCalled();
    }
  );

  it("maps the Review fallback conflict without reusing the unrelated name-conflict copy", async () => {
    mocks.core.undoMutationBatch.mockRejectedValue(
      new ServiceRpcError(ServiceRpcErrorCode.CONFLICT_REQUIRES_REVIEW)
    );
    const repository = new ManagedEncryptedOwnerInteractionRepository();

    const operation = repository.undoMutationBatch(CONTEXT, MUTATION_ID, BATCH_UNDO);

    await expect(operation).rejects.toMatchObject({
      status: 409,
      code: ApiErrorCode.CONFLICT_REQUIRES_REVIEW,
      message: "Review this change before editing the note."
    });
  });

  it.each([
    [ServiceRpcErrorCode.FORBIDDEN, 403, ApiErrorCode.FORBIDDEN],
    [ServiceRpcErrorCode.NOT_FOUND, 404, ApiErrorCode.NOT_FOUND],
    [ServiceRpcErrorCode.STALE_REVISION, 409, ApiErrorCode.STALE_REVISION],
    [ServiceRpcErrorCode.PROVIDER_UNAVAILABLE, 503, ApiErrorCode.PROVIDER_UNAVAILABLE]
  ] as const)("maps service failure %s to stable HTTP output", async (code, status, apiCode) => {
    mocks.core.correctDecision.mockRejectedValue(new ServiceRpcError(code));
    const operation = new ManagedEncryptedOwnerInteractionRepository().correctDecision(
      CONTEXT,
      DECISION_ID,
      CORRECTION
    );

    await expect(operation).rejects.toMatchObject({ status, code: apiCode });
    await operation.catch((error: unknown) => {
      expect(String(error)).not.toContain(PRIVATE_CANARY);
    });
  });

  it("maps aggregate and domain failures without reflecting their private messages", async () => {
    mocks.core.correctDecision.mockRejectedValueOnce(
      new EncryptedAggregateError(
        EncryptedAggregateErrorCode.INTEGRITY_CHECK_FAILED,
        PRIVATE_CANARY
      )
    );
    const repository = new ManagedEncryptedOwnerInteractionRepository();
    const aggregateFailure = repository.correctDecision(CONTEXT, DECISION_ID, CORRECTION);
    await expect(aggregateFailure).rejects.toMatchObject({
      status: 503,
      code: ApiErrorCode.PROVIDER_UNAVAILABLE
    });
    await aggregateFailure.catch((error: unknown) => {
      expect(String(error)).not.toContain(PRIVATE_CANARY);
    });

    mocks.core.correctDecision.mockRejectedValueOnce(
      new DomainError(ApiErrorCode.STRUCTURE_CONFLICT, PRIVATE_CANARY)
    );
    const domainFailure = repository.correctDecision(CONTEXT, DECISION_ID, CORRECTION);
    await expect(domainFailure).rejects.toMatchObject({
      status: 409,
      code: ApiErrorCode.STRUCTURE_CONFLICT,
      message: "This change cannot preserve the note structure safely."
    });
  });

  it("fails an already-cancelled request before allocating a service client", async () => {
    const controller = new AbortController();
    controller.abort();
    const repository = new ManagedEncryptedOwnerInteractionRepository({
      signalForOperation: () => controller.signal
    });

    await expect(
      repository.correctDecision(CONTEXT, DECISION_ID, CORRECTION)
    ).rejects.toMatchObject({
      status: 503,
      code: ApiErrorCode.PROVIDER_UNAVAILABLE
    });
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it("revokes the scoped signal and custody lease after an unexpected failure", async () => {
    const unexpected = new Error("content-free test failure");
    mocks.core.resolveReviewItem.mockRejectedValue(unexpected);
    const repository = new ManagedEncryptedOwnerInteractionRepository();

    await expect(repository.resolveReviewItem(CONTEXT, REVIEW_ID, REVIEW_RESOLUTION)).rejects.toBe(
      unexpected
    );

    expect(mocks.signals).toHaveLength(1);
    expect(mocks.signals[0]?.aborted).toBe(true);
    expect(mocks.leaseActive).toBe(false);
  });
});
