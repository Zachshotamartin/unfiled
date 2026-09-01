import type { ContentEnvelopeV1 } from "@unfiled/content-crypto";
import type { EntityId, PrivacyMode } from "@unfiled/contracts";
import type { KeyClass, KeyReference, OwnerBoundKeyResolver } from "@unfiled/key-management";

import type { AuthorizedOwnerAccess } from "./authorization.js";
import type {
  CapturePayload,
  CaptureReceiptPayload,
  GeneratedBlockPayload,
  NoteContentPayload,
  NoteMutationPayload,
  NoteRevisionPayload,
  OrganizationDecisionPayload,
  OrganizationMutationAttemptPayload,
  PayloadCodec,
  ReviewPayload,
  RoutingRulePayload,
  SpaceDisplayPayload,
  TagDisplayPayload
} from "./payloads.js";

export type AggregateContentKind =
  | "capture"
  | "capture_receipt"
  | "generated_block"
  | "idempotency_response"
  | "note_content"
  | "note_mutation"
  | "note_rag_index"
  | "note_revision"
  | "organization_decision"
  | "organization_mutation_attempt"
  | "review_item"
  | "routing_rule"
  | "space_display"
  | "tag_display";

export type PrivacyTransition = Readonly<{
  before: PrivacyMode | null;
  after: PrivacyMode;
}>;

export type ObjectWrapKeyReference = KeyReference & Readonly<{ purpose: "object_wrap" }>;
export type ContentMacKeyReference = KeyReference & Readonly<{ purpose: "content_mac" }>;

export type ObjectWrapReservation = Readonly<{
  reservationId: string;
  reference: ObjectWrapKeyReference;
}>;

export type ObjectWrapReservationPort = Readonly<{
  reserveObjectWrappingKey(
    binding: Readonly<{ ownerId: string; keyClass: KeyClass }>
  ): Promise<ObjectWrapReservation>;
}>;

export type EncryptedAggregateRecord<Kind extends AggregateContentKind> = Readonly<{
  ownerId: string;
  resourceId: string;
  recordVersion: number;
  kind: Kind;
  envelope: ContentEnvelopeV1;
  keyId: string;
  keyClass: KeyClass;
  keyPurpose: "object_wrap";
  keyVersion: number;
}>;

export type SealedEncryptedAggregateRecord<Kind extends AggregateContentKind> =
  EncryptedAggregateRecord<Kind> &
    Readonly<{
      reservationId: string;
    }>;

export type KeyedMacRecord = Readonly<{
  value: string;
  keyId: string;
  keyClass: KeyClass;
  keyPurpose: "content_mac";
  keyVersion: number;
}>;

export type SemanticMacNamespace = "space_slug" | "tag_normalized_name";

export type MacProtectedEncryptedAggregateRecord<Kind extends AggregateContentKind> = Readonly<{
  encrypted: SealedEncryptedAggregateRecord<Kind>;
  contentMac: KeyedMacRecord;
}>;

export type LogicalApiRequest<Payload> = Readonly<{
  schemaVersion: 1;
  scope: string;
  targetResourceId: string | null;
  expectedRevision: number | null;
  payload: Payload;
}>;

export type EncryptedIdempotencyRecord = Readonly<{
  ownerId: string;
  idempotencyKey: string;
  keyClass: KeyClass;
  requestMac: KeyedMacRecord;
  response: EncryptedAggregateRecord<"idempotency_response">;
}>;

export type SealedEncryptedIdempotencyRecord = Omit<EncryptedIdempotencyRecord, "response"> &
  Readonly<{ response: SealedEncryptedAggregateRecord<"idempotency_response"> }>;

export type EncryptedAggregateServiceOptions = Readonly<{
  crypto?: Crypto;
  keyResolver: OwnerBoundKeyResolver;
  objectWrapReservations: ObjectWrapReservationPort;
}>;

export type SealCaptureInput = Readonly<{
  captureId: EntityId<"cap">;
  recordVersion: number;
  privacy: PrivacyMode;
  payload: CapturePayload;
}>;

