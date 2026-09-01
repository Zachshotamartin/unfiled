import {
  ApiErrorCode,
  type ApiErrorCodeValue,
  type DecisionCorrectionRequest,
  type DecisionCorrectionResponse,
  type EntityId,
  type MutationBatchUndoResponse,
  type MutationUndoRequest,
  type ReviewResolveRequest,
  type ReviewResolveResponse
} from "@unfiled/contracts";
import { DomainError } from "@unfiled/domain";
import { EncryptedAggregateError } from "@unfiled/encrypted-aggregate";

import { HttpError } from "@/server/api/errors";
import {
  EncryptedOwnerInteractionCoordinator,
  type EncryptedOwnerInteractionCoordinatorDependencies
} from "@/server/owner-interactions/encrypted-owner-interaction-coordinator";
import type {
  OwnerInteractionRepository,
  OwnerInteractionRepositoryContext
} from "@/server/owner-interactions/repository";

import {
  encryptedAggregateRuntimeRpcFunctions,
  withOwnerEncryptedAggregateRuntime
} from "./encrypted-aggregate-runtime";
import {
  createEncryptedOwnerInteractionRpcAdapter,
  encryptedOwnerInteractionRpcFunctions
} from "./encrypted-owner-interaction-rpc-adapter";
import {
  mappedEncryptedAggregateHttpError,
  mappedServiceRpcHttpError
} from "./managed-encryption-error-mapping";
import {
  createServiceRpcClient,
  settleServiceOperationBeforeAbort,
  ServiceRpcError,
  ServiceRpcErrorCode,
  throwIfServiceOperationAborted
} from "./service-rpc-client";
import { createInteractiveWebKeyRuntime, type WebKeyRuntimeEnvironment } from "./web-key-runtime";

const OWNER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_ACCESS_TOKEN_LENGTH = 16_384;
const MAX_OPERATION_SCOPE_MS = 60_000;

/** Exact service-role capability set for one owner-interaction request. */
export const managedEncryptedOwnerInteractionRpcFunctions = Object.freeze([
  ...encryptedAggregateRuntimeRpcFunctions,
  ...encryptedOwnerInteractionRpcFunctions
] as const);

export type ManagedEncryptedOwnerInteractionRepositoryOptions = Readonly<{
  environment?: WebKeyRuntimeEnvironment;
  fetch?: typeof fetch;
  signalForOperation?: (context: OwnerInteractionRepositoryContext) => AbortSignal | undefined;
}>;

type ScopedSignal = Readonly<{
  close(): void;
  signal: AbortSignal;
}>;

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
      message: "Review this change before editing the note."
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
      message: "A related note changed somewhere else. Review the latest version."
    },
    [ApiErrorCode.STRUCTURE_CONFLICT]: {
      status: 409,
      code: ApiErrorCode.STRUCTURE_CONFLICT,
      message: "This change cannot preserve the note structure safely."
    },
    [ApiErrorCode.VALIDATION_FAILED]: {
      status: 400,
      code: ApiErrorCode.VALIDATION_FAILED,
      message: "Check this request and try again."
    }
  });

function unauthorized(): never {
  throw new HttpError(401, ApiErrorCode.UNAUTHORIZED, "Sign in to continue.");
}

function authenticatedOwner(context: OwnerInteractionRepositoryContext): string {
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

function serviceErrorToHttpError(error: ServiceRpcError): HttpError {
  if (error.code === ServiceRpcErrorCode.CONFLICT_REQUIRES_REVIEW) {
    return new HttpError(
      409,
      ApiErrorCode.CONFLICT_REQUIRES_REVIEW,
      "Review this change before editing the note."
    );
  }
  return mappedServiceRpcHttpError(error, "note");
}

function domainErrorToHttpError(error: DomainError): HttpError {
  const mapping = DOMAIN_HTTP_MAPPING[error.code] ?? {
    status: 503,
    code: ApiErrorCode.PROVIDER_UNAVAILABLE,
    message: "Encrypted storage could not complete that action. Try again."
  };
  return new HttpError(mapping.status, mapping.code, mapping.message);
}

/**
 * Production facade for encrypted owner interactions. Every call gets a new
 * bounded service client and owner-authorized plaintext custody lease. There
 * is deliberately no legacy repository or plaintext fallback.
 */
export class ManagedEncryptedOwnerInteractionRepository implements OwnerInteractionRepository {
  public constructor(
    private readonly options: ManagedEncryptedOwnerInteractionRepositoryOptions = {}
  ) {}

  private async scoped<Result>(
    context: OwnerInteractionRepositoryContext,
    use: (coordinator: EncryptedOwnerInteractionCoordinator) => Promise<Result>
  ): Promise<Result> {
    const ownerId = authenticatedOwner(context);
    const scope = scopedSignal(this.options.signalForOperation?.(context));
    try {
      throwIfServiceOperationAborted(scope.signal);
      const client = createServiceRpcClient({
        allowedFunctions: managedEncryptedOwnerInteractionRpcFunctions,
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
          async ({ access, createPreparedService, service }) => {
            const dependencies: EncryptedOwnerInteractionCoordinatorDependencies = {
              ownerId,
              access,
              aggregate: service,
              createPreparedService,
              adapter: createEncryptedOwnerInteractionRpcAdapter(client),
              signal: scope.signal
            };
            return use(new EncryptedOwnerInteractionCoordinator(dependencies));
          }
        );
      })();
      return await settleServiceOperationBeforeAbort(scope.signal, operation);
    } catch (error: unknown) {
      if (error instanceof ServiceRpcError) throw serviceErrorToHttpError(error);
      if (error instanceof EncryptedAggregateError) {
        throw mappedEncryptedAggregateHttpError(error);
      }
      if (error instanceof DomainError) throw domainErrorToHttpError(error);
      throw error;
    } finally {
      scope.close();
    }
  }

  public correctDecision(
    context: OwnerInteractionRepositoryContext,
    decisionId: EntityId<"dec">,
    request: DecisionCorrectionRequest
  ): Promise<DecisionCorrectionResponse> {
    return this.scoped(context, (coordinator) => coordinator.correctDecision(decisionId, request));
  }

  public resolveReviewItem(
    context: OwnerInteractionRepositoryContext,
    reviewItemId: EntityId<"rvw">,
    request: ReviewResolveRequest
  ): Promise<ReviewResolveResponse> {
    return this.scoped(context, (coordinator) =>
      coordinator.resolveReviewItem(reviewItemId, request)
    );
  }

  public undoMutationBatch(
    context: OwnerInteractionRepositoryContext,
    mutationId: EntityId<"mut">,
    request: MutationUndoRequest
  ): Promise<MutationBatchUndoResponse> {
    return this.scoped(context, (coordinator) =>
      coordinator.undoMutationBatch(mutationId, request)
    );
  }
}
