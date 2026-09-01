import {
  ModelOperationSchema,
  NoteTypeSchema,
  OrganizationPlanSchema,
  RoutingRuleMatchSnapshotSchema,
  entityIdSchema,
  type ModelOperation,
  type NoteType,
  type OrganizationPlan
} from "@unfiled/contracts";
import { z } from "zod";

import { assertPlanSourcePreserved } from "./preservation.js";

const MAX_CANDIDATES = 8;
const MAX_AUTHORIZED_SPACES = 16;
const MAX_AUTHORIZED_TAGS = 100;
const MAX_UNTRUSTED_DEPTH = 64;
const MAX_UNTRUSTED_NODES = 50_000;
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export const OrganizerCandidateManifestItemSchema = z.strictObject({
  candidateId: entityIdSchema("note"),
  isOpen: z.boolean(),
  noteId: entityIdSchema("note"),
  // Present on organizer-owned manifests so a matched-space append remains
  // bound to the frozen space capability. Legacy non-rule callers may omit it.
  spaceId: entityIdSchema("spc").nullable().optional(),
  revision: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER - 1),
  noteType: NoteTypeSchema
});

export const OrganizerCaptureControlsSchema = z.strictObject({
  expansionDisabled: z.boolean(),
  explicitDestinationNoteId: entityIdSchema("note").nullable(),
  // Missing is normalized to the legacy-safe no-rule state; database-bound
  // organizer controls require the member explicitly at their trust boundary.
  ruleMatch: RoutingRuleMatchSnapshotSchema.nullable().default(null)
});

export const OrganizerCandidateManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    candidates: z.array(OrganizerCandidateManifestItemSchema).max(MAX_CANDIDATES),
    controls: OrganizerCaptureControlsSchema,
    authorizedSpaceIds: z.array(entityIdSchema("spc")).max(MAX_AUTHORIZED_SPACES),
    authorizedTagIds: z.array(entityIdSchema("tag")).max(MAX_AUTHORIZED_TAGS)
  })
  .superRefine((manifest, context) => {
    for (const [field, values] of [
      ["candidateId", manifest.candidates.map(({ candidateId }) => candidateId)],
      ["noteId", manifest.candidates.map(({ noteId }) => noteId)],
      ["authorizedSpaceIds", manifest.authorizedSpaceIds],
      ["authorizedTagIds", manifest.authorizedTagIds]
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          message: "Authorized manifest identifiers must be unique",
          path: [field]
        });
      }
    }
  });

export type OrganizerCandidateManifestItem = z.infer<typeof OrganizerCandidateManifestItemSchema>;
export type OrganizerCaptureControls = z.infer<typeof OrganizerCaptureControlsSchema>;
export type OrganizerCandidateManifest = z.infer<typeof OrganizerCandidateManifestSchema>;

export const StableOrganizationIdsSchema = z.strictObject({
  decisionId: entityIdSchema("dec"),
  createdNoteId: entityIdSchema("note").nullable(),
  revisionId: entityIdSchema("rev").nullable(),
  mutationId: entityIdSchema("mut").nullable(),
  reviewItemId: entityIdSchema("rvw").nullable(),
  generatedBlockId: entityIdSchema("blk").nullable()
});

export type StableOrganizationIds = z.infer<typeof StableOrganizationIdsSchema>;

export type MaterializedOrganizationOperation =
  | Exclude<ModelOperation, Readonly<{ type: "add_relation" }>>
  | Readonly<{
      type: "add_relation";
      toNoteId: `note_${string}`;
      linkType: "reference" | "related";
    }>;

type MaterializedGeneratedBlock = Readonly<{
  blockId: `blk_${string}`;
  kind: "summary" | "interpretation" | "suggestion" | "label";
  text: string;
}>;

type MaterializedOrganizationBase = Readonly<{
  decisionId: `dec_${string}`;
  validatedPlan: OrganizationPlan;
  generatedBlock: MaterializedGeneratedBlock | null;
}>;

