import { z, type ZodType } from "zod";

import {
  AuthOtpAcceptedResponseSchema,
  AuthOtpRequestSchema,
  AuthOtpVerifyRequestSchema,
  AuthRefreshRequestSchema,
  AuthSessionResponseSchema,
  AuthSessionSchema,
  AuthSignOutResponseSchema,
  AuthVerifyRequestSchema,
  AuthVerifyResponseSchema
} from "./auth.js";
import { ApiErrorSchema } from "./errors.js";
import { MutationResultSchema, MutationUndoRequestSchema } from "./mutations.js";
import {
  NoteArchiveRequestSchema,
  NoteCreateRequestSchema,
  NoteDetailResponseSchema,
  NoteListQuerySchema,
  NoteListResponseSchema,
  NoteMoveRequestSchema,
  NoteRestoreDeletedRequestSchema,
  NoteSoftDeleteRequestSchema,
  NoteUpdateRequestSchema
} from "./notes.js";
import { InteractiveOperationsRequestSchema } from "./operations.js";
import {
  NoteLinkCreateRequestSchema,
  NoteLinkDeleteRequestSchema,
  NoteLinkListResponseSchema,
  NoteRelationMutationResponseSchema,
  NoteTagLinkRequestSchema,
  NoteTagUnlinkRequestSchema
} from "./relations.js";
import {
  ListReviewItemsResponseSchema,
  ReviewItemDtoSchema,
  ReviewItemListQuerySchema
} from "./review.js";
import {
  NoteRestoreRequestSchema,
  NoteRevisionListQuerySchema,
  NoteRevisionListResponseSchema
} from "./revisions.js";
import { SearchNotesQuerySchema, SearchNotesResponseSchema } from "./search.js";
import {
  SpaceArchiveRequestSchema,
  SpaceCreateRequestSchema,
  SpaceDetailResponseSchema,
  SpaceListQuerySchema,
  SpaceListResponseSchema,
  SpaceMutationResultSchema,
  SpaceUpdateRequestSchema
} from "./spaces.js";
import {
  DeleteMutationResultSchema,
  TagCreateRequestSchema,
  TagDeleteRequestSchema,
  TagListQuerySchema,
  TagListResponseSchema,
  TagMutationResultSchema,
  TagUpdateRequestSchema
} from "./tags.js";

function openApiSchema(schema: ZodType): Record<string, unknown> {
  const { $schema: dialect, ...document } = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    unrepresentable: "any"
  });
  void dialect;
  return document;
}

function schemaRef(name: string) {
  return { $ref: `#/components/schemas/${name}` } as const;
}

function jsonBody(name: string) {
  return {
    required: true,
    content: { "application/json": { schema: schemaRef(name) } }
  } as const;
}

function jsonResponse(description: string, name: string) {
  return {
    description,
    content: { "application/json": { schema: schemaRef(name) } }
  } as const;
}

const errorResponse = jsonResponse("Stable API error", "ApiError");
const authenticated = [{ bearerAuth: [] }] as const;
const idempotencyHeader = {
  name: "Idempotency-Key",
  in: "header",
  required: true,
  description: "Caller-generated key that remains stable across retries.",
  schema: { type: "string", minLength: 1, maxLength: 80 }
} as const;

function pathId(name: string, pattern: string) {
  return {
    name,
    in: "path",
    required: true,
    schema: { type: "string", pattern }
  } as const;
}

const noteId = pathId("noteId", "^note_[0-9A-HJKMNP-TV-Z]{26}$");
const linkId = pathId("linkId", "^lnk_[0-9A-HJKMNP-TV-Z]{26}$");
const spaceId = pathId("spaceId", "^spc_[0-9A-HJKMNP-TV-Z]{26}$");
const tagId = pathId("tagId", "^tag_[0-9A-HJKMNP-TV-Z]{26}$");
const mutationId = pathId("mutationId", "^mut_[0-9A-HJKMNP-TV-Z]{26}$");

