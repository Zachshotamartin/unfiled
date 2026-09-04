import { createHash, createHmac, randomBytes, timingSafeEqual, type Hmac } from "node:crypto";

import {
  ApiErrorCode,
  InteractiveOperationsRequestSchema,
  MutationUndoRequestSchema,
  NoteArchiveRequestSchema,
  NoteCreateRequestSchema,
  NoteLinkCreateRequestSchema,
  NoteLinkDeleteRequestSchema,
  NoteMoveRequestSchema,
  NoteRestoreDeletedRequestSchema,
  NoteRestoreRequestSchema,
  NoteSoftDeleteRequestSchema,
  NoteTagLinkRequestSchema,
  NoteTagUnlinkRequestSchema,
  NoteUpdateRequestSchema,
  ReviewItemListQuerySchema,
  SearchNotesRequestSchema,
  ENCRYPTED_USER_SEARCH_REQUEST_VERSION,
  USER_HYBRID_SEARCH_RANKING_VERSION,
  USER_SEMANTIC_SEARCH_RANKING_VERSION,
  encryptedUserSearchMaterialFromRequest,
  SpaceArchiveRequestSchema,
  SpaceCreateRequestSchema,
  SpaceUpdateRequestSchema,
  TagCreateRequestSchema,
  TagDeleteRequestSchema,
  TagUpdateRequestSchema,
  entityIdSchema,
  noteAttachmentReferences,
  type EntityId,
  type EncryptedUserSearchContinuation,
  type EncryptedUserSearchMaterial,
  type EncryptedUserSearchResult,
  type NoteDetail,
  type NoteSummary,
  type SearchNoteResult,
  type Space
} from "@unfiled/contracts";
import { normalizePrivateRagText } from "@unfiled/search";

import type {
  NoteMutationResult,
  NoteRecord,
  SearchResult,
  SpaceRecord
} from "@/lib/product/types";
import { authenticateRequest, type AuthenticatedRequest } from "@/server/auth/session";
import { scheduleIndexDrain as scheduleProductionIndexDrain } from "@/server/indexing/index-worker-scheduler";
import { runHybridSearch } from "@/server/product/hybrid-search";
import { createProductionRepository } from "@/server/product/supabase-http-repository";
import type { ManualNotesRepository, RepositoryContext } from "@/server/product/repository";
import { createProductionSemanticSearchCoordinator } from "@/server/search/production-composition";

import {
  ConfigurationError,
  errorResponse,
  HttpError,
  jsonResponse,
  readJsonObject,
  requireIdempotencyKey
} from "./errors";

type RouteParameters = Readonly<Record<string, string>>;

type Schema<T> = Readonly<{
  safeParse(
    value: unknown
  ):
    | Readonly<{ data: T; success: true }>
    | Readonly<{ error: { issues: readonly unknown[] }; success: false }>;
}>;

export type ManualNotesDependencies = Readonly<{
  authenticate?: (request: Request) => Promise<AuthenticatedRequest>;
  getPrivateSearchCursorKey?: () => string | undefined;
  repository: ManualNotesRepository | ((request: Request) => ManualNotesRepository);
  scheduleIndexDrain?: () => void;
  semanticSearch?: (
    context: RepositoryContext,
    signal: AbortSignal
  ) => Readonly<{
    search(
      material: EncryptedUserSearchMaterial,
      signal?: AbortSignal
    ): Promise<EncryptedUserSearchResult>;
  }>;
}>;

const MAX_PRIVATE_SEARCH_REQUEST_BYTES = 4_096;
const PRIVATE_OWNER_CONTENT_CACHE_CONTROL = "private, no-store";
const PRIVATE_SEARCH_CURSOR_DOMAIN = "unfiled/private-search-cursor/hmac-sha256/v3";
const PRIVATE_SEARCH_CURSOR_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const PRIVATE_SEARCH_CURSOR_NONCE_BYTES = 16;
const PRIVATE_SEARCH_CURSOR_TAG_BYTES = 32;
const PRIVATE_SEARCH_CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/u;
const PRIVATE_SEARCH_CURSOR_VERSION = 3 as const;
const PRIVATE_SEARCH_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

type PrivateSearchSemanticContinuation = EncryptedUserSearchContinuation;

type PrivateSearchHybridBoundary = Readonly<{
  combinedScore: number;
  currentRevision: number;
  noteId: EntityId<"note">;
  updatedAt: string;
}>;

type PrivateSearchContinuation = Readonly<{
  hybrid: PrivateSearchHybridBoundary;
  semantic: PrivateSearchSemanticContinuation | null;
}>;

type PrivateSearchCursorScope = Readonly<{
  filters: Readonly<{
    archive: "exclude" | "include" | "only";
    limit: number;
    privacy: "ai_assisted" | "private_manual" | null;
    space: Readonly<{ id: string | null; mode: "any" | "exact" | "root" }>;
    tagIds: readonly string[];
    type: "generic" | "list" | "log" | "principle" | "project" | null;
    updatedFrom: string | null;
    updatedTo: string | null;
  }>;
  ownerId: string;
  query: string;
  requestVersion: typeof ENCRYPTED_USER_SEARCH_REQUEST_VERSION;
  rankingVersion: typeof USER_HYBRID_SEARCH_RANKING_VERSION;
}>;