export type OpenCaptureInput = Omit<SealCaptureInput, "payload">;

export type SealNoteContentInput = Readonly<{
  noteId: EntityId<"note">;
  currentRevision: number;
  privacy: PrivacyMode;
  payload: NoteContentPayload;
}>;

export type OpenNoteContentInput = Omit<SealNoteContentInput, "payload">;

export type NoteRagIndexId = `irw_${string}`;

export type SealNoteRagIndexInput<Payload> = Readonly<{
  indexId: NoteRagIndexId;
  indexedRevision: number;
  payload: Payload;
  payloadCodec: PayloadCodec<Payload>;
}>;

export type OpenNoteRagIndexInput<Payload> = Omit<SealNoteRagIndexInput<Payload>, "payload">;

export type SealSpaceDisplayInput = Readonly<{
  spaceId: EntityId<"spc">;
  currentRevision: number;
  payload: SpaceDisplayPayload;
}>;

export type OpenSpaceDisplayInput = Omit<SealSpaceDisplayInput, "payload">;

export type SealTagDisplayInput = Readonly<{
  tagId: EntityId<"tag">;
  currentRevision: number;
  payload: TagDisplayPayload;
}>;

export type OpenTagDisplayInput = Omit<SealTagDisplayInput, "payload">;

export type SealNoteRevisionInput = Readonly<{
  revisionId: EntityId<"rev">;
  revision: number;
  transition: PrivacyTransition;
  payload: NoteRevisionPayload;
}>;

export type OpenNoteRevisionInput = Omit<SealNoteRevisionInput, "payload">;

export type SealNoteMutationInput = Readonly<{
  mutationId: EntityId<"mut">;
  afterRevision: number;
  payload: NoteMutationPayload;
}>;

export type OpenNoteMutationInput = Omit<SealNoteMutationInput, "payload"> &
  Readonly<{ transition: PrivacyTransition }>;

/** Maintenance-only mutation opening that derives sticky class from plaintext provenance. */
export type OpenNoteMutationForVerificationInput = Readonly<{
  mutationId: EntityId<"mut">;
  afterRevision: number;
}>;

export type SealOrganizationDecisionInput = Readonly<{
  decisionId: EntityId<"dec">;
  payload: OrganizationDecisionPayload;
}>;

export type OpenOrganizationDecisionInput = Omit<SealOrganizationDecisionInput, "payload">;

export type SealGeneratedBlockInput = Readonly<{
  blockId: EntityId<"blk">;
  payload: GeneratedBlockPayload;
}>;

export type OpenGeneratedBlockInput = Omit<SealGeneratedBlockInput, "payload">;

export type SealReviewInput = Readonly<{
  reviewId: EntityId<"rvw">;
  recordVersion: number;
  sourcePrivacy: PrivacyMode;
  payload: ReviewPayload;
}>;

export type OpenReviewInput = Omit<SealReviewInput, "payload">;

export type SealRoutingRuleInput = Readonly<{
  ruleId: EntityId<"rule">;
  recordVersion: number;
  payload: RoutingRulePayload;
}>;

export type OpenRoutingRuleInput = Omit<SealRoutingRuleInput, "payload">;

export type SealOrganizationMutationAttemptInput = Readonly<{
  jobId: EntityId<"job">;
  noteId: EntityId<"note">;
  recordVersion: number;
  payload: OrganizationMutationAttemptPayload;
}>;

export type OpenOrganizationMutationAttemptInput = Omit<
  SealOrganizationMutationAttemptInput,
  "payload"
>;

export type SealCaptureReceiptInput = Readonly<{
  captureId: EntityId<"cap">;
  recordVersion: number;
  sourcePrivacy: PrivacyMode;
  payload: CaptureReceiptPayload;
}>;

export type OpenCaptureReceiptInput = Omit<SealCaptureReceiptInput, "payload">;

