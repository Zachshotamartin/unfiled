import {
  parseContentEnvelope,
  serializeContentEnvelope,
  type ContentEnvelopeV1
} from "@unfiled/content-crypto";
import {
  CaptureReceiptPayloadSchema,
  GeneratedBlockPayloadSchema,
  NoteContentPayloadSchema,
  NoteMutationPayloadSchema,
  NoteRevisionPayloadSchema,
  OrganizationDecisionPayloadSchema,
  OrganizationMutationAttemptPayloadSchema,
  ReviewPayloadSchema,
  RoutingRulePayloadSchema,
  SpaceDisplayPayloadSchema,
  TagDisplayPayloadSchema,
  encryptedFieldForRpc,
  keyedMacForRpc,
  type CaptureReceiptPayload,
  type EncryptedAggregateRecord,
  type GeneratedBlockPayload,
  type JsonValue,
  type KeyedMacRecord,
  type NoteContentPayload,
  type NoteMutationPayload,
  type NoteRevisionPayload,
  type OrganizationDecisionPayload,
  type OrganizationMutationAttemptPayload,
  type ReviewPayload,
  type RoutingRulePayload,
  type SealedEncryptedAggregateRecord,
  type SpaceDisplayPayload,
  type TagDisplayPayload
} from "@unfiled/encrypted-aggregate";
import type { KeyClass } from "@unfiled/key-management";

import { ServiceRpcError, ServiceRpcErrorCode, type ServiceRpcClient } from "./service-rpc-client";

export const encryptedLibrarySurfaces = Object.freeze([
  "space_display",
  "tag_display",
  "note_content",
  "note_revision",
  "organization_decision",
  "note_mutation",
  "generated_block",
  "review_item",
  "routing_rule",
  "organization_mutation_attempt",
  "idempotency_response",
  "capture_receipt",
  "capture"
] as const);

export type EncryptedLibrarySurface = (typeof encryptedLibrarySurfaces)[number];
export type BackfillableEncryptedLibrarySurface = Exclude<EncryptedLibrarySurface, "capture">;
export type EncryptionRolloutState = "expanded" | "dual_write" | "encrypted_read";

type Timestamp = string;

export type EncryptedLibraryOperationalBySurface = Readonly<{
  space_display: Readonly<{
    parentId: string | null;
    sortKey: string;
    archivedAt: Timestamp | null;
    createdAt: Timestamp;
    updatedAt: Timestamp;
  }>;
  tag_display: Readonly<{ createdAt: Timestamp; updatedAt: Timestamp }>;
  note_content: Readonly<{
    spaceId: string | null;
    type: "generic" | "list" | "log" | "principle" | "project";
    dailyDate: string | null;
    isOpen: boolean;
    pinnedAt: Timestamp | null;
    privacy: KeyClass;
    archivedAt: Timestamp | null;
    deletedAt: Timestamp | null;
    createdAt: Timestamp;
    updatedAt: Timestamp;
  }>;
  note_revision: Readonly<{
    noteId: string;
    source: "manual" | "organization" | "undo" | "import" | "interactive";
    privacy: KeyClass;
    actor: string;
    mutationId: string | null;
    createdAt: Timestamp;
  }>;
  organization_decision: Readonly<{
    captureId: string;
    band: "auto" | "review" | "inbox";
    score: number | null;
    margin: number | null;
    destinationNoteId: string | null;
    reasonCodes: readonly string[];
    createdAt: Timestamp;
  }>;
  note_mutation: Readonly<{
    decisionId: string | null;
    noteId: string;
    beforeRevision: number;
    afterRevision: number;
    undoneAt: Timestamp | null;
    createdAt: Timestamp;
  }>;
  generated_block: Readonly<{
    noteId: string;
    decisionId: string;
    kind: "summary" | "interpretation" | "suggestion" | "label";
    state: "proposed" | "accepted" | "rejected";
    modelId: string;
    promptVersion: string;
    resolvedAt: Timestamp | null;
    createdAt: Timestamp;
  }>;
  review_item: Readonly<{
    captureId: string | null;
    noteId: string | null;
    type:
      | "low_confidence"
      | "revision_conflict"
      | "failed_job"
      | "duplicate_suggestion"
      | "pending_expansion"
      | "structure_conflict";
    state: "open" | "resolved" | "dismissed";
    createdAt: Timestamp;
    resolvedAt: Timestamp | null;
  }>;
  routing_rule: Readonly<{
    currentRevision: number;
    enabled: boolean;
    ruleType: "prefix" | "phrase" | "alias" | "destination_mention";
    destinationNoteId: string | null;
    destinationSpaceId: string | null;
    priority: number;
    source: "explicit" | "correction_suggested";
    proposalState: "observing" | "offered" | "accepted" | "declined" | null;
    destinationStatus: "active" | "archived" | "deleted" | "missing";
    lastFiredAt: Timestamp | null;
    createdAt: Timestamp;
    updatedAt: Timestamp;
  }>;
  organization_mutation_attempt: Readonly<{
    jobId: string;
    noteId: string;
    plannedRevision: number;
    replanCount: number;
    state: "replanned" | "applied" | "needs_review";
    reviewItemId: string | null;
    createdAt: Timestamp;
    updatedAt: Timestamp;
  }>;
  idempotency_response: Readonly<{
    scope: string;
    requestResourceType: string;
    requestResourceId: string;
    responseResourceType: string;
    responseResourceId: string;
    responseRecordVersion: number;
    createdAt: Timestamp;
    completedAt: Timestamp | null;
    replayPolicy: "legacy_nonreplayable" | "logical_mac";
    requestMac: KeyedMacRecord | null;
  }>;
  capture_receipt: Readonly<{
    jobId: string;
    decisionId: string | null;
    reviewItemId: string | null;
    mutationId: string | null;
    outcome: "created_note" | "added_to_note" | "kept_in_inbox" | "needs_review" | "failed";
    headline: string;
    destinationNoteId: string | null;
    reasonCodes: readonly string[];
    createdAt: Timestamp;
  }>;
  capture: Readonly<{
    source: "mobile" | "web" | "ios_lock_screen_widget" | "share_sheet" | "import";
    deviceId: string;
    contentLength: number;
    privacy: KeyClass;
    explicitDestinationNoteId: string | null;
    expansionDisabled: boolean;
    clientCreatedAt: Timestamp;
    clientTimezone: string;
    receivedAt: Timestamp;
    status:
      | "pending"
      | "queued"
      | "processing"
      | "organized"
      | "inbox"
      | "needs_review"
      | "failed"
      | "deleted";
    lastErrorCode: string | null;
    deletedAt: Timestamp | null;
  }>;
}>;

export type EncryptedLibraryObject<Surface extends EncryptedLibrarySurface> = Readonly<{
  surface: Surface;
  ownerId: string;
  resourceId: string;
  recordVersion: number;
  operational: EncryptedLibraryOperationalBySurface[Surface];
  encrypted: EncryptedAggregateRecord<Surface>;
  contentMac: KeyedMacRecord | null;
}>;

export type EncryptedLibraryPage<Surface extends EncryptedLibrarySurface> = Readonly<{
  surface: Surface;
  items: readonly EncryptedLibraryObject<Surface>[];
  nextCursor: string | null;
}>;

export type ListEncryptedLibraryObjectsInput<Surface extends EncryptedLibrarySurface> = Readonly<{
  ownerId: string;
  surface: Surface;
  afterResourceId?: string | null;
  limit?: number;
}>;

export type ContentEncryptionBackfillExpectedContentBySurface = Readonly<{
  space_display: SpaceDisplayPayload;
  tag_display: TagDisplayPayload;
  note_content: NoteContentPayload;
  note_revision: NoteRevisionPayload;
  organization_decision: OrganizationDecisionPayload;
  note_mutation: NoteMutationPayload;
  generated_block: GeneratedBlockPayload;
  review_item: ReviewPayload;
  routing_rule: RoutingRulePayload;
  organization_mutation_attempt: OrganizationMutationAttemptPayload;
  idempotency_response: Readonly<{
    requestHash: string;
    responseJson: Readonly<Record<string, JsonValue>> | null;
    requestResourceType: "legacy_idempotency";
    requestResourceId: string;
    responseResourceType: "legacy_response";
    responseResourceId: string;
    responseRecordVersion: 1;
  }>;
  capture_receipt: CaptureReceiptPayload;
  capture: Readonly<{
    contentEnvelope: ContentEnvelopeV1;
    contentFingerprint: string;
  }>;
}>;

