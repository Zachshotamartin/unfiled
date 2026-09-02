import {
  ApiErrorCode,
  MAX_AI_SETTINGS_RESPONSE_BYTES,
  MAX_PROVIDER_KEY_RESPONSE_BYTES
} from "@unfiled/contracts";

import { HttpError } from "@/server/api/errors";
import { mappedServiceRpcHttpError } from "@/server/encryption/managed-encryption-error-mapping";
import {
  createServiceRpcClient,
  settleServiceOperationBeforeAbort,
  ServiceRpcError,
  throwIfServiceOperationAborted
} from "@/server/encryption/service-rpc-client";

import {
  createOpenAiProviderKeyValidator,
  type ProviderKeyValidator
} from "./provider-key-validator";
import type { AiSettingsRepository, AiSettingsRepositoryContext } from "./repository";
import { createOwnerAiSettingsRpcAdapter, ownerAiSettingsRpcFunctions } from "./rpc-adapter";

const OWNER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_ACCESS_TOKEN_LENGTH = 16_384;
const MAX_OPERATION_SCOPE_MS = 30_000;

export type ProductionAiSettingsRepositoryOptions = Readonly<{
  environment?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
  providerKeyValidator?: ProviderKeyValidator;
  signalForOperation?: (context: AiSettingsRepositoryContext) => AbortSignal | undefined;
}>;

type ScopedSignal = Readonly<{ close(): void; signal: AbortSignal }>;

function unauthorized(): never {
  throw new HttpError(401, ApiErrorCode.UNAUTHORIZED, "Sign in to continue.");
}

function authenticatedOwner(context: AiSettingsRepositoryContext): string {
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

export class ProductionAiSettingsRepository implements AiSettingsRepository {
  private readonly providerKeyValidator: ProviderKeyValidator;

  public constructor(private readonly options: ProductionAiSettingsRepositoryOptions = {}) {
    this.providerKeyValidator =
      options.providerKeyValidator ??
      createOpenAiProviderKeyValidator(options.fetch === undefined ? {} : { fetch: options.fetch });
  }

  private async scoped<Result>(
    context: AiSettingsRepositoryContext,
    subject: "provider key" | "settings",
    use: (
      adapter: ReturnType<typeof createOwnerAiSettingsRpcAdapter>,
      ownerId: string,
      signal: AbortSignal
    ) => Promise<Result>
  ): Promise<Result> {
    const ownerId = authenticatedOwner(context);
    const scope = scopedSignal(this.options.signalForOperation?.(context));
    try {
      throwIfServiceOperationAborted(scope.signal);
      const client = createServiceRpcClient({
        allowedFunctions: ownerAiSettingsRpcFunctions,
        maximumResponseBytes:
          subject === "settings" ? MAX_AI_SETTINGS_RESPONSE_BYTES : MAX_PROVIDER_KEY_RESPONSE_BYTES,
        signal: scope.signal,
        ...(this.options.environment === undefined
          ? {}
          : { environment: this.options.environment }),
        ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch })
      });
      const operation = use(createOwnerAiSettingsRpcAdapter(client), ownerId, scope.signal);
      return await settleServiceOperationBeforeAbort(scope.signal, operation);
    } catch (error: unknown) {
      if (error instanceof ServiceRpcError) {
        throw mappedServiceRpcHttpError(error, subject);
      }
      throw error;
    } finally {
      scope.close();
    }
  }

  public getSettings(context: AiSettingsRepositoryContext) {
    return this.scoped(context, "settings", (adapter, ownerId) => adapter.getSettings(ownerId));
  }

  public updateSettings(
    context: AiSettingsRepositoryContext,
    request: Parameters<AiSettingsRepository["updateSettings"]>[1]
  ) {
    return this.scoped(context, "settings", (adapter, ownerId) =>
      adapter.updateSettings(ownerId, request)
    );
  }

  public getProviderKey(context: AiSettingsRepositoryContext) {
    return this.scoped(context, "provider key", (adapter, ownerId) =>
      adapter.getProviderKey(ownerId)
    );
  }

  public putProviderKey(
    context: AiSettingsRepositoryContext,
    request: Parameters<AiSettingsRepository["putProviderKey"]>[1]
  ) {
    return this.scoped(context, "provider key", async (adapter, ownerId, signal) => {
      const replay = await adapter.replayProviderKeyPut(ownerId, request);
      if (replay !== null) return replay;
      await this.providerKeyValidator.validate(request.provider, request.apiKey, signal);
      throwIfServiceOperationAborted(signal);
      return adapter.putProviderKey(ownerId, request);
    });
  }

  public deleteProviderKey(
    context: AiSettingsRepositoryContext,
    request: Parameters<AiSettingsRepository["deleteProviderKey"]>[1]
  ) {
    return this.scoped(context, "provider key", (adapter, ownerId) =>
      adapter.deleteProviderKey(ownerId, request)
    );
  }
}

export function createProductionAiSettingsRepository(
  options: ProductionAiSettingsRepositoryOptions = {}
): AiSettingsRepository {
  return new ProductionAiSettingsRepository(options);
}