export type SealIdempotencyRecordInput<RequestPayload, ResponsePayload> = Readonly<{
  idempotencyKey: string;
  transition: PrivacyTransition;
  logicalRequest: LogicalApiRequest<RequestPayload>;
  requestCodec: PayloadCodec<RequestPayload>;
  response: ResponsePayload;
  responseCodec: PayloadCodec<ResponsePayload>;
}>;

export type CreateIdempotencyRequestMacInput<RequestPayload> = Readonly<{
  idempotencyKey: string;
  transition: PrivacyTransition;
  logicalRequest: LogicalApiRequest<RequestPayload>;
  requestCodec: PayloadCodec<RequestPayload>;
  keyReference?: ContentMacKeyReference;
}>;

export type SealIdempotencyResponseInput<ResponsePayload> = Readonly<{
  idempotencyKey: string;
  transition: PrivacyTransition;
  response: ResponsePayload;
  responseCodec: PayloadCodec<ResponsePayload>;
}>;

export type VerifyIdempotencyRequestInput<RequestPayload> = Readonly<{
  idempotencyKey: string;
  transition: PrivacyTransition;
  logicalRequest: LogicalApiRequest<RequestPayload>;
  requestCodec: PayloadCodec<RequestPayload>;
}>;

export type OpenIdempotencyResponseInput<RequestPayload, ResponsePayload> =
  VerifyIdempotencyRequestInput<RequestPayload> &
    Readonly<{ responseCodec: PayloadCodec<ResponsePayload> }>;

/**
 * Decrypts an already-authorized stored response solely so a maintenance
 * workflow can produce canonical content-verification evidence. This input
 * deliberately has no logical request and produces no replay authorization.
 */
export type OpenIdempotencyResponseForVerificationInput<ResponsePayload> = Readonly<{
  idempotencyKey: string;
  responseCodec: PayloadCodec<ResponsePayload>;
}>;

export type AggregateVerificationSurface =
  | "capture_receipt"
  | "note_content"
  | "note_mutation"
  | "organization_decision"
  | "review_item"
  | "space_display"
  | "tag_display"
  | "idempotency_response";

export type CaptureReceiptVerificationMacInput = Readonly<{
  surface: "capture_receipt";
}> &
  SealCaptureReceiptInput;

export type NoteContentVerificationMacInput = Readonly<{
  surface: "note_content";
  noteId: EntityId<"note">;
  recordVersion: number;
  privacy: PrivacyMode;
  payload: NoteContentPayload;
}>;

export type NoteMutationVerificationMacInput = Readonly<{
  surface: "note_mutation";
  mutationId: EntityId<"mut">;
  recordVersion: number;
  payload: NoteMutationPayload;
}>;

export type OrganizationDecisionVerificationMacInput = Readonly<{
  surface: "organization_decision";
  decisionId: EntityId<"dec">;
  payload: OrganizationDecisionPayload;
}>;

export type ReviewVerificationMacInput = Readonly<{
  surface: "review_item";
  reviewId: EntityId<"rvw">;
  recordVersion: number;
  sourcePrivacy: PrivacyMode;
  payload: ReviewPayload;
}>;

export type SpaceDisplayVerificationMacInput = Readonly<{
  surface: "space_display";
}> &
  SealSpaceDisplayInput;

export type TagDisplayVerificationMacInput = Readonly<{
  surface: "tag_display";
}> &
  SealTagDisplayInput;

export type IdempotencyResponseVerificationMacInput<Payload> = Readonly<{
  surface: "idempotency_response";
  idempotencyKey: string;
  transition: PrivacyTransition;
  payload: Payload;
  payloadCodec: PayloadCodec<Payload>;
}>;

export type AggregateVerificationMacInput<Payload = never> =
  | CaptureReceiptVerificationMacInput
  | NoteContentVerificationMacInput
  | NoteMutationVerificationMacInput
  | OrganizationDecisionVerificationMacInput
  | ReviewVerificationMacInput
  | SpaceDisplayVerificationMacInput
  | TagDisplayVerificationMacInput
  | IdempotencyResponseVerificationMacInput<Payload>;