function parse<T>(schema: Schema<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(
      400,
      ApiErrorCode.VALIDATION_FAILED,
      "Check the fields in this request and try again."
    );
  }
  return result.data;
}

function parseId<K extends "lnk" | "mut" | "note" | "rev" | "spc" | "tag">(
  kind: K,
  value: string | undefined
): EntityId<K> {
  return parse(entityIdSchema(kind), value);
}

function canonicalNote(note: NoteRecord): NoteDetail {
  return {
    id: note.id,
    spaceId: note.spaceId,
    type: note.type,
    title: note.title,
    bodyMarkdown: note.bodyMarkdown,
    structuredData: note.structuredData,
    currentRevision: note.currentRevision,
    isOpen: note.isOpen,
    pinnedAt: note.pinnedAt,
    privacy: note.privacy,
    archivedAt: note.archivedAt,
    deletedAt: note.deletedAt,
    tagIds: note.tagIds,
    links: note.links.map(({ linkType, toNoteId }) => ({ linkType, toNoteId })),
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    // The body keeps the references because they carry the placement; the array carries identity
    // and kind, so a client renders a note's photo without parsing the body for markers.
    attachments: [...noteAttachmentReferences(note.bodyMarkdown)]
  };
}

function noteSummary(note: NoteRecord): NoteSummary {
  return {
    id: note.id,
    spaceId: note.spaceId,
    type: note.type,
    title: note.title,
    currentRevision: note.currentRevision,
    isOpen: note.isOpen,
    pinnedAt: note.pinnedAt,
    privacy: note.privacy,
    archivedAt: note.archivedAt,
    deletedAt: note.deletedAt,
    updatedAt: note.updatedAt
  };
}

function canonicalSpace(space: SpaceRecord): Space {
  return {
    id: space.id,
    parentId: space.parentId,
    name: space.name,
    slug: space.slug,
    sortKey: space.sortKey,
    currentRevision: space.currentRevision,
    archivedAt: space.archivedAt,
    createdAt: space.createdAt,
    updatedAt: space.updatedAt
  };
}

function mutationResponse(result: NoteMutationResult): Readonly<Record<string, unknown>> {
  return {
    note: canonicalNote(result.note),
    revision: result.revision,
    mutationId: result.mutation.id,
    replayed: result.mutation.replayed,
    undo: { eligible: result.mutation.undoAvailable, expiresAt: null }
  };
}

function scopeHash(scope: string): string {
  return createHash("sha256").update(scope).digest("base64url").slice(0, 16);
}

function cursorOffset(value: string | null, scope: string): number {
  if (value === null) return 0;
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/u.test(value)) throw new TypeError("invalid cursor");
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const [version, offsetValue, hash, extra] = decoded.split(":");
    const offset = Number(offsetValue);
    if (
      version !== "v1" ||
      extra !== undefined ||
      hash !== scopeHash(scope) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 100_000
    ) {
      throw new TypeError("invalid cursor");
    }
    return offset;
  } catch {
    throw new HttpError(
      400,
      ApiErrorCode.VALIDATION_FAILED,
      "That page cursor is invalid or no longer matches these filters."
    );
  }
}

function pageWindow<T>(
  values: readonly T[],
  limit: number,
  offset: number,
  scope: string
): Readonly<{
  items: readonly T[];
  pageInfo: Readonly<{ hasMore: boolean; nextCursor: string | null }>;
}> {
  const hasMore = values.length > limit;
  return {
    items: values.slice(0, limit),
    pageInfo: {
      hasMore,
      nextCursor: hasMore
        ? Buffer.from(`v1:${offset + limit}:${scopeHash(scope)}`, "utf8").toString("base64url")
        : null
    }
  };
}

function privateSearchCursorKey(value: string | undefined): Buffer {
  if (value === undefined || !PRIVATE_SEARCH_CURSOR_KEY_PATTERN.test(value)) {
    throw new ConfigurationError();
  }
  const key = Buffer.from(value, "base64url");
  if (key.byteLength !== 32 || key.toString("base64url") !== value) {
    key.fill(0);
    throw new ConfigurationError();
  }
  return key;
}

function updatePrivateSearchCursorMacField(mac: Hmac, value: string): void {
  const encoded = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(encoded.byteLength);
  mac.update(length);
  mac.update(encoded);
  length.fill(0);
  encoded.fill(0);
}

function privateSearchCursorTag(
  key: Buffer,
  payload: Buffer,
  scope: PrivateSearchCursorScope
): Buffer {
  const mac = createHmac("sha256", key);
  mac.update(PRIVATE_SEARCH_CURSOR_DOMAIN, "utf8");
  updatePrivateSearchCursorMacField(mac, scope.ownerId);
  updatePrivateSearchCursorMacField(mac, scope.query);
  updatePrivateSearchCursorMacField(mac, JSON.stringify(scope.filters));
  updatePrivateSearchCursorMacField(mac, scope.requestVersion);
  updatePrivateSearchCursorMacField(mac, scope.rankingVersion);
  mac.update(payload);
  return mac.digest();
}

function validPrivateSearchScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1.2;
}

function privateSearchNoteId(value: unknown): EntityId<"note"> {
  const parsed = entityIdSchema("note").safeParse(value);
  if (!parsed.success) throw new TypeError("invalid cursor note");
  return parsed.data;
}

function privateSearchSemanticContinuation(
  value: unknown
): PrivateSearchSemanticContinuation | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 4) throw new TypeError("invalid cursor semantic");
  const generationBindingDigest: unknown = value[0];
  const rankingVersion: unknown = value[1];
  const resultDigest: unknown = value[2];
  const boundaryValue: unknown = value[3];
  if (
    typeof generationBindingDigest !== "string" ||
    !PRIVATE_SEARCH_DIGEST_PATTERN.test(generationBindingDigest) ||
    rankingVersion !== USER_SEMANTIC_SEARCH_RANKING_VERSION ||
    typeof resultDigest !== "string" ||
    !PRIVATE_SEARCH_DIGEST_PATTERN.test(resultDigest)
  ) {
    throw new TypeError("invalid cursor semantic");
  }
  let boundary: PrivateSearchSemanticContinuation["boundary"] = null;
  if (boundaryValue !== null) {
    if (!Array.isArray(boundaryValue) || boundaryValue.length !== 3) {
      throw new TypeError("invalid cursor semantic boundary");
    }
    const score: unknown = boundaryValue[0];
    const noteId: unknown = boundaryValue[1];
    const indexedRevision: unknown = boundaryValue[2];
    if (
      !validPrivateSearchScore(score) ||
      !Number.isSafeInteger(indexedRevision) ||
      typeof indexedRevision !== "number" ||
      indexedRevision < 1
    ) {
      throw new TypeError("invalid cursor semantic boundary");
    }
    boundary = Object.freeze({
      score,
      noteId: privateSearchNoteId(noteId),
      indexedRevision
    });
  }
  return Object.freeze({
    boundary,
    generationBindingDigest,
    rankingVersion: USER_SEMANTIC_SEARCH_RANKING_VERSION,
    resultDigest
  });
}

function privateSearchHybridBoundary(value: unknown): PrivateSearchHybridBoundary {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new TypeError("invalid cursor hybrid boundary");
  }
  const combinedScore: unknown = value[0];
  const updatedAt: unknown = value[1];
  const noteId: unknown = value[2];
  const currentRevision: unknown = value[3];
  if (
    !validPrivateSearchScore(combinedScore) ||
    typeof updatedAt !== "string" ||
    updatedAt.length < 1 ||
    updatedAt.length > 64 ||
    !Number.isFinite(Date.parse(updatedAt)) ||
    !Number.isSafeInteger(currentRevision) ||
    typeof currentRevision !== "number" ||
    currentRevision < 1
  ) {
    throw new TypeError("invalid cursor hybrid boundary");
  }
  return Object.freeze({
    combinedScore,
    currentRevision,
    noteId: privateSearchNoteId(noteId),
    updatedAt
  });
}

function compactPrivateSearchContinuation(
  continuation: PrivateSearchContinuation,
  nonce: string
): Readonly<Record<string, unknown>> {
  const semantic = continuation.semantic;
  return {
    v: PRIVATE_SEARCH_CURSOR_VERSION,
    n: nonce,
    s:
      semantic === null
        ? null
        : [
            semantic.generationBindingDigest,
            semantic.rankingVersion,
            semantic.resultDigest,
            semantic.boundary === null
              ? null
              : [
                  semantic.boundary.score,
                  semantic.boundary.noteId,
                  semantic.boundary.indexedRevision
                ]
          ],
    h: [
      continuation.hybrid.combinedScore,
      continuation.hybrid.updatedAt,
      continuation.hybrid.noteId,
      continuation.hybrid.currentRevision
    ]
  };
}

function encodePrivateSearchCursor(
  continuation: PrivateSearchContinuation,
  scope: PrivateSearchCursorScope,
  key: Buffer
): string {
  const nonceBytes = randomBytes(PRIVATE_SEARCH_CURSOR_NONCE_BYTES);
  let payload: Buffer | undefined;
  let tag: Buffer | undefined;
  let combined: Buffer | undefined;
  try {
    const nonce = nonceBytes.toString("base64url");
    payload = Buffer.from(
      JSON.stringify(compactPrivateSearchContinuation(continuation, nonce)),
      "utf8"
    );
    tag = privateSearchCursorTag(key, payload, scope);
    combined = Buffer.concat([payload, tag]);
    const encoded = combined.toString("base64url");
    if (!PRIVATE_SEARCH_CURSOR_PATTERN.test(encoded)) {
      throw new TypeError("invalid cursor size");
    }
    return encoded;
  } finally {
    nonceBytes.fill(0);
    payload?.fill(0);
    tag?.fill(0);
    combined?.fill(0);
  }
}

