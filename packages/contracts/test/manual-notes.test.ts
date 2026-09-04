import { describe, expect, it } from "vitest";

import {
  AuthSessionResponseSchema,
  AuthSignOutResponseSchema,
  AuthPasswordSignInRequestSchema,
  AuthPasswordSignUpRequestSchema,
  AuthRefreshRequestSchema,
  captureAttachmentReference,
  createEntityId,
  IdempotencyKeySchema,
  InteractiveOperationsRequestSchema,
  ListReviewItemsResponseSchema,
  ModelOperationSchema,
  MutationResultSchema,
  NoteArchiveRequestSchema,
  NoteCreateRequestSchema,
  NoteDetailResponseSchema,
  NoteLinkSchema,
  NoteLinkCreateRequestSchema,
  NoteLinkDeleteRequestSchema,
  NoteLinkListResponseSchema,
  NoteTagLinkRequestSchema,
  NoteTagUnlinkRequestSchema,
  NoteListQuerySchema,
  NoteListResponseSchema,
  NoteMoveRequestSchema,
  NoteRestoreDeletedRequestSchema,
  NoteRestoreRequestSchema,
  NoteRevisionListResponseSchema,
  NoteSoftDeleteRequestSchema,
  NoteSummarySchema,
  NoteUpdateRequestSchema,
  ReviewItemDtoSchema,
  ReviewItemListQuerySchema,
  LogEntrySchema,
  SearchNotesRequestSchema,
  SearchNotesResponseSchema,
  SpaceArchiveRequestSchema,
  SpaceCreateRequestSchema,
  SpaceListQuerySchema,
  SpaceListResponseSchema,
  SpaceUpdateRequestSchema,
  TagCreateRequestSchema,
  TagDeleteRequestSchema,
  TagUpdateRequestSchema,
  UserOperationSchema,
  manualNoteFixtures,
  openApiDocument,
  paginatedResponseSchema
} from "../src/index.js";

const idempotencyKey = "manual-note-write-01J6M9Q7";

