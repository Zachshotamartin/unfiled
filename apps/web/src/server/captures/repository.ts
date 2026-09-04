import type {
  CaptureAttachment,
  CaptureAttachmentUpload,
  Capture,
  CaptureCreateResponse,
  CaptureDeleteResponse,
  CaptureDetailResponse,
  CaptureListQuery,
  CaptureListResponse,
  CaptureReceiptResponse,
  CaptureRetryResponse,
  EntityId
} from "@unfiled/contracts";

export type CaptureRepositoryContext = Readonly<{
  accessToken: string;
  userId: string;
}>;

export type NormalizedCaptureCreateInput = Readonly<{
  clientCaptureId: EntityId<"cap">;
  rawContent: string;
  source: Capture["source"];
  deviceId?: string | undefined;
  clientCreatedAt: string;
  clientTimezone: string;
  privacy: Capture["privacy"];
  explicitDestinationNoteId?: EntityId<"note"> | undefined;
  expansionDisabled: boolean;
  /** Uploads this capture claims, bound to it as the capture is stored. */
  attachmentIds?: readonly EntityId<"att">[] | undefined;
  guidance?: string | undefined;
}>;

export type NormalizedAttachmentUploadInput = Readonly<
  CaptureAttachmentUpload & { bytes: Uint8Array }
>;

export type CaptureAttachmentRead = Readonly<{
  attachment: CaptureAttachment;
  bytes: Uint8Array;
}>;

export type NormalizedCaptureDeleteInput = Readonly<{
  idempotencyKey: string;
  removeInsertedContent: boolean;
  expectedNoteRevisions: readonly Readonly<{
    noteId: EntityId<"note">;
    expectedRevision: number;
  }>[];
}>;

export interface CaptureRepository {
  readonly createCapture: (
    context: CaptureRepositoryContext,
    input: NormalizedCaptureCreateInput
  ) => Promise<CaptureCreateResponse>;
  readonly deleteCapture: (
    context: CaptureRepositoryContext,
    captureId: EntityId<"cap">,
    input: NormalizedCaptureDeleteInput
  ) => Promise<CaptureDeleteResponse>;
  readonly getCapture: (
    context: CaptureRepositoryContext,
    captureId: EntityId<"cap">
  ) => Promise<CaptureDetailResponse>;
  readonly getReceipt: (
    context: CaptureRepositoryContext,
    captureId: EntityId<"cap">
  ) => Promise<CaptureReceiptResponse>;
  readonly listCaptures: (
    context: CaptureRepositoryContext,
    query: CaptureListQuery
  ) => Promise<CaptureListResponse>;
  readonly retryCapture: (
    context: CaptureRepositoryContext,
    captureId: EntityId<"cap">,
    idempotencyKey: string
  ) => Promise<CaptureRetryResponse>;
  /** Seals an uploaded photo or recording beside the capture it names. */
  readonly createAttachment: (
    context: CaptureRepositoryContext,
    input: NormalizedAttachmentUploadInput
  ) => Promise<CaptureAttachment>;
  /** Opens the owner's attachment back into bytes, or null when they have none by that id. */
  readonly getAttachment: (
    context: CaptureRepositoryContext,
    attachmentId: EntityId<"att">
  ) => Promise<CaptureAttachmentRead | null>;
}
