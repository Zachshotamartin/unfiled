import {
  ApiErrorCode,
  type ApiErrorCodeValue,
  type EntityId,
  type UserOperation
} from "@unfiled/contracts";
import { DomainError } from "@unfiled/domain";
import {
  EncryptedAggregateError,
  type AuthorizedOwnerAccess,
  type EncryptedAggregateService
} from "@unfiled/encrypted-aggregate";

import type {
  CreateNoteInput,
  NoteLinkRecord,
  NoteListFilters,
  NoteMutationResult,
  NoteRecord,
  RevisionRecord,
  UpdateNoteInput
} from "@/lib/product/types";
import { HttpError } from "@/server/api/errors";
import type {
  ExistingNoteWrite,
  ManualNotesRepository,
  RepositoryContext,
  RepositoryPage
} from "@/server/product/repository";

import {
  encryptedAggregateRuntimeRpcFunctions,
  withOwnerEncryptedAggregateRuntime
} from "./encrypted-aggregate-runtime";
import { createEncryptedLibraryRpcStore } from "./encrypted-library-rpc-store";
import { EncryptedLexicalSearch } from "./encrypted-lexical-search";
import { EncryptedNoteAggregateRepository } from "./encrypted-note-aggregate-repository";
import {
  createEncryptedNoteReadRpcAdapter,
  encryptedNoteReadRpcFunctions
} from "./encrypted-note-read-rpc-adapter";
import {
  createEncryptedNoteRpcAdapter,
  encryptedNoteWriteRpcFunctions
} from "./encrypted-note-rpc-adapter";
import {
  mappedEncryptedAggregateHttpError,
  mappedServiceRpcHttpError
} from "./managed-encryption-error-mapping";
import { EncryptedTaxonomyReadRepository } from "./encrypted-taxonomy-read-repository";
import {
  createEncryptedTaxonomyRpcAdapter,
  encryptedTaxonomyWriteRpcFunctions
} from "./encrypted-taxonomy-rpc-adapter";
import { EncryptedTaxonomyWriteCoordinator } from "./encrypted-taxonomy-write-coordinator";
import {
  createServiceRpcClient,
  settleServiceOperationBeforeAbort,
  ServiceRpcError,
  type ServiceRpcClient,
  throwIfServiceOperationAborted
} from "./service-rpc-client";
import { createInteractiveWebKeyRuntime, type WebKeyRuntimeEnvironment } from "./web-key-runtime";

const OWNER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_ACCESS_TOKEN_LENGTH = 16_384;
const MAX_OPERATION_SCOPE_MS = 60_000;

/**
 * The complete capability set available to one managed note operation. Keep
 * this explicit: adding an RPC to an adapter must not silently make it callable
 * by the service-role client.
 */
export const managedEncryptedNoteRpcFunctions = Object.freeze([
  ...encryptedAggregateRuntimeRpcFunctions,
  ...encryptedNoteReadRpcFunctions,
  ...encryptedNoteWriteRpcFunctions,
  ...encryptedTaxonomyWriteRpcFunctions,
  "list_encrypted_library_objects"
] as const);

type HttpMapping = Readonly<{
  code: ApiErrorCodeValue;
  message: string;
  status: number;
}>;

const DOMAIN_HTTP_MAPPING: Readonly<Partial<Record<ApiErrorCodeValue, HttpMapping>>> =
  Object.freeze({
    [ApiErrorCode.CONFLICT_REQUIRES_REVIEW]: {
      status: 409,
      code: ApiErrorCode.CONFLICT_REQUIRES_REVIEW,
      message: "This change needs review before it can be applied."
    },
    [ApiErrorCode.FORBIDDEN]: {
      status: 403,
      code: ApiErrorCode.FORBIDDEN,
      message: "You do not have access to that item."
    },
    [ApiErrorCode.NOT_FOUND]: {
      status: 404,
      code: ApiErrorCode.NOT_FOUND,
      message: "That item was not found."
    },
    [ApiErrorCode.STALE_REVISION]: {
      status: 409,
      code: ApiErrorCode.STALE_REVISION,
      message: "This note changed somewhere else. Review the latest version."
    },
    [ApiErrorCode.STRUCTURE_CONFLICT]: {
      status: 409,
      code: ApiErrorCode.STRUCTURE_CONFLICT,
      message: "This edit changes structured content ambiguously."
    },
    [ApiErrorCode.VALIDATION_FAILED]: {
      status: 400,
      code: ApiErrorCode.VALIDATION_FAILED,
      message: "Check this request and try again."
    }
  });

