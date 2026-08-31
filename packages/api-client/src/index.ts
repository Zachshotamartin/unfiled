import {
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
  InteractiveOperationsRequestSchema,
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
  NoteMoveRequestSchema,
  NoteRestoreDeletedRequestSchema,
  NoteRestoreRequestSchema,
  NoteRevisionListQuerySchema,
  NoteRevisionListResponseSchema,
  NoteSoftDeleteRequestSchema,
  NoteUpdateRequestSchema,
  NoteRelationMutationResponseSchema,
  NoteTagLinkRequestSchema,
  NoteTagUnlinkRequestSchema,
  ListReviewItemsResponseSchema,
  ReviewItemListQuerySchema,
  SearchNotesQuerySchema,
  SearchNotesResponseSchema,
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
  entityIdSchema,
  type ApiError,
  type AuthOtpRequest,
  type AuthOtpVerifyRequest,
  type AuthRefreshRequest,
  type AuthVerifyRequest,
  type CaptureCreateRequest,
  type CaptureDeleteRequest,
  type CaptureListQuery,
  type CaptureRetryRequest,
  type InteractiveOperationsRequest,
  type MutationUndoRequest,
  type NoteArchiveRequest,
  type NoteCreateRequest,
  type NoteListQuery,
  type NoteLinkCreateRequest,
  type NoteLinkDeleteRequest,
  type NoteMoveRequest,
  type NoteRestoreDeletedRequest,
  type NoteRestoreRequest,
  type NoteRevisionListQuery,
  type NoteSoftDeleteRequest,
  type NoteUpdateRequest,
  type NoteTagLinkRequest,
  type NoteTagUnlinkRequest,
  type ReviewItemListQuery,
  type SearchNotesQuery,
  type SpaceArchiveRequest,
  type SpaceCreateRequest,
  type SpaceListQuery,
  type SpaceUpdateRequest,
  type TagCreateRequest,
  type TagDeleteRequest,
  type TagListQuery,
  type TagUpdateRequest
} from "@unfiled/contracts";
import type { ZodType } from "zod";

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
      idempotencyKey?: string;
      authenticated?: boolean;
    }>,
    responseSchema: ZodType<T>
  ): Promise<T> {
    const authenticated = init.authenticated ?? true;
    const token = authenticated ? await options.getAccessToken() : null;
    const response = await fetcher(`${baseUrl}/api/v1${path}`, {
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
      return request(`/review-items${suffix}`, {}, ListReviewItemsResponseSchema);
    },

    searchNotes(input: SearchNotesQuery) {
      const query = SearchNotesQuerySchema.parse(input);
      const suffix = queryString([
        ["q", query.q],
        ["archive", query.archive],
        ["limit", query.limit],
        ["cursor", query.cursor]
      ]);
      return request(`/search${suffix}`, {}, SearchNotesResponseSchema);
    }
  });
}

export type ApiClient = ReturnType<typeof createApiClient>;
