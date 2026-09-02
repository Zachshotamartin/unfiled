import {
  AccountDeleteRequestSchema,
  AccountDeletionReceiptSchema,
  AccountDeletionReceiptReplayRequestSchema,
  AccountDeletionTokenSchema,
  ApiErrorSchema,
  AuthOtpAcceptedResponseSchema,
  AuthOtpRequestSchema,
  AuthOtpVerifyRequestSchema,
  AuthRefreshRequestSchema,
  AuthSessionResponseSchema,
  AuthSessionSchema,
  AuthSignOutResponseSchema,
  AuthVerifyRequestSchema,
  AuthVerifyResponseSchema,
  CaptureCreateRequestSchema,
  CaptureCreateResponseSchema,
  CaptureDeleteRequestSchema,
  CaptureDeleteResponseSchema,
  CaptureDetailResponseSchema,
  CaptureListQuerySchema,
  CaptureListResponseSchema,
  CaptureReceiptResponseSchema,
  CaptureRetryRequestSchema,
  CaptureRetryResponseSchema,
  DecisionCorrectionRequestSchema,
  DecisionCorrectionResponseSchema,
  GeneratedBlockDetailResponseSchema,
  GeneratedBlockDtoSchema,
  GeneratedBlockListQuerySchema,
  GeneratedBlockListResponseSchema,
  GeneratedBlockResolveRequestSchema,
  GeneratedBlockResolveResponseSchema,
  InteractiveOperationsRequestSchema,
  MutationBatchUndoResponseSchema,
  MutationResultSchema,
  MutationUndoRequestSchema,
  MAX_AI_SETTINGS_RESPONSE_BYTES,
  MAX_GENERATED_BLOCK_RESPONSE_BYTES,
  MAX_PROVIDER_KEY_RESPONSE_BYTES,
  MAX_RETAINED_ROUTING_RULES,
  MAX_ROUTING_RULE_PAGE_BYTES,
  NoteArchiveRequestSchema,
  NoteCreateRequestSchema,
  NoteDetailResponseSchema,
  NoteListQuerySchema,
  NoteListResponseSchema,
  NoteLinkCreateRequestSchema,
  NoteLinkDeleteRequestSchema,
  NoteLinkListResponseSchema,
  NoteBacklinksQuerySchema,
  NoteBacklinksResponseSchema,
  NoteMoveRequestSchema,
  NoteRestoreDeletedRequestSchema,
  NoteRestoreRequestSchema,
  NoteRevisionListQuerySchema,
  NoteRevisionListResponseSchema,
  NoteSoftDeleteRequestSchema,
  NoteUpdateRequestSchema,
  NoteRelationMutationResponseSchema,
  NoteSourcesQuerySchema,
  NoteSourcesResponseSchema,
  NoteTagLinkRequestSchema,
  NoteTagUnlinkRequestSchema,
  ListReviewItemsResponseSchema,
  ReviewItemListQuerySchema,
  ReviewResolveRequestSchema,
  ReviewResolveResponseSchema,
  RoutingRuleCreateRequestSchema,
  RoutingRuleDeleteRequestSchema,
  RoutingRuleDeleteResponseSchema,
  RoutingRuleListQuerySchema,
  RoutingRuleListResponseSchema,
  RoutingRuleMutationResponseSchema,
  RoutingRuleUpdateRequestSchema,
  SearchNotesRequestSchema,
  SearchNotesResponseSchema,
  ProviderKeyDeleteRequestSchema,
  ProviderKeyDeleteResponseSchema,
  ProviderKeyPutRequestSchema,
  ProviderKeyPutResponseSchema,
  ProviderKeyResponseSchema,
  SpaceArchiveRequestSchema,
  SpaceCreateRequestSchema,
  SpaceDetailResponseSchema,
  SpaceListQuerySchema,
  SpaceListResponseSchema,
  SpaceMutationResultSchema,
  SpaceUpdateRequestSchema,
  TagCreateRequestSchema,
  TagDeleteRequestSchema,
  TagListQuerySchema,
  TagListResponseSchema,
  TagMutationResultSchema,
  TagUpdateRequestSchema,
  DeleteMutationResultSchema,
  UserSettingsResponseSchema,
  UserSettingsUpdateRequestSchema,
  UserSettingsUpdateResponseSchema,
  entityIdSchema,
  type ApiError,
  type AccountDeleteRequest,
  type AccountDeletionReceiptReplayRequest,
  type AuthOtpRequest,
  type AuthOtpVerifyRequest,
  type AuthRefreshRequest,
  type AuthVerifyRequest,
  type CaptureCreateRequest,
  type CaptureDeleteRequest,
  type CaptureListQuery,
  type CaptureRetryRequest,
  type DecisionCorrectionRequest,
  type GeneratedBlockListQuery,
  type GeneratedBlockDto,
  type GeneratedBlockResolveRequest,
  type InteractiveOperationsRequest,
  type MutationUndoRequest,
  type NoteArchiveRequest,
  type NoteCreateRequest,
  type NoteListQuery,
  type NoteLinkCreateRequest,
  type NoteLinkDeleteRequest,
  type NoteBacklinksQuery,
  type NoteMoveRequest,
  type NoteRestoreDeletedRequest,
  type NoteRestoreRequest,
  type NoteRevisionListQuery,
  type NoteSoftDeleteRequest,
  type NoteUpdateRequest,
  type NoteTagLinkRequest,
  type NoteTagUnlinkRequest,
  type NoteSourcesQuery,
  type ProviderKeyDeleteRequest,
  type ProviderKeyPutRequest,
  type ReviewItemListQuery,
  type ReviewResolveRequest,
  type RoutingRuleCreateRequest,
  type RoutingRuleDeleteRequest,
  type RoutingRuleDto,
  type RoutingRuleListQuery,
  type RoutingRuleUpdateRequest,
  type SearchNotesRequest,
  type SpaceArchiveRequest,
  type SpaceCreateRequest,
  type SpaceListQuery,
  type SpaceUpdateRequest,
  type TagCreateRequest,
  type TagDeleteRequest,
  type TagListQuery,
  type TagUpdateRequest,
  type UserSettingsUpdateRequest
} from "@unfiled/contracts";
import type { ZodType } from "zod";

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Creates the 256-bit bearer capability used for deletion and receipt replay. */
export function createAccountDeletionToken(random: Crypto = globalThis.crypto): string {
  const bytes = new Uint8Array(32);
  random.getRandomValues(bytes);
  let encoded = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const first = bytes[offset] ?? 0;
    const second = bytes[offset + 1];
    const third = bytes[offset + 2];
    encoded += BASE64URL_ALPHABET[(first >>> 2) & 63] ?? "";
    encoded += BASE64URL_ALPHABET[((first & 3) << 4) | ((second ?? 0) >>> 4)] ?? "";
    if (second !== undefined) {
      encoded += BASE64URL_ALPHABET[((second & 15) << 2) | ((third ?? 0) >>> 6)] ?? "";
    }
    if (third !== undefined) encoded += BASE64URL_ALPHABET[third & 63] ?? "";
  }
  return AccountDeletionTokenSchema.parse(`delete_${encoded}`);
}

