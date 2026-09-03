import {
  ApiErrorCode,
  CaptureCreateResponseSchema,
  CaptureDeleteResponseSchema,
  CaptureDetailResponseSchema,
  CaptureListResponseSchema,
  CaptureReceiptResponseSchema,
  CaptureRetryResponseSchema,
  type Capture,
  type CaptureCreateResponse,
  type CaptureDeleteResponse,
  type CaptureDetailResponse,
  type CaptureListQuery,
  type CaptureListResponse,
  type CaptureReceipt,
  type CaptureReceiptResponse,
  type CaptureRetryResponse,
  type CaptureSummary,
  type EntityId
} from "@unfiled/contracts";

import { ConfigurationError, HttpError } from "@/server/api/errors";

import {
  environmentCaptureContentProtector,
  type CaptureContentProtector
} from "./content-protection";
import type {
  CaptureRepository,
  CaptureRepositoryContext,
  NormalizedCaptureCreateInput,
  NormalizedCaptureDeleteInput
} from "./repository";
import { createProductionCaptureComposition } from "./production-repository-composition";

type UnknownRecord = Record<string, unknown>;

type ContractSchema<T> = Readonly<{
  safeParse(
    value: unknown
  ):
    | Readonly<{ data: T; success: true }>
    | Readonly<{ error: { issues: readonly unknown[] }; success: false }>;
}>;

type SupabaseConfiguration = Readonly<{
  anonKey: string;
  serviceRoleKey: string | null;
  url: string;
}>;

function configuration(needsServiceRole = false): SupabaseConfiguration {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? null;
  if (url === undefined || anonKey === undefined || (needsServiceRole && serviceRoleKey === null)) {
    throw new ConfigurationError();
  }
  return { anonKey, serviceRoleKey, url: url.replace(/\/$/u, "") };
}

function asRecord(value: unknown): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw providerResponseError();
  }
  return value as UnknownRecord;
}

function requiredString(value: UnknownRecord, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string") throw providerResponseError();
  return candidate;
}

function contract<T>(schema: ContractSchema<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw providerResponseError();
  return result.data;
}

function attachmentsNeedEncryptedLibrary(): HttpError {
  return new HttpError(
    503,
    ApiErrorCode.PROVIDER_UNAVAILABLE,
    "Photos and recordings need the encrypted library, which is still being set up for this account."
  );
}

function providerResponseError(): HttpError {
  return new HttpError(
    503,
    ApiErrorCode.PROVIDER_UNAVAILABLE,
    "The data service returned an incomplete response. Try again."
  );
}

function databaseError(status: number, body: unknown): HttpError {
  const value = body === null || typeof body !== "object" ? {} : (body as UnknownRecord);
  const message = typeof value.message === "string" ? value.message : "";
  if (message.includes("invalid_idempotency_key") || message.includes("capture_id_conflict")) {
    return new HttpError(
      409,
      ApiErrorCode.INVALID_IDEMPOTENCY_KEY,
      "That capture identifier was already used for different content."
    );
  }
  if (message.includes("stale_revision")) {
    return new HttpError(
      409,
      ApiErrorCode.STALE_REVISION,
      "A linked note changed. Refresh before removing captured content."
    );
  }
  if (message.includes("conflict_requires_review")) {
    return new HttpError(
      409,
      ApiErrorCode.CONFLICT_REQUIRES_REVIEW,
      "This change needs review before it can be applied."
    );
  }
  if (message.includes("invalid_plan")) {
    return new HttpError(
      409,
      ApiErrorCode.INVALID_PLAN,
      "This capture is not in a state where that action can run."
    );
  }
  if (message.includes("explicit_destination_not_owned") || status === 403) {
    return new HttpError(403, ApiErrorCode.FORBIDDEN, "You do not have access to that item.");
  }
  if (message.includes("not_found") || status === 404) {
    return new HttpError(404, ApiErrorCode.NOT_FOUND, "That capture was not found.");
  }
  if (message.includes("invalid_capture") || message.includes("validation_failed")) {
    return new HttpError(
      400,
      message.includes("invalid_capture")
        ? ApiErrorCode.INVALID_CAPTURE
        : ApiErrorCode.VALIDATION_FAILED,
      "Check this capture and try again."
    );
  }
  if (message.includes("unauthorized") || status === 401) {
    return new HttpError(401, ApiErrorCode.UNAUTHORIZED, "Sign in to continue.");
  }
  if (status === 429) {
    return new HttpError(429, ApiErrorCode.RATE_LIMITED, "Try again in a moment.");
  }
  return new HttpError(
    503,
    ApiErrorCode.PROVIDER_UNAVAILABLE,
    "The data service could not complete that action."
  );
}