export type MaterializedAppendOrganizationCommand = MaterializedOrganizationBase &
  Readonly<{
    kind: "append";
    candidateId: `note_${string}`;
    noteId: `note_${string}`;
    expectedRevision: number;
    afterRevision: number;
    noteType: NoteType;
    revisionId: `rev_${string}`;
    mutationId: `mut_${string}`;
    operations: readonly MaterializedOrganizationOperation[];
  }>;

export type MaterializedCreateOrganizationCommand = MaterializedOrganizationBase &
  Readonly<{
    kind: "create";
    noteId: `note_${string}`;
    expectedRevision: 0;
    afterRevision: 1;
    noteType: NoteType;
    title: string;
    spaceId: `spc_${string}` | null;
    revisionId: `rev_${string}`;
    mutationId: `mut_${string}`;
    operations: readonly MaterializedOrganizationOperation[];
  }>;

export type MaterializedReviewAlternative = Readonly<{
  candidateId: `note_${string}`;
  noteId: `note_${string}`;
  revision: number;
  noteType: NoteType;
}>;

export type MaterializedReviewOrganizationCommand = MaterializedOrganizationBase &
  Readonly<{
    kind: "review";
    disposition: "needs_review" | "add_to_inbox";
    reviewItemId: `rvw_${string}` | null;
    alternatives: readonly MaterializedReviewAlternative[];
  }>;

export type MaterializedOrganizationCommand =
  | MaterializedAppendOrganizationCommand
  | MaterializedCreateOrganizationCommand
  | MaterializedReviewOrganizationCommand;

export const OrganizationMaterializationErrorCode = Object.freeze({
  INVALID_PLAN: "invalid_plan",
  INVALID_MANIFEST: "invalid_manifest",
  INVALID_STABLE_IDS: "invalid_stable_ids",
  INVALID_DECISION: "invalid_decision",
  SOURCE_PRESERVATION_FAILED: "source_preservation_failed",
  UNAUTHORIZED_REFERENCE: "unauthorized_reference",
  INCOMPATIBLE_OPERATION: "incompatible_operation",
  INVALID_STABLE_ID_BINDING: "invalid_stable_id_binding"
} as const);

export type OrganizationMaterializationErrorCodeValue =
  (typeof OrganizationMaterializationErrorCode)[keyof typeof OrganizationMaterializationErrorCode];

export class OrganizationMaterializationError extends Error {
  public readonly code: OrganizationMaterializationErrorCodeValue;

  public constructor(code: OrganizationMaterializationErrorCodeValue, message: string) {
    super(message);
    this.name = "OrganizationMaterializationError";
    this.code = code;
  }
}

function fail(code: OrganizationMaterializationErrorCodeValue, message: string): never {
  throw new OrganizationMaterializationError(code, message);
}

interface UntrustedJsonState {
  readonly ancestors: Set<object>;
  nodes: number;
}

function assertUntrustedJsonNode(
  value: unknown,
  code: OrganizationMaterializationErrorCodeValue,
  message: string,
  state: UntrustedJsonState,
  depth: number
): void {
  state.nodes += 1;
  if (state.nodes > MAX_UNTRUSTED_NODES || depth > MAX_UNTRUSTED_DEPTH) fail(code, message);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(code, message);
    return;
  }
  if (typeof value !== "object" || state.ancestors.has(value)) fail(code, message);

  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) fail(code, message);
      const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
        string,
        PropertyDescriptor
      >;
      const lengthDescriptor = descriptors.length;
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        typeof lengthDescriptor.value !== "number" ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) {
        fail(code, message);
      }
      const length = lengthDescriptor.value;
      if (
        Object.keys(descriptors).some(
          (key) => key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key)
        ) ||
        Object.keys(descriptors).length !== length + 1
      ) {
        fail(code, message);
      }
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          fail(code, message);
        }
        assertUntrustedJsonNode(descriptor.value, code, message, state, depth + 1);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) fail(code, message);
    if (Object.getOwnPropertySymbols(value).length > 0) fail(code, message);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable || !("value" in descriptor) || FORBIDDEN_OBJECT_KEYS.has(key)) {
        fail(code, message);
      }
      assertUntrustedJsonNode(descriptor.value, code, message, state, depth + 1);
    }
  } finally {
    state.ancestors.delete(value);
  }
}