type BackfillSurfaceInput<Surface extends AggregateContentKind, Input> = Readonly<{
  surface: Surface;
}> &
  Input;

export type IdempotencyResponseBackfillVerificationMacInput<Payload> = Readonly<{
  surface: "idempotency_response";
  idempotencyKey: string;
  transition: PrivacyTransition;
  payload: Payload;
  payloadCodec: PayloadCodec<Payload>;
}>;

/** Canonical plaintext evidence used only by atomic legacy backfill commits. */
export type BackfillVerificationMacInput<Payload = never> =
  | BackfillSurfaceInput<"capture", SealCaptureInput>
  | BackfillSurfaceInput<"capture_receipt", SealCaptureReceiptInput>
  | BackfillSurfaceInput<"generated_block", SealGeneratedBlockInput>
  | BackfillSurfaceInput<"note_content", SealNoteContentInput>
  | BackfillSurfaceInput<"note_mutation", SealNoteMutationInput>
  | BackfillSurfaceInput<"note_revision", SealNoteRevisionInput>
  | BackfillSurfaceInput<"organization_decision", SealOrganizationDecisionInput>
  | BackfillSurfaceInput<"organization_mutation_attempt", SealOrganizationMutationAttemptInput>
  | BackfillSurfaceInput<"review_item", SealReviewInput>
  | BackfillSurfaceInput<"routing_rule", SealRoutingRuleInput>
  | BackfillSurfaceInput<"space_display", SealSpaceDisplayInput>
  | BackfillSurfaceInput<"tag_display", SealTagDisplayInput>
  | IdempotencyResponseBackfillVerificationMacInput<Payload>;

declare const encryptedFieldRpcKind: unique symbol;

export type EncryptedFieldRpcValue<Kind extends AggregateContentKind> = Readonly<{
  envelope: ContentEnvelopeV1;
  keyId: string;
  keyClass: KeyClass;
  keyPurpose: "object_wrap";
  keyVersion: number;
  reservationId: string;
  [encryptedFieldRpcKind]?: Kind;
}>;

export type KeyedMacRpcValue = Readonly<{
  mac: string;
  keyId: string;
  keyClass: KeyClass;
  keyPurpose: "content_mac";
  keyVersion: number;
}>;

export type EncryptedIdempotencyRpcValue = Readonly<{
  idempotencyKey: string;
  keyClass: KeyClass;
  requestMac: KeyedMacRpcValue;
  response: EncryptedFieldRpcValue<"idempotency_response">;
}>;

export type EncryptedNoteMutationRpcInput = Readonly<{
  ownerId: string;
  noteId: EntityId<"note">;
  expectedRevision: number;
  afterRevision: number;
  privacy: PrivacyMode;
  revisionId: EntityId<"rev">;
  mutationId: EntityId<"mut">;
  idempotencyKey: string;
  noteContent: EncryptedFieldRpcValue<"note_content">;
  revisionSnapshot: EncryptedFieldRpcValue<"note_revision">;
  revisionSnapshotMac: KeyedMacRpcValue;
  mutation: EncryptedFieldRpcValue<"note_mutation">;
  idempotency: EncryptedIdempotencyRpcValue;
}>;

export type EncryptedNoteCreateRpcInput = Omit<EncryptedNoteMutationRpcInput, "expectedRevision"> &
  Readonly<{ expectedRevision: 0; afterRevision: 1 }>;

export type EncryptedNoteMutationRpcResult = Readonly<{
  status: "applied" | "replayed";
  ownerId: string;
  noteId: EntityId<"note">;
  currentRevision: number;
  revisionId: EntityId<"rev">;
  mutationId: EntityId<"mut">;
  replayed: boolean;
}>;

export type EncryptedAggregateReadRpcResult<Kind extends AggregateContentKind> = Readonly<{
  ownerId: string;
  encrypted: EncryptedFieldRpcValue<Kind>;
}>;