function privateSearchCursorContinuation(
  value: string | null,
  scope: PrivateSearchCursorScope,
  key: Buffer
): PrivateSearchContinuation | null {
  if (value === null) return null;
  let decoded: Buffer | undefined;
  let expectedTag: Buffer | undefined;
  let nonceBytes: Buffer | undefined;
  try {
    if (!PRIVATE_SEARCH_CURSOR_PATTERN.test(value)) throw new TypeError("invalid cursor");
    decoded = Buffer.from(value, "base64url");
    if (
      decoded.toString("base64url") !== value ||
      decoded.byteLength <= PRIVATE_SEARCH_CURSOR_TAG_BYTES
    ) {
      throw new TypeError("invalid cursor");
    }
    const payloadLength = decoded.byteLength - PRIVATE_SEARCH_CURSOR_TAG_BYTES;
    const payload = decoded.subarray(0, payloadLength);
    const suppliedTag = decoded.subarray(payloadLength);
    expectedTag = privateSearchCursorTag(key, payload, scope);
    if (
      suppliedTag.byteLength !== expectedTag.byteLength ||
      !timingSafeEqual(suppliedTag, expectedTag)
    ) {
      throw new TypeError("invalid cursor");
    }
    const serialized = payload.toString("utf8");
    const candidate: unknown = JSON.parse(serialized);
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      JSON.stringify(candidate) !== serialized
    ) {
      throw new TypeError("invalid cursor");
    }
    const record = candidate as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record);
    if (
      keys.length !== 4 ||
      keys[0] !== "v" ||
      keys[1] !== "n" ||
      keys[2] !== "s" ||
      keys[3] !== "h" ||
      record.v !== PRIVATE_SEARCH_CURSOR_VERSION ||
      typeof record.n !== "string" ||
      !/^[A-Za-z0-9_-]{22}$/u.test(record.n)
    ) {
      throw new TypeError("invalid cursor");
    }
    nonceBytes = Buffer.from(record.n, "base64url");
    if (
      nonceBytes.byteLength !== PRIVATE_SEARCH_CURSOR_NONCE_BYTES ||
      nonceBytes.toString("base64url") !== record.n
    ) {
      throw new TypeError("invalid cursor");
    }
    const semantic = privateSearchSemanticContinuation(record.s);
    if (scope.filters.privacy !== "ai_assisted" && semantic !== null) {
      throw new TypeError("invalid cursor privacy");
    }
    return Object.freeze({
      hybrid: privateSearchHybridBoundary(record.h),
      semantic
    });
  } catch {
    throw new HttpError(
      400,
      ApiErrorCode.VALIDATION_FAILED,
      "That page cursor is invalid or no longer matches this private search."
    );
  } finally {
    nonceBytes?.fill(0);
    expectedTag?.fill(0);
    decoded?.fill(0);
  }
}

function privateSearchBoundary(result: SearchResult): PrivateSearchHybridBoundary {
  return Object.freeze({
    combinedScore: result.score,
    currentRevision: result.note.currentRevision,
    noteId: result.note.id,
    updatedAt: result.note.updatedAt
  });
}

function privateSearchBoundaryMatches(
  result: SearchResult,
  boundary: PrivateSearchHybridBoundary
): boolean {
  return (
    result.score === boundary.combinedScore &&
    result.note.updatedAt === boundary.updatedAt &&
    result.note.id === boundary.noteId &&
    result.note.currentRevision === boundary.currentRevision
  );
}

function samePrivateSearchSemanticContinuation(
  left: PrivateSearchSemanticContinuation,
  right: PrivateSearchSemanticContinuation
): boolean {
  const leftBoundary = left.boundary;
  const rightBoundary = right.boundary;
  return (
    left.generationBindingDigest === right.generationBindingDigest &&
    left.resultDigest === right.resultDigest &&
    ((leftBoundary === null && rightBoundary === null) ||
      (leftBoundary !== null &&
        rightBoundary !== null &&
        leftBoundary.score === rightBoundary.score &&
        leftBoundary.noteId === rightBoundary.noteId &&
        leftBoundary.indexedRevision === rightBoundary.indexedRevision))
  );
}

function privateSearchPageWindow(
  values: readonly SearchResult[],
  limit: number,
  continuation: PrivateSearchContinuation | null,
  semantic: PrivateSearchSemanticContinuation | null,
  scope: PrivateSearchCursorScope,
  key: Buffer
): Readonly<{
  results: readonly SearchResult[];
  pageInfo: Readonly<{ hasMore: boolean; nextCursor: string | null }>;
}> | null {
  const boundaryIndex =
    continuation === null
      ? -1
      : values.findIndex((result) => privateSearchBoundaryMatches(result, continuation.hybrid));
  if (continuation !== null && boundaryIndex < 0) return null;
  const start = boundaryIndex + 1;
  const end = start + limit;
  const hasMore = values.length > end;
  const results = values.slice(start, end);
  const last = results.at(-1);
  return {
    results,
    pageInfo: {
      hasMore,
      nextCursor:
        hasMore && last !== undefined
          ? encodePrivateSearchCursor({ hybrid: privateSearchBoundary(last), semantic }, scope, key)
          : null
    }
  };
}

