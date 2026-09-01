import { describe, expect, it } from "vitest";

import {
  DecisionCorrectionRequestSchema,
  DecisionCorrectionResponseSchema,
  GeneratedBlockDtoSchema,
  GeneratedBlockResolveRequestSchema,
  InteractiveOperationsRequestSchema,
  MutationBatchUndoResponseSchema,
  NoteBacklinksResponseSchema,
  NoteSourcesResponseSchema,
  ProviderKeyMetadataSchema,
  ReviewItemDtoSchema,
  ReviewProposalSchema,
  ReviewResolveRequestSchema,
  RoutingRuleCreateRequestSchema,
  RoutingRuleDtoSchema,
  RoutingRuleUpdateRequestSchema,
  SearchNotesRequestSchema,
  UserSettingsDtoSchema,
  UserSettingsUpdateRequestSchema,
  manualNoteFixtures,
  openApiDocument,
  reviewResolutionMatchesSemantics
} from "../src/index.js";

const NOTE_A = "note_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const NOTE_B = "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y";
const SPACE_ID = "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const DECISION_ID = "dec_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const MUTATION_A = "mut_01J6M9Q7G4BMKB33GSG3NJ6D1X";
const MUTATION_B = "mut_01J6M9Q7G4BMKB33GSG3NJ6D1Y";
const NOW = "2026-09-01T18:30:00.000Z";