const cursorQuery = {
  name: "cursor",
  in: "query",
  required: false,
  schema: { type: "string", minLength: 1, maxLength: 512 }
} as const;
const limitQuery = {
  name: "limit",
  in: "query",
  required: false,
  schema: { type: "integer", minimum: 1, maximum: 100, default: 30 }
} as const;
const archiveQuery = {
  name: "archive",
  in: "query",
  required: false,
  schema: { type: "string", enum: ["exclude", "include", "only"], default: "exclude" }
} as const;
const deletedQuery = {
  name: "deleted",
  in: "query",
  required: false,
  schema: { type: "string", enum: ["exclude", "only"], default: "exclude" }
} as const;
const spaceFilterQuery = {
  name: "spaceId",
  in: "query",
  required: false,
  description: "A space identifier, or root for notes without a space.",
  schema: {
    oneOf: [
      { type: "string", pattern: "^spc_[0-9A-HJKMNP-TV-Z]{26}$" },
      { type: "string", const: "root" }
    ]
  }
} as const;
const noteTypeQuery = {
  name: "type",
  in: "query",
  required: false,
  schema: { type: "string", enum: ["generic", "list", "log", "principle", "project"] }
} as const;
const includeArchivedQuery = {
  name: "includeArchived",
  in: "query",
  required: false,
  schema: { type: "boolean", default: false }
} as const;
const searchTextQuery = {
  name: "q",
  in: "query",
  required: true,
  schema: { type: "string", minLength: 1, maxLength: 200 }
} as const;
const reviewStateQuery = {
  name: "state",
  in: "query",
  required: false,
  schema: {
    type: "string",
    enum: ["open", "resolved", "dismissed"],
    default: "open"
  }
} as const;