export class ApiClientError extends Error {
  public readonly error: ApiError;
  public readonly status: number;

  public constructor(status: number, error: ApiError) {
    super(error.message);
    this.name = "ApiClientError";
    this.status = status;
    this.error = error;
  }
}

/** A content-free failure for invalid JSON, error envelopes, or success payloads. */
export class ApiClientMalformedResponseError extends Error {
  public constructor(public readonly status: number) {
    super("The service returned malformed data.");
    this.name = "ApiClientMalformedResponseError";
  }
}

export type ApiClientOptions = Readonly<{
  baseUrl: string;
  getAccessToken: () => Promise<string | null>;
  fetch?: typeof globalThis.fetch;
}>;

async function decode<T>(
  response: Response,
  schema: ZodType<T>,
  maximumResponseBytes?: number
): Promise<T> {
  let serialized: string;
  try {
    if (maximumResponseBytes === undefined) {
      serialized = await response.text();
    } else {
      const declared = response.headers.get("content-length");
      if (declared !== null) {
        const declaredBytes = Number(declared);
        if (
          !/^\d+$/u.test(declared) ||
          !Number.isSafeInteger(declaredBytes) ||
          declaredBytes > maximumResponseBytes
        ) {
          throw new ApiClientMalformedResponseError(response.status);
        }
      }
      if (response.body === null) {
        serialized = await response.text();
      } else {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.byteLength;
            if (length > maximumResponseBytes) {
              try {
                await reader.cancel();
              } catch {
                // The sanitized size failure remains authoritative even if cancellation races.
              }
              throw new ApiClientMalformedResponseError(response.status);
            }
            chunks.push(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        serialized = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      }
    }
  } catch {
    throw new ApiClientMalformedResponseError(response.status);
  }
  if (
    maximumResponseBytes !== undefined &&
    new TextEncoder().encode(serialized).byteLength > maximumResponseBytes
  ) {
    throw new ApiClientMalformedResponseError(response.status);
  }
  let body: unknown;
  try {
    body = JSON.parse(serialized) as unknown;
  } catch {
    throw new ApiClientMalformedResponseError(response.status);
  }
  if (!response.ok) {
    const parsedError = ApiErrorSchema.safeParse(body);
    if (!parsedError.success) throw new ApiClientMalformedResponseError(response.status);
    throw new ApiClientError(response.status, parsedError.data);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiClientMalformedResponseError(response.status);
  return parsed.data;
}

function queryString(
  entries: readonly (readonly [string, string | number | boolean | undefined])[]
) {
  const search = new URLSearchParams();
  for (const [key, value] of entries) {
    if (value !== undefined) search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized.length > 0 ? `?${serialized}` : "";
}

export function createApiClient(options: ApiClientOptions) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");

  async function request<T>(
    path: string,
    init: Readonly<{
      method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
      body?: unknown;
      cache?: RequestCache;
      idempotencyKey?: string;
      authenticated?: boolean;
      maximumResponseBytes?: number;
      requirePrivateNoStore?: boolean;
    }>,
    responseSchema: ZodType<T>
  ): Promise<T> {
    const authenticated = init.authenticated ?? true;
    const token = authenticated ? await options.getAccessToken() : null;
    const response = await fetcher(`${baseUrl}/api/v1${path}`, {
      ...(init.cache === undefined ? {} : { cache: init.cache }),
      method: init.method ?? "GET",
      headers: {
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.idempotencyKey === undefined ? {} : { "idempotency-key": init.idempotencyKey }),
        ...(init.cache === "no-store" ? { "cache-control": "no-store", pragma: "no-cache" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
    });
    if (
      init.requirePrivateNoStore === true &&
      (response.headers.get("cache-control") !== "private, no-store" ||
        response.headers.get("pragma") !== "no-cache")
    ) {
      try {
        await response.body?.cancel();
      } catch {
        // The sanitized transport failure remains authoritative if cancellation races.
      }
      throw new ApiClientMalformedResponseError(response.status);
    }
    return decode(response, responseSchema, init.maximumResponseBytes);
  }

  async function authenticatedRawRequest(path: string): Promise<Response> {
    const token = await options.getAccessToken();
    const response = await fetcher(`${baseUrl}/api/v1${path}`, {
      cache: "no-store",
      method: "GET",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "cache-control": "no-store",
        pragma: "no-cache"
      }
    });
    if (!response.ok) {
      let body: unknown;
      try {
        body = JSON.parse(await response.text()) as unknown;
      } catch {
        throw new ApiClientMalformedResponseError(response.status);
      }
      const parsed = ApiErrorSchema.safeParse(body);
      if (!parsed.success) throw new ApiClientMalformedResponseError(response.status);
      throw new ApiClientError(response.status, parsed.data);
    }
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (
      mediaType !== "application/gzip" ||
      response.headers.get("cache-control") !== "private, no-store" ||
      !response.headers.get("content-disposition")?.startsWith("attachment;")
    ) {
      throw new TypeError("Invalid account export response");
    }
    return response;
  }

  async function listRoutingRules(input: Partial<RoutingRuleListQuery> = {}) {
    const query = RoutingRuleListQuerySchema.parse(input);
    const suffix = queryString([["cursor", query.cursor]]);
    return request(
      `/routing-rules${suffix}`,
      { cache: "no-store", maximumResponseBytes: MAX_ROUTING_RULE_PAGE_BYTES },
      RoutingRuleListResponseSchema
    );
  }

  async function listAllRoutingRules(): Promise<Readonly<{ items: readonly RoutingRuleDto[] }>> {
    const items: RoutingRuleDto[] = [];
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: RoutingRuleListQuery["cursor"];
    for (;;) {
      const page = await listRoutingRules(cursor === undefined ? {} : { cursor });
      for (const rule of page.items) {
        if (seenIds.has(rule.id) || items.length >= MAX_RETAINED_ROUTING_RULES) {
          throw new ApiClientMalformedResponseError(200);
        }
        seenIds.add(rule.id);
        items.push(rule);
      }
      if (!page.pageInfo.hasMore) return Object.freeze({ items: Object.freeze(items) });
      const nextCursor = page.pageInfo.nextCursor;
      if (nextCursor === null || seenCursors.has(nextCursor)) {
        throw new ApiClientMalformedResponseError(200);
      }
      seenCursors.add(nextCursor);
      cursor = RoutingRuleListQuerySchema.parse({ cursor: nextCursor }).cursor;
    }
  }

  return Object.freeze({
    requestOtp(input: AuthOtpRequest) {
      const body = AuthOtpRequestSchema.parse(input);
      return request(
        "/auth/otp",
        { authenticated: false, body, method: "POST" },
        AuthOtpAcceptedResponseSchema
      );
    },

    verifyOtp(input: AuthOtpVerifyRequest) {
      const body = AuthOtpVerifyRequestSchema.parse(input);
      return request("/auth/otp", { authenticated: false, body, method: "PUT" }, AuthSessionSchema);
    },

    verifyAuth(input: AuthVerifyRequest) {
      const body = AuthVerifyRequestSchema.parse(input);
      return request(
        "/auth/verify",
        { authenticated: false, body, method: "PUT" },
        AuthVerifyResponseSchema
      );
    },

    refreshAuth(input: AuthRefreshRequest) {
      const body = AuthRefreshRequestSchema.parse(input);
      return request(
        "/auth/refresh",
        { authenticated: false, body, method: "POST" },
        AuthSessionSchema
      );
    },

    getAuthSession() {
      return request("/auth/session", {}, AuthSessionResponseSchema);
    },

    signOut() {
      return request("/auth/sign-out", { method: "POST" }, AuthSignOutResponseSchema);
    },

    createCapture(input: CaptureCreateRequest) {
      const body = CaptureCreateRequestSchema.parse(input);
      return request(
        "/captures",
        { body, idempotencyKey: body.clientCaptureId, method: "POST" },
        CaptureCreateResponseSchema
      );
    },

    listCaptures(input: Partial<CaptureListQuery> = {}) {
      const query = CaptureListQuerySchema.parse(input);
      const suffix = queryString([
        ["status", query.status],
        ["limit", query.limit],
        ["cursor", query.cursor],
        ["from", query.from],
        ["to", query.to]
      ]);
      return request(`/captures${suffix}`, {}, CaptureListResponseSchema);
    },

    getCapture(captureId: string) {
      const id = entityIdSchema("cap").parse(captureId);
      return request(`/captures/${id}`, {}, CaptureDetailResponseSchema);
    },

    getCaptureReceipt(captureId: string) {
      const id = entityIdSchema("cap").parse(captureId);
      return request(`/captures/${id}/receipt`, {}, CaptureReceiptResponseSchema);
    },

    retryCapture(captureId: string, input: CaptureRetryRequest) {
      const id = entityIdSchema("cap").parse(captureId);
      const body = CaptureRetryRequestSchema.parse(input);
      return request(
        `/captures/${id}/retry`,
        { body, idempotencyKey: body.idempotencyKey, method: "POST" },
        CaptureRetryResponseSchema
      );
    },

    deleteCapture(captureId: string, input: CaptureDeleteRequest) {
      const id = entityIdSchema("cap").parse(captureId);
      const body = CaptureDeleteRequestSchema.parse(input);
      return request(
        `/captures/${id}`,
        { body, idempotencyKey: body.idempotencyKey, method: "DELETE" },
        CaptureDeleteResponseSchema
      );
    },

    correctDecision(decisionId: string, input: DecisionCorrectionRequest) {
      const id = entityIdSchema("dec").parse(decisionId);
      const body = DecisionCorrectionRequestSchema.parse(input);
      return request(
        `/decisions/${id}/correct`,
        { body, cache: "no-store", idempotencyKey: body.idempotencyKey, method: "POST" },
        DecisionCorrectionResponseSchema
      );
    },

    listNotes(input: Partial<NoteListQuery> = {}) {
      const query = NoteListQuerySchema.parse(input);
      const suffix = queryString([
        ["archive", query.archive],
        ["deleted", query.deleted],
        ["limit", query.limit],
        ["cursor", query.cursor],
        ["spaceId", query.spaceId === null ? "root" : query.spaceId],
        ["type", query.type]
      ]);
      return request(`/notes${suffix}`, {}, NoteListResponseSchema);
    },

    getNote(noteId: string) {
      const id = entityIdSchema("note").parse(noteId);
      return request(`/notes/${id}`, {}, NoteDetailResponseSchema);
    },

    listNoteLinks(noteId: string) {
      const id = entityIdSchema("note").parse(noteId);
      return request(`/notes/${id}/links`, {}, NoteLinkListResponseSchema);
    },

    createNoteLink(noteId: string, input: NoteLinkCreateRequest) {
      const id = entityIdSchema("note").parse(noteId);
      const body = NoteLinkCreateRequestSchema.parse(input);
      return request(
        `/notes/${id}/links`,
        { body, idempotencyKey: body.idempotencyKey, method: "POST" },
        NoteRelationMutationResponseSchema
      );
    },

    deleteNoteLink(noteId: string, linkId: string, input: NoteLinkDeleteRequest) {
      const id = entityIdSchema("note").parse(noteId);
      const relationId = entityIdSchema("lnk").parse(linkId);
      const body = NoteLinkDeleteRequestSchema.parse(input);
      return request(
        `/notes/${id}/links/${relationId}`,
        { body, idempotencyKey: body.idempotencyKey, method: "DELETE" },
        NoteRelationMutationResponseSchema
      );
    },

    listNoteSources(noteId: string, input: Partial<NoteSourcesQuery> = {}) {
      const id = entityIdSchema("note").parse(noteId);
      const query = NoteSourcesQuerySchema.parse(input);
      const suffix = queryString([
        ["limit", query.limit],
        ["cursor", query.cursor]
      ]);
      return request(
        `/notes/${id}/sources${suffix}`,
        { cache: "no-store" },
        NoteSourcesResponseSchema
      );
    },

    listNoteBacklinks(noteId: string, input: Partial<NoteBacklinksQuery> = {}) {
      const id = entityIdSchema("note").parse(noteId);
      const query = NoteBacklinksQuerySchema.parse(input);
      const suffix = queryString([
        ["limit", query.limit],
        ["cursor", query.cursor]
      ]);
      return request(
        `/notes/${id}/backlinks${suffix}`,
        { cache: "no-store" },
        NoteBacklinksResponseSchema
      );
    },

    listGeneratedBlocks(noteId: string, input: Partial<GeneratedBlockListQuery> = {}) {
      const id = entityIdSchema("note").parse(noteId);
      const query = GeneratedBlockListQuerySchema.parse(input);
      const suffix = queryString([["cursor", query.cursor]]);
      return request(
        `/notes/${id}/generated-blocks${suffix}`,
        { cache: "no-store", maximumResponseBytes: MAX_GENERATED_BLOCK_RESPONSE_BYTES },
        GeneratedBlockListResponseSchema
      ).then((response) => {
        if (
          response.items.some(
            (block) =>
              block.noteId !== id || (query.cursor !== undefined && block.id <= query.cursor)
          )
        ) {
          throw new ApiClientMalformedResponseError(200);
        }
        return response;
      });
    },

    getGeneratedBlock(blockId: string, expectedNoteId: string) {
      const id = entityIdSchema("blk").parse(blockId);
      const noteId = entityIdSchema("note").parse(expectedNoteId);
      return request(
        `/generated-blocks/${id}`,
        { cache: "no-store", maximumResponseBytes: MAX_GENERATED_BLOCK_RESPONSE_BYTES },
        GeneratedBlockDetailResponseSchema
      ).then((response) => {
        if (response.block.id !== id || response.block.noteId !== noteId) {
          throw new ApiClientMalformedResponseError(200);
        }
        return response;
      });
    },

    linkNoteTag(noteId: string, input: NoteTagLinkRequest) {
      const id = entityIdSchema("note").parse(noteId);
      const body = NoteTagLinkRequestSchema.parse(input);
      return request(
        `/notes/${id}/tags`,
        { body, idempotencyKey: body.idempotencyKey, method: "POST" },
        NoteRelationMutationResponseSchema
      );
    },

    unlinkNoteTag(noteId: string, tagId: string, input: NoteTagUnlinkRequest) {
      const id = entityIdSchema("note").parse(noteId);
      const relationId = entityIdSchema("tag").parse(tagId);
      const body = NoteTagUnlinkRequestSchema.parse(input);
      return request(
        `/notes/${id}/tags/${relationId}`,
        { body, idempotencyKey: body.idempotencyKey, method: "DELETE" },
        NoteRelationMutationResponseSchema
      );
    },

    createNote(input: NoteCreateRequest) {
      const body = NoteCreateRequestSchema.parse(input);
      return request(
        "/notes",
        { body, idempotencyKey: body.idempotencyKey, method: "POST" },
        MutationResultSchema
      );
    },

    updateNote(noteId: string, input: NoteUpdateRequest) {
      const id = entityIdSchema("note").parse(noteId);
      const body = NoteUpdateRequestSchema.parse(input);
      return request(
        `/notes/${id}`,
        { body, idempotencyKey: body.idempotencyKey, method: "PATCH" },
        MutationResultSchema
      );
    },

    moveNote(noteId: string, input: NoteMoveRequest) {
      const id = entityIdSchema("note").parse(noteId);
      const body = NoteMoveRequestSchema.parse(input);
      return request(
        `/notes/${id}/move`,
        { body, idempotencyKey: body.idempotencyKey, method: "POST" },
        MutationResultSchema
      );
    },

    archiveNote(noteId: string, input: NoteArchiveRequest) {
      const id = entityIdSchema("note").parse(noteId);
      const body = NoteArchiveRequestSchema.parse(input);
      return request(
        `/notes/${id}/archive`,
        { body, idempotencyKey: body.idempotencyKey, method: "POST" },
        MutationResultSchema
      );
    },

    softDeleteNote(noteId: string, input: NoteSoftDeleteRequest) {
      const id = entityIdSchema("note").parse(noteId);
      const body = NoteSoftDeleteRequestSchema.parse(input);
      return request(
        `/notes/${id}`,
        { body, idempotencyKey: body.idempotencyKey, method: "DELETE" },
        MutationResultSchema
      );
    },

    restoreDeletedNote(noteId: string, input: NoteRestoreDeletedRequest) {
      const id = entityIdSchema("note").parse(noteId);
      const body = NoteRestoreDeletedRequestSchema.parse(input);
      return request(
        `/notes/${id}/restore-deleted`,
        { body, idempotencyKey: body.idempotencyKey, method: "POST" },
        MutationResultSchema
      );
    },

    applyNoteOperations(noteId: string, input: InteractiveOperationsRequest) {
      const id = entityIdSchema("note").parse(noteId);
      const body = InteractiveOperationsRequestSchema.parse(input);
      return request(
        `/notes/${id}/operations`,
        { body, idempotencyKey: body.idempotencyKey, method: "POST" },
        MutationResultSchema
      );
    },

    listNoteRevisions(noteId: string, input: Partial<NoteRevisionListQuery> = {}) {
      const id = entityIdSchema("note").parse(noteId);
      const query = NoteRevisionListQuerySchema.parse(input);
      const suffix = queryString([
        ["limit", query.limit],
        ["cursor", query.cursor]
      ]);
      return request(`/notes/${id}/revisions${suffix}`, {}, NoteRevisionListResponseSchema);
    },

    restoreNoteRevision(noteId: string, input: NoteRestoreRequest) {
      const id = entityIdSchema("note").parse(noteId);
      const body = NoteRestoreRequestSchema.parse(input);
      return request(
        `/notes/${id}/restore`,
        { body, idempotencyKey: body.idempotencyKey, method: "POST" },
        MutationResultSchema
      );
    },

    undoMutation(mutationId: string, input: MutationUndoRequest) {
      const id = entityIdSchema("mut").parse(mutationId);
      const body = MutationUndoRequestSchema.parse(input);
      return request(
        `/mutations/${id}/undo`,
        { body, idempotencyKey: body.idempotencyKey, method: "POST" },
        MutationResultSchema
      );
    },

    undoMutationBatch(mutationId: string, input: MutationUndoRequest) {
      const id = entityIdSchema("mut").parse(mutationId);
      const body = MutationUndoRequestSchema.parse(input);
      return request(
        `/mutation-batches/${id}/undo`,
        { body, cache: "no-store", idempotencyKey: body.idempotencyKey, method: "POST" },
        MutationBatchUndoResponseSchema
      );
    },

    listSpaces(input: Partial<SpaceListQuery> = {}) {
      const query = SpaceListQuerySchema.parse(input);
      const suffix = queryString([
        ["limit", query.limit],
        ["cursor", query.cursor],
        ["includeArchived", query.includeArchived || undefined]
      ]);
      return request(`/spaces${suffix}`, {}, SpaceListResponseSchema);
    },

    getSpace(spaceId: string) {
      const id = entityIdSchema("spc").parse(spaceId);
      return request(`/spaces/${id}`, {}, SpaceDetailResponseSchema);
    },

    createSpace(input: SpaceCreateRequest) {
      const body = SpaceCreateRequestSchema.parse(input);
      return request(
        "/spaces",
        { body, idempotencyKey: body.idempotencyKey, method: "POST" },
        SpaceMutationResultSchema
      );
    },

    updateSpace(spaceId: string, input: SpaceUpdateRequest) {
      const id = entityIdSchema("spc").parse(spaceId);
      const body = SpaceUpdateRequestSchema.parse(input);
      return request(
        `/spaces/${id}`,
        { body, idempotencyKey: body.idempotencyKey, method: "PATCH" },
        SpaceMutationResultSchema
      );
    },

    archiveSpace(spaceId: string, input: SpaceArchiveRequest) {
      const id = entityIdSchema("spc").parse(spaceId);
      const body = SpaceArchiveRequestSchema.parse(input);
      return request(
        `/spaces/${id}/archive`,
        { body, idempotencyKey: body.idempotencyKey, method: "POST" },
        SpaceMutationResultSchema
      );
    },

    listTags(input: Partial<TagListQuery> = {}) {
      const query = TagListQuerySchema.parse(input);
      const suffix = queryString([
        ["limit", query.limit],
        ["cursor", query.cursor]
      ]);
      return request(`/tags${suffix}`, {}, TagListResponseSchema);
    },

    createTag(input: TagCreateRequest) {
      const body = TagCreateRequestSchema.parse(input);
      return request(
        "/tags",
        { body, idempotencyKey: body.idempotencyKey, method: "POST" },
        TagMutationResultSchema
      );
    },

    updateTag(tagId: string, input: TagUpdateRequest) {
      const id = entityIdSchema("tag").parse(tagId);
      const body = TagUpdateRequestSchema.parse(input);
      return request(
        `/tags/${id}`,
        { body, idempotencyKey: body.idempotencyKey, method: "PATCH" },
        TagMutationResultSchema
      );
    },

    deleteTag(tagId: string, input: TagDeleteRequest) {
      const id = entityIdSchema("tag").parse(tagId);
      const body = TagDeleteRequestSchema.parse(input);
      return request(
        `/tags/${id}`,
        { body, idempotencyKey: body.idempotencyKey, method: "DELETE" },
        DeleteMutationResultSchema
      );
    },

    listReviewItems(input: Partial<ReviewItemListQuery> = {}) {
      const query = ReviewItemListQuerySchema.parse(input);
      const suffix = queryString([
        ["state", query.state],
        ["limit", query.limit],
        ["cursor", query.cursor]
      ]);
      return request(
        `/review-items${suffix}`,
        { cache: "no-store" },
        ListReviewItemsResponseSchema
      );
    },

    resolveReviewItem(reviewItemId: string, input: ReviewResolveRequest) {
      const id = entityIdSchema("rvw").parse(reviewItemId);
      const body = ReviewResolveRequestSchema.parse(input);
      return request(
        `/review-items/${id}/resolve`,
        { body, cache: "no-store", idempotencyKey: body.idempotencyKey, method: "POST" },
        ReviewResolveResponseSchema
      );
    },

    resolveGeneratedBlock(blockValue: GeneratedBlockDto, input: GeneratedBlockResolveRequest) {
      const source = GeneratedBlockDtoSchema.parse(blockValue);
      const id = entityIdSchema("blk").parse(source.id);
      const body = GeneratedBlockResolveRequestSchema.parse(input);
      return request(
        `/generated-blocks/${id}/resolve`,
        {
          body,
          cache: "no-store",
          idempotencyKey: body.idempotencyKey,
          maximumResponseBytes: MAX_GENERATED_BLOCK_RESPONSE_BYTES,
          method: "POST"
        },
        GeneratedBlockResolveResponseSchema
      ).then((response) => {
        const expectedState = body.resolution === "accept" ? "accepted" : "rejected";
        if (
          response.block.id !== id ||
          response.block.noteId !== source.noteId ||
          response.block.decisionId !== source.decisionId ||
          response.block.kind !== source.kind ||
          response.block.content !== source.content ||
          response.block.modelId !== source.modelId ||
          response.block.promptVersion !== source.promptVersion ||
          response.block.createdAt !== source.createdAt ||
          response.block.state !== expectedState ||
          response.block.stateRevision !== body.expectedStateRevision + 1 ||
          response.block.stateRevision !== source.stateRevision + 1
        ) {
          throw new ApiClientMalformedResponseError(200);
        }
        return response;
      });
    },

    listRoutingRules,

    listAllRoutingRules,

    createRoutingRule(input: RoutingRuleCreateRequest) {
      const body = RoutingRuleCreateRequestSchema.parse(input);
      return request(
        "/routing-rules",
        {
          body,
          cache: "no-store",
          idempotencyKey: body.idempotencyKey,
          maximumResponseBytes: MAX_ROUTING_RULE_PAGE_BYTES,
          method: "POST"
        },
        RoutingRuleMutationResponseSchema
      );
    },

    updateRoutingRule(routingRuleId: string, input: RoutingRuleUpdateRequest) {
      const id = entityIdSchema("rule").parse(routingRuleId);
      const body = RoutingRuleUpdateRequestSchema.parse(input);
      return request(
        `/routing-rules/${id}`,
        {
          body,
          cache: "no-store",
          idempotencyKey: body.idempotencyKey,
          maximumResponseBytes: MAX_ROUTING_RULE_PAGE_BYTES,
          method: "PATCH"
        },
        RoutingRuleMutationResponseSchema
      );
    },

    deleteRoutingRule(routingRuleId: string, input: RoutingRuleDeleteRequest) {
      const id = entityIdSchema("rule").parse(routingRuleId);
      const body = RoutingRuleDeleteRequestSchema.parse(input);
      return request(
        `/routing-rules/${id}`,
        {
          body,
          cache: "no-store",
          idempotencyKey: body.idempotencyKey,
          maximumResponseBytes: MAX_ROUTING_RULE_PAGE_BYTES,
          method: "DELETE"
        },
        RoutingRuleDeleteResponseSchema
      );
    },

    searchNotes(input: SearchNotesRequest) {
      const body = SearchNotesRequestSchema.parse(input);
      return request(
        "/search",
        { body, cache: "no-store", method: "POST" },
        SearchNotesResponseSchema
      );
    },

    getUserSettings() {
      return request(
        "/me/settings",
        {
          cache: "no-store",
          maximumResponseBytes: MAX_AI_SETTINGS_RESPONSE_BYTES,
          requirePrivateNoStore: true
        },
        UserSettingsResponseSchema
      );
    },

    async updateUserSettings(input: UserSettingsUpdateRequest) {
      const body = UserSettingsUpdateRequestSchema.parse(input);
      const response = await request(
        "/me/settings",
        {
          body,
          cache: "no-store",
          idempotencyKey: body.idempotencyKey,
          maximumResponseBytes: MAX_AI_SETTINGS_RESPONSE_BYTES,
          method: "PATCH",
          requirePrivateNoStore: true
        },
        UserSettingsUpdateResponseSchema
      );
      if (response.settings.settingsRevision !== body.expectedSettingsRevision + 1) {
        throw new ApiClientMalformedResponseError(200);
      }
      for (const field of [
        "organizationMode",
        "providerMode",
        "byokProvider",
        "byokFallbackToApp",
        "routingEffort",
        "expansionStyle",
        "timezone",
        "locale"
      ] as const) {
        if (body[field] !== undefined && response.settings[field] !== body[field]) {
          throw new ApiClientMalformedResponseError(200);
        }
      }
      return response;
    },

    getProviderKeyMetadata() {
      return request(
        "/me/provider-key",
        {
          cache: "no-store",
          maximumResponseBytes: MAX_PROVIDER_KEY_RESPONSE_BYTES,
          requirePrivateNoStore: true
        },
        ProviderKeyResponseSchema
      );
    },

    async putProviderKey(input: ProviderKeyPutRequest) {
      const body = ProviderKeyPutRequestSchema.parse(input);
      const response = await request(
        "/me/provider-key",
        {
          body,
          cache: "no-store",
          idempotencyKey: body.idempotencyKey,
          maximumResponseBytes: MAX_PROVIDER_KEY_RESPONSE_BYTES,
          method: "PUT",
          requirePrivateNoStore: true
        },
        ProviderKeyPutResponseSchema
      );
      if (
        body.expectedCredentialRevision !== null &&
        response.providerKey.credentialRevision !== body.expectedCredentialRevision + 1
      ) {
        throw new ApiClientMalformedResponseError(200);
      }
      if (response.providerKey.lastFour !== body.apiKey.slice(-4)) {
        throw new ApiClientMalformedResponseError(200);
      }
      return response;
    },

    async deleteProviderKey(input: ProviderKeyDeleteRequest) {
      const body = ProviderKeyDeleteRequestSchema.parse(input);
      const response = await request(
        "/me/provider-key",
        {
          body,
          cache: "no-store",
          idempotencyKey: body.idempotencyKey,
          maximumResponseBytes: MAX_PROVIDER_KEY_RESPONSE_BYTES,
          method: "DELETE",
          requirePrivateNoStore: true
        },
        ProviderKeyDeleteResponseSchema
      );
      if (response.deletedCredentialRevision !== body.expectedCredentialRevision) {
        throw new ApiClientMalformedResponseError(200);
      }
      return response;
    },

    /** Returns the unbuffered archive response so callers can stream it to their chosen sink. */
    exportAccountData() {
      return authenticatedRawRequest("/me/export");
    },

    deleteAccount(input: AccountDeleteRequest) {
      const body = AccountDeleteRequestSchema.parse(input);
      return request(
        "/me",
        { body, cache: "no-store", method: "DELETE" },
        AccountDeletionReceiptSchema
      );
    },

    replayAccountDeletionReceipt(input: AccountDeletionReceiptReplayRequest) {
      const body = AccountDeletionReceiptReplayRequestSchema.parse(input);
      return request(
        "/me/deletion-receipt",
        { authenticated: false, body, cache: "no-store", method: "POST" },
        AccountDeletionReceiptSchema
      );
    }
  });
}

export type ApiClient = ReturnType<typeof createApiClient>;