function assertUntrustedJson(
  value: unknown,
  code: OrganizationMaterializationErrorCodeValue,
  message: string
): void {
  assertUntrustedJsonNode(value, code, message, { ancestors: new Set(), nodes: 0 }, 0);
}

function parsePlan(value: unknown): OrganizationPlan {
  assertUntrustedJson(value, OrganizationMaterializationErrorCode.INVALID_PLAN, "Plan is invalid");
  const result = OrganizationPlanSchema.safeParse(value);
  if (!result.success) fail(OrganizationMaterializationErrorCode.INVALID_PLAN, "Plan is invalid");
  return result.data;
}

function parseManifest(value: unknown): OrganizerCandidateManifest {
  assertUntrustedJson(
    value,
    OrganizationMaterializationErrorCode.INVALID_MANIFEST,
    "Manifest is invalid"
  );
  const result = OrganizerCandidateManifestSchema.safeParse(value);
  if (!result.success) {
    fail(OrganizationMaterializationErrorCode.INVALID_MANIFEST, "Manifest is invalid");
  }
  return result.data;
}

function parseStableIds(value: unknown): StableOrganizationIds {
  assertUntrustedJson(
    value,
    OrganizationMaterializationErrorCode.INVALID_STABLE_IDS,
    "Stable IDs are invalid"
  );
  const result = StableOrganizationIdsSchema.safeParse(value);
  if (!result.success) {
    fail(OrganizationMaterializationErrorCode.INVALID_STABLE_IDS, "Stable IDs are invalid");
  }
  return result.data;
}

function candidateMap(
  manifest: OrganizerCandidateManifest
): ReadonlyMap<string, OrganizerCandidateManifestItem> {
  return new Map(manifest.candidates.map((candidate) => [candidate.candidateId, candidate]));
}

function assertPlanShape(plan: OrganizationPlan): void {
  const hasCandidate = plan.destination.candidateId !== null;
  const hasNewNote = plan.destination.newNote !== null;

  if (
    (plan.decision === "append_to_note" && (!hasCandidate || hasNewNote)) ||
    (plan.decision === "create_note" && (hasCandidate || !hasNewNote)) ||
    ((plan.decision === "add_to_inbox" || plan.decision === "needs_review") &&
      (hasCandidate || hasNewNote))
  ) {
    fail(
      OrganizationMaterializationErrorCode.INVALID_DECISION,
      "Plan destination does not match its decision"
    );
  }

  if (new Set(plan.alternatives).size !== plan.alternatives.length) {
    fail(OrganizationMaterializationErrorCode.INVALID_DECISION, "Plan alternatives are invalid");
  }
  if (new Set(plan.reasonCodes).size !== plan.reasonCodes.length) {
    fail(OrganizationMaterializationErrorCode.INVALID_DECISION, "Plan reasons are invalid");
  }
  if (plan.decision === "add_to_inbox" && plan.alternatives.length > 0) {
    fail(
      OrganizationMaterializationErrorCode.INVALID_DECISION,
      "Inbox plans cannot carry alternatives"
    );
  }
}

function requiresCapturedContent(operation: ModelOperation): boolean {
  return (
    operation.type === "append_raw" ||
    operation.type === "append_paragraphs" ||
    operation.type === "append_list_items" ||
    operation.type === "append_log_entry" ||
    operation.type === "update_structured_data"
  );
}

function assertOperationCompatible(operation: ModelOperation, noteType: NoteType): void {
  if (
    (operation.type === "append_list_items" && noteType !== "list") ||
    (operation.type === "append_log_entry" && noteType !== "log") ||
    (operation.type === "update_structured_data" &&
      noteType !== "list" &&
      noteType !== "log" &&
      noteType !== "project")
  ) {
    fail(
      OrganizationMaterializationErrorCode.INCOMPATIBLE_OPERATION,
      "Plan operation is incompatible with its destination"
    );
  }
}

