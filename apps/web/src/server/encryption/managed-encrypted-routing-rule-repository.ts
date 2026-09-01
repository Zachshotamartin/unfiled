import { ApiErrorCode, type EntityId } from "@unfiled/contracts";
import { RoutingRuleCapacityError } from "@unfiled/ai-routing/routing-rules";
import { EncryptedAggregateError } from "@unfiled/encrypted-aggregate";

import { HttpError } from "@/server/api/errors";
import type {
  RoutingRuleRepository,
  RoutingRuleRepositoryContext
} from "@/server/routing-rules/repository";
import { EncryptedRoutingRuleCoordinator } from "@/server/routing-rules/encrypted-routing-rule-coordinator";
import { EncryptedRoutingRuleReader } from "@/server/routing-rules/encrypted-routing-rule-reader";

import {
  encryptedAggregateRuntimeRpcFunctions,
  withOwnerEncryptedAggregateRuntime
} from "./encrypted-aggregate-runtime";
import { createEncryptedLibraryRpcStore } from "./encrypted-library-rpc-store";
import {
  createEncryptedRoutingRuleRpcAdapter,
  encryptedRoutingRuleRpcFunctions
} from "./encrypted-routing-rule-rpc-adapter";
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

export const managedEncryptedRoutingRuleRpcFunctions = Object.freeze([
  ...encryptedAggregateRuntimeRpcFunctions,
  "list_encrypted_library_objects",
  ...encryptedRoutingRuleRpcFunctions
] as const);

export type ManagedEncryptedRoutingRuleRepositoryOptions = Readonly<{
  environment?: WebKeyRuntimeEnvironment;
  fetch?: typeof fetch;
  signalForOperation?: (context: RoutingRuleRepositoryContext) => AbortSignal | undefined;
}>;

type ScopedSignal = Readonly<{ close(): void; signal: AbortSignal }>;

function unauthorized(): never {
  throw new HttpError(401, ApiErrorCode.UNAUTHORIZED, "Sign in to continue.");
}

function authenticatedOwner(context: RoutingRuleRepositoryContext): string {
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

export class ManagedEncryptedRoutingRuleRepository implements RoutingRuleRepository {
  public constructor(private readonly options: ManagedEncryptedRoutingRuleRepositoryOptions = {}) {}

  private async scoped<Result>(
    context: RoutingRuleRepositoryContext,
    use: (coordinator: EncryptedRoutingRuleCoordinator) => Promise<Result>
  ): Promise<Result> {
    const ownerId = authenticatedOwner(context);
    const scope = scopedSignal(this.options.signalForOperation?.(context));
    try {
      throwIfServiceOperationAborted(scope.signal);
      const client = createServiceRpcClient({
        allowedFunctions: managedEncryptedRoutingRuleRpcFunctions,
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
            const reader = new EncryptedRoutingRuleReader({
              ownerId,
              access,
              aggregate: service,
              store: createEncryptedLibraryRpcStore(client),
              signal: scope.signal
            });
            return use(
              new EncryptedRoutingRuleCoordinator({
                ownerId,
                access,
                aggregate: service,
                createPreparedService,
                adapter: createEncryptedRoutingRuleRpcAdapter(client),
                reader,
                signal: scope.signal
              })
            );
          }
        );
      })();
      return await settleServiceOperationBeforeAbort(scope.signal, operation);
    } catch (error: unknown) {
      if (error instanceof ServiceRpcError) {
        throw mappedServiceRpcHttpError(error, "routing rule");
      }
      if (error instanceof EncryptedAggregateError) {
        throw mappedEncryptedAggregateHttpError(error);
      }
      if (error instanceof RoutingRuleCapacityError) {
        throw new HttpError(
          429,
          ApiErrorCode.RATE_LIMITED,
          "This account has reached its routing-rule limit."
        );
      }
      throw error;
    } finally {
      scope.close();
    }
  }

  public list(
    context: RoutingRuleRepositoryContext,
    query: Parameters<RoutingRuleRepository["list"]>[1] = {}
  ) {
    return this.scoped(context, (coordinator) => coordinator.list(query));
  }

  public create(
    context: RoutingRuleRepositoryContext,
    request: Parameters<RoutingRuleRepository["create"]>[1]
  ) {
    return this.scoped(context, (coordinator) => coordinator.create(request));
  }

  public update(
    context: RoutingRuleRepositoryContext,
    ruleId: EntityId<"rule">,
    request: Parameters<RoutingRuleRepository["update"]>[2]
  ) {
    return this.scoped(context, (coordinator) => coordinator.update(ruleId, request));
  }

  public delete(
    context: RoutingRuleRepositoryContext,
    ruleId: EntityId<"rule">,
    request: Parameters<RoutingRuleRepository["delete"]>[2]
  ) {
    return this.scoped(context, (coordinator) => coordinator.delete(ruleId, request));
  }
}