export type ManagedEncryptedNoteRepositoryOptions = Readonly<{
  environment?: WebKeyRuntimeEnvironment;
  fetch?: typeof fetch;
  /**
   * ManualNotesRepository does not currently carry Request.signal. A server
   * composition that does have one may supply it here without widening the
   * repository interface.
   */
  signalForOperation?: (context: RepositoryContext) => AbortSignal | undefined;
}>;

type ScopedSignal = Readonly<{
  close(): void;
  signal: AbortSignal;
}>;

type ScopedEncryptedOperation = Readonly<{
  access: AuthorizedOwnerAccess;
  aggregate: EncryptedAggregateService;
  client: ServiceRpcClient;
  ownerId: string;
}>;

/** Maps only the closed ServiceRpcError set; it never reflects provider text. */
export function serviceRpcErrorToHttpError(error: ServiceRpcError): HttpError {
  return mappedServiceRpcHttpError(error, "note");
}

/** Maps domain failures without reflecting note-derived error messages. */
function domainErrorToHttpError(error: DomainError): HttpError {
  const mapping = DOMAIN_HTTP_MAPPING[error.code] ?? {
    status: 503,
    code: ApiErrorCode.PROVIDER_UNAVAILABLE,
    message: "Encrypted storage could not complete that action. Try again."
  };
  return new HttpError(mapping.status, mapping.code, mapping.message);
}

/** A content-free, typed failure for capabilities not yet on the encrypted path. */
export class ManagedEncryptedNoteCapabilityUnavailableError extends HttpError {
  public constructor() {
    super(
      503,
      ApiErrorCode.PROVIDER_UNAVAILABLE,
      "That encrypted note capability is not available yet."
    );
    this.name = "ManagedEncryptedNoteCapabilityUnavailableError";
  }
}

function unauthorized(): never {
  throw new HttpError(401, ApiErrorCode.UNAUTHORIZED, "Sign in to continue.");
}

function authenticatedOwner(context: RepositoryContext): string {
  const candidate: unknown = context;
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return unauthorized();
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  if (
    typeof record.accessToken !== "string" ||
    record.accessToken.length < 1 ||
    record.accessToken.length > MAX_ACCESS_TOKEN_LENGTH ||
    record.accessToken.trim() !== record.accessToken ||
    record.accessToken.includes("\0") ||
    typeof record.userId !== "string" ||
    !OWNER_ID_PATTERN.test(record.userId)
  ) {
    return unauthorized();
  }
  return record.userId.toLowerCase();
}

function scopedSignal(parent: AbortSignal | undefined): ScopedSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, MAX_OPERATION_SCOPE_MS);
  if (parent?.aborted === true) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  let closed = false;
  return Object.freeze({
    signal: controller.signal,
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abort);
      abort();
    }
  });
}

/**
 * Manual-note facade whose managed key runtime, service-role RPC client,
 * strict adapters, and aggregate repository exist for exactly one authenticated
 * operation. It has no legacy repository dependency and therefore no plaintext
 * fallback path.
 */
export class ManagedEncryptedNoteRepository implements ManualNotesRepository {
  public constructor(private readonly options: ManagedEncryptedNoteRepositoryOptions = {}) {}

  private taxonomy(operation: ScopedEncryptedOperation): EncryptedTaxonomyWriteCoordinator {
    const reads = new EncryptedTaxonomyReadRepository({
      access: operation.access,
      aggregate: operation.aggregate,
      ownerId: operation.ownerId,
      store: createEncryptedLibraryRpcStore(operation.client)
    });
    return new EncryptedTaxonomyWriteCoordinator({
      access: operation.access,
      aggregate: operation.aggregate,
      ownerId: operation.ownerId,
      adapter: createEncryptedTaxonomyRpcAdapter(operation.client),
      reads
    });
  }