function assertAuthorizedPlan(plan: OrganizationPlan, manifest: OrganizerCandidateManifest): void {
  assertPlanShape(plan);
  const candidates = candidateMap(manifest);
  const spaces = new Set(manifest.authorizedSpaceIds);
  const tags = new Set(manifest.authorizedTagIds);

  for (const alternative of plan.alternatives) {
    if (!candidates.has(alternative)) {
      fail(
        OrganizationMaterializationErrorCode.UNAUTHORIZED_REFERENCE,
        "Plan references an unauthorized alternative"
      );
    }
  }

  const destinationCandidate =
    plan.destination.candidateId === null
      ? null
      : (candidates.get(plan.destination.candidateId) ?? null);
  if (plan.destination.candidateId !== null && destinationCandidate === null) {
    fail(
      OrganizationMaterializationErrorCode.UNAUTHORIZED_REFERENCE,
      "Plan references an unauthorized destination"
    );
  }
  if (destinationCandidate !== null && !destinationCandidate.isOpen) {
    fail(
      OrganizationMaterializationErrorCode.UNAUTHORIZED_REFERENCE,
      "Plan references a closed destination"
    );
  }

  const explicitDestinationNoteId = manifest.controls.explicitDestinationNoteId;
  if (
    explicitDestinationNoteId !== null &&
    (plan.decision === "append_to_note" || plan.decision === "create_note") &&
    (plan.decision !== "append_to_note" ||
      destinationCandidate?.noteId !== explicitDestinationNoteId)
  ) {
    fail(
      OrganizationMaterializationErrorCode.UNAUTHORIZED_REFERENCE,
      "Plan does not honor the explicit destination"
    );
  }
  const ruleMatch = explicitDestinationNoteId === null ? manifest.controls.ruleMatch : null;
  if (
    ruleMatch !== null &&
    (plan.decision === "append_to_note" || plan.decision === "create_note")
  ) {
    if (!plan.reasonCodes.includes("routing_rule_match") || plan.generatedExpansion !== null) {
      fail(
        OrganizationMaterializationErrorCode.INCOMPATIBLE_OPERATION,
        "Plan does not preserve deterministic routing-rule provenance"
      );
    }
    if (
      ruleMatch.destinationKind === "note" &&
      (plan.decision !== "append_to_note" ||
        destinationCandidate?.noteId !== ruleMatch.destinationId)
    ) {
      fail(
        OrganizationMaterializationErrorCode.UNAUTHORIZED_REFERENCE,
        "Plan does not honor the routing-rule note destination"
      );
    }
    if (
      ruleMatch.destinationKind === "space" &&
      (plan.decision === "create_note"
        ? plan.destination.newNote?.spaceCandidateId !== ruleMatch.destinationId
        : destinationCandidate?.spaceId !== ruleMatch.destinationId ||
          !spaces.has(ruleMatch.destinationId))
    ) {
      fail(
        OrganizationMaterializationErrorCode.UNAUTHORIZED_REFERENCE,
        "Plan does not honor the routing-rule space destination"
      );
    }
  }
  if (manifest.controls.expansionDisabled && plan.generatedExpansion !== null) {
    fail(
      OrganizationMaterializationErrorCode.INCOMPATIBLE_OPERATION,
      "Plan does not honor the expansion control"
    );
  }

  const newSpaceId = plan.destination.newNote?.spaceCandidateId ?? null;
  if (newSpaceId !== null && !spaces.has(newSpaceId)) {
    fail(
      OrganizationMaterializationErrorCode.UNAUTHORIZED_REFERENCE,
      "Plan references an unauthorized space"
    );
  }

  const routedNoteType = destinationCandidate?.noteType ?? plan.destination.newNote?.noteType;
  for (const operation of plan.operations) {
    if (operation.type === "add_tags" && operation.tagIds.some((tagId) => !tags.has(tagId))) {
      fail(
        OrganizationMaterializationErrorCode.UNAUTHORIZED_REFERENCE,
        "Plan references an unauthorized tag"
      );
    }
    if (operation.type === "add_relation") {
      const relation = candidates.get(operation.toCandidateId);
      if (relation === undefined || relation.noteId === destinationCandidate?.noteId) {
        fail(
          OrganizationMaterializationErrorCode.UNAUTHORIZED_REFERENCE,
          "Plan references an unauthorized relation"
        );
      }
    }
    if (routedNoteType !== undefined) assertOperationCompatible(operation, routedNoteType);
  }

  if (
    (plan.decision === "append_to_note" || plan.decision === "create_note") &&
    !plan.operations.some(requiresCapturedContent)
  ) {
    fail(
      OrganizationMaterializationErrorCode.INVALID_DECISION,
      "Routed plans must contain a content operation"
    );
  }
}