export type ContentEncryptionBackfillOperationalBySurface = Readonly<{
  space_display: Omit<EncryptedLibraryOperationalBySurface["space_display"], "createdAt">;
  tag_display: Readonly<{ updatedAt: Timestamp }>;
  note_content: Omit<
    EncryptedLibraryOperationalBySurface["note_content"],
    "pinnedAt" | "createdAt"
  >;
  note_revision: EncryptedLibraryOperationalBySurface["note_revision"] &
    Readonly<{ legacyContentHash: string }>;
  organization_decision: Omit<
    EncryptedLibraryOperationalBySurface["organization_decision"],
    "band"
  >;
  note_mutation: EncryptedLibraryOperationalBySurface["note_mutation"] &
    Readonly<{ idempotencyKey: string }>;
  generated_block: EncryptedLibraryOperationalBySurface["generated_block"];
  review_item: Omit<EncryptedLibraryOperationalBySurface["review_item"], "state">;
  routing_rule: Omit<EncryptedLibraryOperationalBySurface["routing_rule"], "createdAt">;
  organization_mutation_attempt: Omit<
    EncryptedLibraryOperationalBySurface["organization_mutation_attempt"],
    "createdAt"
  >;
  idempotency_response: Readonly<{
    scope: string;
    createdAt: Timestamp;
    completedAt: Timestamp | null;
    replayPolicy: "legacy_nonreplayable" | "logical_mac";
  }>;
  capture_receipt: Omit<EncryptedLibraryOperationalBySurface["capture_receipt"], "headline">;
  capture: Pick<
    EncryptedLibraryOperationalBySurface["capture"],
    | "source"
    | "deviceId"
    | "contentLength"
    | "clientCreatedAt"
    | "clientTimezone"
    | "privacy"
    | "status"
  >;
}>;

export type ContentEncryptionBackfillCandidate<Surface extends EncryptedLibrarySurface> = Readonly<{
  surface: Surface;
  ownerId: string;
  cursor: string;
  resourceId: string;
  recordVersion: number;
  keyClass: KeyClass;
  expectedContent: ContentEncryptionBackfillExpectedContentBySurface[Surface];
  operational: ContentEncryptionBackfillOperationalBySurface[Surface];
}>;

export type ContentEncryptionBackfillCandidatePage<Surface extends EncryptedLibrarySurface> =
  Readonly<{
    surface: Surface;
    items: readonly ContentEncryptionBackfillCandidate<Surface>[];
    nextCursor: string | null;
  }>;

export type ListContentEncryptionBackfillCandidatesInput<Surface extends EncryptedLibrarySurface> =
  Readonly<{
    ownerId: string;
    surface: Surface;
    afterCursor?: string | null;
    limit?: number;
  }>;

export type CommitContentEncryptionBackfillInput<
  Surface extends BackfillableEncryptedLibrarySurface
> = Readonly<{
  ownerId: string;
  surface: Surface;
  resourceId: string;
  expectedRecordVersion: number;
  expectedContent: ContentEncryptionBackfillExpectedContentBySurface[Surface];
  cipher: SealedEncryptedAggregateRecord<Surface>;
  contentMac: KeyedMacRecord | null;
  verificationMac: KeyedMacRecord;
  batchReference: string;
  expectedCursor: string | null;
  nextCursor: string | null;
  complete: boolean;
}>;

export type CommitContentEncryptionBackfillResult<
  Surface extends BackfillableEncryptedLibrarySurface
> = Readonly<{
  surface: Surface;
  resourceId: string;
  recordVersion: number;
  cursor: string | null;
  complete: boolean;
  replayed: boolean;
}>;

export type CompleteContentEncryptionBackfillInput = Readonly<{
  ownerId: string;
  batchReference: string;
  expectedCursor: string | null;
}>;

export type CompleteContentEncryptionBackfillResult = Readonly<{
  complete: true;
  replayed: boolean;
}>;

export type AdvanceContentEncryptionRolloutInput = Readonly<{
  ownerId: string;
  expectedState: "expanded" | "dual_write";
  nextState: "dual_write" | "encrypted_read";
}>;

export type AdvanceContentEncryptionRolloutResult = Readonly<{
  state: "dual_write" | "encrypted_read";
  readMode: "legacy" | "encrypted";
  replayed: boolean;
}>;

export type ResealCaptureContentInput = Readonly<{
  ownerId: string;
  captureId: string;
  expectedEnvelope: ContentEnvelopeV1;
  expectedFingerprint: string;
  contentCipher: SealedEncryptedAggregateRecord<"capture">;
  contentMac: KeyedMacRecord;
  verificationMac: KeyedMacRecord;
}>;

export type ResealCaptureContentResult = Readonly<{
  captureId: string;
  envelopeDigest: string | null;
  replayed: boolean;
}>;

export const verifiableEncryptedContentSurfaces = Object.freeze([
  "note_content",
  "note_mutation",
  "idempotency_response"
] as const);

export type VerifiableEncryptedContentSurface = (typeof verifiableEncryptedContentSurfaces)[number];

export type VerifyEncryptedContentObjectInput<Surface extends VerifiableEncryptedContentSurface> =
  Readonly<{
    ownerId: string;
    surface: Surface;
    resourceId: string;
    expectedRecordVersion: number;
    expectedEnvelope: ContentEnvelopeV1;
    verificationMac: KeyedMacRecord;
  }>;

export type VerifyEncryptedContentObjectResult<Surface extends VerifiableEncryptedContentSurface> =
  Readonly<{
    surface: Surface;
    resourceId: string;
    recordVersion: number;
    envelopeDigest: string;
    replayed: boolean;
  }>;

export type EncryptedLibraryRpcStore = Readonly<{
  listEncryptedLibraryObjects<Surface extends EncryptedLibrarySurface>(
    input: ListEncryptedLibraryObjectsInput<Surface>
  ): Promise<EncryptedLibraryPage<Surface>>;
  listContentEncryptionBackfillCandidates<Surface extends EncryptedLibrarySurface>(
    input: ListContentEncryptionBackfillCandidatesInput<Surface>
  ): Promise<ContentEncryptionBackfillCandidatePage<Surface>>;
  commitContentEncryptionBackfill<Surface extends BackfillableEncryptedLibrarySurface>(
    input: CommitContentEncryptionBackfillInput<Surface>
  ): Promise<CommitContentEncryptionBackfillResult<Surface>>;
  completeContentEncryptionBackfill(
    input: CompleteContentEncryptionBackfillInput
  ): Promise<CompleteContentEncryptionBackfillResult>;
  advanceContentEncryptionRollout(
    input: AdvanceContentEncryptionRolloutInput
  ): Promise<AdvanceContentEncryptionRolloutResult>;
  resealCaptureContent(input: ResealCaptureContentInput): Promise<ResealCaptureContentResult>;
  verifyEncryptedContentObject<Surface extends VerifiableEncryptedContentSurface>(
    input: VerifyEncryptedContentObjectInput<Surface>
  ): Promise<VerifyEncryptedContentObjectResult<Surface>>;
}>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ENTITY_SUFFIX = "[0-9A-HJKMNP-TV-Z]{26}";
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HEX_PATTERN = /^[0-9a-f]{64}$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 25;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;

const BACKFILL_SURFACE_RANK: Readonly<Record<EncryptedLibrarySurface, string>> = Object.freeze({
  space_display: "01",
  tag_display: "02",
  note_content: "03",
  note_revision: "04",
  organization_decision: "05",
  note_mutation: "06",
  generated_block: "07",
  review_item: "08",
  routing_rule: "09",
  organization_mutation_attempt: "10",
  idempotency_response: "11",
  capture_receipt: "12",
  capture: "13"
});

const MAC_SURFACES = new Set<EncryptedLibrarySurface>([
  "space_display",
  "tag_display",
  "note_revision",
  "capture"
]);

const BACKFILL_SURFACES = new Set<BackfillableEncryptedLibrarySurface>(
  encryptedLibrarySurfaces.filter(
    (surface): surface is BackfillableEncryptedLibrarySurface => surface !== "capture"
  )
);

type Failure = () => never;
type UnknownRecord = Readonly<Record<string, unknown>>;

function invalidInput(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.VALIDATION_FAILED);
}

function invalidProjection(): never {
  throw new ServiceRpcError(ServiceRpcErrorCode.PROVIDER_UNAVAILABLE);
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function exactRecord(value: unknown, keys: readonly string[], failure: Failure): UnknownRecord {
  if (!isRecord(value) || !hasExactKeys(value, keys)) return failure();
  return value;
}

function canonicalOwnerId(value: unknown, failure: Failure): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return failure();
  return value.toLowerCase();
}

function positiveVersion(value: unknown, failure: Failure): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return failure();
  return value;
}

function nonNegativeInteger(
  value: unknown,
  failure: Failure,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    return failure();
  }
  return value;
}

function boundedPositiveInteger(value: unknown, failure: Failure, maximum: number): number {
  const parsed = positiveVersion(value, failure);
  if (parsed > maximum) return failure();
  return parsed;
}

function boundedString(value: unknown, failure: Failure, minimum = 1, maximum = 200): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    return failure();
  }
  return value;
}

function nullableBoundedString(value: unknown, failure: Failure, maximum = 200): string | null {
  return value === null ? null : boundedString(value, failure, 1, maximum);
}

function booleanValue(value: unknown, failure: Failure): boolean {
  if (typeof value !== "boolean") return failure();
  return value;
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  failure: Failure
): Values[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) return failure();
  return value;
}

function timestamp(value: unknown, failure: Failure): Timestamp {
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !TIMESTAMP_PATTERN.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    return failure();
  }
  return value;
}