  private async scoped<Result>(
    context: RepositoryContext,
    use: (
      repository: EncryptedNoteAggregateRepository,
      operation: ScopedEncryptedOperation
    ) => Promise<Result>
  ): Promise<Result> {
    const ownerId = authenticatedOwner(context);
    const operationSignal = this.options.signalForOperation?.(context);
    const scope = scopedSignal(operationSignal);
    try {
      throwIfServiceOperationAborted(scope.signal);
      const client = createServiceRpcClient({
        allowedFunctions: managedEncryptedNoteRpcFunctions,
        signal: scope.signal,
        ...(this.options.environment === undefined
          ? {}
          : { environment: this.options.environment }),
        ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch })
      });
      const operation = (async () => {
        const runtime = await createInteractiveWebKeyRuntime(
          this.options.environment === undefined ? {} : { environment: this.options.environment }
        );
        throwIfServiceOperationAborted(scope.signal);
        return withOwnerEncryptedAggregateRuntime(
          runtime,
          client,
          ownerId,
          { signal: scope.signal },
          async ({ access, service }) => {
            const repository = new EncryptedNoteAggregateRepository({
              ownerId,
              access,
              aggregate: service,
              reads: createEncryptedNoteReadRpcAdapter(client),
              writes: createEncryptedNoteRpcAdapter(client)
            });
            return use(repository, Object.freeze({ access, aggregate: service, client, ownerId }));
          }
        );
      })();
      return await settleServiceOperationBeforeAbort(scope.signal, operation);
    } catch (error) {
      if (error instanceof ServiceRpcError) throw serviceRpcErrorToHttpError(error);
      if (error instanceof EncryptedAggregateError) {
        throw mappedEncryptedAggregateHttpError(error);
      }
      if (error instanceof DomainError) throw domainErrorToHttpError(error);
      throw error;
    } finally {
      scope.close();
    }
  }

  public async archiveNote(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    input: ExistingNoteWrite & { archived: boolean }
  ): Promise<NoteMutationResult> {
    return this.scoped(context, (repository) => repository.archiveNote(noteId, input));
  }

  public async archiveSpace(...parameters: Parameters<ManualNotesRepository["archiveSpace"]>) {
    return this.scoped(parameters[0], (_repository, operation) =>
      this.taxonomy(operation).archiveSpace(
        parameters[1],
        parameters[2],
        parameters[3],
        parameters[4]
      )
    );
  }

  public async createLink(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    input: ExistingNoteWrite & {
      linkType: "reference" | "related";
      toNoteId: EntityId<"note">;
    }
  ): Promise<NoteMutationResult> {
    return this.scoped(context, (repository) => repository.createLink(noteId, input));
  }

  public async createNote(
    context: RepositoryContext,
    input: CreateNoteInput,
    idempotencyKey: string
  ): Promise<NoteMutationResult> {
    return this.scoped(context, (repository) => repository.createNote(input, idempotencyKey));
  }

  public async createSpace(...parameters: Parameters<ManualNotesRepository["createSpace"]>) {
    return this.scoped(parameters[0], (_repository, operation) =>
      this.taxonomy(operation).createSpace(parameters[1], parameters[2])
    );
  }

  public async createTag(...parameters: Parameters<ManualNotesRepository["createTag"]>) {
    return this.scoped(parameters[0], (_repository, operation) =>
      this.taxonomy(operation).createTag(parameters[1], parameters[2])
    );
  }

  public async deleteLink(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    linkId: EntityId<"lnk">,
    input: ExistingNoteWrite & {
      linkType: "reference" | "related";
      toNoteId: EntityId<"note">;
    }
  ): Promise<NoteMutationResult> {
    return this.scoped(context, (repository) => repository.deleteLink(noteId, linkId, input));
  }

  public async deleteNote(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    input: ExistingNoteWrite
  ): Promise<NoteMutationResult> {
    return this.scoped(context, (repository) => repository.deleteNote(noteId, input));
  }

  public async deleteTag(...parameters: Parameters<ManualNotesRepository["deleteTag"]>) {
    return this.scoped(parameters[0], (_repository, operation) =>
      this.taxonomy(operation).deleteTag(parameters[1], parameters[2], parameters[3])
    );
  }

  public async getNote(context: RepositoryContext, noteId: EntityId<"note">): Promise<NoteRecord> {
    return this.scoped(context, (repository) => repository.getNote(noteId));
  }

  public async linkTag(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    tagId: EntityId<"tag">,
    input: ExistingNoteWrite
  ): Promise<NoteMutationResult> {
    return this.scoped(context, (repository) => repository.linkTag(noteId, tagId, input));
  }

  public async listLinks(
    context: RepositoryContext,
    noteId: EntityId<"note">
  ): Promise<readonly NoteLinkRecord[]> {
    return this.scoped(context, async (repository) => (await repository.getNote(noteId)).links);
  }

  public async listNotes(
    context: RepositoryContext,
    filters: NoteListFilters
  ): Promise<readonly NoteRecord[]> {
    return this.scoped(context, (repository) => repository.listNotes(filters));
  }

  public async listRevisions(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    page?: RepositoryPage
  ): Promise<readonly RevisionRecord[]> {
    return this.scoped(context, (repository) => repository.listRevisions(noteId, page));
  }

  public async listReviewItems(
    ...parameters: Parameters<ManualNotesRepository["listReviewItems"]>
  ) {
    return this.scoped(parameters[0], (_repository, operation) =>
      new EncryptedTaxonomyReadRepository({
        access: operation.access,
        aggregate: operation.aggregate,
        ownerId: operation.ownerId,
        store: createEncryptedLibraryRpcStore(operation.client)
      }).listReviewItems(parameters[1], parameters[2])
    );
  }

  public async listSpaces(...parameters: Parameters<ManualNotesRepository["listSpaces"]>) {
    return this.scoped(parameters[0], (_repository, operation) =>
      new EncryptedTaxonomyReadRepository({
        access: operation.access,
        aggregate: operation.aggregate,
        ownerId: operation.ownerId,
        store: createEncryptedLibraryRpcStore(operation.client)
      }).listSpaces(parameters[1], parameters[2])
    );
  }

  public async listTags(...parameters: Parameters<ManualNotesRepository["listTags"]>) {
    return this.scoped(parameters[0], (_repository, operation) =>
      new EncryptedTaxonomyReadRepository({
        access: operation.access,
        aggregate: operation.aggregate,
        ownerId: operation.ownerId,
        store: createEncryptedLibraryRpcStore(operation.client)
      }).listTags(parameters[1])
    );
  }

  public async moveNote(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    input: ExistingNoteWrite & { spaceId: EntityId<"spc"> | null }
  ): Promise<NoteMutationResult> {
    return this.scoped(context, (repository) => repository.moveNote(noteId, input));
  }

  public async restoreDeletedNote(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    input: ExistingNoteWrite
  ): Promise<NoteMutationResult> {
    return this.scoped(context, (repository) => repository.restoreDeletedNote(noteId, input));
  }

  public async restoreRevision(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    revisionId: EntityId<"rev">,
    input: ExistingNoteWrite
  ): Promise<NoteMutationResult> {
    return this.scoped(context, (repository) =>
      repository.restoreRevision(noteId, revisionId, input)
    );
  }

  public async search(...parameters: Parameters<ManualNotesRepository["search"]>) {
    return this.scoped(parameters[0], (repository) =>
      new EncryptedLexicalSearch(repository).search(parameters[1], parameters[2], parameters[3])
    );
  }

  public async unlinkTag(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    tagId: EntityId<"tag">,
    input: ExistingNoteWrite
  ): Promise<NoteMutationResult> {
    return this.scoped(context, (repository) => repository.unlinkTag(noteId, tagId, input));
  }

  public async undoMutation(
    context: RepositoryContext,
    mutationId: EntityId<"mut">,
    input: ExistingNoteWrite
  ): Promise<NoteMutationResult> {
    return this.scoped(context, (repository) => repository.undoMutation(mutationId, input));
  }

  public async updateNote(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    input: UpdateNoteInput,
    idempotencyKey: string
  ): Promise<NoteMutationResult> {
    return this.scoped(context, (repository) =>
      repository.updateNote(noteId, input, idempotencyKey)
    );
  }

  public async updateSpace(...parameters: Parameters<ManualNotesRepository["updateSpace"]>) {
    return this.scoped(parameters[0], (_repository, operation) =>
      this.taxonomy(operation).updateSpace(
        parameters[1],
        parameters[2],
        parameters[3],
        parameters[4]
      )
    );
  }

  public async updateTag(...parameters: Parameters<ManualNotesRepository["updateTag"]>) {
    return this.scoped(parameters[0], (_repository, operation) =>
      this.taxonomy(operation).updateTag(parameters[1], parameters[2], parameters[3], parameters[4])
    );
  }

  public async applyOperations(
    context: RepositoryContext,
    noteId: EntityId<"note">,
    operations: readonly UserOperation[],
    input: ExistingNoteWrite
  ): Promise<NoteMutationResult> {
    return this.scoped(context, (repository) =>
      repository.applyOperations(noteId, operations, input)
    );
  }
}
