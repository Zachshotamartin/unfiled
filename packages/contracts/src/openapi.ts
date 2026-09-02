import { z, type ZodType } from "zod";

import {
  AccountDeleteRequestSchema,
  AccountDeletionReceiptSchema,
  AccountDeletionReceiptReplayRequestSchema,
  AccountExportManifestSchema,
  AccountExportNoteSchema,
  AccountExportRoutingRuleSchema,
  AccountExportSpaceSchema,
  AccountExportTagSchema
} from "./account.js";
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
import {
  CaptureCreateRequestSchema,
  CaptureCreateResponseSchema,
  CaptureContentRemovalMutationSchema,
  CaptureDeleteRequestSchema,
  CaptureDeleteResponseSchema,
  CaptureDetailResponseSchema,
  CaptureListQuerySchema,
  CaptureListResponseSchema,
  CaptureReceiptResponseSchema,
  CaptureReceiptSchema,
  CaptureRetryRequestSchema,
  CaptureRetryResponseSchema,
  CaptureSummarySchema
} from "./captures.js";
import {
  DecisionCorrectionRequestSchema,
  DecisionCorrectionResponseSchema
} from "./corrections.js";
import { ApiErrorSchema } from "./errors.js";
import {
  GeneratedBlockDetailResponseSchema,
  GeneratedBlockDtoSchema,
  GeneratedBlockListQuerySchema,
  GeneratedBlockListResponseSchema,
  GeneratedBlockResolveRequestSchema,
  GeneratedBlockResolveResponseSchema,
  VisibleGeneratedBlockDtoSchema
} from "./generated-blocks.js";
import {
  MutationBatchUndoMemberSchema,
  MutationBatchUndoResponseSchema,
  MutationResultSchema,
  MutationUndoRequestSchema
} from "./mutations.js";
import {
  NoteBacklinkDtoSchema,
  NoteBacklinksQuerySchema,
  NoteBacklinksResponseSchema,
  NoteSourceDtoSchema,
  NoteSourcesQuerySchema,
  NoteSourcesResponseSchema
} from "./note-context.js";
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
import { RoutingRuleMatchSnapshotSchema } from "./organization.js";
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
  ReviewItemListQuerySchema,
  ReviewProposalSchema,
  ReviewResolveRequestSchema,
  ReviewResolveResponseSchema,
  ReviewResolutionSchema
} from "./review.js";
import {
  NoteRestoreRequestSchema,
  NoteRevisionListQuerySchema,
  NoteRevisionListResponseSchema
} from "./revisions.js";
import { SearchNotesRequestSchema, SearchNotesResponseSchema } from "./search.js";
import {
  RoutingRuleCreateRequestSchema,
  RoutingRuleDeleteRequestSchema,
  RoutingRuleDeleteResponseSchema,
  RoutingRuleDtoSchema,
  RoutingRuleListQuerySchema,
  RoutingRuleListResponseSchema,
  RoutingRuleMutationResponseSchema,
  RoutingRuleUpdateRequestSchema
} from "./routing-rules.js";
import {
  ProviderKeyDeleteRequestSchema,
  ProviderKeyDeleteResponseSchema,
  ProviderKeyMetadataSchema,
  ProviderKeyPutRequestSchema,
  ProviderKeyPutResponseSchema,
  ProviderKeyResponseSchema,
  UserSettingsDtoSchema,
  UserSettingsResponseSchema,
  UserSettingsUpdateRequestSchema,
  UserSettingsUpdateResponseSchema
} from "./settings.js";
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

const canonicalRoutingRuleConditionDescription =
  "After NFKC normalization, Unicode lowercase, Unicode White_Space collapsing, trimming, and trailing Unicode punctuation removal, the condition must contain 1 to 500 UTF-16 code units.";

function describedProperty(
  schema: Record<string, unknown>,
  propertyName: string,
  description: string
): Record<string, unknown> {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const property = properties?.[propertyName];
  if (properties === undefined || property === undefined) return schema;
  return {
    ...schema,
    properties: {
      ...properties,
      [propertyName]: { ...property, description }
    }
  };
}