function nullableTimestamp(value: unknown, failure: Failure): Timestamp | null {
  return value === null ? null : timestamp(value, failure);
}

function entityId(value: unknown, prefix: string, failure: Failure): string {
  if (typeof value !== "string" || !new RegExp(`^${prefix}_${ENTITY_SUFFIX}$`, "u").test(value)) {
    return failure();
  }
  return value;
}

function nullableEntityId(value: unknown, prefix: string, failure: Failure): string | null {
  return value === null ? null : entityId(value, prefix, failure);
}

function resourceIdForSurface(
  value: unknown,
  surface: EncryptedLibrarySurface,
  failure: Failure
): string {
  if (surface === "organization_mutation_attempt") {
    if (typeof value !== "string") return failure();
    const [jobId, noteId, extra] = value.split(":");
    if (extra !== undefined) return failure();
    return `${entityId(jobId, "job", failure)}:${entityId(noteId, "note", failure)}`;
  }
  if (surface === "idempotency_response") {
    if (
      typeof value !== "string" ||
      !/^idempotency:[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u.test(value)
    ) {
      return failure();
    }
    return value;
  }
  const prefixes: Readonly<
    Record<
      Exclude<EncryptedLibrarySurface, "organization_mutation_attempt" | "idempotency_response">,
      string
    >
  > = {
    space_display: "spc",
    tag_display: "tag",
    note_content: "note",
    note_revision: "rev",
    organization_decision: "dec",
    note_mutation: "mut",
    generated_block: "blk",
    review_item: "rvw",
    routing_rule: "rule",
    capture_receipt: "cap",
    capture: "cap"
  };
  return entityId(value, prefixes[surface], failure);
}

function backfillCursor(value: unknown, failure: Failure): string | null {
  if (value === null) return null;
  const parsed = boundedString(value, failure, 1, 300);
  const match = /^(\d{2}):([a-z_]+):(.{1,200})$/u.exec(parsed);
  if (match === null) return failure();
  const [, rank, surfaceValue, resourceValue] = match;
  if (
    rank === undefined ||
    surfaceValue === undefined ||
    resourceValue === undefined ||
    !(encryptedLibrarySurfaces as readonly string[]).includes(surfaceValue)
  ) {
    return failure();
  }
  const surface = surfaceValue as EncryptedLibrarySurface;
  const resourceId = resourceIdForSurface(resourceValue, surface, failure);
  if (BACKFILL_SURFACE_RANK[surface] !== rank) return failure();
  return `${rank}:${surface}:${resourceId}`;
}

function stringArray(value: unknown, failure: Failure, maximum = 20): readonly string[] {
  if (
    !isUnknownArray(value) ||
    value.length > maximum ||
    value.some((item) => typeof item !== "string" || item.length < 1 || item.length > 100)
  ) {
    return failure();
  }
  return Object.freeze(value.map((item) => String(item)));
}

function nullableUnitNumber(value: unknown, failure: Failure): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return failure();
  }
  return value;
}

function parseEnvelope(value: unknown, failure: Failure): ContentEnvelopeV1 {
  try {
    return parseContentEnvelope(serializeContentEnvelope(value));
  } catch {
    return failure();
  }
}

function parseStoredCipher<Surface extends EncryptedLibrarySurface>(
  value: unknown,
  ownerId: string,
  surface: Surface,
  resourceId: string,
  recordVersion: number,
  failure: Failure
): EncryptedAggregateRecord<Surface> {
  const record = exactRecord(
    value,
    ["envelope", "keyId", "keyClass", "keyPurpose", "keyVersion"],
    failure
  );
  const keyId = boundedString(record.keyId, failure, 1, 128);
  if (!IDENTIFIER_PATTERN.test(keyId)) return failure();
  const keyClass = enumValue(record.keyClass, ["ai_assisted", "private_manual"] as const, failure);
  if (record.keyPurpose !== "object_wrap") return failure();
  const keyVersion = positiveVersion(record.keyVersion, failure);
  const envelope = parseEnvelope(record.envelope, failure);
  if (
    envelope.keyId !== keyId ||
    envelope.context.tenantId !== ownerId ||
    envelope.context.resourceId !== resourceId ||
    envelope.context.recordVersion !== recordVersion ||
    envelope.context.kind !== surface
  ) {
    return failure();
  }
  return Object.freeze({
    ownerId,
    resourceId,
    recordVersion,
    kind: surface,
    envelope,
    keyId,
    keyClass,
    keyPurpose: "object_wrap",
    keyVersion
  });
}

function parseStoredMac(value: unknown, expectedClass: KeyClass, failure: Failure): KeyedMacRecord {
  const record = exactRecord(
    value,
    ["mac", "keyId", "keyClass", "keyPurpose", "keyVersion"],
    failure
  );
  if (typeof record.mac !== "string" || !HEX_PATTERN.test(record.mac)) return failure();
  const keyId = boundedString(record.keyId, failure, 1, 128);
  if (!IDENTIFIER_PATTERN.test(keyId) || record.keyClass !== expectedClass) return failure();
  if (record.keyPurpose !== "content_mac") return failure();
  return Object.freeze({
    value: record.mac,
    keyId,
    keyClass: expectedClass,
    keyPurpose: "content_mac",
    keyVersion: positiveVersion(record.keyVersion, failure)
  });
}

function parseInputCipher<Surface extends EncryptedLibrarySurface>(
  value: unknown,
  ownerId: string,
  surface: Surface,
  resourceId: string,
  recordVersion: number
): SealedEncryptedAggregateRecord<Surface> {
  const record = exactRecord(
    value,
    [
      "ownerId",
      "resourceId",
      "recordVersion",
      "kind",
      "envelope",
      "keyId",
      "keyClass",
      "keyPurpose",
      "keyVersion",
      "reservationId"
    ],
    invalidInput
  );
  if (
    record.ownerId !== ownerId ||
    record.resourceId !== resourceId ||
    record.recordVersion !== recordVersion ||
    record.kind !== surface ||
    typeof record.reservationId !== "string" ||
    !UUID_PATTERN.test(record.reservationId)
  ) {
    return invalidInput();
  }
  const stored = parseStoredCipher(
    {
      envelope: record.envelope,
      keyId: record.keyId,
      keyClass: record.keyClass,
      keyPurpose: record.keyPurpose,
      keyVersion: record.keyVersion
    },
    ownerId,
    surface,
    resourceId,
    recordVersion,
    invalidInput
  );
  return Object.freeze({ ...stored, reservationId: record.reservationId });
}

function parseInputMac(value: unknown, expectedClass: KeyClass): KeyedMacRecord {
  const record = exactRecord(
    value,
    ["value", "keyId", "keyClass", "keyPurpose", "keyVersion"],
    invalidInput
  );
  return parseStoredMac(
    {
      mac: record.value,
      keyId: record.keyId,
      keyClass: record.keyClass,
      keyPurpose: record.keyPurpose,
      keyVersion: record.keyVersion
    },
    expectedClass,
    invalidInput
  );
}

function parseInputMacWithBoundClass(value: unknown): KeyedMacRecord {
  const record = exactRecord(
    value,
    ["value", "keyId", "keyClass", "keyPurpose", "keyVersion"],
    invalidInput
  );
  const keyClass = enumValue(
    record.keyClass,
    ["ai_assisted", "private_manual"] as const,
    invalidInput
  );
  return parseInputMac(value, keyClass);
}

function assertExpectedKeyClass(
  surface: EncryptedLibrarySurface,
  keyClass: KeyClass,
  operational: EncryptedLibraryOperationalBySurface[EncryptedLibrarySurface]
): void {
  if (
    (["space_display", "tag_display", "routing_rule"] as const).includes(
      surface as "space_display"
    ) &&
    keyClass !== "private_manual"
  ) {
    invalidProjection();
  }
  if (
    (
      ["organization_decision", "generated_block", "organization_mutation_attempt"] as const
    ).includes(surface as "organization_decision") &&
    keyClass !== "ai_assisted"
  ) {
    invalidProjection();
  }
  if (surface === "note_content" || surface === "capture") {
    const privacy = (operational as { privacy: KeyClass }).privacy;
    if (keyClass !== privacy) invalidProjection();
  }
  if (
    surface === "note_revision" &&
    (operational as EncryptedLibraryOperationalBySurface["note_revision"]).privacy ===
      "private_manual" &&
    keyClass !== "private_manual"
  ) {
    invalidProjection();
  }
}