async function supabaseRequest(
  path: string,
  accessToken: string,
  needsServiceRole: boolean,
  init?: RequestInit
): Promise<unknown> {
  const config = configuration(needsServiceRole);
  const apiKey = needsServiceRole ? config.serviceRoleKey : config.anonKey;
  if (apiKey === null) throw new ConfigurationError();
  const headers = new Headers(init?.headers);
  headers.set("apikey", apiKey);
  headers.set("authorization", `Bearer ${accessToken}`);
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  let response: Response;
  try {
    response = await fetch(`${config.url}/rest/v1/${path}`, {
      ...init,
      cache: "no-store",
      headers
    });
  } catch {
    throw new HttpError(
      503,
      ApiErrorCode.PROVIDER_UNAVAILABLE,
      "The data service is temporarily unavailable."
    );
  }
  const body: unknown = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw databaseError(response.status, body);
  return body;
}

export async function captureServiceRpc(
  functionName: string,
  parameters: Readonly<Record<string, unknown>>
): Promise<unknown> {
  const config = configuration(true);
  if (config.serviceRoleKey === null) throw new ConfigurationError();
  return supabaseRequest(`rpc/${functionName}`, config.serviceRoleKey, true, {
    method: "POST",
    body: JSON.stringify(parameters)
  });
}

function publicCapture(value: UnknownRecord, rawContent: string): Capture {
  return {
    id: requiredString(value, "id") as EntityId<"cap">,
    rawContent,
    source: value.source as Capture["source"],
    deviceId: typeof value.deviceId === "string" ? value.deviceId : "",
    privacy: value.privacy as Capture["privacy"],
    explicitDestinationNoteId:
      typeof value.explicitDestinationNoteId === "string"
        ? (value.explicitDestinationNoteId as EntityId<"note">)
        : null,
    expansionDisabled: value.expansionDisabled === true,
    clientCreatedAt: requiredString(value, "clientCreatedAt"),
    clientTimezone: requiredString(value, "clientTimezone"),
    receivedAt: requiredString(value, "receivedAt"),
    status: value.status as Capture["status"],
    lastErrorCode: (value.lastErrorCode ?? null) as Capture["lastErrorCode"]
  };
}

async function publicReceipt(
  protector: CaptureContentProtector,
  userId: string,
  value: unknown
): Promise<CaptureReceipt> {
  const row = asRecord(value);
  const references = row.insertedContentReferences;
  if (!Array.isArray(references)) throw providerResponseError();
  const captureId = requiredString(row, "captureId");
  let captureContent: string | null = null;
  if (references.some((reference) => asRecord(reference).type === "captured")) {
    try {
      captureContent = await protector.openCapture(row.encryptedContent, userId, captureId);
    } catch {
      throw providerResponseError();
    }
  }
  const insertedContent = references.map((reference) => {
    const item = asRecord(reference);
    if (item.type === "captured" && captureContent !== null) {
      return {
        type: "captured" as const,
        itemId: typeof item.itemId === "string" ? item.itemId : null,
        content: captureContent
      };
    }
    // Generated-block retrieval is intentionally not guessed here. Milestone C
    // never generates one, and a future routed workflow must provide an
    // owner-scoped server lookup before this API may expose it.
    throw providerResponseError();
  });
  const result = {
    schemaVersion: row.schemaVersion,
    captureId: row.captureId,
    jobId: row.jobId,
    decisionId: row.decisionId ?? null,
    reviewItemId: row.reviewItemId ?? null,
    mutationId: row.mutationId ?? null,
    outcome: row.outcome,
    headline: row.headline,
    destination: row.destination ?? null,
    insertedContent,
    actions: row.actions,
    reasonCodes: row.reasonCodes,
    createdAt: row.createdAt
  };
  return contract(
    {
      safeParse(candidate: unknown) {
        const parsed = CaptureReceiptResponseSchema.safeParse({ receipt: candidate });
        return parsed.success
          ? { success: true as const, data: parsed.data.receipt }
          : { success: false as const, error: parsed.error };
      }
    },
    result
  );
}

async function decryptCapture(
  protector: CaptureContentProtector,
  userId: string,
  value: UnknownRecord
): Promise<string> {
  const captureId = requiredString(value, "id");
  if (!("encryptedContent" in value)) throw providerResponseError();
  try {
    return await protector.openCapture(value.encryptedContent, userId, captureId);
  } catch {
    throw providerResponseError();
  }
}

export class SupabaseHttpCaptureRepository implements CaptureRepository {
  public constructor(
    private readonly protector: CaptureContentProtector = environmentCaptureContentProtector
  ) {}

  public async createCapture(
    context: CaptureRepositoryContext,
    input: NormalizedCaptureCreateInput
  ): Promise<CaptureCreateResponse> {
    const protectedContent = await this.protector.protectCapture(
      input.rawContent,
      context.userId,
      input.clientCaptureId
    );
    const response = asRecord(
      await captureServiceRpc("create_capture_with_job", {
        p_owner_id: context.userId,
        p_capture: {
          clientCaptureId: input.clientCaptureId,
          contentEnvelope: protectedContent.contentEnvelope,
          contentFingerprint: protectedContent.contentFingerprint,
          contentLength: protectedContent.contentLength,
          source: input.source,
          ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
          clientCreatedAt: input.clientCreatedAt,
          clientTimezone: input.clientTimezone,
          privacy: input.privacy,
          ...(input.explicitDestinationNoteId === undefined
            ? {}
            : { explicitDestinationNoteId: input.explicitDestinationNoteId }),
          expansionDisabled: input.expansionDisabled
        }
      })
    );
    const capture = asRecord(response.capture);
    return contract(CaptureCreateResponseSchema, {
      capture: publicCapture(capture, input.rawContent),
      jobId: response.jobId,
      replayed: response.replayed
    });
  }

