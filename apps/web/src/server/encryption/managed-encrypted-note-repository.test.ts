import { ApiErrorCode, type EntityId, type UserOperation } from "@unfiled/contracts";
import { DomainError } from "@unfiled/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CreateNoteInput, NoteRecord, UpdateNoteInput } from "@/lib/product/types";
import type { HttpError } from "@/server/api/errors";
import type { RepositoryContext } from "@/server/product/repository";

const mocks = vi.hoisted(() => ({
  aggregateDependencies: [] as unknown[],
  clients: [] as unknown[],
  core: {
    applyOperations: vi.fn(),
    archiveNote: vi.fn(),
    createLink: vi.fn(),
    createNote: vi.fn(),
    deleteLink: vi.fn(),
    deleteNote: vi.fn(),
    getNote: vi.fn(),
    linkTag: vi.fn(),
    listNotes: vi.fn(),
    listRevisions: vi.fn(),
    moveNote: vi.fn(),
    restoreDeletedNote: vi.fn(),
    restoreRevision: vi.fn(),
    undoMutation: vi.fn(),
    unlinkTag: vi.fn(),
    updateNote: vi.fn()
  },
  createKeyRuntime: vi.fn(),
  createLibraryStore: vi.fn(),
  createReadAdapter: vi.fn(),
  createServiceClient: vi.fn(),
  createTaxonomyWriteAdapter: vi.fn(),
  createWriteAdapter: vi.fn(),
  lexical: {
    search: vi.fn()
  },
  lexicalDependencies: [] as unknown[],
  leaseActive: false,
  libraryStores: [] as unknown[],
  runtimes: [] as unknown[],
  signals: [] as AbortSignal[],
  taxonomy: {
    listReviewItems: vi.fn(),
    listSpaces: vi.fn(),
    listTags: vi.fn()
  },
  taxonomyDependencies: [] as unknown[],
  taxonomyWriteDependencies: [] as unknown[],
  taxonomyWrites: {
    archiveSpace: vi.fn(),
    createSpace: vi.fn(),
    createTag: vi.fn(),
    deleteTag: vi.fn(),
    updateSpace: vi.fn(),
    updateTag: vi.fn()
  },
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

type NoteReadAdapterModule = Readonly<{
  createEncryptedNoteReadRpcAdapter: typeof createEncryptedNoteReadRpcAdapter;
  encryptedNoteReadRpcFunctions: typeof encryptedNoteReadRpcFunctions;
}>;

type NoteWriteAdapterModule = Readonly<{
  createEncryptedNoteRpcAdapter: typeof createEncryptedNoteRpcAdapter;
  encryptedNoteWriteRpcFunctions: typeof encryptedNoteWriteRpcFunctions;
}>;

type TaxonomyWriteAdapterModule = Readonly<{
  createEncryptedTaxonomyRpcAdapter: typeof createEncryptedTaxonomyRpcAdapter;
  encryptedTaxonomyWriteRpcFunctions: typeof encryptedTaxonomyWriteRpcFunctions;
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

vi.mock("./encrypted-note-read-rpc-adapter", async (importOriginal) => {
  const actual = await importOriginal<NoteReadAdapterModule>();
  return { ...actual, createEncryptedNoteReadRpcAdapter: mocks.createReadAdapter };
});

vi.mock("./encrypted-note-rpc-adapter", async (importOriginal) => {
  const actual = await importOriginal<NoteWriteAdapterModule>();
  return { ...actual, createEncryptedNoteRpcAdapter: mocks.createWriteAdapter };
});

vi.mock("./encrypted-taxonomy-rpc-adapter", async (importOriginal) => {
  const actual = await importOriginal<TaxonomyWriteAdapterModule>();
  return { ...actual, createEncryptedTaxonomyRpcAdapter: mocks.createTaxonomyWriteAdapter };
});

vi.mock("./encrypted-taxonomy-write-coordinator", () => ({
  EncryptedTaxonomyWriteCoordinator: function MockEncryptedTaxonomyWriteCoordinator(
    dependencies: unknown
  ) {
    mocks.taxonomyWriteDependencies.push(dependencies);
    return mocks.taxonomyWrites;
  }
}));

vi.mock("./encrypted-library-rpc-store", () => ({
  createEncryptedLibraryRpcStore: mocks.createLibraryStore
}));

vi.mock("./encrypted-taxonomy-read-repository", () => ({
  EncryptedTaxonomyReadRepository: function MockEncryptedTaxonomyReadRepository(
    dependencies: unknown
  ) {
    mocks.taxonomyDependencies.push(dependencies);
    return mocks.taxonomy;
  }
}));

vi.mock("./encrypted-lexical-search", () => ({
  EncryptedLexicalSearch: function MockEncryptedLexicalSearch(dependencies: unknown) {
    mocks.lexicalDependencies.push(dependencies);
    return mocks.lexical;
  }
}));

vi.mock("./encrypted-note-aggregate-repository", () => ({
  EncryptedNoteAggregateRepository: function MockEncryptedNoteAggregateRepository(
    dependencies: unknown
  ) {
    mocks.aggregateDependencies.push(dependencies);
    return mocks.core;
  }
}));

import {
  encryptedAggregateRuntimeRpcFunctions,
  type OwnerEncryptedAggregateRuntime,
  type withOwnerEncryptedAggregateRuntime
} from "./encrypted-aggregate-runtime";
import {
  type createEncryptedNoteReadRpcAdapter,
  encryptedNoteReadRpcFunctions
} from "./encrypted-note-read-rpc-adapter";
import {
  type createEncryptedNoteRpcAdapter,
  encryptedNoteWriteRpcFunctions
} from "./encrypted-note-rpc-adapter";
import {
  type createEncryptedTaxonomyRpcAdapter,
  encryptedTaxonomyWriteRpcFunctions
} from "./encrypted-taxonomy-rpc-adapter";
import {
  ManagedEncryptedNoteRepository,
  managedEncryptedNoteRpcFunctions,
  serviceRpcErrorToHttpError
} from "./managed-encrypted-note-repository";
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
const CONTEXT: RepositoryContext = Object.freeze({ accessToken: ACCESS_TOKEN, userId: OWNER_ID });
const NOTE_ID = "note_01J00000000000000000000000" as EntityId<"note">;
const TARGET_NOTE_ID = "note_01J00000000000000000000001" as EntityId<"note">;
const LINK_ID = "lnk_01J00000000000000000000000" as EntityId<"lnk">;
const MUTATION_ID = "mut_01J00000000000000000000000" as EntityId<"mut">;
const REVISION_ID = "rev_01J00000000000000000000000" as EntityId<"rev">;
const SPACE_ID = "spc_01J00000000000000000000000" as EntityId<"spc">;
const TAG_ID = "tag_01J00000000000000000000000" as EntityId<"tag">;
const IDEMPOTENCY_KEY = "test-operation-00000001";
const CANARY = "private note: summer house alarm code";
const RESULT = Object.freeze({ result: "encrypted-core-result" });
const LINKS = Object.freeze([
  Object.freeze({
    id: LINK_ID,
    fromNoteId: NOTE_ID,
    toNoteId: TARGET_NOTE_ID,
    linkType: "related" as const,
    targetTitle: "Target"
  })
]);
const NOTE = Object.freeze({ links: LINKS }) as NoteRecord;
const CREATE_INPUT: CreateNoteInput = Object.freeze({
  title: "Title",
  bodyMarkdown: "Body",
  type: "generic",
  privacy: "private_manual",
  spaceId: null,
  tagIds: [],
  links: []
});
const UPDATE_INPUT: UpdateNoteInput = Object.freeze({ expectedRevision: 2, title: "Updated" });
const WRITE = Object.freeze({ expectedRevision: 2, idempotencyKey: IDEMPOTENCY_KEY });
const OPERATIONS = Object.freeze([
  Object.freeze({ type: "set_title" as const, title: "Updated" })
]) satisfies readonly UserOperation[];

function resetCore(): void {
  for (const operation of Object.values(mocks.core)) {
    operation.mockReset();
    operation.mockResolvedValue(RESULT);
  }
  mocks.core.getNote.mockResolvedValue(NOTE);
}

beforeEach(() => {
  mocks.aggregateDependencies.length = 0;
  mocks.clients.length = 0;
  mocks.lexicalDependencies.length = 0;
  mocks.libraryStores.length = 0;
  mocks.runtimes.length = 0;
  mocks.signals.length = 0;
  mocks.taxonomyDependencies.length = 0;
  mocks.taxonomyWriteDependencies.length = 0;
  mocks.leaseActive = false;
  mocks.createKeyRuntime.mockReset();
  mocks.createLibraryStore.mockReset();
  mocks.createReadAdapter.mockReset();
  mocks.createServiceClient.mockReset();
  mocks.createTaxonomyWriteAdapter.mockReset();
  mocks.createWriteAdapter.mockReset();
  mocks.withOwnerRuntime.mockReset();
  for (const operation of Object.values(mocks.lexical)) {
    operation.mockReset();
    operation.mockResolvedValue(RESULT);
  }
  for (const operation of Object.values(mocks.taxonomy)) {
    operation.mockReset();
    operation.mockResolvedValue(RESULT);
  }
  for (const operation of Object.values(mocks.taxonomyWrites)) {
    operation.mockReset();
    operation.mockResolvedValue(RESULT);
  }
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
  mocks.createLibraryStore.mockImplementation((client: unknown) => {
    const store = Object.freeze({ kind: "encrypted-library-read", client });
    mocks.libraryStores.push(store);
    return store;
  });
  mocks.createReadAdapter.mockImplementation((client: unknown) =>
    Object.freeze({ kind: "strict-read", client })
  );
  mocks.createWriteAdapter.mockImplementation((client: unknown) =>
    Object.freeze({ kind: "strict-write", client })
  );
  mocks.createTaxonomyWriteAdapter.mockImplementation((client: unknown) =>
    Object.freeze({ kind: "strict-taxonomy-write", client })
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

describe("managed encrypted note repository", () => {
  it("uses the exact duplicate-free runtime/read/write RPC capability composition", () => {
    expect(managedEncryptedNoteRpcFunctions).toEqual([
      ...encryptedAggregateRuntimeRpcFunctions,
      ...encryptedNoteReadRpcFunctions,
      ...encryptedNoteWriteRpcFunctions,
      ...encryptedTaxonomyWriteRpcFunctions,
      "list_encrypted_library_objects"
    ]);
    expect(new Set(managedEncryptedNoteRpcFunctions).size).toBe(
      managedEncryptedNoteRpcFunctions.length
    );
    expect(Object.isFrozen(managedEncryptedNoteRpcFunctions)).toBe(true);
  });

  it("creates and closes a fresh complete custody scope for every authenticated operation", async () => {
    const environment = Object.freeze({ NODE_ENV: "test" });
    const repository = new ManagedEncryptedNoteRepository({ environment });
    const uppercaseContext = Object.freeze({
      accessToken: ACCESS_TOKEN,
      userId: UPPERCASE_OWNER_ID
    });
    mocks.core.getNote.mockImplementation(() => {
      expect(mocks.leaseActive).toBe(true);
      return Promise.resolve(NOTE);
    });

    await expect(repository.getNote(uppercaseContext, NOTE_ID)).resolves.toBe(NOTE);
    await expect(repository.getNote(uppercaseContext, NOTE_ID)).resolves.toBe(NOTE);

    expect(mocks.createServiceClient).toHaveBeenCalledTimes(2);
    expect(mocks.createKeyRuntime).toHaveBeenCalledTimes(2);
    expect(mocks.withOwnerRuntime).toHaveBeenCalledTimes(2);
    expect(mocks.createReadAdapter).toHaveBeenCalledTimes(2);
    expect(mocks.createWriteAdapter).toHaveBeenCalledTimes(2);
    expect(mocks.aggregateDependencies).toHaveLength(2);
    expect(mocks.clients[0]).not.toBe(mocks.clients[1]);
    expect(mocks.runtimes[0]).not.toBe(mocks.runtimes[1]);
    expect(mocks.signals[0]).not.toBe(mocks.signals[1]);
    expect(mocks.signals.every(({ aborted }) => aborted)).toBe(true);
    expect(mocks.leaseActive).toBe(false);

    for (const [index, dependencies] of mocks.aggregateDependencies.entries()) {
      expect(dependencies).toMatchObject({
        ownerId: OWNER_ID,
        reads: { kind: "strict-read", client: mocks.clients[index] },
        writes: { kind: "strict-write", client: mocks.clients[index] }
      });
    }
    expect(mocks.createServiceClient).toHaveBeenNthCalledWith(1, {
      allowedFunctions: managedEncryptedNoteRpcFunctions,
      environment,
      signal: mocks.signals[0]
    });
    expect(mocks.createKeyRuntime).toHaveBeenNthCalledWith(1, { environment });
    expect(JSON.stringify(mocks.createServiceClient.mock.calls)).not.toContain(ACCESS_TOKEN);
  });

  it("fails closed when caller cancellation wins even if the repository later resolves", async () => {
    const parent = new AbortController();
    const repository = new ManagedEncryptedNoteRepository({
      signalForOperation: () => parent.signal
    });
    let release: ((note: NoteRecord) => void) | undefined;
    mocks.core.getNote.mockImplementation(
      () =>
        new Promise<NoteRecord>((resolve) => {
          release = resolve;
        })
    );

    const pending = repository.getNote(CONTEXT, NOTE_ID);
    await vi.waitFor(() => expect(mocks.signals).toHaveLength(1));
    expect(mocks.signals[0]?.aborted).toBe(false);
    parent.abort();
    expect(mocks.signals[0]?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({
      status: 503,
      code: ApiErrorCode.PROVIDER_UNAVAILABLE
    } satisfies Partial<HttpError>);
    release?.(NOTE);
    await vi.waitFor(() => expect(mocks.leaseActive).toBe(false));
  });

  it("rejects an already-cancelled operation before creating a privileged capability", async () => {
    const parent = new AbortController();
    parent.abort();
    const repository = new ManagedEncryptedNoteRepository({
      signalForOperation: () => parent.signal
    });

    await expect(repository.getNote(CONTEXT, NOTE_ID)).rejects.toMatchObject({
      status: 503,
      code: ApiErrorCode.PROVIDER_UNAVAILABLE
    } satisfies Partial<HttpError>);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.createKeyRuntime).not.toHaveBeenCalled();
    expect(mocks.withOwnerRuntime).not.toHaveBeenCalled();
  });

  it("fails closed at the operation deadline even if the repository later resolves", async () => {
    vi.useFakeTimers();
    const repository = new ManagedEncryptedNoteRepository();
    let release: ((note: NoteRecord) => void) | undefined;
    mocks.core.getNote.mockImplementation(
      () =>
        new Promise<NoteRecord>((resolve) => {
          release = resolve;
        })
    );

    const pending = repository.getNote(CONTEXT, NOTE_ID);
    const rejected = expect(pending).rejects.toMatchObject({
      status: 503,
      code: ApiErrorCode.PROVIDER_UNAVAILABLE
    } satisfies Partial<HttpError>);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.signals).toHaveLength(1);
    expect(mocks.signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.signals[0]?.aborted).toBe(true);
    await rejected;

    release?.(NOTE);
    await vi.runAllTimersAsync();
    expect(mocks.leaseActive).toBe(false);
  });

  it("delegates the complete encrypted note-core surface inside operation scopes", async () => {
    const repository = new ManagedEncryptedNoteRepository();
    const calls: readonly Readonly<{
      invoke(): Promise<unknown>;
      operation: keyof typeof mocks.core;
      expected: readonly unknown[];
    }>[] = [
      {
        operation: "archiveNote",
        expected: [NOTE_ID, { ...WRITE, archived: true }],
        invoke: () => repository.archiveNote(CONTEXT, NOTE_ID, { ...WRITE, archived: true })
      },
      {
        operation: "createLink",
        expected: [NOTE_ID, { ...WRITE, linkType: "related", toNoteId: TARGET_NOTE_ID }],
        invoke: () =>
          repository.createLink(CONTEXT, NOTE_ID, {
            ...WRITE,
            linkType: "related",
            toNoteId: TARGET_NOTE_ID
          })
      },
      {
        operation: "createNote",
        expected: [CREATE_INPUT, IDEMPOTENCY_KEY],
        invoke: () => repository.createNote(CONTEXT, CREATE_INPUT, IDEMPOTENCY_KEY)
      },
      {
        operation: "deleteLink",
        expected: [NOTE_ID, LINK_ID, { ...WRITE, linkType: "related", toNoteId: TARGET_NOTE_ID }],
        invoke: () =>
          repository.deleteLink(CONTEXT, NOTE_ID, LINK_ID, {
            ...WRITE,
            linkType: "related",
            toNoteId: TARGET_NOTE_ID
          })
      },
      {
        operation: "deleteNote",
        expected: [NOTE_ID, WRITE],
        invoke: () => repository.deleteNote(CONTEXT, NOTE_ID, WRITE)
      },
      {
        operation: "getNote",
        expected: [NOTE_ID],
        invoke: () => repository.getNote(CONTEXT, NOTE_ID)
      },
      {
        operation: "linkTag",
        expected: [NOTE_ID, TAG_ID, WRITE],
        invoke: () => repository.linkTag(CONTEXT, NOTE_ID, TAG_ID, WRITE)
      },
      {
        operation: "listNotes",
        expected: [{ archived: "exclude", limit: 10 }],
        invoke: () => repository.listNotes(CONTEXT, { archived: "exclude", limit: 10 })
      },
      {
        operation: "listRevisions",
        expected: [NOTE_ID, { limit: 10, offset: 2 }],
        invoke: () => repository.listRevisions(CONTEXT, NOTE_ID, { limit: 10, offset: 2 })
      },
      {
        operation: "moveNote",
        expected: [NOTE_ID, { ...WRITE, spaceId: SPACE_ID }],
        invoke: () => repository.moveNote(CONTEXT, NOTE_ID, { ...WRITE, spaceId: SPACE_ID })
      },
      {
        operation: "restoreDeletedNote",
        expected: [NOTE_ID, WRITE],
        invoke: () => repository.restoreDeletedNote(CONTEXT, NOTE_ID, WRITE)
      },
      {
        operation: "restoreRevision",
        expected: [NOTE_ID, REVISION_ID, WRITE],
        invoke: () => repository.restoreRevision(CONTEXT, NOTE_ID, REVISION_ID, WRITE)
      },
      {
        operation: "unlinkTag",
        expected: [NOTE_ID, TAG_ID, WRITE],
        invoke: () => repository.unlinkTag(CONTEXT, NOTE_ID, TAG_ID, WRITE)
      },
      {
        operation: "undoMutation",
        expected: [MUTATION_ID, WRITE],
        invoke: () => repository.undoMutation(CONTEXT, MUTATION_ID, WRITE)
      },
      {
        operation: "updateNote",
        expected: [NOTE_ID, UPDATE_INPUT, IDEMPOTENCY_KEY],
        invoke: () => repository.updateNote(CONTEXT, NOTE_ID, UPDATE_INPUT, IDEMPOTENCY_KEY)
      },
      {
        operation: "applyOperations",
        expected: [NOTE_ID, OPERATIONS, WRITE],
        invoke: () => repository.applyOperations(CONTEXT, NOTE_ID, OPERATIONS, WRITE)
      }
    ];

    for (const call of calls) {
      await call.invoke();
      expect(mocks.core[call.operation]).toHaveBeenLastCalledWith(...call.expected);
      expect(mocks.leaseActive).toBe(false);
    }
    await expect(repository.listLinks(CONTEXT, NOTE_ID)).resolves.toBe(LINKS);
    expect(mocks.core.getNote).toHaveBeenLastCalledWith(NOTE_ID);
    expect(mocks.createServiceClient).toHaveBeenCalledTimes(calls.length + 1);
    expect(mocks.signals.every(({ aborted }) => aborted)).toBe(true);
  });

  it("rejects malformed owner contexts before creating any privileged capability", async () => {
    const repository = new ManagedEncryptedNoteRepository();
    const invalidContexts = [
      { accessToken: "", userId: OWNER_ID },
      { accessToken: ` ${ACCESS_TOKEN}`, userId: OWNER_ID },
      { accessToken: ACCESS_TOKEN, userId: "not-an-owner" }
    ] as const;

    for (const context of invalidContexts) {
      await expect(repository.getNote(context, NOTE_ID)).rejects.toMatchObject({
        status: 401,
        code: ApiErrorCode.UNAUTHORIZED,
        message: "Sign in to continue."
      } satisfies Partial<HttpError>);
    }
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.createKeyRuntime).not.toHaveBeenCalled();
    expect(mocks.withOwnerRuntime).not.toHaveBeenCalled();
  });

  it("delegates encrypted taxonomy, review, and search reads inside complete custody scopes", async () => {
    const repository = new ManagedEncryptedNoteRepository();

    await expect(
      repository.listReviewItems(CONTEXT, "open", { limit: 10, offset: 1 })
    ).resolves.toBe(RESULT);
    await expect(repository.listSpaces(CONTEXT, true, { limit: 9, offset: 2 })).resolves.toBe(
      RESULT
    );
    await expect(repository.listTags(CONTEXT, { limit: 8, offset: 3 })).resolves.toBe(RESULT);
    await expect(
      repository.search(CONTEXT, CANARY, "include", { limit: 7, offset: 4 })
    ).resolves.toBe(RESULT);

    expect(mocks.taxonomy.listReviewItems).toHaveBeenCalledWith("open", {
      limit: 10,
      offset: 1
    });
    expect(mocks.taxonomy.listSpaces).toHaveBeenCalledWith(true, { limit: 9, offset: 2 });
    expect(mocks.taxonomy.listTags).toHaveBeenCalledWith({ limit: 8, offset: 3 });
    expect(mocks.lexical.search).toHaveBeenCalledWith(CANARY, "include", {
      limit: 7,
      offset: 4
    });
    expect(mocks.taxonomyDependencies).toHaveLength(3);
    expect(mocks.lexicalDependencies).toEqual([mocks.core]);
    expect(mocks.libraryStores).toHaveLength(3);
    expect(mocks.createServiceClient).toHaveBeenCalledTimes(4);
    expect(mocks.signals.every(({ aborted }) => aborted)).toBe(true);
  });

  it("routes every taxonomy write through a fresh scoped encrypted coordinator", async () => {
    const repository = new ManagedEncryptedNoteRepository();
    const spaceInput = { name: CANARY, parentId: null, sortKey: "a0" } as const;

    await expect(
      repository.archiveSpace(CONTEXT, SPACE_ID, true, 1, IDEMPOTENCY_KEY)
    ).resolves.toBe(RESULT);
    await expect(repository.createSpace(CONTEXT, spaceInput, IDEMPOTENCY_KEY)).resolves.toBe(
      RESULT
    );
    await expect(repository.createTag(CONTEXT, CANARY, IDEMPOTENCY_KEY)).resolves.toBe(RESULT);
    await expect(repository.deleteTag(CONTEXT, TAG_ID, 1, IDEMPOTENCY_KEY)).resolves.toBe(RESULT);
    await expect(
      repository.updateSpace(CONTEXT, SPACE_ID, { name: CANARY }, 1, IDEMPOTENCY_KEY)
    ).resolves.toBe(RESULT);
    await expect(repository.updateTag(CONTEXT, TAG_ID, CANARY, 1, IDEMPOTENCY_KEY)).resolves.toBe(
      RESULT
    );

    expect(mocks.taxonomyWrites.archiveSpace).toHaveBeenCalledWith(
      SPACE_ID,
      true,
      1,
      IDEMPOTENCY_KEY
    );
    expect(mocks.taxonomyWrites.createSpace).toHaveBeenCalledWith(spaceInput, IDEMPOTENCY_KEY);
    expect(mocks.taxonomyWrites.createTag).toHaveBeenCalledWith(CANARY, IDEMPOTENCY_KEY);
    expect(mocks.taxonomyWrites.deleteTag).toHaveBeenCalledWith(TAG_ID, 1, IDEMPOTENCY_KEY);
    expect(mocks.taxonomyWrites.updateSpace).toHaveBeenCalledWith(
      SPACE_ID,
      { name: CANARY },
      1,
      IDEMPOTENCY_KEY
    );
    expect(mocks.taxonomyWrites.updateTag).toHaveBeenCalledWith(TAG_ID, CANARY, 1, IDEMPOTENCY_KEY);
    expect(mocks.taxonomyWriteDependencies).toHaveLength(6);
    expect(mocks.createTaxonomyWriteAdapter).toHaveBeenCalledTimes(6);
    expect(mocks.createServiceClient).toHaveBeenCalledTimes(6);
    expect(mocks.signals.every(({ aborted }) => aborted)).toBe(true);
  });

  it("maps the complete ServiceRpcError code set to stable content-free HTTP errors", () => {
    const cases = [
      [
        ServiceRpcErrorCode.CONFLICT_REQUIRES_REVIEW,
        409,
        ApiErrorCode.CONFLICT_REQUIRES_REVIEW,
        "That name is already in use."
      ],
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
        "This note changed somewhere else. Review the latest version."
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
      const mapped = serviceRpcErrorToHttpError(serviceError);
      expect(mapped).toMatchObject({ status, code: apiCode, message });
      expect(mapped.message).not.toContain(CANARY);
    }
  });

  it("translates scoped service failures after closing the custody scope", async () => {
    const repository = new ManagedEncryptedNoteRepository();
    mocks.core.getNote.mockRejectedValue(new ServiceRpcError(ServiceRpcErrorCode.STALE_REVISION));

    await expect(repository.getNote(CONTEXT, NOTE_ID)).rejects.toMatchObject({
      status: 409,
      code: ApiErrorCode.STALE_REVISION
    } satisfies Partial<HttpError>);
    expect(mocks.leaseActive).toBe(false);
    expect(mocks.signals[0]?.aborted).toBe(true);
    expect(mocks.core.getNote).toHaveBeenCalledTimes(1);
    expect(mocks.createServiceClient).toHaveBeenCalledTimes(1);
    expect(mocks.withOwnerRuntime).toHaveBeenCalledTimes(1);
  });

  it("preserves domain error semantics without reflecting note-derived details", async () => {
    const repository = new ManagedEncryptedNoteRepository();
    const cases = [
      [ApiErrorCode.STRUCTURE_CONFLICT, 409, "This edit changes structured content ambiguously."],
      [
        ApiErrorCode.CONFLICT_REQUIRES_REVIEW,
        409,
        "This change needs review before it can be applied."
      ],
      [ApiErrorCode.VALIDATION_FAILED, 400, "Check this request and try again."]
    ] as const;

    for (const [code, status, message] of cases) {
      mocks.core.updateNote.mockRejectedValueOnce(new DomainError(code, CANARY));
      const error = await repository
        .updateNote(CONTEXT, NOTE_ID, UPDATE_INPUT, IDEMPOTENCY_KEY)
        .catch((reason: unknown) => reason);
      expect(error).toMatchObject({ code, status, message } satisfies Partial<HttpError>);
      expect(String(error)).not.toContain(CANARY);
      expect(mocks.leaseActive).toBe(false);
      expect(mocks.signals.at(-1)?.aborted).toBe(true);
    }
  });
});
