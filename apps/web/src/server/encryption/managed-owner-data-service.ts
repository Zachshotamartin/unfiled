import type { AccountDeletionReceipt } from "@unfiled/contracts";
import { EncryptedAggregateError } from "@unfiled/encrypted-aggregate";

import { ApiErrorCode } from "@unfiled/contracts";
import { HttpError } from "@/server/api/errors";
import type { RepositoryContext } from "@/server/product/repository";

import {
  encryptedAggregateRuntimeRpcFunctions,
  withOwnerEncryptedAggregateRuntime
} from "./encrypted-aggregate-runtime";
import { createEncryptedLibraryRpcStore } from "./encrypted-library-rpc-store";
import {
  createEncryptedNoteReadRpcAdapter,
  encryptedNoteReadRpcFunctions
} from "./encrypted-note-read-rpc-adapter";
import {
  createEncryptedOwnerDataRpcAdapter,
  type EncryptedOwnerDataRpcAdapter
} from "./encrypted-owner-data-rpc-adapter";
import { EncryptedOwnerExportSource } from "./encrypted-owner-export-source";
import {
  mappedEncryptedAggregateHttpError,
  mappedServiceRpcHttpError
} from "./managed-encryption-error-mapping";
import {
  createServiceRpcClient,
  ServiceRpcError,
  type ServiceRpcClient,
  throwIfServiceOperationAborted
} from "./service-rpc-client";
import { createInteractiveWebKeyRuntime, type WebKeyRuntimeEnvironment } from "./web-key-runtime";
import { createStreamingAccountExport } from "@/server/export/streaming-account-export";

const OWNER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_ACCESS_TOKEN_LENGTH = 16_384;
const MAX_EXPORT_SCOPE_MS = 5 * 60_000;
const MAX_DELETE_SCOPE_MS = 60_000;

export const managedOwnerExportRpcFunctions = Object.freeze([
  ...encryptedAggregateRuntimeRpcFunctions,
  ...encryptedNoteReadRpcFunctions,
  "list_encrypted_library_objects",
  "list_encrypted_export_note_sources"
] as const);

export const managedOwnerDeletionRpcFunctions = Object.freeze([
  "get_account_deletion_receipt",
  "delete_encrypted_owner_account"
] as const);

type ScopedSignal = Readonly<{
  close(): void;
  signal: AbortSignal;
}>;

export type ManagedOwnerDataServiceOptions = Readonly<{
  environment?: WebKeyRuntimeEnvironment;
  fetch?: typeof fetch;
}>;

function unauthorized(): never {
  throw new HttpError(401, ApiErrorCode.UNAUTHORIZED, "Sign in to continue.");
}

function authenticatedOwner(context: RepositoryContext): string {
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

function scopedSignal(parent: AbortSignal | undefined, timeoutMs: number): ScopedSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, timeoutMs);
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

function mapError(error: unknown): unknown {
  if (error instanceof ServiceRpcError) return mappedServiceRpcHttpError(error, "note");
  if (error instanceof EncryptedAggregateError) return mappedEncryptedAggregateHttpError(error);
  return error;
}

async function pump(
  source: ReadableStream<Uint8Array>,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  signal: AbortSignal
): Promise<void> {
  const reader = source.getReader();
  try {
    for (;;) {
      throwIfServiceOperationAborted(signal);
      const next = await reader.read();
      if (next.done) break;
      await writer.write(next.value);
    }
    await writer.close();
  } finally {
    reader.releaseLock();
  }
}

export class ManagedOwnerDataService {
  public constructor(private readonly options: ManagedOwnerDataServiceOptions = {}) {}

  private client(allowedFunctions: readonly string[], signal: AbortSignal): ServiceRpcClient {
    return createServiceRpcClient({
      allowedFunctions,
      signal,
      ...(this.options.environment === undefined ? {} : { environment: this.options.environment }),
      ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch })
    });
  }

  /**
   * Keeps the key-custody callback alive until the response stream completes.
   * The returned stream is backpressure-coupled to both decryption and gzip;
   * cancelling it revokes the scoped RPC capability and key lease.
   */
  public async exportAccount(
    context: RepositoryContext,
    options: Readonly<{ exportedAt: string; signal?: AbortSignal }>
  ): Promise<ReadableStream<Uint8Array>> {
    const ownerId = authenticatedOwner(context);
    const scope = scopedSignal(options.signal, MAX_EXPORT_SCOPE_MS);
    const output = new TransformStream<Uint8Array, Uint8Array>();
    const writer = output.writable.getWriter();
    void writer.closed.catch(() => scope.close());
    let resolveReady: (() => void) | undefined;
    let rejectReady: ((reason: unknown) => void) | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    void (async () => {
      try {
        throwIfServiceOperationAborted(scope.signal);
        const client = this.client(managedOwnerExportRpcFunctions, scope.signal);
        const runtime = await createInteractiveWebKeyRuntime(
          this.options.environment === undefined ? {} : { environment: this.options.environment }
        );
        await withOwnerEncryptedAggregateRuntime(
          runtime,
          client,
          ownerId,
          { signal: scope.signal },
          async ({ access, service }) => {
            const ownerData = createEncryptedOwnerDataRpcAdapter(client);
            const source = new EncryptedOwnerExportSource({
              ownerId,
              access,
              aggregate: service,
              reads: createEncryptedNoteReadRpcAdapter(client),
              library: createEncryptedLibraryRpcStore(client),
              ownerData,
              signal: scope.signal
            });
            const archive = createStreamingAccountExport(source, {
              exportedAt: options.exportedAt,
              signal: scope.signal
            });
            resolveReady?.();
            resolveReady = undefined;
            rejectReady = undefined;
            await pump(archive, writer, scope.signal);
          }
        );
      } catch (error) {
        const mapped = mapError(error);
        rejectReady?.(mapped);
        resolveReady = undefined;
        rejectReady = undefined;
        await writer.abort(mapped).catch(() => undefined);
      } finally {
        scope.close();
      }
    })();

    await ready;
    return output.readable;
  }

  private deletionAdapter(signal: AbortSignal): EncryptedOwnerDataRpcAdapter {
    return createEncryptedOwnerDataRpcAdapter(
      this.client(managedOwnerDeletionRpcFunctions, signal)
    );
  }

  public async deleteAccount(
    context: RepositoryContext,
    idempotencyKey: string
  ): Promise<AccountDeletionReceipt> {
    const ownerId = authenticatedOwner(context);
    // Once global session revocation begins at the handler boundary, request
    // disconnects must not interrupt this atomic live-data deletion.
    const scope = scopedSignal(undefined, MAX_DELETE_SCOPE_MS);
    try {
      return await this.deletionAdapter(scope.signal).deleteAccount({
        ownerId,
        idempotencyKey
      });
    } catch (error) {
      throw mapError(error);
    } finally {
      scope.close();
    }
  }

  public async getDeletionReceipt(
    idempotencyKey: string,
    requesterDigest: string,
    signal?: AbortSignal
  ): Promise<AccountDeletionReceipt> {
    const scope = scopedSignal(signal, MAX_DELETE_SCOPE_MS);
    try {
      return await this.deletionAdapter(scope.signal).getDeletionReceipt({
        idempotencyKey,
        requesterDigest
      });
    } catch (error) {
      throw mapError(error);
    } finally {
      scope.close();
    }
  }
}