function enumQuery<T extends string>(value: string | null, values: readonly T[], fallback: T): T {
  if (value === null || value.length === 0) return fallback;
  if (values.includes(value as T)) return value as T;
  throw new HttpError(400, ApiErrorCode.VALIDATION_FAILED, "That filter is not valid.");
}

function positiveLimit(value: string | null): number {
  if (value === null) return 30;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new HttpError(400, ApiErrorCode.VALIDATION_FAILED, "Limit must be between 1 and 100.");
  }
  return parsed;
}

function privateOwnerContentResponse(response: Response): Response {
  response.headers.set("cache-control", PRIVATE_OWNER_CONTENT_CACHE_CONTROL);
  response.headers.set("pragma", "no-cache");
  return response;
}

function privateSearchRequestTooLarge(): HttpError {
  return new HttpError(413, ApiErrorCode.VALIDATION_FAILED, "That search request is too large.");
}

async function readBoundedPrivateSearchBytes(request: Request): Promise<Uint8Array> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new HttpError(400, ApiErrorCode.VALIDATION_FAILED, "Send a valid JSON request.");
    }
    if (length > MAX_PRIVATE_SEARCH_REQUEST_BYTES) throw privateSearchRequestTooLarge();
  }

  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_PRIVATE_SEARCH_REQUEST_BYTES) {
        void reader.cancel();
        throw privateSearchRequestTooLarge();
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
  return bytes;
}

async function readPrivateSearchRequest(request: Request) {
  const url = new URL(request.url);
  if (url.search.length > 0) {
    throw new HttpError(
      400,
      ApiErrorCode.VALIDATION_FAILED,
      "Send search fields in the private request body."
    );
  }
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new HttpError(400, ApiErrorCode.VALIDATION_FAILED, "Send search fields as JSON.");
  }
  const bytes = await readBoundedPrivateSearchBytes(request);
  let value: unknown;
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(json) as unknown;
  } catch {
    throw new HttpError(400, ApiErrorCode.VALIDATION_FAILED, "Send a valid JSON request.");
  } finally {
    bytes.fill(0);
  }
  return parse(SearchNotesRequestSchema, value);
}