function parseOperational(
  surface: EncryptedLibrarySurface,
  value: unknown,
  resourceId: string,
  recordVersion: number
): EncryptedLibraryOperationalBySurface[EncryptedLibrarySurface] {
  const fail = invalidProjection;
  switch (surface) {
    case "space_display": {
      const row = exactRecord(
        value,
        ["parentId", "sortKey", "archivedAt", "createdAt", "updatedAt"],
        fail
      );
      return Object.freeze({
        parentId: nullableEntityId(row.parentId, "spc", fail),
        sortKey: boundedString(row.sortKey, fail, 1, 100),
        archivedAt: nullableTimestamp(row.archivedAt, fail),
        createdAt: timestamp(row.createdAt, fail),
        updatedAt: timestamp(row.updatedAt, fail)
      });
    }
    case "tag_display": {
      const row = exactRecord(value, ["createdAt", "updatedAt"], fail);
      return Object.freeze({
        createdAt: timestamp(row.createdAt, fail),
        updatedAt: timestamp(row.updatedAt, fail)
      });
    }
    case "note_content": {
      const row = exactRecord(
        value,
        [
          "spaceId",
          "type",
          "dailyDate",
          "isOpen",
          "pinnedAt",
          "privacy",
          "archivedAt",
          "deletedAt",
          "createdAt",
          "updatedAt"
        ],
        fail
      );
      if (
        row.dailyDate !== null &&
        (typeof row.dailyDate !== "string" || !DATE_PATTERN.test(row.dailyDate))
      ) {
        return fail();
      }
      return Object.freeze({
        spaceId: nullableEntityId(row.spaceId, "spc", fail),
        type: enumValue(
          row.type,
          ["generic", "list", "log", "principle", "project"] as const,
          fail
        ),
        dailyDate: row.dailyDate,
        isOpen: booleanValue(row.isOpen, fail),
        pinnedAt: nullableTimestamp(row.pinnedAt, fail),
        privacy: enumValue(row.privacy, ["ai_assisted", "private_manual"] as const, fail),
        archivedAt: nullableTimestamp(row.archivedAt, fail),
        deletedAt: nullableTimestamp(row.deletedAt, fail),
        createdAt: timestamp(row.createdAt, fail),
        updatedAt: timestamp(row.updatedAt, fail)
      });
    }
    case "note_revision": {
      const row = exactRecord(
        value,
        ["noteId", "source", "privacy", "actor", "mutationId", "createdAt"],
        fail
      );
      return Object.freeze({
        noteId: entityId(row.noteId, "note", fail),
        source: enumValue(
          row.source,
          ["manual", "organization", "undo", "import", "interactive"] as const,
          fail
        ),
        privacy: enumValue(row.privacy, ["ai_assisted", "private_manual"] as const, fail),
        actor: boundedString(row.actor, fail, 1, 200),
        mutationId: nullableEntityId(row.mutationId, "mut", fail),
        createdAt: timestamp(row.createdAt, fail)
      });
    }
    case "organization_decision": {
      const row = exactRecord(
        value,
        ["captureId", "band", "score", "margin", "destinationNoteId", "reasonCodes", "createdAt"],
        fail
      );
      return Object.freeze({
        captureId: entityId(row.captureId, "cap", fail),
        band: enumValue(row.band, ["auto", "review", "inbox"] as const, fail),
        score: nullableUnitNumber(row.score, fail),
        margin: nullableUnitNumber(row.margin, fail),
        destinationNoteId: nullableEntityId(row.destinationNoteId, "note", fail),
        reasonCodes: stringArray(row.reasonCodes, fail),
        createdAt: timestamp(row.createdAt, fail)
      });
    }
    case "note_mutation": {
      const row = exactRecord(
        value,
        ["decisionId", "noteId", "beforeRevision", "afterRevision", "undoneAt", "createdAt"],
        fail
      );
      const beforeRevision = nonNegativeInteger(row.beforeRevision, fail);
      const afterRevision = positiveVersion(row.afterRevision, fail);
      if (afterRevision !== recordVersion || afterRevision !== beforeRevision + 1) return fail();
      return Object.freeze({
        decisionId: nullableEntityId(row.decisionId, "dec", fail),
        noteId: entityId(row.noteId, "note", fail),
        beforeRevision,
        afterRevision,
        undoneAt: nullableTimestamp(row.undoneAt, fail),
        createdAt: timestamp(row.createdAt, fail)
      });
    }
    case "generated_block": {
      const row = exactRecord(
        value,
        [
          "noteId",
          "decisionId",
          "kind",
          "state",
          "modelId",
          "promptVersion",
          "resolvedAt",
          "createdAt"
        ],
        fail
      );
      if (recordVersion !== 1) return fail();
      return Object.freeze({
        noteId: entityId(row.noteId, "note", fail),
        decisionId: entityId(row.decisionId, "dec", fail),
        kind: enumValue(
          row.kind,
          ["summary", "interpretation", "suggestion", "label"] as const,
          fail
        ),
        state: enumValue(row.state, ["proposed", "accepted", "rejected"] as const, fail),
        modelId: boundedString(row.modelId, fail, 1, 200),
        promptVersion: boundedString(row.promptVersion, fail, 1, 100),
        resolvedAt: nullableTimestamp(row.resolvedAt, fail),
        createdAt: timestamp(row.createdAt, fail)
      });
    }
    case "review_item": {
      const row = exactRecord(
        value,
        ["captureId", "noteId", "type", "state", "createdAt", "resolvedAt"],
        fail
      );
      return Object.freeze({
        captureId: nullableEntityId(row.captureId, "cap", fail),
        noteId: nullableEntityId(row.noteId, "note", fail),
        type: enumValue(
          row.type,
          [
            "low_confidence",
            "revision_conflict",
            "failed_job",
            "duplicate_suggestion",
            "pending_expansion",
            "structure_conflict"
          ] as const,
          fail
        ),
        state: enumValue(row.state, ["open", "resolved", "dismissed"] as const, fail),
        createdAt: timestamp(row.createdAt, fail),
        resolvedAt: nullableTimestamp(row.resolvedAt, fail)
      });
    }
    case "routing_rule": {
      const row = exactRecord(
        value,
        [
          "currentRevision",
          "enabled",
          "ruleType",
          "destinationNoteId",
          "destinationSpaceId",
          "priority",
          "source",
          "proposalState",
          "destinationStatus",
          "lastFiredAt",
          "createdAt",
          "updatedAt"
        ],
        fail
      );
      const destinationNoteId = nullableEntityId(row.destinationNoteId, "note", fail);
      const destinationSpaceId = nullableEntityId(row.destinationSpaceId, "spc", fail);
      if ((destinationNoteId === null) === (destinationSpaceId === null)) return fail();
      return Object.freeze({
        currentRevision: positiveVersion(row.currentRevision, fail),
        enabled: booleanValue(row.enabled, fail),
        ruleType: enumValue(
          row.ruleType,
          ["prefix", "phrase", "alias", "destination_mention"] as const,
          fail
        ),
        destinationNoteId,
        destinationSpaceId,
        priority: nonNegativeInteger(row.priority, fail, 10_000),
        source: enumValue(row.source, ["explicit", "correction_suggested"] as const, fail),
        proposalState:
          row.proposalState === null
            ? null
            : enumValue(
                row.proposalState,
                ["observing", "offered", "accepted", "declined"] as const,
                fail
              ),
        destinationStatus: enumValue(
          row.destinationStatus,
          ["active", "archived", "deleted", "missing"] as const,
          fail
        ),
        lastFiredAt: nullableTimestamp(row.lastFiredAt, fail),
        createdAt: timestamp(row.createdAt, fail),
        updatedAt: timestamp(row.updatedAt, fail)
      });
    }
    case "organization_mutation_attempt": {
      const row = exactRecord(
        value,
        [
          "jobId",
          "noteId",
          "plannedRevision",
          "replanCount",
          "state",
          "reviewItemId",
          "createdAt",
          "updatedAt"
        ],
        fail
      );
      const jobId = entityId(row.jobId, "job", fail);
      const noteId = entityId(row.noteId, "note", fail);
      if (`${jobId}:${noteId}` !== resourceId) return fail();
      return Object.freeze({
        jobId,
        noteId,
        plannedRevision: positiveVersion(row.plannedRevision, fail),
        replanCount: nonNegativeInteger(row.replanCount, fail, 1),
        state: enumValue(row.state, ["replanned", "applied", "needs_review"] as const, fail),
        reviewItemId: nullableEntityId(row.reviewItemId, "rvw", fail),
        createdAt: timestamp(row.createdAt, fail),
        updatedAt: timestamp(row.updatedAt, fail)
      });
    }
    case "idempotency_response": {
      const row = exactRecord(
        value,
        [
          "scope",
          "requestResourceType",
          "requestResourceId",
          "responseResourceType",
          "responseResourceId",
          "responseRecordVersion",
          "createdAt",
          "completedAt",
          "replayPolicy",
          "requestMac"
        ],
        fail
      );
      if (recordVersion !== 1) return fail();
      const scope = boundedString(row.scope, fail, 1, 100);
      if (!/^[a-z][a-z0-9_]{0,99}$/u.test(scope)) return fail();
      return Object.freeze({
        scope,
        requestResourceType: boundedString(row.requestResourceType, fail, 1, 80),
        requestResourceId: boundedString(row.requestResourceId, fail, 1, 200),
        responseResourceType: boundedString(row.responseResourceType, fail, 1, 80),
        responseResourceId: boundedString(row.responseResourceId, fail, 1, 200),
        responseRecordVersion: positiveVersion(row.responseRecordVersion, fail),
        createdAt: timestamp(row.createdAt, fail),
        completedAt: nullableTimestamp(row.completedAt, fail),
        replayPolicy: enumValue(
          row.replayPolicy,
          ["legacy_nonreplayable", "logical_mac"] as const,
          fail
        ),
        requestMac: row.requestMac as KeyedMacRecord | null
      });
    }
    case "capture_receipt": {
      const row = exactRecord(
        value,
        [
          "jobId",
          "decisionId",
          "reviewItemId",
          "mutationId",
          "outcome",
          "headline",
          "destinationNoteId",
          "reasonCodes",
          "createdAt"
        ],
        fail
      );
      return Object.freeze({
        jobId: entityId(row.jobId, "job", fail),
        decisionId: nullableEntityId(row.decisionId, "dec", fail),
        reviewItemId: nullableEntityId(row.reviewItemId, "rvw", fail),
        mutationId: nullableEntityId(row.mutationId, "mut", fail),
        outcome: enumValue(
          row.outcome,
          ["created_note", "added_to_note", "kept_in_inbox", "needs_review", "failed"] as const,
          fail
        ),
        headline: boundedString(row.headline, fail, 1, 240),
        destinationNoteId: nullableEntityId(row.destinationNoteId, "note", fail),
        reasonCodes: stringArray(row.reasonCodes, fail),
        createdAt: timestamp(row.createdAt, fail)
      });
    }
    case "capture": {
      const row = exactRecord(
        value,
        [
          "source",
          "deviceId",
          "contentLength",
          "privacy",
          "explicitDestinationNoteId",
          "expansionDisabled",
          "clientCreatedAt",
          "clientTimezone",
          "receivedAt",
          "status",
          "lastErrorCode",
          "deletedAt"
        ],
        fail
      );
      if (recordVersion !== 1) return fail();
      return Object.freeze({
        source: enumValue(
          row.source,
          ["mobile", "web", "ios_lock_screen_widget", "share_sheet", "import"] as const,
          fail
        ),
        deviceId: boundedString(row.deviceId, fail, 0, 120),
        contentLength: boundedPositiveInteger(row.contentLength, fail, 10_000),
        privacy: enumValue(row.privacy, ["ai_assisted", "private_manual"] as const, fail),
        explicitDestinationNoteId: nullableEntityId(row.explicitDestinationNoteId, "note", fail),
        expansionDisabled: booleanValue(row.expansionDisabled, fail),
        clientCreatedAt: timestamp(row.clientCreatedAt, fail),
        clientTimezone: boundedString(row.clientTimezone, fail, 1, 100),
        receivedAt: timestamp(row.receivedAt, fail),
        status: enumValue(
          row.status,
          [
            "pending",
            "queued",
            "processing",
            "organized",
            "inbox",
            "needs_review",
            "failed",
            "deleted"
          ] as const,
          fail
        ),
        lastErrorCode: nullableBoundedString(row.lastErrorCode, fail, 100),
        deletedAt: nullableTimestamp(row.deletedAt, fail)
      });
    }
  }
}