function routingRuleDtoOpenApiSchema(): Record<string, unknown> {
  return {
    ...describedProperty(
      openApiSchema(RoutingRuleDtoSchema),
      "condition",
      canonicalRoutingRuleConditionDescription
    ),
    allOf: [
      {
        if: { properties: { source: { const: "explicit" } }, required: ["source"] },
        then: { properties: { proposalState: { type: "null" } } }
      },
      {
        if: {
          properties: { source: { const: "correction_suggested" } },
          required: ["source"]
        },
        then: {
          properties: {
            proposalState: { type: "string", enum: ["offered", "accepted"] }
          }
        }
      },
      {
        if: { properties: { proposalState: { const: "offered" } }, required: ["proposalState"] },
        then: { properties: { enabled: { const: false } } }
      }
    ]
  };
}

function routingRuleUpdateOpenApiSchema(): Record<string, unknown> {
  return {
    ...describedProperty(
      openApiSchema(RoutingRuleUpdateRequestSchema),
      "condition",
      canonicalRoutingRuleConditionDescription
    ),
    anyOf: [
      { required: ["enabled"] },
      { required: ["ruleType"] },
      { required: ["condition"] },
      { required: ["destination"] },
      { required: ["priority"] }
    ]
  };
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

function privateJsonResponse(description: string, name: string) {
  return {
    ...jsonResponse(description, name),
    headers: {
      "Cache-Control": {
        description: "Prevents storage of owner-authorized private data.",
        required: true,
        schema: { type: "string", const: "private, no-store" }
      },
      Pragma: {
        description: "Prevents legacy intermediary caching.",
        required: true,
        schema: { type: "string", const: "no-cache" }
      }
    }
  } as const;
}

function privateArchiveResponse(description: string) {
  return {
    description,
    content: {
      "application/gzip": {
        schema: { type: "string", contentEncoding: "binary" }
      }
    },
    headers: {
      "Cache-Control": {
        description: "Prevents storage of the owner-authorized plaintext export.",
        required: true,
        schema: { type: "string", const: "private, no-store" }
      },
      "Content-Disposition": {
        description: "Attachment filename for the streamed tar.gz archive.",
        required: true,
        schema: { type: "string" }
      },
      Pragma: {
        description: "Prevents legacy intermediary caching.",
        required: true,
        schema: { type: "string", const: "no-cache" }
      }
    }
  } as const;
}

const errorResponse = jsonResponse("Stable API error", "ApiError");
const privateErrorResponse = privateJsonResponse("Stable API error", "ApiError");
const authenticated = [{ bearerAuth: [] }] as const;
const idempotencyHeader = {
  name: "Idempotency-Key",
  in: "header",
  required: true,
  description: "Caller-generated key that remains stable across retries.",
  schema: {
    type: "string",
    pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    minLength: 1,
    maxLength: 80
  }
} as const;
const captureIdempotencyHeader = {
  ...idempotencyHeader,
  description:
    "The clientCaptureId from the request body. It must remain byte-identical across retries.",
  schema: {
    type: "string",
    pattern: "^cap_[0-9A-HJKMNP-TV-Z]{26}$",
    minLength: 30,
    maxLength: 30
  }
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
const captureId = pathId("captureId", "^cap_[0-9A-HJKMNP-TV-Z]{26}$");
const decisionId = pathId("decisionId", "^dec_[0-9A-HJKMNP-TV-Z]{26}$");
const reviewItemId = pathId("reviewItemId", "^rvw_[0-9A-HJKMNP-TV-Z]{26}$");
const routingRuleId = pathId("routingRuleId", "^rule_[0-9A-HJKMNP-TV-Z]{26}$");
const generatedBlockId = pathId("blockId", "^blk_[0-9A-HJKMNP-TV-Z]{26}$");

const cursorQuery = {
  name: "cursor",
  in: "query",
  required: false,
  schema: { type: "string", minLength: 1, maxLength: 512 }
} as const;
const routingRuleCursorQuery = {
  name: "cursor",
  in: "query",
  required: false,
  description: "The last routing-rule ID returned by the previous fixed 50-item page.",
  schema: { type: "string", pattern: "^rule_[0-9A-HJKMNP-TV-Z]{26}$" }
} as const;
const generatedBlockCursorQuery = {
  name: "cursor",
  in: "query",
  required: false,
  description: "The last block ID returned by the previous fixed 50-item note page.",
  schema: { type: "string", pattern: "^blk_[0-9A-HJKMNP-TV-Z]{26}$" }
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
const captureStatusQuery = {
  name: "status",
  in: "query",
  required: false,
  schema: {
    type: "string",
    enum: ["queued", "processing", "done", "needs_review", "failed", "inbox"]
  }
} as const;
const captureFromQuery = {
  name: "from",
  in: "query",
  required: false,
  description: "Inclusive clientCreatedAt lower bound for the offline-safe capture timeline.",
  schema: { type: "string", format: "date-time" }
} as const;
const captureToQuery = {
  name: "to",
  in: "query",
  required: false,
  description: "Exclusive clientCreatedAt upper bound for the offline-safe capture timeline.",
  schema: { type: "string", format: "date-time" }
} as const;

const commonErrors = {
  "400": errorResponse,
  "401": errorResponse,
  "404": errorResponse,
  "409": errorResponse
} as const;

const privateCommonErrors = {
  "400": privateErrorResponse,
  "401": privateErrorResponse,
  "404": privateErrorResponse,
  "409": privateErrorResponse
} as const;

const privateRoutingRuleErrors = {
  ...privateCommonErrors,
  "403": privateErrorResponse,
  "413": privateErrorResponse,
  "429": privateErrorResponse,
  "500": privateErrorResponse,
  "503": privateErrorResponse
} as const;

const privateRoutingRuleListErrors = {
  "400": privateErrorResponse,
  "401": privateErrorResponse,
  "429": privateErrorResponse,
  "500": privateErrorResponse,
  "503": privateErrorResponse
} as const;

const privateGeneratedBlockReadErrors = {
  ...privateCommonErrors,
  "403": privateErrorResponse,
  "429": privateErrorResponse,
  "500": privateErrorResponse,
  "503": privateErrorResponse
} as const;

const privateGeneratedBlockResolveErrors = {
  ...privateGeneratedBlockReadErrors,
  "413": privateErrorResponse
} as const;

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Unfiled API",
    version: "1.0.0",
    description: "Versioned API for durable capture, authentication, and note management."
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
    "/captures": {
      get: {
        operationId: "listCaptures",
        summary: "List captures by processing state and original client time",
        description:
          "Orders by server receivedAt descending with capture ID as a stable tie-breaker. Date filters apply to clientCreatedAt as a half-open [from, to) interval.",
        security: authenticated,
        parameters: [captureStatusQuery, limitQuery, cursorQuery, captureFromQuery, captureToQuery],
        responses: {
          "200": jsonResponse("Paginated capture summaries", "CaptureListResponse"),
          ...commonErrors
        }
      },
      post: {
        operationId: "createCapture",
        summary: "Durably create a capture and its organization job",
        security: authenticated,
        parameters: [captureIdempotencyHeader],
        requestBody: jsonBody("CaptureCreateRequest"),
        responses: {
          "202": jsonResponse("Durable capture accepted", "CaptureCreateResponse"),
          ...commonErrors
        }
      }
    },
    "/captures/{captureId}": {
      get: {
        operationId: "getCapture",
        summary: "Get one capture with its durable receipt when available",
        security: authenticated,
        parameters: [captureId],
        responses: {
          "200": jsonResponse("Capture detail", "CaptureDetailResponse"),
          ...commonErrors
        }
      },
      delete: {
        operationId: "deleteCapture",
        summary: "Remove a capture source and optionally its inserted note content",
        security: authenticated,
        parameters: [captureId, idempotencyHeader],
        requestBody: jsonBody("CaptureDeleteRequest"),
        responses: {
          "200": jsonResponse("Capture deletion result", "CaptureDeleteResponse"),
          ...commonErrors
        }
      }
    },
    "/captures/{captureId}/receipt": {
      get: {
        operationId: "getCaptureReceipt",
        summary: "Get the durable organization receipt for one capture",
        security: authenticated,
        parameters: [captureId],
        responses: {
          "200": jsonResponse("Capture organization receipt", "CaptureReceiptResponse"),
          ...commonErrors
        }
      }
    },
    "/captures/{captureId}/retry": {
      post: {
        operationId: "retryCapture",
        summary: "Retry a safely retryable capture organization job",
        security: authenticated,
        parameters: [captureId, idempotencyHeader],
        requestBody: jsonBody("CaptureRetryRequest"),
        responses: {
          "202": jsonResponse("Capture retry accepted", "CaptureRetryResponse"),
          ...commonErrors
        }
      }
    },
    "/decisions/{decisionId}/correct": {
      post: {
        operationId: "correctDecision",
        summary: "Atomically move a routed capture to a corrected destination",
        security: authenticated,
        parameters: [decisionId, idempotencyHeader],
        requestBody: jsonBody("DecisionCorrectionRequest"),
        responses: {
          "200": privateJsonResponse(
            "Applied decision correction or queued exact-inverse review",
            "DecisionCorrectionResponse"
          ),
          ...privateCommonErrors
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
    "/notes/{noteId}/sources": {
      get: {
        operationId: "listNoteSources",
        summary: "List captures that contributed content to a note",
        security: authenticated,
        parameters: [noteId, limitQuery, cursorQuery],
        responses: {
          "200": privateJsonResponse("Paginated note sources", "NoteSourcesResponse"),
          ...commonErrors
        }
      }
    },
    "/notes/{noteId}/backlinks": {
      get: {
        operationId: "listNoteBacklinks",
        summary: "List notes that link to this note",
        security: authenticated,
        parameters: [noteId, limitQuery, cursorQuery],
        responses: {
          "200": privateJsonResponse("Paginated note backlinks", "NoteBacklinksResponse"),
          ...commonErrors
        }
      }
    },
    "/notes/{noteId}/generated-blocks": {
      get: {
        operationId: "listGeneratedBlocks",
        summary: "List AI-generated blocks for a note",
        security: authenticated,
        parameters: [noteId, generatedBlockCursorQuery],
        responses: {
          "200": privateJsonResponse(
            "AI-generated blocks for the note",
            "GeneratedBlockListResponse"
          ),
          ...privateGeneratedBlockReadErrors
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
          "200": privateJsonResponse("Paginated Review items", "ListReviewItemsResponse"),
          ...privateCommonErrors
        }
      }
    },
    "/review-items/{reviewItemId}/resolve": {
      post: {
        operationId: "resolveReviewItem",
        summary: "Resolve one Review item with a typed action",
        security: authenticated,
        parameters: [reviewItemId, idempotencyHeader],
        requestBody: jsonBody("ReviewResolveRequest"),
        responses: {
          "200": privateJsonResponse("Resolved Review item", "ReviewResolveResponse"),
          ...privateCommonErrors
        }
      }
    },
    "/generated-blocks/{blockId}/resolve": {
      post: {
        operationId: "resolveGeneratedBlock",
        summary: "Accept or reject an AI-generated block",
        security: authenticated,
        parameters: [generatedBlockId, idempotencyHeader],
        requestBody: jsonBody("GeneratedBlockResolveRequest"),
        responses: {
          "200": privateJsonResponse(
            "Resolved AI-generated block",
            "GeneratedBlockResolveResponse"
          ),
          ...privateGeneratedBlockResolveErrors
        }
      }
    },
    "/generated-blocks/{blockId}": {
      get: {
        operationId: "getGeneratedBlock",
        summary: "Get one owner-scoped AI-generated block",
        security: authenticated,
        parameters: [generatedBlockId],
        responses: {
          "200": privateJsonResponse("AI-generated block", "GeneratedBlockDetailResponse"),
          ...privateGeneratedBlockReadErrors
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
    "/mutation-batches/{mutationId}/undo": {
      post: {
        operationId: "undoMutationBatch",
        summary: "Undo one atomic multi-note mutation batch",
        security: authenticated,
        parameters: [mutationId, idempotencyHeader],
        requestBody: jsonBody("MutationUndoRequest"),
        responses: {
          "200": privateJsonResponse("Undo mutation batch", "MutationBatchUndoResponse"),
          ...privateCommonErrors
        }
      }
    },
    "/routing-rules": {
      get: {
        operationId: "listRoutingRules",
        summary: "List visible explicit, offered, and accepted personal routing rules",
        description:
          "Returns a fixed page of at most 50 rules and at most 8 MiB. Follow pageInfo.nextCursor until hasMore is false.",
        security: authenticated,
        parameters: [routingRuleCursorQuery],
        responses: {
          "200": privateJsonResponse("Personal routing rules", "RoutingRuleListResponse"),
          ...privateRoutingRuleListErrors
        }
      },
      post: {
        operationId: "createRoutingRule",
        summary: "Create an explicit personal routing rule",
        security: authenticated,
        parameters: [idempotencyHeader],
        requestBody: jsonBody("RoutingRuleCreateRequest"),
        responses: {
          "201": privateJsonResponse("Created routing rule", "RoutingRuleMutationResponse"),
          ...privateRoutingRuleErrors
        }
      }
    },
    "/routing-rules/{routingRuleId}": {
      patch: {
        operationId: "updateRoutingRule",
        summary: "Update a personal routing rule or confirm an offered learned rule",
        security: authenticated,
        parameters: [routingRuleId, idempotencyHeader],
        requestBody: jsonBody("RoutingRuleUpdateRequest"),
        responses: {
          "200": privateJsonResponse("Updated routing rule", "RoutingRuleMutationResponse"),
          ...privateRoutingRuleErrors
        }
      },
      delete: {
        operationId: "deleteRoutingRule",
        summary: "Delete a personal routing rule or decline an offered learned rule",
        security: authenticated,
        parameters: [routingRuleId, idempotencyHeader],
        requestBody: jsonBody("RoutingRuleDeleteRequest"),
        responses: {
          "200": privateJsonResponse("Deleted routing rule", "RoutingRuleDeleteResponse"),
          ...privateRoutingRuleErrors
        }
      }
    },
    "/search": {
      post: {
        operationId: "searchNotes",
        summary: "Search title and body text",
        security: authenticated,
        requestBody: jsonBody("SearchNotesRequest"),
        responses: {
          "200": privateJsonResponse("Paginated search results", "SearchNotesResponse"),
          "400": privateJsonResponse("Stable API error", "ApiError"),
          "401": privateJsonResponse("Stable API error", "ApiError"),
          "429": privateJsonResponse("Stable API error", "ApiError"),
          "413": privateJsonResponse("Stable API error", "ApiError")
        }
      }
    },
    "/me/export": {
      get: {
        operationId: "exportAccountData",
        summary: "Stream an owner-authorized Markdown and JSON account export",
        security: authenticated,
        responses: {
          "200": privateArchiveResponse("Streamed tar.gz account export"),
          "401": privateJsonResponse("Stable API error", "ApiError"),
          "503": privateJsonResponse("Stable API error", "ApiError")
        }
      }
    },
    "/me/settings": {
      get: {
        operationId: "getUserSettings",
        summary: "Read organization and AI settings",
        security: authenticated,
        responses: {
          "200": jsonResponse("Current user settings", "UserSettingsResponse"),
          ...commonErrors
        }
      },
      patch: {
        operationId: "updateUserSettings",
        summary: "Update organization and AI settings",
        security: authenticated,
        parameters: [idempotencyHeader],
        requestBody: jsonBody("UserSettingsUpdateRequest"),
        responses: {
          "200": jsonResponse("Updated user settings", "UserSettingsUpdateResponse"),
          ...commonErrors
        }
      }
    },
    "/me/provider-key": {
      get: {
        operationId: "getProviderKeyMetadata",
        summary: "Read provider-key metadata without exposing key material",
        security: authenticated,
        responses: {
          "200": privateJsonResponse("Provider-key metadata", "ProviderKeyResponse"),
          ...commonErrors
        }
      },
      put: {
        operationId: "putProviderKey",
        summary: "Validate and securely store a provider key",
        security: authenticated,
        parameters: [idempotencyHeader],
        requestBody: jsonBody("ProviderKeyPutRequest"),
        responses: {
          "200": privateJsonResponse("Stored provider-key metadata", "ProviderKeyPutResponse"),
          ...commonErrors
        }
      },
      delete: {
        operationId: "deleteProviderKey",
        summary: "Revoke and destroy a stored provider key",
        security: authenticated,
        parameters: [idempotencyHeader],
        requestBody: jsonBody("ProviderKeyDeleteRequest"),
        responses: {
          "200": privateJsonResponse("Deleted provider key", "ProviderKeyDeleteResponse"),
          ...commonErrors
        }
      }
    },
    "/me": {
      delete: {
        operationId: "deleteAccount",
        summary: "Delete live account data and revoke every session",
        description:
          "Deletes live data immediately. Encrypted copies in provider backups may remain until the stated 30-day backup window expires.",
        security: authenticated,
        requestBody: jsonBody("AccountDeleteRequest"),
        responses: {
          "200": privateJsonResponse(
            "Content-free account deletion receipt",
            "AccountDeletionReceipt"
          ),
          "400": privateJsonResponse("Stable API error", "ApiError"),
          "401": privateJsonResponse("Stable API error", "ApiError"),
          "429": privateJsonResponse("Stable API error", "ApiError"),
          "409": privateJsonResponse("Stable API error", "ApiError"),
          "503": privateJsonResponse("Stable API error", "ApiError")
        }
      }
    },
    "/me/deletion-receipt": {
      post: {
        operationId: "replayAccountDeletionReceipt",
        summary: "Recover a content-free account deletion receipt after response loss",
        description:
          "Uses the original high-entropy deletion capability after the auth principal no longer exists. Missing and expired capabilities are indistinguishable.",
        security: [],
        requestBody: jsonBody("AccountDeletionReceiptReplayRequest"),
        responses: {
          "200": privateJsonResponse(
            "Content-free account deletion receipt",
            "AccountDeletionReceipt"
          ),
          "400": privateJsonResponse("Stable API error", "ApiError"),
          "404": privateJsonResponse("Stable API error", "ApiError"),
          "429": privateJsonResponse("Stable API error", "ApiError"),
          "503": privateJsonResponse("Stable API error", "ApiError")
        }
      }
    }
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" }
    },
    schemas: {
      AccountDeleteRequest: openApiSchema(AccountDeleteRequestSchema),
      AccountDeletionReceipt: openApiSchema(AccountDeletionReceiptSchema),
      AccountDeletionReceiptReplayRequest: openApiSchema(AccountDeletionReceiptReplayRequestSchema),
      AccountExportManifest: openApiSchema(AccountExportManifestSchema),
      AccountExportNote: openApiSchema(AccountExportNoteSchema),
      AccountExportRoutingRule: openApiSchema(AccountExportRoutingRuleSchema),
      AccountExportSpace: openApiSchema(AccountExportSpaceSchema),
      AccountExportTag: openApiSchema(AccountExportTagSchema),
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
      CaptureCreateRequest: openApiSchema(CaptureCreateRequestSchema),
      CaptureCreateResponse: openApiSchema(CaptureCreateResponseSchema),
      CaptureContentRemovalMutation: openApiSchema(CaptureContentRemovalMutationSchema),
      CaptureSummary: openApiSchema(CaptureSummarySchema),
      CaptureListQuery: openApiSchema(CaptureListQuerySchema),
      CaptureListResponse: openApiSchema(CaptureListResponseSchema),
      CaptureDetailResponse: openApiSchema(CaptureDetailResponseSchema),
      CaptureReceipt: openApiSchema(CaptureReceiptSchema),
      CaptureReceiptResponse: openApiSchema(CaptureReceiptResponseSchema),
      CaptureRetryRequest: openApiSchema(CaptureRetryRequestSchema),
      CaptureRetryResponse: openApiSchema(CaptureRetryResponseSchema),
      CaptureDeleteRequest: openApiSchema(CaptureDeleteRequestSchema),
      CaptureDeleteResponse: openApiSchema(CaptureDeleteResponseSchema),
      DecisionCorrectionRequest: openApiSchema(DecisionCorrectionRequestSchema),
      DecisionCorrectionResponse: openApiSchema(DecisionCorrectionResponseSchema),
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
      NoteSourcesQuery: openApiSchema(NoteSourcesQuerySchema),
      NoteSourceDto: openApiSchema(NoteSourceDtoSchema),
      NoteSourcesResponse: openApiSchema(NoteSourcesResponseSchema),
      NoteBacklinksQuery: openApiSchema(NoteBacklinksQuerySchema),
      NoteBacklinkDto: openApiSchema(NoteBacklinkDtoSchema),
      NoteBacklinksResponse: openApiSchema(NoteBacklinksResponseSchema),
      NoteRevisionListResponse: openApiSchema(NoteRevisionListResponseSchema),
      NoteRevisionListQuery: openApiSchema(NoteRevisionListQuerySchema),
      NoteRestoreRequest: openApiSchema(NoteRestoreRequestSchema),
      MutationBatchUndoMember: openApiSchema(MutationBatchUndoMemberSchema),
      MutationBatchUndoResponse: openApiSchema(MutationBatchUndoResponseSchema),
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
      ReviewProposal: openApiSchema(ReviewProposalSchema),
      ReviewResolution: openApiSchema(ReviewResolutionSchema),
      ReviewItemListQuery: openApiSchema(ReviewItemListQuerySchema),
      ListReviewItemsResponse: openApiSchema(ListReviewItemsResponseSchema),
      ReviewResolveRequest: openApiSchema(ReviewResolveRequestSchema),
      ReviewResolveResponse: openApiSchema(ReviewResolveResponseSchema),
      RoutingRuleDto: routingRuleDtoOpenApiSchema(),
      RoutingRuleListQuery: openApiSchema(RoutingRuleListQuerySchema),
      RoutingRuleListResponse: openApiSchema(RoutingRuleListResponseSchema),
      RoutingRuleCreateRequest: describedProperty(
        openApiSchema(RoutingRuleCreateRequestSchema),
        "condition",
        canonicalRoutingRuleConditionDescription
      ),
      RoutingRuleUpdateRequest: routingRuleUpdateOpenApiSchema(),
      RoutingRuleDeleteRequest: openApiSchema(RoutingRuleDeleteRequestSchema),
      RoutingRuleMutationResponse: openApiSchema(RoutingRuleMutationResponseSchema),
      RoutingRuleDeleteResponse: openApiSchema(RoutingRuleDeleteResponseSchema),
      RoutingRuleMatchSnapshot: openApiSchema(RoutingRuleMatchSnapshotSchema),
      GeneratedBlockDto: openApiSchema(GeneratedBlockDtoSchema),
      VisibleGeneratedBlockDto: openApiSchema(VisibleGeneratedBlockDtoSchema),
      GeneratedBlockListQuery: openApiSchema(GeneratedBlockListQuerySchema),
      GeneratedBlockListResponse: openApiSchema(GeneratedBlockListResponseSchema),
      GeneratedBlockDetailResponse: openApiSchema(GeneratedBlockDetailResponseSchema),
      GeneratedBlockResolveRequest: openApiSchema(GeneratedBlockResolveRequestSchema),
      GeneratedBlockResolveResponse: openApiSchema(GeneratedBlockResolveResponseSchema),
      UserSettingsDto: openApiSchema(UserSettingsDtoSchema),
      UserSettingsResponse: openApiSchema(UserSettingsResponseSchema),
      UserSettingsUpdateRequest: openApiSchema(UserSettingsUpdateRequestSchema),
      UserSettingsUpdateResponse: openApiSchema(UserSettingsUpdateResponseSchema),
      ProviderKeyMetadata: openApiSchema(ProviderKeyMetadataSchema),
      ProviderKeyResponse: openApiSchema(ProviderKeyResponseSchema),
      ProviderKeyPutRequest: openApiSchema(ProviderKeyPutRequestSchema),
      ProviderKeyPutResponse: openApiSchema(ProviderKeyPutResponseSchema),
      ProviderKeyDeleteRequest: openApiSchema(ProviderKeyDeleteRequestSchema),
      ProviderKeyDeleteResponse: openApiSchema(ProviderKeyDeleteResponseSchema),
      SearchNotesRequest: openApiSchema(SearchNotesRequestSchema),
      SearchNotesResponse: openApiSchema(SearchNotesResponseSchema)
    }
  }
} as const;
