import { ApiErrorCode, type EntityId } from "@unfiled/contracts";
import { RoutingRuleCapacityError } from "@unfiled/ai-routing/routing-rules";
import { EncryptedAggregateError } from "@unfiled/encrypted-aggregate";

import { HttpError } from "@/server/api/errors";
import type {
  CaptureRepository,
  CaptureRepositoryContext,
  NormalizedCaptureCreateInput,
  NormalizedCaptureDeleteInput
} from "@/server/captures/repository";
import { EncryptedRoutingRuleReader } from "@/server/routing-rules/encrypted-routing-rule-reader";

import {
  encryptedAggregateRuntimeRpcFunctions,
  withOwnerEncryptedAggregateRuntime
} from "./encrypted-aggregate-runtime";
import {
  EncryptedCaptureAggregateRepository,
  EncryptedCaptureOperationUnavailableError
} from "./encrypted-capture-aggregate-repository";
import {
  createEncryptedCaptureRpcAdapter,
  encryptedCaptureRpcFunctions
} from "./encrypted-capture-rpc-adapter";
import { createEncryptedLibraryRpcStore } from "./encrypted-library-rpc-store";
import {
  createEncryptedNoteReadRpcAdapter,
  encryptedNoteReadRpcFunctions
} from "./encrypted-note-read-rpc-adapter";
import {
  mappedEncryptedAggregateHttpError,
  mappedServiceRpcHttpError
} from "./managed-encryption-error-mapping";
import {
  createServiceRpcClient,
  settleServiceOperationBeforeAbort,
  ServiceRpcError,
  throwIfServiceOperationAborted
} from "./service-rpc-client";
import { createInteractiveWebKeyRuntime, type WebKeyRuntimeEnvironment } from "./web-key-runtime";

const OWNER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_ACCESS_TOKEN_LENGTH = 16_384;
const MAX_OPERATION_SCOPE_MS = 60_000;

/**
 * The complete service-role capability set for one encrypted capture
 * operation. Keep this list explicit so an adapter change cannot silently
 * widen the privileged RPC surface.
 */
export const managedEncryptedCaptureRpcFunctions = Object.freeze([
  ...encryptedAggregateRuntimeRpcFunctions,
  ...encryptedCaptureRpcFunctions,
  "list_encrypted_library_objects",
  ...encryptedNoteReadRpcFunctions
] as const);

export type ManagedEncryptedCaptureRepositoryOptions = Readonly<{
  environment?: WebKeyRuntimeEnvironment;
  fetch?: typeof fetch;
  /** Lets a request-aware composition forward cancellation without widening the repository API. */
  signalForOperation?: (context: CaptureRepositoryContext) => AbortSignal | undefined;
}>;

type ScopedSignal = Readonly<{
  close(): void;
  signal: AbortSignal;
}>;

/** Maps the closed service failure set without reflecting provider content. */
export function captureServiceRpcErrorToHttpError(error: ServiceRpcError): HttpError {
  return mappedServiceRpcHttpError(error, "capture");
}

/** The stable, content-free boundary for capture commands awaiting encrypted RPC support. */
export class ManagedEncryptedCaptureCapabilityUnavailableError extends HttpError {
  public constructor() {
    super(
      503,
      ApiErrorCode.PROVIDER_UNAVAILABLE,
      "That encrypted capture capability is not available yet."
    );
    this.name = "ManagedEncryptedCaptureCapabilityUnavailableError";
  }
}

function unauthorized(): never {
  throw new HttpError(401, ApiErrorCode.UNAUTHORIZED, "Sign in to continue.");
}

function authenticatedOwner(context: CaptureRepositoryContext): string {
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
 * Capture facade whose service-role RPC client, managed key runtime, and
 * plaintext custody lease exist for exactly one authenticated operation. It
 * accepts no legacy repository dependency and therefore has no plaintext
 * fallback path.
 */
export class ManagedEncryptedCaptureRepository implements CaptureRepository {
  public constructor(private readonly options: ManagedEncryptedCaptureRepositoryOptions = {}) {}

  private async scoped<Result>(
    context: CaptureRepositoryContext,
    use: (repository: EncryptedCaptureAggregateRepository) => Promise<Result>
  ): Promise<Result> {
    const ownerId = authenticatedOwner(context);
    const operationSignal = this.options.signalForOperation?.(context);
    const scope = scopedSignal(operationSignal);
    try {
      throwIfServiceOperationAborted(scope.signal);
      const client = createServiceRpcClient({
        allowedFunctions: managedEncryptedCaptureRpcFunctions,
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
            const repository = new EncryptedCaptureAggregateRepository({
              ownerId,
              access,
              aggregate: service,
              adapter: createEncryptedCaptureRpcAdapter(client),
              noteReads: createEncryptedNoteReadRpcAdapter(client),
              routingRules: new EncryptedRoutingRuleReader({
                ownerId,
                access,
                aggregate: service,
                store: createEncryptedLibraryRpcStore(client),
                signal: scope.signal
              }),
              signal: scope.signal
            });
            return use(repository);
          }
        );
      })();
      return await settleServiceOperationBeforeAbort(scope.signal, operation);
    } catch (error) {
      if (error instanceof ServiceRpcError) throw captureServiceRpcErrorToHttpError(error);
      if (error instanceof EncryptedAggregateError) {
        throw mappedEncryptedAggregateHttpError(error);
      }
      if (error instanceof EncryptedCaptureOperationUnavailableError) {
        throw new ManagedEncryptedCaptureCapabilityUnavailableError();
      }
      if (error instanceof RoutingRuleCapacityError) {
        throw new HttpError(
          429,
          ApiErrorCode.RATE_LIMITED,
          "Too many active routing rules are enabled for this capture."
        );
      }
      throw error;
    } finally {
      scope.close();
    }
  }

  public createCapture(context: CaptureRepositoryContext, input: NormalizedCaptureCreateInput) {
    return this.scoped(context, (repository) => repository.createCapture(context, input));
  }

  public deleteCapture(
    context: CaptureRepositoryContext,
    captureId: EntityId<"cap">,
    input: NormalizedCaptureDeleteInput
  ) {
    return this.scoped(context, (repository) =>
      repository.deleteCapture(context, captureId, input)
    );
  }

  public getCapture(context: CaptureRepositoryContext, captureId: EntityId<"cap">) {
    return this.scoped(context, (repository) => repository.getCapture(context, captureId));
  }

  public getReceipt(context: CaptureRepositoryContext, captureId: EntityId<"cap">) {
    return this.scoped(context, (repository) => repository.getReceipt(context, captureId));
  }

  public listCaptures(
    context: CaptureRepositoryContext,
    query: Parameters<CaptureRepository["listCaptures"]>[1]
  ) {
    return this.scoped(context, (repository) => repository.listCaptures(context, query));
  }

  public retryCapture(
    context: CaptureRepositoryContext,
    captureId: EntityId<"cap">,
    idempotencyKey: string
  ) {
    return this.scoped(context, (repository) =>
      repository.retryCapture(context, captureId, idempotencyKey)
    );
  }

  public createAttachment(...parameters: Parameters<CaptureRepository["createAttachment"]>) {
    return this.scoped(parameters[0], (repository) => repository.createAttachment(...parameters));
  }

  public getAttachment(...parameters: Parameters<CaptureRepository["getAttachment"]>) {
    return this.scoped(parameters[0], (repository) => repository.getAttachment(...parameters));
  }
}