  public async listCaptures(
    context: CaptureRepositoryContext,
    query: CaptureListQuery
  ): Promise<CaptureListResponse> {
    const response = asRecord(
      await captureServiceRpc("list_captures", {
        p_owner_id: context.userId,
        p_cursor: query.cursor ?? null,
        p_limit: query.limit,
        p_status: query.status ?? null,
        p_from: query.from ?? null,
        p_to: query.to ?? null
      })
    );
    if (!Array.isArray(response.items)) throw providerResponseError();
    const items: CaptureSummary[] = await Promise.all(
      response.items.map(async (value) => {
        const row = asRecord(value);
        const rawContent = await decryptCapture(this.protector, context.userId, row);
        return {
          id: requiredString(row, "id") as EntityId<"cap">,
          jobId: requiredString(row, "jobId") as EntityId<"job">,
          rawContentPreview: rawContent.trim().slice(0, 280),
          source: row.source as CaptureSummary["source"],
          privacy: row.privacy as CaptureSummary["privacy"],
          clientCreatedAt: requiredString(row, "clientCreatedAt"),
          receivedAt: requiredString(row, "receivedAt"),
          status: row.status as CaptureSummary["status"],
          lastErrorCode: (row.lastErrorCode ?? null) as CaptureSummary["lastErrorCode"],
          receiptAvailable: row.receiptAvailable === true
        };
      })
    );
    return contract(CaptureListResponseSchema, { items, pageInfo: response.pageInfo });
  }

  public async getCapture(
    context: CaptureRepositoryContext,
    captureId: EntityId<"cap">
  ): Promise<CaptureDetailResponse> {
    const response = asRecord(
      await captureServiceRpc("get_capture_detail", {
        p_owner_id: context.userId,
        p_capture_id: captureId
      })
    );
    const row = asRecord(response.capture);
    const rawContent = await decryptCapture(this.protector, context.userId, row);
    const receipt =
      row.receipt === null || row.receipt === undefined
        ? null
        : await publicReceipt(this.protector, context.userId, row.receipt);
    return contract(CaptureDetailResponseSchema, {
      capture: {
        ...publicCapture(row, rawContent),
        jobId: row.jobId,
        receipt,
        attachments: []
      }
    });
  }

  public async getReceipt(
    context: CaptureRepositoryContext,
    captureId: EntityId<"cap">
  ): Promise<CaptureReceiptResponse> {
    const response = asRecord(
      await captureServiceRpc("get_capture_receipt", {
        p_owner_id: context.userId,
        p_capture_id: captureId
      })
    );
    return contract(CaptureReceiptResponseSchema, {
      receipt: await publicReceipt(this.protector, context.userId, response.receipt)
    });
  }

  public async retryCapture(
    context: CaptureRepositoryContext,
    captureId: EntityId<"cap">,
    idempotencyKey: string
  ): Promise<CaptureRetryResponse> {
    const response = asRecord(
      await captureServiceRpc("retry_capture", {
        p_owner_id: context.userId,
        p_capture_id: captureId,
        p_idempotency_key: idempotencyKey
      })
    );
    const row = asRecord(response.capture);
    const rawContent = await decryptCapture(this.protector, context.userId, row);
    return contract(CaptureRetryResponseSchema, {
      capture: publicCapture(row, rawContent),
      jobId: response.jobId,
      replayed: response.replayed
    });
  }

  public createAttachment(): Promise<never> {
    return Promise.reject(attachmentsNeedEncryptedLibrary());
  }

  public getAttachment(): Promise<never> {
    return Promise.reject(attachmentsNeedEncryptedLibrary());
  }

  public async deleteCapture(
    context: CaptureRepositoryContext,
    captureId: EntityId<"cap">,
    input: NormalizedCaptureDeleteInput
  ): Promise<CaptureDeleteResponse> {
    return contract(
      CaptureDeleteResponseSchema,
      await captureServiceRpc("delete_capture", {
        p_owner_id: context.userId,
        p_capture_id: captureId,
        p_idempotency_key: input.idempotencyKey,
        p_remove_inserted_content: input.removeInsertedContent,
        p_expected_note_revisions: input.expectedNoteRevisions
      })
    );
  }
}

export function createProductionCaptureRepository(request?: Request): CaptureRepository {
  return createProductionCaptureComposition({
    legacy: new SupabaseHttpCaptureRepository(),
    ...(request === undefined ? {} : { signal: request.signal })
  });
}

export const captureSupabaseInternals = Object.freeze({
  configuration,
  databaseError,
  supabaseRequest
});