function jsonValue(value: unknown): value is JsonValue {
  const state = { nodes: 0 };
  function visit(candidate: unknown, depth: number): boolean {
    state.nodes += 1;
    if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return false;
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") {
      return true;
    }
    if (typeof candidate === "number") return Number.isFinite(candidate);
    if (Array.isArray(candidate)) return candidate.every((item) => visit(item, depth + 1));
    if (!isRecord(candidate) || Object.getOwnPropertySymbols(candidate).length > 0) return false;
    const prototype: unknown = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    return Object.entries(descriptors).every(
      ([key, descriptor]) =>
        key !== "__proto__" &&
        key !== "constructor" &&
        key !== "prototype" &&
        descriptor.enumerable &&
        "value" in descriptor &&
        visit(descriptor.value, depth + 1)
    );
  }
  return visit(value, 0);
}

function jsonObject(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return isRecord(value) && jsonValue(value);
}

function parsedJsonObject(value: unknown, failure: Failure): Readonly<Record<string, JsonValue>> {
  if (!jsonObject(value)) return failure();
  return value;
}

type SafePayloadParser<Value> = Readonly<{
  safeParse(
    value: unknown
  ): Readonly<{ success: true; data: Value }> | Readonly<{ success: false }>;
}>;

function parsedStrictPayload<Value>(
  value: unknown,
  parser: SafePayloadParser<Value>,
  failure: Failure
): Value {
  const result = parser.safeParse(value);
  return result.success ? result.data : failure();
}

function parseBackfillExpectedContent(
  surface: EncryptedLibrarySurface,
  value: unknown,
  ownerId: string,
  resourceId: string,
  recordVersion: number
): ContentEncryptionBackfillExpectedContentBySurface[EncryptedLibrarySurface] {
  const fail = invalidProjection;
  switch (surface) {
    case "space_display":
      return Object.freeze(parsedStrictPayload(value, SpaceDisplayPayloadSchema, fail));
    case "tag_display":
      return Object.freeze(parsedStrictPayload(value, TagDisplayPayloadSchema, fail));
    case "note_content":
      return Object.freeze(parsedStrictPayload(value, NoteContentPayloadSchema, fail));
    case "note_revision": {
      return Object.freeze(parsedStrictPayload(value, NoteRevisionPayloadSchema, fail));
    }
    case "organization_decision":
      return Object.freeze(parsedStrictPayload(value, OrganizationDecisionPayloadSchema, fail));
    case "note_mutation": {
      const payload = parsedStrictPayload(value, NoteMutationPayloadSchema, fail);
      if (payload.afterRevision !== recordVersion) return fail();
      return Object.freeze(payload);
    }
    case "generated_block":
      return Object.freeze(parsedStrictPayload(value, GeneratedBlockPayloadSchema, fail));
    case "review_item":
      return Object.freeze(parsedStrictPayload(value, ReviewPayloadSchema, fail));
    case "routing_rule": {
      return Object.freeze(parsedStrictPayload(value, RoutingRulePayloadSchema, fail));
    }
    case "organization_mutation_attempt":
      return Object.freeze(
        parsedStrictPayload(value, OrganizationMutationAttemptPayloadSchema, fail)
      );
    case "idempotency_response": {
      const row = exactRecord(
        value,
        [
          "requestHash",
          "responseJson",
          "requestResourceType",
          "requestResourceId",
          "responseResourceType",
          "responseResourceId",
          "responseRecordVersion"
        ],
        fail
      );
      if (
        recordVersion !== 1 ||
        typeof row.requestHash !== "string" ||
        !HEX_PATTERN.test(row.requestHash) ||
        row.requestResourceType !== "legacy_idempotency" ||
        row.requestResourceId !== resourceId ||
        row.responseResourceType !== "legacy_response" ||
        row.responseResourceId !== resourceId ||
        row.responseRecordVersion !== 1
      ) {
        return fail();
      }
      return Object.freeze({
        requestHash: row.requestHash,
        responseJson: row.responseJson === null ? null : parsedJsonObject(row.responseJson, fail),
        requestResourceType: "legacy_idempotency",
        requestResourceId: resourceId,
        responseResourceType: "legacy_response",
        responseResourceId: resourceId,
        responseRecordVersion: 1
      });
    }
    case "capture_receipt": {
      const payload = parsedStrictPayload(value, CaptureReceiptPayloadSchema, fail);
      if (payload.captureId !== resourceId) return fail();
      return Object.freeze(payload);
    }
    case "capture": {
      const row = exactRecord(value, ["contentEnvelope", "contentFingerprint"], fail);
      if (
        recordVersion !== 1 ||
        typeof row.contentFingerprint !== "string" ||
        !HEX_PATTERN.test(row.contentFingerprint)
      ) {
        return fail();
      }
      const contentEnvelope = parseEnvelope(row.contentEnvelope, fail);
      if (
        contentEnvelope.context.tenantId !== ownerId ||
        contentEnvelope.context.resourceId !== resourceId ||
        contentEnvelope.context.recordVersion !== 1 ||
        contentEnvelope.context.kind !== "capture"
      ) {
        return fail();
      }
      return Object.freeze({
        contentEnvelope,
        contentFingerprint: row.contentFingerprint
      });
    }
  }
}

