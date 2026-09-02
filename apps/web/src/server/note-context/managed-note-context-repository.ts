import { ApiErrorCode } from "@unfiled/contracts";
import { EncryptedAggregateError } from "@unfiled/encrypted-aggregate";

import { HttpError } from "@/server/api/errors";
import {
  encryptedAggregateRuntimeRpcFunctions,
  withOwnerEncryptedAggregateRuntime
} from "@/server/encryption/encrypted-aggregate-runtime";
import {
  mappedEncryptedAggregateHttpError,
  mappedServiceRpcHttpError
} from "@/server/encryption/managed-encryption-error-mapping";
import {
  createServiceRpcClient,
  ServiceRpcError,
  settleServiceOperationBeforeAbort,
  throwIfServiceOperationAborted
} from "@/server/encryption/service-rpc-client";
import {
  createInteractiveWebKeyRuntime,
  type WebKeyRuntimeEnvironment
} from "@/server/encryption/web-key-runtime";

import { noteContextCursorKey } from "./cursor";
import { EncryptedNoteContextReader } from "./encrypted-note-context-reader";
import { createNoteContextRpcAdapter, noteContextRpcFunctions } from "./note-context-rpc-adapter";
import type { NoteContextRepository } from "./repository";

const OWNER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_ACCESS_TOKEN_LENGTH = 16_384;
const MAX_OPERATION_SCOPE_MS = 60_000;

export const managedNoteContextRpcFunctions = Object.freeze([
  ...encryptedAggregateRuntimeRpcFunctions,
  ...noteContextRpcFunctions
] as const);

export type ManagedNoteContextRepositoryOptions = Readonly<{
  environment?: WebKeyRuntimeEnvironment;
  fetch?: typeof fetch;
  signalForOperation?: (
    context: Parameters<NoteContextRepository["listSources"]>[0]
  ) => AbortSignal | undefined;
}>;

type ScopedSignal = Readonly<{ close(): void; signal: AbortSignal }>;

function unauthorized(): never {
  throw new HttpError(401, ApiErrorCode.UNAUTHORIZED, "Sign in to continue.");
}

function authenticatedOwner(context: Parameters<NoteContextRepository["listSources"]>[0]): string {
  if (
    typeof context.accessToken !== "string" ||
    context.accessToken.length < 1 ||
    context.accessToken.length > MAX_ACCESS_TOKEN_LENGTH ||
    context.accessToken.trim() !== context.accessToken ||
    context.accessToken.includes("\0") ||
    typeof context.userId !== "string" ||
    !OWNER_ID_PATTERN.test(context.userId)
  ) {
    return unauthorized();
  }
  return context.userId.toLowerCase();
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

export class ManagedNoteContextRepository implements NoteContextRepository {
  public constructor(private readonly options: ManagedNoteContextRepositoryOptions = {}) {}

  private async scoped<Result>(
    context: Parameters<NoteContextRepository["listSources"]>[0],
    use: (reader: EncryptedNoteContextReader) => Promise<Result>
  ): Promise<Result> {
    const ownerId = authenticatedOwner(context);
    const scope = scopedSignal(this.options.signalForOperation?.(context));
    let cursorKey: Buffer | undefined;
    try {
      throwIfServiceOperationAborted(scope.signal);
      const operationCursorKey = noteContextCursorKey(
        (this.options.environment ?? process.env).UNFILED_PRIVATE_SEARCH_CURSOR_HMAC_KEY
      );
      cursorKey = operationCursorKey;
      const client = createServiceRpcClient({
        allowedFunctions: managedNoteContextRpcFunctions,
        signal: scope.signal,
        maximumResponseBytes: 8 * 1024 * 1024,
        ...(this.options.environment === undefined
          ? {}
          : { environment: this.options.environment }),
        ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch })
      });
      const runtime = await createInteractiveWebKeyRuntime(
        this.options.environment === undefined ? {} : { environment: this.options.environment }
      );
      const operation = withOwnerEncryptedAggregateRuntime(
        runtime,
        client,
        ownerId,
        { signal: scope.signal },
        ({ access, service }) =>
          use(
            new EncryptedNoteContextReader({
              ownerId,
              access,
              aggregate: service,
              rpc: createNoteContextRpcAdapter(client),
              cursorKey: operationCursorKey
            })
          )
      );
      return await settleServiceOperationBeforeAbort(scope.signal, operation);
    } catch (error: unknown) {
      if (error instanceof ServiceRpcError) throw mappedServiceRpcHttpError(error, "note");
      if (error instanceof EncryptedAggregateError) {
        throw mappedEncryptedAggregateHttpError(error);
      }
      throw error;
    } finally {
      cursorKey?.fill(0);
      scope.close();
    }
  }

  public listSources(
    context: Parameters<NoteContextRepository["listSources"]>[0],
    noteId: Parameters<NoteContextRepository["listSources"]>[1],
    query: Parameters<NoteContextRepository["listSources"]>[2]
  ) {
    return this.scoped(context, (reader) => reader.listSources(noteId, query));
  }

  public listBacklinks(
    context: Parameters<NoteContextRepository["listBacklinks"]>[0],
    noteId: Parameters<NoteContextRepository["listBacklinks"]>[1],
    query: Parameters<NoteContextRepository["listBacklinks"]>[2]
  ) {
    return this.scoped(context, (reader) => reader.listBacklinks(noteId, query));
  }
}