function assertNull(value: unknown, label: string): void {
  if (value !== null) {
    fail(
      OrganizationMaterializationErrorCode.INVALID_STABLE_ID_BINDING,
      `${label} is not valid for this decision`
    );
  }
}

function requireId<Value>(value: Value | null, label: string): Value {
  if (value === null) {
    fail(
      OrganizationMaterializationErrorCode.INVALID_STABLE_ID_BINDING,
      `${label} is required for this decision`
    );
  }
  return value;
}

function assertGeneratedBlockBinding(
  plan: OrganizationPlan,
  stableIds: StableOrganizationIds
): MaterializedGeneratedBlock | null {
  if (plan.generatedExpansion === null) {
    assertNull(stableIds.generatedBlockId, "Generated block ID");
    return null;
  }
  const blockId = requireId(stableIds.generatedBlockId, "Generated block ID");
  return {
    blockId,
    kind: plan.generatedExpansion.kind,
    text: plan.generatedExpansion.text
  };
}

function materializeOperations(
  operations: readonly ModelOperation[],
  manifest: OrganizerCandidateManifest
): readonly MaterializedOrganizationOperation[] {
  const candidates = candidateMap(manifest);
  return operations.map((operation) => {
    const parsed = ModelOperationSchema.parse(operation);
    if (parsed.type !== "add_relation") return parsed;
    const destination = candidates.get(parsed.toCandidateId);
    if (destination === undefined) {
      fail(
        OrganizationMaterializationErrorCode.UNAUTHORIZED_REFERENCE,
        "Plan references an unauthorized relation"
      );
    }
    return {
      type: "add_relation" as const,
      toNoteId: destination.noteId,
      linkType: parsed.linkType
    };
  });
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.isFrozen(value) ? value : Object.freeze(value);
}

export function parseAuthorizedOrganizationPlan(
  input: Readonly<{
    unknownPlan: unknown;
    manifest: unknown;
    captureText?: string;
  }>
): Readonly<{ plan: OrganizationPlan; manifest: OrganizerCandidateManifest }> {
  const plan = parsePlan(input.unknownPlan);
  const manifest = parseManifest(input.manifest);
  assertAuthorizedPlan(plan, manifest);
  if (input.captureText !== undefined) {
    try {
      assertPlanSourcePreserved(input.captureText, plan);
    } catch {
      fail(
        OrganizationMaterializationErrorCode.SOURCE_PRESERVATION_FAILED,
        "Plan does not preserve the capture source"
      );
    }
  }
  return deepFreeze({ plan, manifest });
}