describe("Milestone E public contracts", () => {
  it("requires correction CAS coordinates and exactly one destination variant", () => {
    const base = {
      idempotencyKey: "correct-decision-01",
      source: { noteId: NOTE_A, expectedRevision: 4 }
    } as const;

    expect(
      DecisionCorrectionRequestSchema.parse({
        ...base,
        destination: { type: "existing_note", noteId: NOTE_B, expectedRevision: 2 }
      })
    ).toHaveProperty("destination.type", "existing_note");
    expect(
      DecisionCorrectionRequestSchema.parse({
        ...base,
        destination: {
          type: "new_note",
          title: " Better home ",
          noteType: "project",
          spaceId: SPACE_ID
        }
      })
    ).toHaveProperty("destination.title", "Better home");
    expect(
      DecisionCorrectionRequestSchema.safeParse({
        ...base,
        destination: { type: "existing_note", noteId: NOTE_A, expectedRevision: 4 }
      }).success
    ).toBe(false);
    expect(
      DecisionCorrectionRequestSchema.safeParse({
        ...base,
        destination: {
          type: "existing_note",
          noteId: NOTE_B,
          expectedRevision: 2,
          title: "smuggled"
        }
      }).success
    ).toBe(false);

    expect(
      DecisionCorrectionResponseSchema.parse({
        outcome: "applied",
        decisionId: DECISION_ID,
        source: { noteId: NOTE_A, currentRevision: 5, mutationId: MUTATION_A },
        destination: {
          type: "existing_note",
          noteId: NOTE_B,
          currentRevision: 3,
          mutationId: MUTATION_B
        },
        replayed: false
      })
    ).toHaveProperty("destination.currentRevision", 3);

    expect(
      DecisionCorrectionResponseSchema.parse({
        outcome: "needs_review",
        decisionId: DECISION_ID,
        reviewItemId: "rvw_01J6M9Q7G4BMKB33GSG3NJ6D1X",
        reasonCode: "exact_inverse_unavailable",
        replayed: false
      })
    ).toHaveProperty("outcome", "needs_review");
    expect(
      DecisionCorrectionResponseSchema.safeParse({
        outcome: "needs_review",
        decisionId: DECISION_ID,
        reviewItemId: "rvw_01J6M9Q7G4BMKB33GSG3NJ6D1X",
        reasonCode: "revision_conflict",
        replayed: false
      }).success
    ).toBe(false);
  });

  it("publishes bounded atomic batch-undo results without nested replay flags", () => {
    const mutation = manualNoteFixtures.mutationResult;
    const member = {
      note: mutation.note,
      revision: mutation.revision,
      mutationId: mutation.mutationId,
      undo: { eligible: false, expiresAt: null }
    };
    expect(
      MutationBatchUndoResponseSchema.parse({ members: [member], replayed: false })
    ).toHaveProperty("members.0.mutationId", member.mutationId);
    expect(
      MutationBatchUndoResponseSchema.safeParse({
        members: [{ ...member, undo: mutation.undo }],
        replayed: false
      }).success
    ).toBe(false);
    expect(
      MutationBatchUndoResponseSchema.safeParse({
        members: [member, member],
        replayed: false
      }).success
    ).toBe(false);
    expect(
      MutationBatchUndoResponseSchema.safeParse({
        members: [{ ...member, replayed: false }],
        replayed: false
      }).success
    ).toBe(false);
    expect(
      MutationBatchUndoResponseSchema.safeParse({
        members: [
          {
            ...member,
            revision: { ...member.revision, noteId: NOTE_B }
          }
        ],
        replayed: false
      }).success
    ).toBe(false);
    expect(
      MutationBatchUndoResponseSchema.safeParse({
        members: [
          {
            ...member,
            revision: { ...member.revision, revision: member.note.currentRevision + 1 }
          }
        ],
        replayed: false
      }).success
    ).toBe(false);
    expect(
      MutationBatchUndoResponseSchema.safeParse({ members: [], replayed: false }).success
    ).toBe(false);
  });

  it("publishes closed Review proposals and resolution actions", () => {
    expect(
      ReviewProposalSchema.parse({
        type: "duplicate_notes",
        notes: [
          { noteId: NOTE_A, revision: 4 },
          { noteId: NOTE_B, revision: 2 }
        ]
      })
    ).toHaveProperty("notes", [
      { noteId: NOTE_A, revision: 4 },
      { noteId: NOTE_B, revision: 2 }
    ]);
    expect(
      ReviewProposalSchema.safeParse({
        type: "duplicate_notes",
        notes: [
          { noteId: NOTE_A, revision: 4 },
          { noteId: NOTE_A, revision: 4 }
        ]
      }).success
    ).toBe(false);

    const resolutions = [
      { type: "route", noteId: NOTE_B, expectedRevision: 2 },
      { type: "create", title: "New destination", noteType: "generic", spaceId: null },
      { type: "keep_inbox" },
      { type: "dismiss" },
      { type: "keep_both" },
      { type: "accept_expansion" },
      { type: "reject_expansion" }
    ] as const;
    for (const [index, resolution] of resolutions.entries()) {
      expect(
        ReviewResolveRequestSchema.safeParse({
          idempotencyKey: `review-resolution-${index}`,
          resolution
        }).success
      ).toBe(true);
    }
    expect(
      ReviewResolveRequestSchema.safeParse({
        idempotencyKey: "review-resolution-invalid",
        resolution: { type: "route", noteId: NOTE_B }
      }).success
    ).toBe(false);

    expect(
      ReviewItemDtoSchema.safeParse({
        id: "rvw_01J6M9Q7G4BMKB33GSG3NJ6D1X",
        captureId: null,
        noteId: NOTE_A,
        type: "structure_conflict",
        proposal: { type: "conflict", reason: "structure" },
        state: "dismissed",
        resolution: { type: "dismiss" },
        createdAt: NOW,
        resolvedAt: NOW
      }).success
    ).toBe(true);

    const openReview = {
      id: "rvw_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      captureId: null,
      noteId: NOTE_A,
      state: "open",
      resolution: null,
      createdAt: NOW,
      resolvedAt: null
    } as const;
    expect(
      ReviewItemDtoSchema.safeParse({
        ...openReview,
        type: "pending_expansion",
        proposal: { type: "conflict", reason: "consent_controls" }
      }).success
    ).toBe(true);
    expect(
      ReviewItemDtoSchema.safeParse({
        ...openReview,
        type: "failed_job",
        proposal: { type: "conflict", reason: "revision" }
      }).success
    ).toBe(false);
    expect(
      ReviewItemDtoSchema.safeParse({
        ...openReview,
        type: "duplicate_suggestion",
        proposal: {
          type: "duplicate_notes",
          notes: [
            { noteId: NOTE_A, revision: 4 },
            { noteId: NOTE_B, revision: 2 }
          ]
        },
        state: "resolved",
        resolution: { type: "keep_inbox" },
        resolvedAt: NOW
      }).success
    ).toBe(false);

    const failedProposal = {
      type: "failed_job",
      errorCode: "provider_unavailable"
    } as const;
    expect(
      reviewResolutionMatchesSemantics("failed_job", failedProposal, { type: "keep_inbox" })
    ).toBe(true);
    expect(
      reviewResolutionMatchesSemantics("failed_job", failedProposal, {
        type: "route",
        noteId: NOTE_B,
        expectedRevision: 2
      })
    ).toBe(false);
    expect(
      reviewResolutionMatchesSemantics("failed_job", failedProposal, {
        type: "create",
        title: "Retry destination",
        noteType: "generic",
        spaceId: null
      })
    ).toBe(false);
    expect(
      ReviewItemDtoSchema.safeParse({
        ...openReview,
        type: "failed_job",
        proposal: failedProposal,
        state: "resolved",
        resolution: { type: "keep_inbox" },
        resolvedAt: NOW
      }).success
    ).toBe(true);
    expect(
      ReviewItemDtoSchema.safeParse({
        ...openReview,
        type: "failed_job",
        proposal: failedProposal,
        state: "resolved",
        resolution: { type: "route", noteId: NOTE_B, expectedRevision: 2 },
        resolvedAt: NOW
      }).success
    ).toBe(false);
  });

  it("models visible revisioned rules with a structurally exclusive destination", () => {
    const editable = {
      enabled: true,
      ruleType: "phrase",
      condition: "groceries",
      destination: { type: "note", noteId: NOTE_A },
      priority: 100
    } as const;
    expect(
      RoutingRuleCreateRequestSchema.parse({ idempotencyKey: "rule-create-01", ...editable })
    ).toHaveProperty("destination", { type: "note", noteId: NOTE_A });
    expect(
      RoutingRuleCreateRequestSchema.safeParse({
        idempotencyKey: "rule-create-02",
        ...editable,
        destination: { type: "note", noteId: NOTE_A, spaceId: SPACE_ID }
      }).success
    ).toBe(false);
    expect(
      RoutingRuleUpdateRequestSchema.safeParse({
        expectedRevision: 1,
        idempotencyKey: "rule-update-empty"
      }).success
    ).toBe(false);
    expect(
      RoutingRuleDtoSchema.safeParse({
        id: "rule_01J6M9Q7G4BMKB33GSG3NJ6D1X",
        revision: 1,
        ...editable,
        normalizedCondition: "groceries",
        aliases: [],
        source: "explicit",
        proposalState: null,
        destinationStatus: "active",
        lastFiredAt: null,
        createdAt: NOW,
        updatedAt: NOW
      }).success
    ).toBe(true);
  });

  it("uses stateRevision for generated-block CAS and settingsRevision for settings CAS", () => {
    const block = {
      id: "blk_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      noteId: NOTE_A,
      decisionId: DECISION_ID,
      kind: "suggestion",
      content: "Try grouping this under accountability.",
      state: "proposed",
      stateRevision: 1,
      modelId: "gpt-5.4-mini-2026-03-17",
      promptVersion: "organizer-v1",
      createdAt: NOW,
      resolvedAt: null
    } as const;
    expect(GeneratedBlockDtoSchema.parse(block)).toEqual(block);
    expect(
      GeneratedBlockDtoSchema.safeParse({
        ...block,
        state: "accepted",
        resolvedAt: NOW
      }).success
    ).toBe(false);
    expect(GeneratedBlockDtoSchema.safeParse({ ...block, stateRevision: 2 }).success).toBe(false);
    expect(
      GeneratedBlockResolveRequestSchema.safeParse({
        expectedStateRevision: 1,
        idempotencyKey: "block-resolve-01",
        resolution: "accept"
      }).success
    ).toBe(true);

    const settings = {
      settingsRevision: 3,
      organizationMode: "balanced",
      providerMode: "byok",
      byokProvider: "openai",
      byokFallbackToApp: false,
      routingEffort: "standard",
      expansionStyle: "brief",
      timezone: "America/Los_Angeles",
      locale: "en-US",
      updatedAt: NOW
    } as const;
    expect(UserSettingsDtoSchema.parse(settings)).toEqual(settings);
    expect(
      UserSettingsDtoSchema.safeParse({
        ...settings,
        providerMode: "app_default",
        byokProvider: "openai"
      }).success
    ).toBe(false);
    expect(
      UserSettingsDtoSchema.safeParse({
        ...settings,
        providerMode: "app_default",
        byokProvider: null,
        byokFallbackToApp: true
      }).success
    ).toBe(false);
    expect(
      UserSettingsUpdateRequestSchema.safeParse({
        expectedSettingsRevision: 3,
        idempotencyKey: "settings-empty"
      }).success
    ).toBe(false);
  });

  it("never accepts secret material as provider-key metadata", () => {
    const metadata = {
      provider: "openai",
      lastFour: "1234",
      status: "active",
      credentialRevision: 1,
      validatedAt: NOW,
      updatedAt: NOW
    } as const;
    expect(ProviderKeyMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(
      ProviderKeyMetadataSchema.safeParse({ ...metadata, credentialRevision: 0 }).success
    ).toBe(false);
    expect(
      ProviderKeyMetadataSchema.safeParse({ ...metadata, apiKey: "sk-secret-must-not-return" })
        .success
    ).toBe(false);
  });

  it("binds strict search filters, log edits, sources, and backlinks", () => {
    expect(
      SearchNotesRequestSchema.parse({
        query: " roosevelt ",
        type: "principle",
        spaceId: SPACE_ID,
        tagIds: ["tag_01J6M9Q7G4BMKB33GSG3NJ6D1X"],
        updatedFrom: "2026-08-01T00:00:00.000Z",
        updatedTo: "2026-09-01T00:00:00.000Z",
        privacy: "ai_assisted"
      })
    ).toMatchObject({ query: "roosevelt", type: "principle", privacy: "ai_assisted" });
    expect(
      SearchNotesRequestSchema.safeParse({
        query: "x",
        updatedFrom: "2026-09-01T00:00:00.000Z",
        updatedTo: "2026-08-01T00:00:00.000Z"
      }).success
    ).toBe(false);
    expect(
      InteractiveOperationsRequestSchema.safeParse({
        expectedRevision: 2,
        idempotencyKey: "log-field-01",
        operations: [
          {
            type: "update_log_field",
            entryId: "ent_01J6M9Q7G4BMKB33GSG3NJ6D1X",
            fieldPath: ["sets", "0", "weight"],
            value: 225
          }
        ]
      }).success
    ).toBe(true);

    expect(
      NoteSourcesResponseSchema.safeParse({
        items: [
          {
            captureId: "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X",
            mutationId: MUTATION_A,
            relation: "routed",
            rawContent: "Bench press 225 x 5",
            source: "mobile",
            clientCreatedAt: NOW,
            insertedItemIds: ["ent_01J6M9Q7G4BMKB33GSG3NJ6D1X"],
            createdAt: NOW
          }
        ],
        pageInfo: { hasMore: false, nextCursor: null }
      }).success
    ).toBe(true);
    expect(
      NoteBacklinksResponseSchema.safeParse({
        items: [
          {
            linkId: "lnk_01J6M9Q7G4BMKB33GSG3NJ6D1X",
            fromNoteId: NOTE_B,
            fromTitle: "Related project",
            linkType: "related",
            createdAt: NOW
          }
        ],
        pageInfo: { hasMore: false, nextCursor: null }
      }).success
    ).toBe(true);
  });

  it("publishes every frozen E/F route and component in OpenAPI", () => {
    for (const path of [
      "/decisions/{decisionId}/correct",
      "/review-items/{reviewItemId}/resolve",
      "/routing-rules",
      "/routing-rules/{routingRuleId}",
      "/notes/{noteId}/generated-blocks",
      "/generated-blocks/{blockId}/resolve",
      "/me/settings",
      "/me/provider-key",
      "/notes/{noteId}/sources",
      "/notes/{noteId}/backlinks",
      "/mutation-batches/{mutationId}/undo"
    ] as const) {
      expect(openApiDocument.paths).toHaveProperty(path);
    }
    for (const component of [
      "DecisionCorrectionRequest",
      "DecisionCorrectionResponse",
      "ReviewProposal",
      "ReviewResolution",
      "RoutingRuleDto",
      "GeneratedBlockDto",
      "UserSettingsDto",
      "ProviderKeyMetadata",
      "NoteSourcesResponse",
      "NoteBacklinksResponse"
    ] as const) {
      expect(openApiDocument.components.schemas).toHaveProperty(component);
    }
    expect(openApiDocument.components.schemas.ProviderKeyMetadata).not.toHaveProperty(
      "properties.apiKey"
    );
    expect(openApiDocument.components.schemas).toHaveProperty("MutationBatchUndoMember");
    expect(openApiDocument.components.schemas).toHaveProperty("MutationBatchUndoResponse");
    for (const headers of [
      openApiDocument.paths["/decisions/{decisionId}/correct"].post.responses["200"].headers,
      openApiDocument.paths["/review-items/{reviewItemId}/resolve"].post.responses["200"].headers,
      openApiDocument.paths["/mutation-batches/{mutationId}/undo"].post.responses["200"].headers
    ]) {
      expect(headers["Cache-Control"].schema).toEqual({
        type: "string",
        const: "private, no-store"
      });
      expect(headers.Pragma.schema).toEqual({ type: "string", const: "no-cache" });
    }
  });
});