const commonErrors = {
  "400": errorResponse,
  "401": errorResponse,
  "404": errorResponse,
  "409": errorResponse
} as const;

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Unfiled API",
    version: "1.0.0",
    description: "Versioned API for authentication and manual note management."
  },
  servers: [{ url: "/api/v1" }],
  paths: {
    "/auth/otp": {
      post: {
        operationId: "requestOtp",
        summary: "Request a non-enumerating email OTP",
        requestBody: jsonBody("AuthOtpRequest"),
        responses: {
          "202": jsonResponse("OTP request accepted", "AuthOtpAcceptedResponse"),
          "400": errorResponse,
          "429": errorResponse
        }
      },
      put: {
        operationId: "verifyOtp",
        summary: "Verify a six-digit email OTP",
        requestBody: jsonBody("AuthOtpVerifyRequest"),
        responses: {
          "200": jsonResponse("Authenticated session", "AuthSession"),
          "400": errorResponse,
          "401": errorResponse,
          "429": errorResponse
        }
      }
    },
    "/auth/refresh": {
      post: {
        operationId: "refreshAuth",
        summary: "Exchange a durable refresh token for a current session",
        requestBody: jsonBody("AuthRefreshRequest"),
        responses: {
          "200": jsonResponse("Refreshed authenticated session", "AuthSession"),
          "400": errorResponse,
          "401": errorResponse,
          "429": errorResponse
        }
      }
    },
    "/auth/session": {
      get: {
        operationId: "getAuthSession",
        summary: "Read the authenticated user session",
        security: authenticated,
        responses: {
          "200": jsonResponse("Authenticated user", "AuthSessionResponse"),
          "401": errorResponse
        }
      }
    },
    "/auth/sign-out": {
      post: {
        operationId: "signOut",
        summary: "Revoke the current session and clear browser cookies",
        security: authenticated,
        responses: {
          "200": jsonResponse("Signed out", "AuthSignOutResponse"),
          "401": errorResponse
        }
      }
    },
    "/auth/verify": {
      put: {
        operationId: "verifyAuth",
        summary: "Verify a six-digit email OTP",
        requestBody: jsonBody("AuthVerifyRequest"),
        responses: {
          "200": jsonResponse("Authenticated session", "AuthVerifyResponse"),
          "400": errorResponse,
          "401": errorResponse,
          "429": errorResponse
        }
      }
    },
    "/notes": {
      get: {
        operationId: "listNotes",
        summary: "List notes with archive and deletion filters",
        security: authenticated,
        parameters: [
          archiveQuery,
          deletedQuery,
          limitQuery,
          cursorQuery,
          spaceFilterQuery,
          noteTypeQuery
        ],
        responses: {
          "200": jsonResponse("Paginated note summaries", "NoteListResponse"),
          ...commonErrors
        }
      },
      post: {
        operationId: "createNote",
        summary: "Create a manual note and initial revision",
        security: authenticated,
        parameters: [idempotencyHeader],
        requestBody: jsonBody("NoteCreateRequest"),
        responses: {
          "201": jsonResponse("Created note mutation", "MutationResult"),
          ...commonErrors
        }
      }
    },
    "/notes/{noteId}": {
      get: {
        operationId: "getNote",
        summary: "Get one note detail",
        security: authenticated,
        parameters: [noteId],
        responses: { "200": jsonResponse("Note detail", "NoteDetailResponse"), ...commonErrors }
      },
      patch: {
        operationId: "updateNote",
        summary: "Update editable note content",
        security: authenticated,
        parameters: [noteId, idempotencyHeader],
        requestBody: jsonBody("NoteUpdateRequest"),
        responses: {
          "200": jsonResponse("Updated note mutation", "MutationResult"),
          ...commonErrors
        }
      },
      delete: {
        operationId: "softDeleteNote",
        summary: "Soft-delete a note",
        security: authenticated,
        parameters: [noteId, idempotencyHeader],
        requestBody: jsonBody("NoteSoftDeleteRequest"),
        responses: {
          "200": jsonResponse("Deleted note mutation", "MutationResult"),
          ...commonErrors
        }
      }
    },
    "/notes/{noteId}/operations": {
      post: {
        operationId: "applyNoteOperations",
        summary: "Apply B-safe interactive checklist operations",
        security: authenticated,
        parameters: [noteId, idempotencyHeader],
        requestBody: jsonBody("InteractiveOperationsRequest"),
        responses: {
          "200": jsonResponse("Interactive note mutation", "MutationResult"),
          ...commonErrors
        }
      }
    },
    "/notes/{noteId}/links": {
      get: {
        operationId: "listNoteLinks",
        summary: "List outgoing note links",
        security: authenticated,
        parameters: [noteId],
        responses: {
          "200": jsonResponse("Outgoing note links", "NoteLinkListResponse"),
          ...commonErrors
        }
      },
      post: {
        operationId: "createNoteLink",
        summary: "Create a manual note link",
        security: authenticated,
        parameters: [noteId, idempotencyHeader],
        requestBody: jsonBody("NoteLinkCreateRequest"),
        responses: {
          "200": jsonResponse("Created note relation", "NoteRelationMutationResponse"),
          ...commonErrors
        }
      }
    },
    "/notes/{noteId}/links/{linkId}": {
      delete: {
        operationId: "deleteNoteLink",
        summary: "Delete a manual note link",
        security: authenticated,
        parameters: [noteId, linkId, idempotencyHeader],
        requestBody: jsonBody("NoteLinkDeleteRequest"),
        responses: {
          "200": jsonResponse("Deleted note relation", "NoteRelationMutationResponse"),
          ...commonErrors
        }
      }
    },
    "/notes/{noteId}/tags": {
      post: {
        operationId: "linkNoteTag",
        summary: "Associate an existing tag with a note",
        security: authenticated,
        parameters: [noteId, idempotencyHeader],
        requestBody: jsonBody("NoteTagLinkRequest"),
        responses: {
          "200": jsonResponse("Associated note tag", "NoteRelationMutationResponse"),
          ...commonErrors
        }
      }
    },
    "/notes/{noteId}/tags/{tagId}": {
      delete: {
        operationId: "unlinkNoteTag",
        summary: "Remove a tag association from a note",
        security: authenticated,
        parameters: [noteId, tagId, idempotencyHeader],
        requestBody: jsonBody("NoteTagUnlinkRequest"),
        responses: {
          "200": jsonResponse("Removed note tag", "NoteRelationMutationResponse"),
          ...commonErrors
        }
      }
    },
    "/notes/{noteId}/move": {
      post: {
        operationId: "moveNote",
        summary: "Move a note to a space or root",
        security: authenticated,
        parameters: [noteId, idempotencyHeader],
        requestBody: jsonBody("NoteMoveRequest"),
        responses: { "200": jsonResponse("Moved note mutation", "MutationResult"), ...commonErrors }
      }
    },
    "/notes/{noteId}/archive": {
      post: {
        operationId: "archiveNote",
        summary: "Archive or unarchive a note",
        security: authenticated,
        parameters: [noteId, idempotencyHeader],
        requestBody: jsonBody("NoteArchiveRequest"),
        responses: {
          "200": jsonResponse("Archived note mutation", "MutationResult"),
          ...commonErrors
        }
      }
    },
    "/notes/{noteId}/restore-deleted": {
      post: {
        operationId: "restoreDeletedNote",
        summary: "Restore a soft-deleted note",
        security: authenticated,
        parameters: [noteId, idempotencyHeader],
        requestBody: jsonBody("NoteRestoreDeletedRequest"),
        responses: {
          "200": jsonResponse("Restored note mutation", "MutationResult"),
          ...commonErrors
        }
      }
    },
    "/notes/{noteId}/revisions": {
      get: {
        operationId: "listNoteRevisions",
        summary: "List immutable note revisions",
        security: authenticated,
        parameters: [noteId, limitQuery, cursorQuery],
        responses: {
          "200": jsonResponse("Paginated revisions", "NoteRevisionListResponse"),
          ...commonErrors
        }
      }
    },
    "/notes/{noteId}/restore": {
      post: {
        operationId: "restoreNoteRevision",
        summary: "Restore a complete historical snapshot as a new revision",
        security: authenticated,
        parameters: [noteId, idempotencyHeader],
        requestBody: jsonBody("NoteRestoreRequest"),
        responses: {
          "200": jsonResponse("Revision restore mutation", "MutationResult"),
          ...commonErrors
        }
      }
    },
    "/spaces": {
      get: {
        operationId: "listSpaces",
        summary: "List spaces",
        security: authenticated,
        parameters: [limitQuery, cursorQuery, includeArchivedQuery],
        responses: { "200": jsonResponse("Paginated spaces", "SpaceListResponse"), ...commonErrors }
      },
      post: {
        operationId: "createSpace",
        summary: "Create a root or one-level child space",
        security: authenticated,
        parameters: [idempotencyHeader],
        requestBody: jsonBody("SpaceCreateRequest"),
        responses: { "201": jsonResponse("Created space", "SpaceMutationResult"), ...commonErrors }
      }
    },
    "/spaces/{spaceId}": {
      get: {
        operationId: "getSpace",
        summary: "Get one space",
        security: authenticated,
        parameters: [spaceId],
        responses: { "200": jsonResponse("Space detail", "SpaceDetailResponse"), ...commonErrors }
      },
      patch: {
        operationId: "updateSpace",
        summary: "Rename, reorder, or reparent a space",
        security: authenticated,
        parameters: [spaceId, idempotencyHeader],
        requestBody: jsonBody("SpaceUpdateRequest"),
        responses: { "200": jsonResponse("Updated space", "SpaceMutationResult"), ...commonErrors }
      }
    },
    "/spaces/{spaceId}/archive": {
      post: {
        operationId: "archiveSpace",
        summary: "Archive or unarchive a space",
        security: authenticated,
        parameters: [spaceId, idempotencyHeader],
        requestBody: jsonBody("SpaceArchiveRequest"),
        responses: { "200": jsonResponse("Archived space", "SpaceMutationResult"), ...commonErrors }
      }
    },
    "/tags": {
      get: {
        operationId: "listTags",
        summary: "List user tags",
        security: authenticated,
        parameters: [limitQuery, cursorQuery],
        responses: { "200": jsonResponse("Paginated tags", "TagListResponse"), ...commonErrors }
      },
      post: {
        operationId: "createTag",
        summary: "Create a normalized tag",
        security: authenticated,
        parameters: [idempotencyHeader],
        requestBody: jsonBody("TagCreateRequest"),
        responses: { "201": jsonResponse("Created tag", "TagMutationResult"), ...commonErrors }
      }
    },
    "/tags/{tagId}": {
      patch: {
        operationId: "updateTag",
        summary: "Rename a normalized tag",
        security: authenticated,
        parameters: [tagId, idempotencyHeader],
        requestBody: jsonBody("TagUpdateRequest"),
        responses: { "200": jsonResponse("Updated tag", "TagMutationResult"), ...commonErrors }
      },
      delete: {
        operationId: "deleteTag",
        summary: "Delete a tag",
        security: authenticated,
        parameters: [tagId, idempotencyHeader],
        requestBody: jsonBody("TagDeleteRequest"),
        responses: { "200": jsonResponse("Deleted tag", "DeleteMutationResult"), ...commonErrors }
      }
    },
    "/review-items": {
      get: {
        operationId: "listReviewItems",
        summary: "List owner-scoped Review items",
        security: authenticated,
        parameters: [reviewStateQuery, limitQuery, cursorQuery],
        responses: {
          "200": jsonResponse("Paginated Review items", "ListReviewItemsResponse"),
          ...commonErrors
        }
      }
    },
    "/mutations/{mutationId}/undo": {
      post: {
        operationId: "undoMutation",
        summary: "Undo the latest compatible mutation",
        security: authenticated,
        parameters: [mutationId, idempotencyHeader],
        requestBody: jsonBody("MutationUndoRequest"),
        responses: { "200": jsonResponse("Undo mutation", "MutationResult"), ...commonErrors }
      }
    },
    "/search": {
      get: {
        operationId: "searchNotes",
        summary: "Search title and body text",
        security: authenticated,
        parameters: [searchTextQuery, archiveQuery, limitQuery, cursorQuery],
        responses: {
          "200": jsonResponse("Paginated search results", "SearchNotesResponse"),
          ...commonErrors
        }
      }
    }
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" }
    },
    schemas: {
      ApiError: openApiSchema(ApiErrorSchema),
      AuthOtpRequest: openApiSchema(AuthOtpRequestSchema),
      AuthOtpAcceptedResponse: openApiSchema(AuthOtpAcceptedResponseSchema),
      AuthOtpVerifyRequest: openApiSchema(AuthOtpVerifyRequestSchema),
      AuthRefreshRequest: openApiSchema(AuthRefreshRequestSchema),
      AuthSession: openApiSchema(AuthSessionSchema),
      AuthSessionResponse: openApiSchema(AuthSessionResponseSchema),
      AuthSignOutResponse: openApiSchema(AuthSignOutResponseSchema),
      AuthVerifyRequest: openApiSchema(AuthVerifyRequestSchema),
      AuthVerifyResponse: openApiSchema(AuthVerifyResponseSchema),
      NoteCreateRequest: openApiSchema(NoteCreateRequestSchema),
      NoteListQuery: openApiSchema(NoteListQuerySchema),
      NoteUpdateRequest: openApiSchema(NoteUpdateRequestSchema),
      NoteMoveRequest: openApiSchema(NoteMoveRequestSchema),
      NoteArchiveRequest: openApiSchema(NoteArchiveRequestSchema),
      NoteSoftDeleteRequest: openApiSchema(NoteSoftDeleteRequestSchema),
      NoteRestoreDeletedRequest: openApiSchema(NoteRestoreDeletedRequestSchema),
      NoteDetailResponse: openApiSchema(NoteDetailResponseSchema),
      NoteListResponse: openApiSchema(NoteListResponseSchema),
      InteractiveOperationsRequest: openApiSchema(InteractiveOperationsRequestSchema),
      NoteLinkCreateRequest: openApiSchema(NoteLinkCreateRequestSchema),
      NoteLinkDeleteRequest: openApiSchema(NoteLinkDeleteRequestSchema),
      NoteLinkListResponse: openApiSchema(NoteLinkListResponseSchema),
      NoteTagLinkRequest: openApiSchema(NoteTagLinkRequestSchema),
      NoteTagUnlinkRequest: openApiSchema(NoteTagUnlinkRequestSchema),
      NoteRelationMutationResponse: openApiSchema(NoteRelationMutationResponseSchema),
      NoteRevisionListResponse: openApiSchema(NoteRevisionListResponseSchema),
      NoteRevisionListQuery: openApiSchema(NoteRevisionListQuerySchema),
      NoteRestoreRequest: openApiSchema(NoteRestoreRequestSchema),
      MutationResult: openApiSchema(MutationResultSchema),
      MutationUndoRequest: openApiSchema(MutationUndoRequestSchema),
      SpaceCreateRequest: openApiSchema(SpaceCreateRequestSchema),
      SpaceListQuery: openApiSchema(SpaceListQuerySchema),
      SpaceUpdateRequest: openApiSchema(SpaceUpdateRequestSchema),
      SpaceArchiveRequest: openApiSchema(SpaceArchiveRequestSchema),
      SpaceDetailResponse: openApiSchema(SpaceDetailResponseSchema),
      SpaceListResponse: openApiSchema(SpaceListResponseSchema),
      SpaceMutationResult: openApiSchema(SpaceMutationResultSchema),
      TagCreateRequest: openApiSchema(TagCreateRequestSchema),
      TagUpdateRequest: openApiSchema(TagUpdateRequestSchema),
      TagListQuery: openApiSchema(TagListQuerySchema),
      TagDeleteRequest: openApiSchema(TagDeleteRequestSchema),
      TagListResponse: openApiSchema(TagListResponseSchema),
      TagMutationResult: openApiSchema(TagMutationResultSchema),
      DeleteMutationResult: openApiSchema(DeleteMutationResultSchema),
      ReviewItemDto: openApiSchema(ReviewItemDtoSchema),
      ReviewItemListQuery: openApiSchema(ReviewItemListQuerySchema),
      ListReviewItemsResponse: openApiSchema(ListReviewItemsResponseSchema),
      SearchNotesQuery: openApiSchema(SearchNotesQuerySchema),
      SearchNotesResponse: openApiSchema(SearchNotesResponseSchema)
    }
  }
} as const;