describe("Milestone B manual-note contracts", () => {
  it("normalizes email and bounds passwords for sign-up and sign-in", () => {
    expect(
      AuthPasswordSignUpRequestSchema.parse({
        email: "  PERSON@Example.COM ",
        password: "correct horse"
      })
    ).toEqual({ email: "person@example.com", password: "correct horse" });
    expect(
      AuthPasswordSignInRequestSchema.safeParse({ email: "person@example.com", password: "short" })
        .success
    ).toBe(false);
    expect(
      AuthPasswordSignInRequestSchema.safeParse({
        email: "person@example.com",
        password: "x".repeat(73)
      }).success
    ).toBe(false);
    expect(
      AuthPasswordSignUpRequestSchema.safeParse({ email: "not-email", password: "correct horse" })
        .success
    ).toBe(false);
    expect(
      AuthPasswordSignUpRequestSchema.safeParse({
        email: "person@example.com",
        password: "correct horse",
        extra: true
      }).success
    ).toBe(false);
    expect(AuthRefreshRequestSchema.parse({ refreshToken: "restart-safe-token" })).toEqual({
      refreshToken: "restart-safe-token"
    });
    expect(AuthRefreshRequestSchema.safeParse({ refreshToken: "" }).success).toBe(false);
    expect(AuthSessionResponseSchema.parse({ user: manualNoteFixtures.authSession.user })).toEqual({
      user: manualNoteFixtures.authSession.user
    });
    expect(AuthSignOutResponseSchema.parse({ signedOut: true })).toEqual({ signedOut: true });
  });

  it("keeps idempotency keys bounded, portable, and nonblank", () => {
    expect(IdempotencyKeySchema.parse(idempotencyKey)).toBe(idempotencyKey);
    for (const invalid of ["", " with-space", "x".repeat(81), "line\nbreak"]) {
      expect(IdempotencyKeySchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("validates create and every existing-note write precondition", () => {
    expect(
      NoteCreateRequestSchema.parse({
        idempotencyKey,
        title: " Shopping ",
        type: "list",
        tagIds: ["tag_01J6M9Q7G4BMKB33GSG3NJ6D1X"],
        links: [
          {
            toNoteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
            linkType: "related"
          }
        ]
      })
    ).toMatchObject({
      title: "Shopping",
      privacy: "ai_assisted",
      bodyMarkdown: "",
      tagIds: ["tag_01J6M9Q7G4BMKB33GSG3NJ6D1X"]
    });

    const expectedWrite = { expectedRevision: 3, idempotencyKey };
    expect(
      NoteUpdateRequestSchema.safeParse({
        ...expectedWrite,
        title: "Groceries",
        spaceId: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X",
        tagIds: [],
        links: []
      }).success
    ).toBe(true);
    expect(NoteMoveRequestSchema.safeParse({ ...expectedWrite, spaceId: null }).success).toBe(true);
    expect(NoteArchiveRequestSchema.safeParse(expectedWrite).success).toBe(true);
    expect(NoteSoftDeleteRequestSchema.safeParse(expectedWrite).success).toBe(true);
    expect(NoteRestoreDeletedRequestSchema.safeParse(expectedWrite).success).toBe(true);
    expect(
      NoteRestoreRequestSchema.safeParse({
        ...expectedWrite,
        revisionId: "rev_01J6M9Q7G4BMKB33GSG3NJ6D1X"
      }).success
    ).toBe(true);

    for (const schema of [
      NoteUpdateRequestSchema,
      NoteMoveRequestSchema,
      NoteArchiveRequestSchema,
      NoteSoftDeleteRequestSchema,
      NoteRestoreDeletedRequestSchema,
      NoteRestoreRequestSchema
    ]) {
      expect(schema.safeParse({ idempotencyKey }).success).toBe(false);
      expect(schema.safeParse({ expectedRevision: 1 }).success).toBe(false);
    }
  });

  it("exports strict shared note summary/detail and page view models", () => {
    const { note, summary, revision } = manualNoteFixtures;
    expect(NoteSummarySchema.parse(summary)).toEqual(summary);
    expect(NoteDetailResponseSchema.parse({ note })).toEqual({ note });
    expect(
      NoteListResponseSchema.parse({
        items: [summary],
        pageInfo: { hasMore: false, nextCursor: null }
      })
    ).toHaveProperty("items.0.type", "list");
    expect(
      NoteRevisionListResponseSchema.parse({
        items: [revision],
        pageInfo: { hasMore: false, nextCursor: null }
      })
    ).toHaveProperty("items.0.revision", 1);
    expect(NoteDetailResponseSchema.safeParse({ note, unexpected: true }).success).toBe(false);
  });

  it("returns the photos a note places and refuses a list that drifts from its body", () => {
    const { note } = manualNoteFixtures;
    const photo = createEntityId("att");
    const recording = createEntityId("att");
    const bodyMarkdown = [
      "- [ ] milk",
      "",
      captureAttachmentReference({ id: photo, kind: "image" }),
      "",
      captureAttachmentReference({ id: recording, kind: "audio" })
    ].join("\n");
    const placed = [
      { id: photo, kind: "image" },
      { id: recording, kind: "audio" }
    ];
    expect(
      NoteDetailResponseSchema.parse({ note: { ...note, bodyMarkdown, attachments: placed } }).note
        .attachments
    ).toEqual(placed);
    // The array is a projection of the body, so a client can render from it without parsing and
    // without the two ever disagreeing about what the note holds.
    expect(
      NoteDetailResponseSchema.safeParse({ note: { ...note, bodyMarkdown, attachments: [] } })
        .success
    ).toBe(false);
    expect(
      NoteDetailResponseSchema.safeParse({
        note: { ...note, bodyMarkdown, attachments: [...placed].reverse() }
      }).success
    ).toBe(false);
    expect(
      NoteDetailResponseSchema.safeParse({
        note: { ...note, bodyMarkdown, attachments: [{ id: photo, kind: "audio" }, placed[1]] }
      }).success
    ).toBe(false);
    expect(
      MutationResultSchema.safeParse({
        note: { ...note, bodyMarkdown, attachments: [] },
        revision: manualNoteFixtures.revision,
        mutationId: manualNoteFixtures.mutationResult.mutationId,
        replayed: false,
        undo: { eligible: true, expiresAt: null }
      }).success
    ).toBe(false);
  });

  it("supports archived/deleted filters without exposing deleted notes by default", () => {
    expect(NoteListQuerySchema.parse({})).toMatchObject({
      archive: "exclude",
      deleted: "exclude",
      limit: 30
    });
    expect(
      NoteListQuerySchema.parse({ archive: "only", deleted: "only", limit: 100 })
    ).toMatchObject({
      archive: "only",
      deleted: "only",
      limit: 100
    });
    expect(NoteListQuerySchema.parse({ spaceId: "root" }).spaceId).toBeNull();
    expect(NoteListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it("validates spaces, tags, and note links with strict identifiers", () => {
    expect(
      SpaceCreateRequestSchema.parse({ idempotencyKey, name: " Work ", parentId: null })
    ).toMatchObject({ name: "Work", parentId: null });
    expect(TagCreateRequestSchema.parse({ idempotencyKey, name: " Fitness " })).toMatchObject({
      name: "fitness"
    });
    expect(
      NoteLinkSchema.safeParse({
        id: "lnk_01J6M9Q7G4BMKB33GSG3NJ6D1X",
        fromNoteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X",
        toNoteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
        linkType: "related",
        targetTitle: "Linked note"
      }).success
    ).toBe(true);
    expect(
      SpaceListResponseSchema.safeParse({
        items: [manualNoteFixtures.space],
        pageInfo: { hasMore: false, nextCursor: null }
      }).success
    ).toBe(true);
    expect(SpaceUpdateRequestSchema.safeParse({ idempotencyKey }).success).toBe(false);
    expect(
      SpaceUpdateRequestSchema.safeParse({ expectedRevision: 1, idempotencyKey, parentId: null })
        .success
    ).toBe(true);
    expect(SpaceUpdateRequestSchema.safeParse({ idempotencyKey, parentId: null }).success).toBe(
      false
    );
    expect(
      SpaceArchiveRequestSchema.safeParse({
        archived: true,
        expectedRevision: 1,
        idempotencyKey
      }).success
    ).toBe(true);
    expect(TagDeleteRequestSchema.safeParse({ expectedRevision: 1, idempotencyKey }).success).toBe(
      true
    );
    expect(
      TagUpdateRequestSchema.parse({
        expectedRevision: 1,
        idempotencyKey,
        name: " Fitness "
      })
    ).toMatchObject({ name: "fitness" });
    const link = {
      expectedRevision: 1,
      idempotencyKey,
      linkType: "related",
      toNoteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y"
    } as const;
    expect(NoteLinkCreateRequestSchema.parse(link)).toEqual(link);
    expect(NoteLinkDeleteRequestSchema.parse(link)).toEqual(link);
    expect(
      NoteLinkListResponseSchema.parse({
        items: [
          {
            id: "lnk_01J6M9Q7G4BMKB33GSG3NJ6D1X",
            fromNoteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X",
            toNoteId: link.toNoteId,
            linkType: link.linkType,
            targetTitle: "Linked note"
          }
        ]
      }).items
    ).toHaveLength(1);
    expect(
      NoteTagLinkRequestSchema.parse({
        expectedRevision: 1,
        idempotencyKey,
        tagId: "tag_01J6M9Q7G4BMKB33GSG3NJ6D1X"
      }).tagId
    ).toBe("tag_01J6M9Q7G4BMKB33GSG3NJ6D1X");
    expect(
      NoteTagUnlinkRequestSchema.safeParse({ expectedRevision: 1, idempotencyKey }).success
    ).toBe(true);
    expect(SpaceListQuerySchema.parse({ includeArchived: "false" }).includeArchived).toBe(false);
    expect(SpaceListQuerySchema.parse({ includeArchived: "true" }).includeArchived).toBe(true);
  });

  it("publishes a strict paginated read model for Review", () => {
    const reviewItem = {
      id: "rvw_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      captureId: null,
      noteId: manualNoteFixtures.note.id,
      type: "structure_conflict",
      proposal: { type: "conflict", reason: "structure" },
      state: "open",
      resolution: null,
      createdAt: "2026-08-30T18:30:00.000Z",
      resolvedAt: null
    } as const;

    expect(ReviewItemListQuerySchema.parse({})).toMatchObject({ state: "open", limit: 30 });
    expect(ReviewItemDtoSchema.parse(reviewItem)).toEqual(reviewItem);
    expect(
      ListReviewItemsResponseSchema.parse({
        items: [reviewItem],
        pageInfo: { hasMore: false, nextCursor: null }
      })
    ).toHaveProperty("items.0.type", "structure_conflict");
    expect(
      ReviewItemDtoSchema.safeParse({ ...reviewItem, proposal: { type: "unknown" } }).success
    ).toBe(false);
  });

  it("exports reusable pagination and bounded log field schemas", () => {
    const pageSchema = paginatedResponseSchema(NoteSummarySchema);
    expect(
      pageSchema.parse({
        items: [manualNoteFixtures.summary],
        pageInfo: { hasMore: false, nextCursor: null }
      })
    ).toHaveProperty("items.0.id", manualNoteFixtures.summary.id);

    const fields = Object.fromEntries(
      Array.from({ length: 50 }, (_, index) => [`field-${index}`, index])
    );
    expect(
      LogEntrySchema.safeParse({
        id: "ent_01J6M9Q7G4BMKB33GSG3NJ6D1X",
        occurredAt: "2026-08-30T18:30:00.000Z",
        fields
      }).success
    ).toBe(true);
    expect(
      LogEntrySchema.safeParse({
        id: "ent_01J6M9Q7G4BMKB33GSG3NJ6D1X",
        occurredAt: "2026-08-30T18:30:00.000Z",
        fields: { ...fields, overflow: 51 }
      }).success
    ).toBe(false);
  });

  it("keeps all user mutation variants out of model output", () => {
    const operations = manualNoteFixtures.userOperations;
    for (const operation of operations) {
      expect(UserOperationSchema.safeParse(operation).success).toBe(true);
      expect(ModelOperationSchema.safeParse(operation).success).toBe(false);
    }
  });

  it("exposes checklist toggles and bounded log-field edits through interactive operations", () => {
    const toggle = manualNoteFixtures.userOperations.find(
      (operation) => operation.type === "toggle_item_checked"
    );
    expect(toggle).toBeDefined();
    expect(
      InteractiveOperationsRequestSchema.safeParse({
        expectedRevision: 1,
        idempotencyKey,
        operations: [toggle]
      }).success
    ).toBe(true);
    expect(
      InteractiveOperationsRequestSchema.safeParse({
        expectedRevision: 1,
        idempotencyKey,
        operations: [
          {
            type: "update_log_field",
            entryId: "ent_01J6M9Q7G4BMKB33GSG3NJ6D1X",
            fieldPath: ["weight"],
            value: 225
          }
        ]
      }).success
    ).toBe(true);
    expect(
      InteractiveOperationsRequestSchema.safeParse({
        expectedRevision: 1,
        idempotencyKey,
        operations: [{ type: "set_title", title: "Bypass" }]
      }).success
    ).toBe(false);
  });

  it("round-trips mutation and search result fixtures", () => {
    expect(MutationResultSchema.parse(manualNoteFixtures.mutationResult)).toEqual(
      manualNoteFixtures.mutationResult
    );
    expect(SearchNotesRequestSchema.parse({ query: " milk " })).toEqual({
      query: "milk",
      archive: "exclude",
      limit: 30
    });
    expect(SearchNotesRequestSchema.safeParse({ q: "milk" }).success).toBe(false);
    expect(SearchNotesRequestSchema.safeParse({ query: "milk", limit: "30" }).success).toBe(false);
    expect(SearchNotesRequestSchema.safeParse({ query: "milk", unexpected: true }).success).toBe(
      false
    );
    expect(
      SearchNotesResponseSchema.parse({
        items: [manualNoteFixtures.searchResult],
        pageInfo: { hasMore: false, nextCursor: null }
      })
    ).toHaveProperty("items.0.snippet", "milk");
  });

  it("publishes every B path with an Idempotency-Key on writes", () => {
    const expectedPaths = [
      "/auth/refresh",
      "/auth/session",
      "/auth/sign-in",
      "/auth/sign-out",
      "/auth/sign-up",
      "/captures",
      "/captures/{captureId}",
      "/captures/{captureId}/receipt",
      "/captures/{captureId}/retry",
      "/notes",
      "/notes/{noteId}",
      "/notes/{noteId}/links",
      "/notes/{noteId}/links/{linkId}",
      "/notes/{noteId}/tags",
      "/notes/{noteId}/tags/{tagId}",
      "/notes/{noteId}/operations",
      "/notes/{noteId}/move",
      "/notes/{noteId}/archive",
      "/notes/{noteId}/restore-deleted",
      "/notes/{noteId}/revisions",
      "/notes/{noteId}/restore",
      "/spaces",
      "/spaces/{spaceId}",
      "/spaces/{spaceId}/archive",
      "/tags",
      "/tags/{tagId}",
      "/mutations/{mutationId}/undo",
      "/review-items",
      "/search",
      "/me",
      "/me/export",
      "/me/deletion-receipt"
    ] as const;

    for (const path of expectedPaths) expect(openApiDocument.paths).toHaveProperty(path);
    for (const pathItem of Object.values(openApiDocument.paths)) {
      for (const method of ["post", "put", "patch", "delete"] as const) {
        const operation = pathItem[method as keyof typeof pathItem] as
          | {
              parameters?: readonly { name: string; required?: boolean }[];
              requestBody?: {
                content: { "application/json"?: { schema: { $ref: string } } };
              };
            }
          | undefined;
        if (operation?.requestBody === undefined) {
          continue;
        }
        const jsonContent = operation.requestBody.content["application/json"];
        if (jsonContent === undefined) {
          // A raw binary upload still names its idempotency key in the header.
          expect(operation.parameters).toContainEqual(
            expect.objectContaining({ name: "Idempotency-Key", required: true })
          );
          continue;
        }
        const schemaReference = jsonContent.schema.$ref;
        if (
          !schemaReference.includes("Auth") &&
          !schemaReference.endsWith("/SearchNotesRequest") &&
          !schemaReference.endsWith("/AccountDeleteRequest") &&
          !schemaReference.endsWith("/AccountDeletionReceiptReplayRequest")
        ) {
          expect(operation.parameters).toContainEqual(
            expect.objectContaining({ name: "Idempotency-Key", required: true })
          );
        }
      }
    }
    expect(openApiDocument.paths["/notes"].get.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ in: "query", name: "cursor" }),
        expect.objectContaining({ in: "query", name: "spaceId" })
      ])
    );
    expect(openApiDocument.paths["/search"]).not.toHaveProperty("get");
    expect(openApiDocument.paths["/search"].post.requestBody).toEqual({
      required: true,
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/SearchNotesRequest" } }
      }
    });
    expect(openApiDocument.paths["/search"].post).not.toHaveProperty("parameters");
    expect(openApiDocument.paths["/me/deletion-receipt"].post).not.toHaveProperty("parameters");
    expect(openApiDocument.paths["/me"].delete).not.toHaveProperty("parameters");
    expect(
      openApiDocument.paths["/search"].post.responses["200"].headers["Cache-Control"].schema
    ).toEqual({ type: "string", const: "private, no-store" });
    const privateResponseHeaders = [
      openApiDocument.paths["/review-items"].get.responses["200"].headers,
      openApiDocument.paths["/review-items"].get.responses["400"].headers,
      openApiDocument.paths["/review-items/{reviewItemId}/resolve"].post.responses["200"].headers,
      openApiDocument.paths["/routing-rules"].get.responses["200"].headers,
      openApiDocument.paths["/routing-rules"].post.responses["201"].headers,
      openApiDocument.paths["/routing-rules/{routingRuleId}"].patch.responses["200"].headers,
      openApiDocument.paths["/routing-rules/{routingRuleId}"].delete.responses["200"].headers
    ];
    for (const headers of privateResponseHeaders) {
      expect(headers["Cache-Control"].schema).toEqual({
        type: "string",
        const: "private, no-store"
      });
      expect(headers.Pragma.schema).toEqual({ type: "string", const: "no-cache" });
    }
    expect(openApiDocument.paths["/review-items"].get.parameters).toContainEqual(
      expect.objectContaining({ in: "query", name: "state" })
    );
  });
});