export type EncryptedBackfillRpcInput<Kind extends AggregateContentKind> = Readonly<{
  ownerId: string;
  encrypted: EncryptedFieldRpcValue<Kind>;
  contentMac: KeyedMacRpcValue | null;
  expectedRolloutVersion: number;
}>;

export type EncryptedAggregateService = Readonly<{
  sealCapture(
    access: AuthorizedOwnerAccess,
    input: SealCaptureInput
  ): Promise<MacProtectedEncryptedAggregateRecord<"capture">>;
  openCapture(
    access: AuthorizedOwnerAccess,
    record: unknown,
    expected: OpenCaptureInput
  ): Promise<CapturePayload>;
  sealNoteContent(
    access: AuthorizedOwnerAccess,
    input: SealNoteContentInput
  ): Promise<SealedEncryptedAggregateRecord<"note_content">>;
  openNoteContent(
    access: AuthorizedOwnerAccess,
    record: unknown,
    expected: OpenNoteContentInput
  ): Promise<NoteContentPayload>;
  sealNoteRagIndex<Payload>(
    access: AuthorizedOwnerAccess,
    input: SealNoteRagIndexInput<Payload>
  ): Promise<SealedEncryptedAggregateRecord<"note_rag_index">>;
  openNoteRagIndex<Payload>(
    access: AuthorizedOwnerAccess,
    record: unknown,
    expected: OpenNoteRagIndexInput<Payload>
  ): Promise<Payload>;
  sealSpaceDisplay(
    access: AuthorizedOwnerAccess,
    input: SealSpaceDisplayInput
  ): Promise<MacProtectedEncryptedAggregateRecord<"space_display">>;
  openSpaceDisplay(
    access: AuthorizedOwnerAccess,
    record: unknown,
    expected: OpenSpaceDisplayInput
  ): Promise<SpaceDisplayPayload>;
  sealTagDisplay(
    access: AuthorizedOwnerAccess,
    input: SealTagDisplayInput
  ): Promise<MacProtectedEncryptedAggregateRecord<"tag_display">>;
  openTagDisplay(
    access: AuthorizedOwnerAccess,
    record: unknown,
    expected: OpenTagDisplayInput
  ): Promise<TagDisplayPayload>;
  sealNoteRevision(
    access: AuthorizedOwnerAccess,
    input: SealNoteRevisionInput
  ): Promise<MacProtectedEncryptedAggregateRecord<"note_revision">>;
  openNoteRevision(
    access: AuthorizedOwnerAccess,
    record: unknown,
    expected: OpenNoteRevisionInput
  ): Promise<NoteRevisionPayload>;
  sealNoteMutation(
    access: AuthorizedOwnerAccess,
    input: SealNoteMutationInput
  ): Promise<SealedEncryptedAggregateRecord<"note_mutation">>;
  openNoteMutation(
    access: AuthorizedOwnerAccess,
    record: unknown,
    expected: OpenNoteMutationInput
  ): Promise<NoteMutationPayload>;
  openNoteMutationForVerification(
    access: AuthorizedOwnerAccess,
    record: unknown,
    expected: OpenNoteMutationForVerificationInput
  ): Promise<NoteMutationPayload>;
  sealOrganizationDecision(
    access: AuthorizedOwnerAccess,
    input: SealOrganizationDecisionInput
  ): Promise<SealedEncryptedAggregateRecord<"organization_decision">>;
  openOrganizationDecision(
    access: AuthorizedOwnerAccess,
    record: unknown,
    expected: OpenOrganizationDecisionInput
  ): Promise<OrganizationDecisionPayload>;
  sealGeneratedBlock(
    access: AuthorizedOwnerAccess,
    input: SealGeneratedBlockInput
  ): Promise<SealedEncryptedAggregateRecord<"generated_block">>;
  openGeneratedBlock(
    access: AuthorizedOwnerAccess,
    record: unknown,
    expected: OpenGeneratedBlockInput
  ): Promise<GeneratedBlockPayload>;
  sealReview(
    access: AuthorizedOwnerAccess,
    input: SealReviewInput
  ): Promise<SealedEncryptedAggregateRecord<"review_item">>;
  openReview(
    access: AuthorizedOwnerAccess,
    record: unknown,
    expected: OpenReviewInput
  ): Promise<ReviewPayload>;
  sealRoutingRule(
    access: AuthorizedOwnerAccess,
    input: SealRoutingRuleInput
  ): Promise<SealedEncryptedAggregateRecord<"routing_rule">>;
  openRoutingRule(
    access: AuthorizedOwnerAccess,
    record: unknown,
    expected: OpenRoutingRuleInput
  ): Promise<RoutingRulePayload>;
  sealOrganizationMutationAttempt(
    access: AuthorizedOwnerAccess,
    input: SealOrganizationMutationAttemptInput
  ): Promise<SealedEncryptedAggregateRecord<"organization_mutation_attempt">>;
  openOrganizationMutationAttempt(
    access: AuthorizedOwnerAccess,
    record: unknown,
    expected: OpenOrganizationMutationAttemptInput
  ): Promise<OrganizationMutationAttemptPayload>;
  sealCaptureReceipt(
    access: AuthorizedOwnerAccess,
    input: SealCaptureReceiptInput
  ): Promise<SealedEncryptedAggregateRecord<"capture_receipt">>;
  openCaptureReceipt(
    access: AuthorizedOwnerAccess,
    record: unknown,
    expected: OpenCaptureReceiptInput
  ): Promise<CaptureReceiptPayload>;
  sealIdempotencyRecord<RequestPayload, ResponsePayload>(
    access: AuthorizedOwnerAccess,
    input: SealIdempotencyRecordInput<RequestPayload, ResponsePayload>
  ): Promise<SealedEncryptedIdempotencyRecord>;
  createIdempotencyRequestMac<RequestPayload>(
    access: AuthorizedOwnerAccess,
    input: CreateIdempotencyRequestMacInput<RequestPayload>
  ): Promise<KeyedMacRecord>;
  sealIdempotencyResponse<ResponsePayload>(
    access: AuthorizedOwnerAccess,
    input: SealIdempotencyResponseInput<ResponsePayload>
  ): Promise<SealedEncryptedAggregateRecord<"idempotency_response">>;
  verifyIdempotencyRequest<RequestPayload>(
    access: AuthorizedOwnerAccess,
    record: unknown,
    input: VerifyIdempotencyRequestInput<RequestPayload>
  ): Promise<boolean>;
  openIdempotencyResponse<RequestPayload, ResponsePayload>(
    access: AuthorizedOwnerAccess,
    record: unknown,
    input: OpenIdempotencyResponseInput<RequestPayload, ResponsePayload>
  ): Promise<ResponsePayload>;
  /**
   * Maintenance-only plaintext opening. The stored request-MAC and response
   * classes must agree, but no request is verified or authorized for replay.
   */
  openIdempotencyResponseForVerification<ResponsePayload>(
    access: AuthorizedOwnerAccess,
    record: unknown,
    input: OpenIdempotencyResponseForVerificationInput<ResponsePayload>
  ): Promise<ResponsePayload>;
  createAggregateVerificationMac<Payload = never>(
    access: AuthorizedOwnerAccess,
    input: AggregateVerificationMacInput<Payload>
  ): Promise<KeyedMacRecord>;
  verifyAggregateVerificationMac<Payload = never>(
    access: AuthorizedOwnerAccess,
    record: unknown,
    input: AggregateVerificationMacInput<Payload>
  ): Promise<boolean>;
  createBackfillVerificationMac<Payload = never>(
    access: AuthorizedOwnerAccess,
    input: BackfillVerificationMacInput<Payload>
  ): Promise<KeyedMacRecord>;
  verifyBackfillVerificationMac<Payload = never>(
    access: AuthorizedOwnerAccess,
    record: unknown,
    input: BackfillVerificationMacInput<Payload>
  ): Promise<boolean>;
}>;