function parseBackfillOperational(
  surface: EncryptedLibrarySurface,
  value: unknown,
  resourceId: string,
  recordVersion: number
): ContentEncryptionBackfillOperationalBySurface[EncryptedLibrarySurface] {
  const fail = invalidProjection;
  switch (surface) {
    case "space_display": {
      const row = exactRecord(value, ["parentId", "sortKey", "archivedAt", "updatedAt"], fail);
      return Object.freeze({
        parentId: nullableEntityId(row.parentId, "spc", fail),
        sortKey: boundedString(row.sortKey, fail, 1, 100),
        archivedAt: nullableTimestamp(row.archivedAt, fail),
        updatedAt: timestamp(row.updatedAt, fail)
      });
    }
    case "tag_display": {
      const row = exactRecord(value, ["updatedAt"], fail);
      return Object.freeze({ updatedAt: timestamp(row.updatedAt, fail) });
    }
    case "note_content": {
      const row = exactRecord(
        value,
        [
          "spaceId",
          "type",
          "dailyDate",
          "isOpen",
          "privacy",
          "archivedAt",
          "deletedAt",
          "updatedAt"
        ],
        fail
      );
      if (
        row.dailyDate !== null &&
        (typeof row.dailyDate !== "string" || !DATE_PATTERN.test(row.dailyDate))
      ) {
        return fail();
      }
      return Object.freeze({
        spaceId: nullableEntityId(row.spaceId, "spc", fail),
        type: enumValue(
          row.type,
          ["generic", "list", "log", "principle", "project"] as const,
          fail
        ),
        dailyDate: row.dailyDate,
        isOpen: booleanValue(row.isOpen, fail),
        privacy: enumValue(row.privacy, ["ai_assisted", "private_manual"] as const, fail),
        archivedAt: nullableTimestamp(row.archivedAt, fail),
        deletedAt: nullableTimestamp(row.deletedAt, fail),
        updatedAt: timestamp(row.updatedAt, fail)
      });
    }
    case "note_revision": {
      const row = exactRecord(
        value,
        ["noteId", "source", "privacy", "actor", "mutationId", "createdAt", "legacyContentHash"],
        fail
      );
      if (typeof row.legacyContentHash !== "string" || !HEX_PATTERN.test(row.legacyContentHash)) {
        return fail();
      }
      return Object.freeze({
        noteId: entityId(row.noteId, "note", fail),
        source: enumValue(
          row.source,
          ["manual", "organization", "undo", "import", "interactive"] as const,
          fail
        ),
        privacy: enumValue(row.privacy, ["ai_assisted", "private_manual"] as const, fail),
        actor: boundedString(row.actor, fail, 1, 200),
        mutationId: nullableEntityId(row.mutationId, "mut", fail),
        createdAt: timestamp(row.createdAt, fail),
        legacyContentHash: row.legacyContentHash
      });
    }
    case "organization_decision": {
      const row = exactRecord(
        value,
        ["captureId", "destinationNoteId", "score", "margin", "reasonCodes", "createdAt"],
        fail
      );
      return Object.freeze({
        captureId: entityId(row.captureId, "cap", fail),
        destinationNoteId: nullableEntityId(row.destinationNoteId, "note", fail),
        score: nullableUnitNumber(row.score, fail),
        margin: nullableUnitNumber(row.margin, fail),
        reasonCodes: stringArray(row.reasonCodes, fail),
        createdAt: timestamp(row.createdAt, fail)
      });
    }
    case "note_mutation": {
      const row = exactRecord(
        value,
        [
          "noteId",
          "decisionId",
          "beforeRevision",
          "afterRevision",
          "idempotencyKey",
          "undoneAt",
          "createdAt"
        ],
        fail
      );
      const beforeRevision = nonNegativeInteger(row.beforeRevision, fail);
      const afterRevision = positiveVersion(row.afterRevision, fail);
      if (afterRevision !== recordVersion || afterRevision !== beforeRevision + 1) return fail();
      return Object.freeze({
        decisionId: nullableEntityId(row.decisionId, "dec", fail),
        noteId: entityId(row.noteId, "note", fail),
        beforeRevision,
        afterRevision,
        idempotencyKey: boundedString(row.idempotencyKey, fail, 1, 200),
        undoneAt: nullableTimestamp(row.undoneAt, fail),
        createdAt: timestamp(row.createdAt, fail)
      });
    }
    case "generated_block":
      return parseOperational(
        surface,
        value,
        resourceId,
        recordVersion
      ) as ContentEncryptionBackfillOperationalBySurface["generated_block"];
    case "review_item": {
      const row = exactRecord(
        value,
        ["captureId", "noteId", "type", "createdAt", "resolvedAt"],
        fail
      );
      return Object.freeze({
        captureId: nullableEntityId(row.captureId, "cap", fail),
        noteId: nullableEntityId(row.noteId, "note", fail),
        type: enumValue(
          row.type,
          [
            "low_confidence",
            "revision_conflict",
            "failed_job",
            "duplicate_suggestion",
            "pending_expansion",
            "structure_conflict"
          ] as const,
          fail
        ),
        createdAt: timestamp(row.createdAt, fail),
        resolvedAt: nullableTimestamp(row.resolvedAt, fail)
      });
    }
    case "routing_rule": {
      const row = exactRecord(
        value,
        [
          "currentRevision",
          "enabled",
          "ruleType",
          "destinationNoteId",
          "destinationSpaceId",
          "priority",
          "source",
          "proposalState",
          "destinationStatus",
          "lastFiredAt",
          "updatedAt"
        ],
        fail
      );
      const destinationNoteId = nullableEntityId(row.destinationNoteId, "note", fail);
      const destinationSpaceId = nullableEntityId(row.destinationSpaceId, "spc", fail);
      if ((destinationNoteId === null) === (destinationSpaceId === null)) return fail();
      return Object.freeze({
        currentRevision: positiveVersion(row.currentRevision, fail),
        enabled: booleanValue(row.enabled, fail),
        ruleType: enumValue(
          row.ruleType,
          ["prefix", "phrase", "alias", "destination_mention"] as const,
          fail
        ),
        destinationNoteId,
        destinationSpaceId,
        priority: nonNegativeInteger(row.priority, fail, 10_000),
        source: enumValue(row.source, ["explicit", "correction_suggested"] as const, fail),
        proposalState:
          row.proposalState === null
            ? null
            : enumValue(
                row.proposalState,
                ["observing", "offered", "accepted", "declined"] as const,
                fail
              ),
        destinationStatus: enumValue(
          row.destinationStatus,
          ["active", "archived", "deleted", "missing"] as const,
          fail
        ),
        lastFiredAt: nullableTimestamp(row.lastFiredAt, fail),
        updatedAt: timestamp(row.updatedAt, fail)
      });
    }
    case "organization_mutation_attempt": {
      const row = exactRecord(
        value,
        ["jobId", "noteId", "plannedRevision", "replanCount", "state", "reviewItemId", "updatedAt"],
        fail
      );
      const jobId = entityId(row.jobId, "job", fail);
      const noteId = entityId(row.noteId, "note", fail);
      if (`${jobId}:${noteId}` !== resourceId) return fail();
      return Object.freeze({
        jobId,
        noteId,
        plannedRevision: positiveVersion(row.plannedRevision, fail),
        replanCount: nonNegativeInteger(row.replanCount, fail, 1),
        state: enumValue(row.state, ["replanned", "applied", "needs_review"] as const, fail),
        reviewItemId: nullableEntityId(row.reviewItemId, "rvw", fail),
        updatedAt: timestamp(row.updatedAt, fail)
      });
    }
    case "idempotency_response": {
      const row = exactRecord(value, ["scope", "createdAt", "completedAt", "replayPolicy"], fail);
      const scope = boundedString(row.scope, fail, 1, 100);
      if (!/^[a-z][a-z0-9_]{0,99}$/u.test(scope)) return fail();
      return Object.freeze({
        scope,
        createdAt: timestamp(row.createdAt, fail),
        completedAt: nullableTimestamp(row.completedAt, fail),
        replayPolicy: enumValue(
          row.replayPolicy,
          ["legacy_nonreplayable", "logical_mac"] as const,
          fail
        )
      });
    }
    case "capture_receipt": {
      const row = exactRecord(
        value,
        [
          "jobId",
          "decisionId",
          "reviewItemId",
          "mutationId",
          "outcome",
          "destinationNoteId",
          "reasonCodes",
          "createdAt"
        ],
        fail
      );
      return Object.freeze({
        jobId: entityId(row.jobId, "job", fail),
        decisionId: nullableEntityId(row.decisionId, "dec", fail),
        reviewItemId: nullableEntityId(row.reviewItemId, "rvw", fail),
        mutationId: nullableEntityId(row.mutationId, "mut", fail),
        outcome: enumValue(
          row.outcome,
          ["created_note", "added_to_note", "kept_in_inbox", "needs_review", "failed"] as const,
          fail
        ),
        destinationNoteId: nullableEntityId(row.destinationNoteId, "note", fail),
        reasonCodes: stringArray(row.reasonCodes, fail),
        createdAt: timestamp(row.createdAt, fail)
      });
    }
    case "capture": {
      const row = exactRecord(
        value,
        [
          "source",
          "deviceId",
          "contentLength",
          "clientCreatedAt",
          "clientTimezone",
          "privacy",
          "status"
        ],
        fail
      );
      if (recordVersion !== 1) return fail();
      return Object.freeze({
        source: enumValue(
          row.source,
          ["mobile", "web", "ios_lock_screen_widget", "share_sheet", "import"] as const,
          fail
        ),
        deviceId: boundedString(row.deviceId, fail, 0, 120),
        contentLength: boundedPositiveInteger(row.contentLength, fail, 10_000),
        clientCreatedAt: timestamp(row.clientCreatedAt, fail),
        clientTimezone: boundedString(row.clientTimezone, fail, 1, 100),
        privacy: enumValue(row.privacy, ["ai_assisted", "private_manual"] as const, fail),
        status: enumValue(
          row.status,
          [
            "pending",
            "queued",
            "processing",
            "organized",
            "inbox",
            "needs_review",
            "failed",
            "deleted"
          ] as const,
          fail
        )
      });
    }
  }
}