export function materializeAuthorizedOrganizationPlan(
  input: Readonly<{
    plan: unknown;
    manifest: unknown;
    stableIds: unknown;
    captureText?: string;
  }>
): MaterializedOrganizationCommand {
  const plan = parsePlan(input.plan);
  const manifest = parseManifest(input.manifest);
  const stableIds = parseStableIds(input.stableIds);
  assertAuthorizedPlan(plan, manifest);
  if (input.captureText !== undefined) {
    try {
      assertPlanSourcePreserved(input.captureText, plan);
    } catch {
      fail(
        OrganizationMaterializationErrorCode.SOURCE_PRESERVATION_FAILED,
        "Plan does not preserve the capture source"
      );
    }
  }

  const base = {
    decisionId: stableIds.decisionId,
    validatedPlan: plan,
    generatedBlock: assertGeneratedBlockBinding(plan, stableIds)
  } as const;

  if (plan.decision === "append_to_note") {
    assertNull(stableIds.createdNoteId, "Created note ID");
    assertNull(stableIds.reviewItemId, "Review item ID");
    const candidateId = plan.destination.candidateId;
    if (candidateId === null) {
      fail(OrganizationMaterializationErrorCode.INVALID_DECISION, "Destination is invalid");
    }
    const destination = candidateMap(manifest).get(candidateId);
    if (destination === undefined) {
      fail(
        OrganizationMaterializationErrorCode.UNAUTHORIZED_REFERENCE,
        "Plan references an unauthorized destination"
      );
    }
    return deepFreeze({
      ...base,
      kind: "append" as const,
      candidateId,
      noteId: destination.noteId,
      expectedRevision: destination.revision,
      afterRevision: destination.revision + 1,
      noteType: destination.noteType,
      revisionId: requireId(stableIds.revisionId, "Revision ID"),
      mutationId: requireId(stableIds.mutationId, "Mutation ID"),
      operations: materializeOperations(plan.operations, manifest)
    });
  }

  if (plan.decision === "create_note") {
    assertNull(stableIds.reviewItemId, "Review item ID");
    const destination = plan.destination.newNote;
    if (destination === null) {
      fail(OrganizationMaterializationErrorCode.INVALID_DECISION, "Destination is invalid");
    }
    const noteId = requireId(stableIds.createdNoteId, "Created note ID");
    const candidates = candidateMap(manifest);
    if (
      candidates.has(noteId) ||
      manifest.candidates.some((candidate) => candidate.noteId === noteId)
    ) {
      fail(
        OrganizationMaterializationErrorCode.INVALID_STABLE_ID_BINDING,
        "Created note ID conflicts with the authorized manifest"
      );
    }
    return deepFreeze({
      ...base,
      kind: "create" as const,
      noteId,
      expectedRevision: 0 as const,
      afterRevision: 1 as const,
      noteType: destination.noteType,
      title: destination.title,
      spaceId: destination.spaceCandidateId,
      revisionId: requireId(stableIds.revisionId, "Revision ID"),
      mutationId: requireId(stableIds.mutationId, "Mutation ID"),
      operations: materializeOperations(plan.operations, manifest)
    });
  }

  assertNull(stableIds.createdNoteId, "Created note ID");
  assertNull(stableIds.revisionId, "Revision ID");
  assertNull(stableIds.mutationId, "Mutation ID");
  assertNull(stableIds.generatedBlockId, "Generated block ID");
  const needsReview = plan.decision === "needs_review";
  if (!needsReview) assertNull(stableIds.reviewItemId, "Review item ID");
  const candidates = candidateMap(manifest);
  return deepFreeze({
    ...base,
    kind: "review" as const,
    disposition: plan.decision,
    reviewItemId: needsReview ? requireId(stableIds.reviewItemId, "Review item ID") : null,
    alternatives: plan.alternatives.map((candidateId) => {
      const candidate = candidates.get(candidateId);
      if (candidate === undefined) {
        fail(
          OrganizationMaterializationErrorCode.UNAUTHORIZED_REFERENCE,
          "Plan references an unauthorized alternative"
        );
      }
      return {
        candidateId,
        noteId: candidate.noteId,
        revision: candidate.revision,
        noteType: candidate.noteType
      };
    })
  });
}

export function validateAndMaterializeOrganizationPlan(
  input: Readonly<{
    unknownPlan: unknown;
    manifest: unknown;
    stableIds: unknown;
    captureText?: string;
  }>
): MaterializedOrganizationCommand {
  const authorized = parseAuthorizedOrganizationPlan(input);
  return materializeAuthorizedOrganizationPlan({
    ...authorized,
    stableIds: input.stableIds,
    ...(input.captureText === undefined ? {} : { captureText: input.captureText })
  });
}