export function createManualNotesHandlers(dependencies: ManualNotesDependencies) {
  const authenticate = dependencies.authenticate ?? authenticateRequest;
  const getPrivateSearchCursorKey =
    dependencies.getPrivateSearchCursorKey ??
    (() => process.env.UNFILED_PRIVATE_SEARCH_CURSOR_HMAC_KEY);
  const scheduleIndexDrain = dependencies.scheduleIndexDrain ?? scheduleProductionIndexDrain;
  const semanticSearch = dependencies.semanticSearch;

  function noteMutationResponse(result: NoteMutationResult, status = 200): Response {
    try {
      scheduleIndexDrain();
    } catch {
      // The committed mutation and encrypted index queue are authoritative.
    }
    return jsonResponse(mutationResponse(result), status);
  }

  async function run(
    request: Request,
    action: (repository: ManualNotesRepository, context: RepositoryContext) => Promise<Response>
  ): Promise<Response> {
    try {
      const session = await authenticate(request);
      const repository =
        typeof dependencies.repository === "function"
          ? dependencies.repository(request)
          : dependencies.repository;
      const response = await action(repository, {
        accessToken: session.accessToken,
        userId: session.user.id
      });
      for (const cookie of session.cookies) response.headers.append("set-cookie", cookie);
      return response;
    } catch (error) {
      return errorResponse(error, request);
    }
  }

  return Object.freeze({
    listNotes(request: Request) {
      return run(request, async (repository, context) => {
        const url = new URL(request.url);
        const archive = enumQuery(
          url.searchParams.get("archive"),
          ["exclude", "include", "only"] as const,
          "exclude"
        );
        const deleted = enumQuery(
          url.searchParams.get("deleted"),
          ["exclude", "only"] as const,
          "exclude"
        );
        const spaceValue = url.searchParams.get("spaceId");
        const type = enumQuery(
          url.searchParams.get("type"),
          ["generic", "list", "log", "principle", "project"] as const,
          "generic"
        );
        const hasType = url.searchParams.has("type");
        const limit = positiveLimit(url.searchParams.get("limit"));
        const scope = JSON.stringify({
          archive,
          deleted,
          route: "notes",
          spaceId: spaceValue,
          type: hasType ? type : null
        });
        const offset = cursorOffset(url.searchParams.get("cursor"), scope);
        const notes = await repository.listNotes(context, {
          archived: archive,
          deleted,
          limit: limit + 1,
          offset,
          ...(spaceValue === null
            ? {}
            : { spaceId: spaceValue === "root" ? null : parseId("spc", spaceValue) }),
          ...(hasType ? { type } : {})
        });
        const page = pageWindow(notes.map(noteSummary), limit, offset, scope);
        return jsonResponse(page);
      });
    },

    createNote(request: Request) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(NoteCreateRequestSchema, body);
        const idempotencyKey = requireIdempotencyKey(request, body);
        const result = await repository.createNote(
          context,
          {
            bodyMarkdown: input.bodyMarkdown,
            links: input.links,
            privacy: input.privacy,
            spaceId: input.spaceId ?? null,
            tagIds: input.tagIds,
            title: input.title,
            type: input.type
          },
          idempotencyKey
        );
        return noteMutationResponse(result, 201);
      });
    },

    getNote(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const note = await repository.getNote(context, parseId("note", parameters.noteId));
        return jsonResponse({ note: canonicalNote(note) });
      });
    },

    updateNote(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(NoteUpdateRequestSchema, body);
        const update = {
          expectedRevision: input.expectedRevision,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.bodyMarkdown === undefined ? {} : { bodyMarkdown: input.bodyMarkdown }),
          ...(input.privacy === undefined ? {} : { privacy: input.privacy }),
          ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
          ...(input.tagIds === undefined ? {} : { tagIds: input.tagIds }),
          ...(input.links === undefined ? {} : { links: input.links })
        };
        const result = await repository.updateNote(
          context,
          parseId("note", parameters.noteId),
          update,
          requireIdempotencyKey(request, body)
        );
        return noteMutationResponse(result);
      });
    },

    deleteNote(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(NoteSoftDeleteRequestSchema, body);
        const result = await repository.deleteNote(context, parseId("note", parameters.noteId), {
          expectedRevision: input.expectedRevision,
          idempotencyKey: requireIdempotencyKey(request, body)
        });
        return noteMutationResponse(result);
      });
    },

    moveNote(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(NoteMoveRequestSchema, body);
        const result = await repository.moveNote(context, parseId("note", parameters.noteId), {
          expectedRevision: input.expectedRevision,
          idempotencyKey: requireIdempotencyKey(request, body),
          spaceId: input.spaceId
        });
        return noteMutationResponse(result);
      });
    },

    archiveNote(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(NoteArchiveRequestSchema, body);
        const result = await repository.archiveNote(context, parseId("note", parameters.noteId), {
          archived: input.archived,
          expectedRevision: input.expectedRevision,
          idempotencyKey: requireIdempotencyKey(request, body)
        });
        return noteMutationResponse(result);
      });
    },

    restoreDeletedNote(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(NoteRestoreDeletedRequestSchema, body);
        const result = await repository.restoreDeletedNote(
          context,
          parseId("note", parameters.noteId),
          {
            expectedRevision: input.expectedRevision,
            idempotencyKey: requireIdempotencyKey(request, body)
          }
        );
        return noteMutationResponse(result);
      });
    },

    applyOperations(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(InteractiveOperationsRequestSchema, body);
        const result = await repository.applyOperations(
          context,
          parseId("note", parameters.noteId),
          input.operations,
          {
            expectedRevision: input.expectedRevision,
            idempotencyKey: requireIdempotencyKey(request, body)
          }
        );
        return noteMutationResponse(result);
      });
    },

    listRevisions(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const url = new URL(request.url);
        const noteId = parseId("note", parameters.noteId);
        const limit = positiveLimit(url.searchParams.get("limit"));
        const scope = JSON.stringify({ noteId, route: "note-revisions" });
        const offset = cursorOffset(url.searchParams.get("cursor"), scope);
        const revisions = await repository.listRevisions(context, noteId, {
          limit: limit + 1,
          offset
        });
        return jsonResponse(pageWindow(revisions, limit, offset, scope));
      });
    },

    restoreRevision(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(NoteRestoreRequestSchema, body);
        const result = await repository.restoreRevision(
          context,
          parseId("note", parameters.noteId),
          input.revisionId,
          {
            expectedRevision: input.expectedRevision,
            idempotencyKey: requireIdempotencyKey(request, body)
          }
        );
        return noteMutationResponse(result);
      });
    },

    undoMutation(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(MutationUndoRequestSchema, body);
        const result = await repository.undoMutation(
          context,
          parseId("mut", parameters.mutationId),
          {
            expectedRevision: input.expectedRevision,
            idempotencyKey: requireIdempotencyKey(request, body)
          }
        );
        return noteMutationResponse(result);
      });
    },

    listSpaces(request: Request) {
      return run(request, async (repository, context) => {
        const url = new URL(request.url);
        const includeValue = url.searchParams.get("includeArchived");
        if (includeValue !== null && includeValue !== "true" && includeValue !== "false") {
          throw new HttpError(400, ApiErrorCode.VALIDATION_FAILED, "That filter is not valid.");
        }
        const includeArchived = includeValue === "true";
        const limit = positiveLimit(url.searchParams.get("limit"));
        const scope = JSON.stringify({ includeArchived, route: "spaces" });
        const offset = cursorOffset(url.searchParams.get("cursor"), scope);
        const spaces = await repository.listSpaces(context, includeArchived, {
          limit: limit + 1,
          offset
        });
        return jsonResponse(pageWindow(spaces.map(canonicalSpace), limit, offset, scope));
      });
    },

    createSpace(request: Request) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(SpaceCreateRequestSchema, body);
        const result = await repository.createSpace(
          context,
          {
            name: input.name,
            parentId: input.parentId,
            ...(input.sortKey === undefined ? {} : { sortKey: input.sortKey })
          },
          requireIdempotencyKey(request, body)
        );
        return jsonResponse(
          { space: canonicalSpace(result.space), replayed: result.replayed },
          201
        );
      });
    },

    getSpace(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const spaceId = parseId("spc", parameters.spaceId);
        const space = (await repository.listSpaces(context, true)).find(
          (candidate) => candidate.id === spaceId
        );
        if (space === undefined) {
          throw new HttpError(404, ApiErrorCode.NOT_FOUND, "That space was not found.");
        }
        return jsonResponse({ space: canonicalSpace(space) });
      });
    },

    updateSpace(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(SpaceUpdateRequestSchema, body);
        const patch = {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
          ...(input.sortKey === undefined ? {} : { sortKey: input.sortKey })
        };
        const result = await repository.updateSpace(
          context,
          parseId("spc", parameters.spaceId),
          patch,
          input.expectedRevision,
          requireIdempotencyKey(request, body)
        );
        return jsonResponse({
          space: canonicalSpace(result.space),
          replayed: result.replayed
        });
      });
    },

    archiveSpace(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(SpaceArchiveRequestSchema, body);
        const result = await repository.archiveSpace(
          context,
          parseId("spc", parameters.spaceId),
          input.archived,
          input.expectedRevision,
          requireIdempotencyKey(request, body)
        );
        return jsonResponse({
          space: canonicalSpace(result.space),
          replayed: result.replayed
        });
      });
    },

    listTags(request: Request) {
      return run(request, async (repository, context) => {
        const url = new URL(request.url);
        const limit = positiveLimit(url.searchParams.get("limit"));
        const scope = JSON.stringify({ route: "tags" });
        const offset = cursorOffset(url.searchParams.get("cursor"), scope);
        const tags = await repository.listTags(context, { limit: limit + 1, offset });
        return jsonResponse(pageWindow(tags, limit, offset, scope));
      });
    },

    createTag(request: Request) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(TagCreateRequestSchema, body);
        const result = await repository.createTag(
          context,
          input.name,
          requireIdempotencyKey(request, body)
        );
        return jsonResponse(result, 201);
      });
    },

    updateTag(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(TagUpdateRequestSchema, body);
        const result = await repository.updateTag(
          context,
          parseId("tag", parameters.tagId),
          input.name,
          input.expectedRevision,
          requireIdempotencyKey(request, body)
        );
        return jsonResponse(result);
      });
    },

    deleteTag(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(TagDeleteRequestSchema, body);
        const tagId = parseId("tag", parameters.tagId);
        const result = await repository.deleteTag(
          context,
          tagId,
          input.expectedRevision,
          requireIdempotencyKey(request, body)
        );
        return jsonResponse(result);
      });
    },

    listNoteLinks(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const items = await repository.listLinks(context, parseId("note", parameters.noteId));
        return jsonResponse({ items });
      });
    },

    createNoteLink(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(NoteLinkCreateRequestSchema, body);
        const result = await repository.createLink(context, parseId("note", parameters.noteId), {
          expectedRevision: input.expectedRevision,
          idempotencyKey: requireIdempotencyKey(request, body),
          linkType: input.linkType,
          toNoteId: input.toNoteId
        });
        return noteMutationResponse(result);
      });
    },

    deleteNoteLink(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(NoteLinkDeleteRequestSchema, body);
        const result = await repository.deleteLink(
          context,
          parseId("note", parameters.noteId),
          parseId("lnk", parameters.linkId),
          {
            expectedRevision: input.expectedRevision,
            idempotencyKey: requireIdempotencyKey(request, body),
            linkType: input.linkType,
            toNoteId: input.toNoteId
          }
        );
        return noteMutationResponse(result);
      });
    },

    linkTag(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(NoteTagLinkRequestSchema, body);
        const result = await repository.linkTag(
          context,
          parseId("note", parameters.noteId),
          input.tagId,
          {
            expectedRevision: input.expectedRevision,
            idempotencyKey: requireIdempotencyKey(request, body)
          }
        );
        return noteMutationResponse(result);
      });
    },

    unlinkTag(request: Request, parameters: RouteParameters) {
      return run(request, async (repository, context) => {
        const body = await readJsonObject(request);
        const input = parse(NoteTagUnlinkRequestSchema, body);
        const result = await repository.unlinkTag(
          context,
          parseId("note", parameters.noteId),
          parseId("tag", parameters.tagId),
          {
            expectedRevision: input.expectedRevision,
            idempotencyKey: requireIdempotencyKey(request, body)
          }
        );
        return noteMutationResponse(result);
      });
    },

    async listReviewItems(request: Request) {
      const response = await run(request, async (repository, context) => {
        const url = new URL(request.url);
        const input = parse(ReviewItemListQuerySchema, {
          ...(url.searchParams.has("state") ? { state: url.searchParams.get("state") } : {}),
          ...(url.searchParams.has("limit") ? { limit: url.searchParams.get("limit") } : {}),
          ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor") } : {})
        });
        const scope = JSON.stringify({ route: "review-items", state: input.state });
        const offset = cursorOffset(input.cursor ?? null, scope);
        const items = await repository.listReviewItems(context, input.state, {
          limit: input.limit + 1,
          offset
        });
        return jsonResponse(pageWindow(items, input.limit, offset, scope));
      });
      return privateOwnerContentResponse(response);
    },

    async search(request: Request) {
      const response = await run(request, async (repository, context) => {
        const input = await readPrivateSearchRequest(request);
        const space =
          input.spaceId === undefined
            ? ({ id: null, mode: "any" } as const)
            : input.spaceId === null
              ? ({ id: null, mode: "root" } as const)
              : ({ id: input.spaceId, mode: "exact" } as const);
        const sortedTagIds = Object.freeze([...(input.tagIds ?? [])].sort());
        const normalizedQuery = normalizePrivateRagText(input.query);
        const options = {
          archived: input.archive,
          ...(input.privacy === undefined ? {} : { privacy: input.privacy }),
          ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
          ...(sortedTagIds.length === 0 ? {} : { tagIds: sortedTagIds }),
          ...(input.type === undefined ? {} : { type: input.type }),
          ...(input.updatedFrom === undefined ? {} : { updatedFrom: input.updatedFrom }),
          ...(input.updatedTo === undefined ? {} : { updatedTo: input.updatedTo })
        };
        const scope: PrivateSearchCursorScope = {
          filters: {
            archive: input.archive,
            limit: input.limit,
            privacy: input.privacy ?? null,
            space,
            tagIds: sortedTagIds,
            type: input.type ?? null,
            updatedFrom: input.updatedFrom ?? null,
            updatedTo: input.updatedTo ?? null
          },
          ownerId: context.userId,
          query: normalizedQuery,
          rankingVersion: USER_HYBRID_SEARCH_RANKING_VERSION,
          requestVersion: ENCRYPTED_USER_SEARCH_REQUEST_VERSION
        };
        const admittedMaterial = encryptedUserSearchMaterialFromRequest({
          ...input,
          query: normalizedQuery
        });
        const cursorKey = privateSearchCursorKey(getPrivateSearchCursorKey());
        try {
          const continuation = privateSearchCursorContinuation(
            input.cursor ?? null,
            scope,
            cursorKey
          );
          const material =
            admittedMaterial === null || (continuation !== null && continuation.semantic === null)
              ? null
              : {
                  ...admittedMaterial,
                  continuation: continuation?.semantic ?? null
                };
          const lexicalOnly = () =>
            runHybridSearch({
              context,
              material: null,
              options,
              query: normalizedQuery,
              repository,
              signal: request.signal
            });
          let result = await runHybridSearch({
            context,
            material,
            options,
            query: normalizedQuery,
            repository,
            ...(semanticSearch === undefined
              ? {}
              : {
                  semantic: () => semanticSearch(context, request.signal)
                }),
            signal: request.signal
          });
          let pageContinuation = continuation;
          if (continuation !== null && material !== null) {
            if (result.semanticStatus === "fallback") {
              pageContinuation = null;
            } else if (
              continuation.semantic === null ||
              result.semanticContinuation === null ||
              !samePrivateSearchSemanticContinuation(
                continuation.semantic,
                result.semanticContinuation
              )
            ) {
              result = await lexicalOnly();
              pageContinuation = null;
            }
          }
          let page = privateSearchPageWindow(
            result.response.results,
            input.limit,
            pageContinuation,
            result.semanticContinuation,
            scope,
            cursorKey
          );
          if (page === null) {
            result = await lexicalOnly();
            page = privateSearchPageWindow(
              result.response.results,
              input.limit,
              null,
              null,
              scope,
              cursorKey
            );
          }
          if (page === null) throw new TypeError("invalid private search page");
          const items: SearchNoteResult[] = page.results.map(({ note, snippet }) => ({
            noteId: note.id,
            title: note.title,
            type: note.type,
            snippet,
            spacePath: note.spacePath?.split(" / ") ?? [],
            updatedAt: note.updatedAt,
            archivedAt: note.archivedAt
          }));
          return jsonResponse({ items, pageInfo: page.pageInfo });
        } finally {
          cursorKey.fill(0);
        }
      });
      return privateOwnerContentResponse(response);
    }
  });
}

export const manualNotesHandlers = createManualNotesHandlers({
  repository: createProductionRepository,
  semanticSearch: createProductionSemanticSearchCoordinator
});