function parseBackfillCandidate<Surface extends EncryptedLibrarySurface>(
  value: unknown,
  ownerId: string,
  surface: Surface
): ContentEncryptionBackfillCandidate<Surface> {
  const row = exactRecord(
    value,
    ["cursor", "resource_id", "record_version", "key_class", "expected_content", "operational"],
    invalidProjection
  );
  const resourceId = resourceIdForSurface(row.resource_id, surface, invalidProjection);
  const recordVersion = positiveVersion(row.record_version, invalidProjection);
  const candidateCursor = backfillCursor(row.cursor, invalidProjection);
  const expectedCursor = `${BACKFILL_SURFACE_RANK[surface]}:${surface}:${resourceId}`;
  if (candidateCursor !== expectedCursor) return invalidProjection();
  const keyClass = enumValue(
    row.key_class,
    ["ai_assisted", "private_manual"] as const,
    invalidProjection
  );
  const expectedContent = parseBackfillExpectedContent(
    surface,
    row.expected_content,
    ownerId,
    resourceId,
    recordVersion
  );
  const operational = parseBackfillOperational(surface, row.operational, resourceId, recordVersion);
  assertExpectedKeyClass(
    surface,
    keyClass,
    operational as EncryptedLibraryOperationalBySurface[EncryptedLibrarySurface]
  );
  if (surface === "idempotency_response" && keyClass !== "private_manual") {
    return invalidProjection();
  }
  if (surface === "note_revision") {
    const revision = expectedContent as NoteRevisionPayload;
    const metadata = operational as ContentEncryptionBackfillOperationalBySurface["note_revision"];
    if (revision.snapshot.privacy !== metadata.privacy) return invalidProjection();
  }
  if (surface === "note_mutation") {
    const mutation = expectedContent as NoteMutationPayload;
    const metadata = operational as ContentEncryptionBackfillOperationalBySurface["note_mutation"];
    if (
      mutation.beforeRevision !== metadata.beforeRevision ||
      mutation.afterRevision !== metadata.afterRevision
    ) {
      return invalidProjection();
    }
  }
  if (surface === "capture_receipt") {
    const receipt = expectedContent as CaptureReceiptPayload;
    const metadata =
      operational as ContentEncryptionBackfillOperationalBySurface["capture_receipt"];
    if (
      receipt.jobId !== metadata.jobId ||
      receipt.decisionId !== metadata.decisionId ||
      receipt.reviewItemId !== metadata.reviewItemId ||
      receipt.mutationId !== metadata.mutationId ||
      receipt.outcome !== metadata.outcome ||
      receipt.destination?.noteId !== metadata.destinationNoteId ||
      receipt.createdAt !== metadata.createdAt
    ) {
      return invalidProjection();
    }
  }
  return Object.freeze({
    surface,
    ownerId,
    cursor: expectedCursor,
    resourceId,
    recordVersion,
    keyClass,
    expectedContent: expectedContent as ContentEncryptionBackfillExpectedContentBySurface[Surface],
    operational: operational as ContentEncryptionBackfillOperationalBySurface[Surface]
  });
}

function parseListRow<Surface extends EncryptedLibrarySurface>(
  value: unknown,
  ownerId: string,
  surface: Surface
): EncryptedLibraryObject<Surface> {
  const row = exactRecord(
    value,
    ["resource_id", "record_version", "operational", "content_cipher", "content_mac"],
    invalidProjection
  );
  const resourceId = resourceIdForSurface(row.resource_id, surface, invalidProjection);
  const recordVersion = positiveVersion(row.record_version, invalidProjection);
  const operational = parseOperational(surface, row.operational, resourceId, recordVersion);
  const encrypted = parseStoredCipher(
    row.content_cipher,
    ownerId,
    surface,
    resourceId,
    recordVersion,
    invalidProjection
  );
  assertExpectedKeyClass(surface, encrypted.keyClass, operational);
  let contentMac: KeyedMacRecord | null;
  if (MAC_SURFACES.has(surface)) {
    contentMac = parseStoredMac(row.content_mac, encrypted.keyClass, invalidProjection);
  } else {
    if (row.content_mac !== null) return invalidProjection();
    contentMac = null;
  }
  if (surface === "idempotency_response") {
    const idempotencyOperational =
      operational as EncryptedLibraryOperationalBySurface["idempotency_response"];
    const source = (row.operational as UnknownRecord).requestMac;
    const requestMac =
      idempotencyOperational.replayPolicy === "logical_mac"
        ? parseStoredMac(source, encrypted.keyClass, invalidProjection)
        : source === null
          ? null
          : invalidProjection();
    return Object.freeze({
      surface,
      ownerId,
      resourceId,
      recordVersion,
      operational: Object.freeze({
        ...idempotencyOperational,
        requestMac
      }) as EncryptedLibraryOperationalBySurface[Surface],
      encrypted,
      contentMac
    });
  }
  return Object.freeze({
    surface,
    ownerId,
    resourceId,
    recordVersion,
    operational: operational as EncryptedLibraryOperationalBySurface[Surface],
    encrypted,
    contentMac
  });
}

function validBatchReference(value: unknown): string {
  return boundedString(value, invalidInput, 1, 120);
}

function parseCommitResult<Surface extends BackfillableEncryptedLibrarySurface>(
  value: unknown,
  input: Readonly<{
    surface: Surface;
    resourceId: string;
    recordVersion: number;
    nextCursor: string | null;
    complete: boolean;
  }>
): CommitContentEncryptionBackfillResult<Surface> {
  const result = exactRecord(
    value,
    ["surface", "resourceId", "recordVersion", "cursor", "complete", "replayed"],
    invalidProjection
  );
  if (
    result.surface !== input.surface ||
    result.resourceId !== input.resourceId ||
    result.recordVersion !== input.recordVersion ||
    result.cursor !== input.nextCursor ||
    result.complete !== input.complete ||
    typeof result.replayed !== "boolean"
  ) {
    return invalidProjection();
  }
  return Object.freeze({
    surface: input.surface,
    resourceId: input.resourceId,
    recordVersion: input.recordVersion,
    cursor: input.nextCursor,
    complete: input.complete,
    replayed: result.replayed
  });
}

