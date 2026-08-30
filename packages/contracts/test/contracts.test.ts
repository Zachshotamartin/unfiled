import { describe, expect, it } from "vitest";

import {
  ApiErrorCode,
  CaptureCreateRequestSchema,
  CaptureCreateResponseSchema,
  CaptureSourceSchema,
  FixedClock,
  ModelOperationSchema,
  NoteUpdateRequestSchema,
  NoteTypeSchema,
  OrganizationPlanSchema,
  SystemClock,
  createEntityId,
  entityIdSchema,
  openApiDocument,
  parseEntityId
} from "../src/index.js";

describe("versioned contracts", () => {
  it("creates and parses typed ULID identifiers", () => {
    const id = createEntityId("note");
    expect(id).toMatch(/^note_[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(parseEntityId(id, "note")).toEqual({ kind: "note", ulid: id.slice(5) });
  });

  it("accepts the Lock Screen widget capture source across the shared schema", () => {
    expect(CaptureSourceSchema.parse("ios_lock_screen_widget")).toBe("ios_lock_screen_widget");
  });

  it("accepts a complete capture request without a user-supplied user id", () => {
    const request = CaptureCreateRequestSchema.parse({
      clientCaptureId: createEntityId("cap"),
      rawContent: "shopping: milk and batteries",
      source: "mobile",
      clientCreatedAt: "2026-08-30T18:30:00.000Z",
      clientTimezone: "America/Los_Angeles",
      privacy: "ai_assisted",
      expansionDisabled: false
    });

    expect(request.rawContent).toBe("shopping: milk and batteries");
    expect("userId" in request).toBe(false);
  });

  it("keeps the five-note-type vocabulary closed", () => {
    expect(NoteTypeSchema.options).toEqual(["generic", "list", "log", "principle", "project"]);
  });

  it("publishes stable machine error codes", () => {
    expect(Object.values(ApiErrorCode)).toEqual([
      "account_deletion_failed",
      "budget_exhausted",
      "capture_too_long",
      "conflict_requires_review",
      "forbidden",
      "invalid_capture",
      "invalid_idempotency_key",
      "invalid_plan",
      "not_found",
      "offline",
      "provider_key_invalid",
      "provider_unavailable",
      "rate_limited",
      "stale_revision",
      "structure_conflict",
      "unauthorized",
      "validation_failed"
    ]);
    expect(new Set(Object.values(ApiErrorCode)).size).toBe(Object.values(ApiErrorCode).length);
  });

  it("rejects empty and oversized captures", () => {
    const base = {
      clientCaptureId: createEntityId("cap"),
      source: "web",
      clientCreatedAt: "2026-08-30T18:30:00.000Z",
      clientTimezone: "UTC",
      privacy: "ai_assisted",
      expansionDisabled: false
    } as const;

    expect(() => CaptureCreateRequestSchema.parse({ ...base, rawContent: "   " })).toThrow();
    expect(() =>
      CaptureCreateRequestSchema.parse({ ...base, rawContent: "x".repeat(10_001) })
    ).toThrow();
  });

  it("provides injectable UTC time without leaking mutable Date instances", () => {
    const instant = "2026-08-30T18:30:00.000Z";
    const clock = new FixedClock(instant);

    expect(clock.now()).toBe(instant);
    expect(new SystemClock().now()).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it("rejects wrong prefixes, malformed ULIDs, and non-string entity identifiers", () => {
    const noteId = createEntityId("note");

    expect(() => parseEntityId(noteId, "cap")).toThrow("invalid_cap_id");
    expect(() => parseEntityId("note_not-a-ulid", "note")).toThrow("invalid_note_id");
    expect(entityIdSchema("note").safeParse(12).success).toBe(false);
    expect(entityIdSchema("note").safeParse(noteId).success).toBe(true);
    expect(entityIdSchema("note").safeParse("note_bad").success).toBe(false);
    expect(parseEntityId(createEntityId("key"), "key").kind).toBe("key");
  });

  it("requires at least one editable note field while accepting every supported field", () => {
    const base = { expectedRevision: 1, idempotencyKey: "edit-once" };

    expect(NoteUpdateRequestSchema.safeParse(base).success).toBe(false);
    expect(NoteUpdateRequestSchema.safeParse({ ...base, title: "Renamed" }).success).toBe(true);
    expect(NoteUpdateRequestSchema.safeParse({ ...base, bodyMarkdown: "Body" }).success).toBe(true);
    expect(NoteUpdateRequestSchema.safeParse({ ...base, privacy: "private_manual" }).success).toBe(
      true
    );
  });

  it("round-trips version-one fixtures and rejects contract drift", () => {
    const request = {
      clientCaptureId: "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      rawContent: "milk",
      source: "ios_lock_screen_widget",
      clientCreatedAt: "2026-08-30T18:30:00.000Z",
      clientTimezone: "America/Los_Angeles",
      privacy: "ai_assisted",
      expansionDisabled: false
    } as const;
    const response = {
      capture: {
        id: request.clientCaptureId,
        rawContent: request.rawContent,
        source: request.source,
        privacy: request.privacy,
        clientCreatedAt: request.clientCreatedAt,
        receivedAt: "2026-08-30T18:30:01.000Z",
        status: "queued",
        lastErrorCode: null
      },
      jobId: "job_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
      replayed: false
    } as const;

    expect(CaptureCreateRequestSchema.parse(request)).toEqual(request);
    expect(CaptureCreateResponseSchema.parse(response)).toEqual(response);
    expect(
      CaptureCreateResponseSchema.safeParse({
        ...response,
        capture: { ...response.capture, lastErrorCode: "upstream request timed out: secret" }
      }).success
    ).toBe(false);
    expect(
      CaptureCreateRequestSchema.safeParse({ ...request, unexpected: "schema drift" }).success
    ).toBe(false);

    const plan = OrganizationPlanSchema.parse({
      schemaVersion: 1,
      captureKind: "freeform",
      decision: "add_to_inbox",
      destination: { candidateId: null, newNote: null },
      operations: [{ type: "append_raw", content: request.rawContent }],
      generatedExpansion: null,
      alternatives: [],
      reasonCodes: ["no_candidate_fit"]
    });
    expect(plan.schemaVersion).toBe(1);
  });

  it("keeps every user-only operation out of the model output allowlist", () => {
    const userOnlyOperations = [
      {
        type: "toggle_item_checked",
        itemId: "itm_01J6M9Q7G4BMKB33GSG3NJ6D1X",
        checked: true
      },
      {
        type: "update_log_field",
        entryId: "ent_01J6M9Q7G4BMKB33GSG3NJ6D1X",
        fieldPath: ["weight"],
        value: 225
      },
      {
        type: "edit_item_text",
        itemId: "itm_01J6M9Q7G4BMKB33GSG3NJ6D1X",
        text: "oat milk"
      },
      { type: "remove_item", itemId: "itm_01J6M9Q7G4BMKB33GSG3NJ6D1X" }
    ];

    for (const operation of userOnlyOperations) {
      expect(ModelOperationSchema.safeParse(operation).success).toBe(false);
    }
  });

  it("derives a complete capture OpenAPI contract and required idempotency header", () => {
    const post = openApiDocument.paths["/captures"].post;
    const responseSchema = openApiDocument.components.schemas.CaptureCreateResponse;

    expect(post.parameters).toContainEqual(
      expect.objectContaining({ name: "Idempotency-Key", in: "header", required: true })
    );
    expect(responseSchema).toHaveProperty("properties.capture.properties.rawContent");
    expect(responseSchema).toHaveProperty("properties.capture.properties.source.enum");
  });
});
