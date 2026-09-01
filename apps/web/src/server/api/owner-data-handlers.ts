import { createHmac } from "node:crypto";

import {
  AccountDeleteRequestSchema,
  AccountDeletionReceiptReplayRequestSchema,
  AccountDeletionReceiptSchema,
  ApiErrorCode,
  type AccountDeletionReceipt
} from "@unfiled/contracts";

import {
  authenticateRequest,
  clearedSessionCookies,
  type AuthenticatedRequest
} from "@/server/auth/session";
import { supabaseAuthProvider } from "@/server/auth/supabase-auth";
import { ManagedOwnerDataService } from "@/server/encryption/managed-owner-data-service";

import { ConfigurationError, errorResponse, HttpError, jsonResponse } from "./errors";

const MAX_ACCOUNT_REQUEST_BYTES = 2_048;
const PRIVATE_CACHE_CONTROL = "private, no-store";
const RATE_LIMIT_PEPPER = "ACCOUNT_DELETION_REPLAY_RATE_LIMIT_PEPPER";

type OwnerDataService = Readonly<{
  exportAccount(
    context: Readonly<{ accessToken: string; userId: string }>,
    options: Readonly<{ exportedAt: string; signal?: AbortSignal }>
  ): Promise<ReadableStream<Uint8Array>>;
  deleteAccount(
    context: Readonly<{ accessToken: string; userId: string }>,
    idempotencyKey: string
  ): Promise<AccountDeletionReceipt>;
  getDeletionReceipt(
    idempotencyKey: string,
    requesterDigest: string,
    signal?: AbortSignal
  ): Promise<AccountDeletionReceipt>;
}>;

export type OwnerDataHandlerDependencies = Readonly<{
  authenticate?: (request: Request) => Promise<AuthenticatedRequest>;
  now?: () => Date;
  requesterDigest?: (request: Request) => string;
  revokeSessions?: (accessToken: string) => Promise<void>;
  service?: OwnerDataService;
}>;

function privateResponse(response: Response): Response {
  response.headers.set("cache-control", PRIVATE_CACHE_CONTROL);
  response.headers.set("pragma", "no-cache");
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}

function accountError(reason: unknown, request: Request): Response {
  return privateResponse(errorResponse(reason, request));
}

function requestTooLarge(): HttpError {
  return new HttpError(413, ApiErrorCode.VALIDATION_FAILED, "That request is too large.");
}

async function readBoundedJsonObject(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    throw new HttpError(400, ApiErrorCode.VALIDATION_FAILED, "Send a JSON request.");
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new HttpError(400, ApiErrorCode.VALIDATION_FAILED, "Send a valid JSON request.");
    }
    if (length > MAX_ACCOUNT_REQUEST_BYTES) throw requestTooLarge();
  }
  if (request.body === null) {
    throw new HttpError(400, ApiErrorCode.VALIDATION_FAILED, "Send a JSON object.");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_ACCOUNT_REQUEST_BYTES) throw requestTooLarge();
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
    chunk.fill(0);
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("not an object");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, ApiErrorCode.VALIDATION_FAILED, "Send a valid JSON object.");
  } finally {
    bytes.fill(0);
  }
}

function requestContext(session: AuthenticatedRequest) {
  return { accessToken: session.accessToken, userId: session.user.id } as const;
}

function defaultRequesterDigest(request: Request): string {
  const pepper = process.env[RATE_LIMIT_PEPPER];
  if (process.env.NODE_ENV === "production" && (pepper === undefined || pepper.length < 32)) {
    throw new ConfigurationError();
  }
  const forwarded =
    request.headers.get("x-vercel-forwarded-for") ?? request.headers.get("x-forwarded-for");
  const address = (forwarded?.split(",", 1)[0]?.trim() ?? "unknown").slice(0, 200);
  return createHmac("sha256", pepper ?? "unfiled-local-deletion-receipt-rate-limit")
    .update(address, "utf8")
    .digest("hex");
}

function appendCookies(response: Response, cookies: readonly string[]): Response {
  for (const cookie of cookies) response.headers.append("set-cookie", cookie);
  return response;
}

export function createOwnerDataHandlers(dependencies: OwnerDataHandlerDependencies = {}) {
  const authenticate = dependencies.authenticate ?? authenticateRequest;
  const now = dependencies.now ?? (() => new Date());
  const requesterDigest = dependencies.requesterDigest ?? defaultRequesterDigest;
  const revokeSessions =
    dependencies.revokeSessions ??
    ((accessToken: string) => supabaseAuthProvider.signOut(accessToken));
  const service = dependencies.service ?? new ManagedOwnerDataService();

  return Object.freeze({
    async exportAccount(request: Request): Promise<Response> {
      try {
        const session = await authenticate(request);
        const exportedAt = now().toISOString();
        const body = await service.exportAccount(requestContext(session), {
          exportedAt,
          signal: request.signal
        });
        const response = privateResponse(
          new Response(body, {
            status: 200,
            headers: {
              "content-disposition": `attachment; filename="unfiled-export-${exportedAt.slice(0, 10)}.tar.gz"`,
              "content-type": "application/gzip"
            }
          })
        );
        return appendCookies(response, session.cookies);
      } catch (error) {
        return accountError(error, request);
      }
    },

    async deleteAccount(request: Request): Promise<Response> {
      let sessionsRevoked = false;
      try {
        const parsed = AccountDeleteRequestSchema.safeParse(await readBoundedJsonObject(request));
        if (!parsed.success) {
          throw new HttpError(
            400,
            ApiErrorCode.VALIDATION_FAILED,
            "Type DELETE exactly and use a valid deletion key."
          );
        }
        if (request.headers.has("idempotency-key")) {
          throw new HttpError(
            400,
            ApiErrorCode.VALIDATION_FAILED,
            "Send the deletion key only in the private JSON body."
          );
        }
        const session = await authenticate(request);
        await revokeSessions(session.accessToken);
        sessionsRevoked = true;
        const receipt = AccountDeletionReceiptSchema.parse(
          await service.deleteAccount(requestContext(session), parsed.data.idempotencyKey)
        );
        return privateResponse(jsonResponse(receipt, 200, clearedSessionCookies()));
      } catch (error) {
        const response = accountError(error, request);
        if (sessionsRevoked) appendCookies(response, clearedSessionCookies());
        return response;
      }
    },

    async replayDeletionReceipt(request: Request): Promise<Response> {
      try {
        const parsed = AccountDeletionReceiptReplayRequestSchema.safeParse(
          await readBoundedJsonObject(request)
        );
        if (!parsed.success) {
          throw new HttpError(400, ApiErrorCode.VALIDATION_FAILED, "Use a valid deletion key.");
        }
        const receipt = AccountDeletionReceiptSchema.parse(
          await service.getDeletionReceipt(
            parsed.data.idempotencyKey,
            requesterDigest(request),
            request.signal
          )
        );
        return privateResponse(jsonResponse(receipt, 200, clearedSessionCookies()));
      } catch (error) {
        return accountError(error, request);
      }
    },

    methodNotAllowed(allow: string): Response {
      return privateResponse(
        new Response(null, {
          status: 405,
          headers: { allow }
        })
      );
    }
  });
}

export const ownerDataHandlers = createOwnerDataHandlers();