export function createEncryptedLibraryRpcStore(client: ServiceRpcClient): EncryptedLibraryRpcStore {
  return Object.freeze({
    async listEncryptedLibraryObjects<Surface extends EncryptedLibrarySurface>(
      input: ListEncryptedLibraryObjectsInput<Surface>
    ): Promise<EncryptedLibraryPage<Surface>> {
      const ownerId = canonicalOwnerId(input.ownerId, invalidInput);
      if (!(encryptedLibrarySurfaces as readonly string[]).includes(input.surface)) {
        return invalidInput();
      }
      const afterResourceId =
        input.afterResourceId === undefined || input.afterResourceId === null
          ? null
          : resourceIdForSurface(input.afterResourceId, input.surface, invalidInput);
      const limit = input.limit ?? DEFAULT_PAGE_SIZE;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
        return invalidInput();
      }
      const value = await client.rpc("list_encrypted_library_objects", {
        p_owner_id: ownerId,
        p_surface: input.surface,
        p_after_resource_id: afterResourceId,
        p_limit: limit
      });
      if (!Array.isArray(value) || value.length > limit) return invalidProjection();
      const items = value.map((row) => parseListRow(row, ownerId, input.surface));
      let previous = afterResourceId;
      for (const item of items) {
        if (previous !== null && item.resourceId <= previous) return invalidProjection();
        previous = item.resourceId;
      }
      return Object.freeze({
        surface: input.surface,
        items: Object.freeze(items),
        nextCursor: items.length === limit ? (items.at(-1)?.resourceId ?? null) : null
      });
    },

    async listContentEncryptionBackfillCandidates<Surface extends EncryptedLibrarySurface>(
      input: ListContentEncryptionBackfillCandidatesInput<Surface>
    ): Promise<ContentEncryptionBackfillCandidatePage<Surface>> {
      const ownerId = canonicalOwnerId(input.ownerId, invalidInput);
      if (!(encryptedLibrarySurfaces as readonly string[]).includes(input.surface)) {
        return invalidInput();
      }
      const afterCursor =
        input.afterCursor === undefined ? null : backfillCursor(input.afterCursor, invalidInput);
      const limit = input.limit ?? DEFAULT_PAGE_SIZE;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
        return invalidInput();
      }
      const value = await client.rpc("list_content_encryption_backfill_candidates", {
        p_owner_id: ownerId,
        p_surface: input.surface,
        p_after_cursor: afterCursor,
        p_limit: limit
      });
      if (!Array.isArray(value) || value.length > limit) return invalidProjection();
      const items = value.map((row) => parseBackfillCandidate(row, ownerId, input.surface));
      let previous = afterCursor;
      for (const item of items) {
        if (previous !== null && item.cursor <= previous) return invalidProjection();
        previous = item.cursor;
      }
      return Object.freeze({
        surface: input.surface,
        items: Object.freeze(items),
        nextCursor: items.length === limit ? (items.at(-1)?.cursor ?? null) : null
      });
    },

    async commitContentEncryptionBackfill<Surface extends BackfillableEncryptedLibrarySurface>(
      input: CommitContentEncryptionBackfillInput<Surface>
    ): Promise<CommitContentEncryptionBackfillResult<Surface>> {
      const ownerId = canonicalOwnerId(input.ownerId, invalidInput);
      if (!BACKFILL_SURFACES.has(input.surface)) return invalidInput();
      const resourceId = resourceIdForSurface(input.resourceId, input.surface, invalidInput);
      const recordVersion = positiveVersion(input.expectedRecordVersion, invalidInput);
      if (!jsonObject(input.expectedContent)) return invalidInput();
      const batchReference = validBatchReference(input.batchReference);
      const expectedCursor = backfillCursor(input.expectedCursor, invalidInput);
      const nextCursor = backfillCursor(input.nextCursor, invalidInput);
      const objectCursor = `${BACKFILL_SURFACE_RANK[input.surface]}:${input.surface}:${resourceId}`;
      if (
        typeof input.complete !== "boolean" ||
        (input.complete && nextCursor !== null) ||
        (!input.complete &&
          (nextCursor === null ||
            nextCursor !== objectCursor ||
            nextCursor <= (expectedCursor ?? "")))
      ) {
        return invalidInput();
      }
      const cipher = parseInputCipher(
        input.cipher,
        ownerId,
        input.surface,
        resourceId,
        recordVersion
      );
      const contentMac = MAC_SURFACES.has(input.surface)
        ? parseInputMac(input.contentMac, cipher.keyClass)
        : input.contentMac === null
          ? null
          : invalidInput();
      const verificationMac = parseInputMac(input.verificationMac, cipher.keyClass);
      const result = await client.rpc("commit_content_encryption_backfill", {
        p_owner_id: ownerId,
        p_surface: input.surface,
        p_resource_id: resourceId,
        p_expected_record_version: recordVersion,
        p_expected_content: input.expectedContent,
        p_cipher: encryptedFieldForRpc(cipher),
        p_content_mac: contentMac === null ? null : keyedMacForRpc(contentMac),
        p_verification_mac: keyedMacForRpc(verificationMac),
        p_batch_reference: batchReference,
        p_expected_cursor: expectedCursor,
        p_next_cursor: nextCursor,
        p_complete: input.complete
      });
      return parseCommitResult(result, {
        surface: input.surface,
        resourceId,
        recordVersion,
        nextCursor,
        complete: input.complete
      });
    },

    async completeContentEncryptionBackfill(
      input: CompleteContentEncryptionBackfillInput
    ): Promise<CompleteContentEncryptionBackfillResult> {
      const ownerId = canonicalOwnerId(input.ownerId, invalidInput);
      const batchReference = validBatchReference(input.batchReference);
      const expectedCursor = backfillCursor(input.expectedCursor, invalidInput);
      const value = await client.rpc("complete_content_encryption_backfill", {
        p_owner_id: ownerId,
        p_batch_reference: batchReference,
        p_expected_cursor: expectedCursor
      });
      const result = exactRecord(value, ["complete", "replayed"], invalidProjection);
      if (result.complete !== true || typeof result.replayed !== "boolean") {
        return invalidProjection();
      }
      return Object.freeze({ complete: true, replayed: result.replayed });
    },

    async advanceContentEncryptionRollout(
      input: AdvanceContentEncryptionRolloutInput
    ): Promise<AdvanceContentEncryptionRolloutResult> {
      const ownerId = canonicalOwnerId(input.ownerId, invalidInput);
      const validTransition =
        (input.expectedState === "expanded" && input.nextState === "dual_write") ||
        (input.expectedState === "dual_write" && input.nextState === "encrypted_read");
      if (!validTransition) return invalidInput();
      const value = await client.rpc("advance_content_encryption_rollout", {
        p_owner_id: ownerId,
        p_expected_state: input.expectedState,
        p_next_state: input.nextState
      });
      const result = exactRecord(value, ["state", "readMode", "replayed"], invalidProjection);
      const expectedReadMode = input.nextState === "encrypted_read" ? "encrypted" : "legacy";
      if (
        result.state !== input.nextState ||
        result.readMode !== expectedReadMode ||
        typeof result.replayed !== "boolean"
      ) {
        return invalidProjection();
      }
      return Object.freeze({
        state: input.nextState,
        readMode: expectedReadMode,
        replayed: result.replayed
      });
    },

    async resealCaptureContent(
      input: ResealCaptureContentInput
    ): Promise<ResealCaptureContentResult> {
      const ownerId = canonicalOwnerId(input.ownerId, invalidInput);
      const captureId = entityId(input.captureId, "cap", invalidInput);
      const expectedEnvelope = parseEnvelope(input.expectedEnvelope, invalidInput);
      if (
        expectedEnvelope.context.tenantId !== ownerId ||
        expectedEnvelope.context.resourceId !== captureId ||
        expectedEnvelope.context.recordVersion !== 1 ||
        expectedEnvelope.context.kind !== "capture" ||
        typeof input.expectedFingerprint !== "string" ||
        !HEX_PATTERN.test(input.expectedFingerprint)
      ) {
        return invalidInput();
      }
      const contentCipher = parseInputCipher(input.contentCipher, ownerId, "capture", captureId, 1);
      const contentMac = parseInputMac(input.contentMac, contentCipher.keyClass);
      const verificationMac = parseInputMac(input.verificationMac, contentCipher.keyClass);
      const value = await client.rpc("reseal_capture_content", {
        p_owner_id: ownerId,
        p_capture_id: captureId,
        p_expected_envelope: expectedEnvelope,
        p_expected_fingerprint: input.expectedFingerprint,
        p_content_cipher: encryptedFieldForRpc(contentCipher),
        p_content_mac: keyedMacForRpc(contentMac),
        p_verification_mac: keyedMacForRpc(verificationMac)
      });
      if (
        !isRecord(value) ||
        typeof value.replayed !== "boolean" ||
        value.captureId !== captureId
      ) {
        return invalidProjection();
      }
      if (value.replayed) {
        if (!hasExactKeys(value, ["captureId", "replayed"])) return invalidProjection();
        return Object.freeze({ captureId, envelopeDigest: null, replayed: true });
      }
      if (
        !hasExactKeys(value, ["captureId", "envelopeDigest", "replayed"]) ||
        typeof value.envelopeDigest !== "string" ||
        !HEX_PATTERN.test(value.envelopeDigest)
      ) {
        return invalidProjection();
      }
      return Object.freeze({
        captureId,
        envelopeDigest: value.envelopeDigest,
        replayed: false
      });
    },

    async verifyEncryptedContentObject<Surface extends VerifiableEncryptedContentSurface>(
      input: VerifyEncryptedContentObjectInput<Surface>
    ): Promise<VerifyEncryptedContentObjectResult<Surface>> {
      const ownerId = canonicalOwnerId(input.ownerId, invalidInput);
      if (!(verifiableEncryptedContentSurfaces as readonly string[]).includes(input.surface)) {
        return invalidInput();
      }
      const resourceId = resourceIdForSurface(input.resourceId, input.surface, invalidInput);
      const recordVersion = positiveVersion(input.expectedRecordVersion, invalidInput);
      const expectedEnvelope = parseEnvelope(input.expectedEnvelope, invalidInput);
      if (
        expectedEnvelope.context.tenantId !== ownerId ||
        expectedEnvelope.context.resourceId !== resourceId ||
        expectedEnvelope.context.recordVersion !== recordVersion ||
        expectedEnvelope.context.kind !== input.surface
      ) {
        return invalidInput();
      }
      const verificationMac = parseInputMacWithBoundClass(input.verificationMac);
      const value = await client.rpc("verify_encrypted_content_object", {
        p_owner_id: ownerId,
        p_surface: input.surface,
        p_resource_id: resourceId,
        p_expected_record_version: recordVersion,
        p_expected_envelope: expectedEnvelope,
        p_verification_mac: keyedMacForRpc(verificationMac)
      });
      const result = exactRecord(
        value,
        ["surface", "resourceId", "recordVersion", "envelopeDigest", "replayed"],
        invalidProjection
      );
      if (
        result.surface !== input.surface ||
        result.resourceId !== resourceId ||
        result.recordVersion !== recordVersion ||
        typeof result.envelopeDigest !== "string" ||
        !HEX_PATTERN.test(result.envelopeDigest) ||
        typeof result.replayed !== "boolean"
      ) {
        return invalidProjection();
      }
      return Object.freeze({
        surface: input.surface,
        resourceId,
        recordVersion,
        envelopeDigest: result.envelopeDigest,
        replayed: result.replayed
      });
    }
  });
}

export const encryptedLibraryRpcFunctions = Object.freeze([
  "list_encrypted_library_objects",
  "list_content_encryption_backfill_candidates",
  "commit_content_encryption_backfill",
  "complete_content_encryption_backfill",
  "advance_content_encryption_rollout",
  "reseal_capture_content",
  "verify_encrypted_content_object"
] as const);

export type EncryptedLibraryRpcFunction = (typeof encryptedLibraryRpcFunctions)[number];
