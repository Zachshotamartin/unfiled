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
  GeneratedBlockListResponseSchema,
  GeneratedBlockResolveRequestSchema,
  GeneratedBlockResolveResponseSchema,
  InteractiveOperationsRequestSchema,
  MutationBatchUndoResponseSchema,
  MutationResultSchema,
  MutationUndoRequestSchema,
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

export type ApiClientOptions = Readonly<{
  baseUrl: string;
  getAccessToken: () => Promise<string | null>;
  fetch?: typeof globalThis.fetch;
}>;

async function decode<T>(response: Response, schema: ZodType<T>): Promise<T> {
  const body: unknown = await response.json();
  if (!response.ok) throw new ApiClientError(response.status, ApiErrorSchema.parse(body));
  return schema.parse(body);
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
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
    });
    return decode(response, responseSchema);
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
      const body: unknown = await response.json().catch(() => null);
      throw new ApiClientError(response.status, ApiErrorSchema.parse(body));
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

    listGeneratedBlocks(noteId: string) {
      const id = entityIdSchema("note").parse(noteId);
      return request(
        `/notes/${id}/generated-blocks`,
        { cache: "no-store" },
        GeneratedBlockListResponseSchema
      );
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

    resolveGeneratedBlock(blockId: string, input: GeneratedBlockResolveRequest) {
      const id = entityIdSchema("blk").parse(blockId);
      const body = GeneratedBlockResolveRequestSchema.parse(input);
      return request(
        `/generated-blocks/${id}/resolve`,
        { body, cache: "no-store", idempotencyKey: body.idempotencyKey, method: "POST" },
        GeneratedBlockResolveResponseSchema
      );
    },

    listRoutingRules() {
      return request("/routing-rules", { cache: "no-store" }, RoutingRuleListResponseSchema);
    },

    createRoutingRule(input: RoutingRuleCreateRequest) {
      const body = RoutingRuleCreateRequestSchema.parse(input);
      return request(
        "/routing-rules",
        { body, cache: "no-store", idempotencyKey: body.idempotencyKey, method: "POST" },
        RoutingRuleMutationResponseSchema
      );
    },

    updateRoutingRule(routingRuleId: string, input: RoutingRuleUpdateRequest) {
      const id = entityIdSchema("rule").parse(routingRuleId);
      const body = RoutingRuleUpdateRequestSchema.parse(input);
      return request(
        `/routing-rules/${id}`,
        { body, cache: "no-store", idempotencyKey: body.idempotencyKey, method: "PATCH" },
        RoutingRuleMutationResponseSchema
      );
    },

    deleteRoutingRule(routingRuleId: string, input: RoutingRuleDeleteRequest) {
      const id = entityIdSchema("rule").parse(routingRuleId);
      const body = RoutingRuleDeleteRequestSchema.parse(input);
      return request(
        `/routing-rules/${id}`,
        { body, cache: "no-store", idempotencyKey: body.idempotencyKey, method: "DELETE" },
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
      return request("/me/settings", {}, UserSettingsResponseSchema);
    },

    updateUserSettings(input: UserSettingsUpdateRequest) {
      const body = UserSettingsUpdateRequestSchema.parse(input);
      return request(
        "/me/settings",
        { body, idempotencyKey: body.idempotencyKey, method: "PATCH" },
        UserSettingsUpdateResponseSchema
      );
    },

    getProviderKeyMetadata() {
      return request("/me/provider-key", { cache: "no-store" }, ProviderKeyResponseSchema);
    },

    putProviderKey(input: ProviderKeyPutRequest) {
      const body = ProviderKeyPutRequestSchema.parse(input);
      return request(
        "/me/provider-key",
        { body, cache: "no-store", idempotencyKey: body.idempotencyKey, method: "PUT" },
        ProviderKeyPutResponseSchema
      );
    },

    deleteProviderKey(input: ProviderKeyDeleteRequest) {
      const body = ProviderKeyDeleteRequestSchema.parse(input);
      return request(
        "/me/provider-key",
        { body, cache: "no-store", idempotencyKey: body.idempotencyKey, method: "DELETE" },
        ProviderKeyDeleteResponseSchema
      );
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
