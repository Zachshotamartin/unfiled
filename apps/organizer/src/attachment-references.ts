import type { MaterializedOrganizationCommand } from "@unfiled/ai-routing";

/// Where a photo or recording sits inside a note body. The scheme is opaque to
/// the model, which never sees attachment identifiers; the organizer appends
/// these references itself after the plan is authorized.
export const ATTACHMENT_REFERENCE_SCHEME = "unfiled-attachment:" as const;

type ReferencedAttachment = Readonly<{ attachmentId: `att_${string}`; kind: "image" | "audio" }>;

export function attachmentReference(attachment: ReferencedAttachment): string {
  const target = `${ATTACHMENT_REFERENCE_SCHEME}${attachment.attachmentId}`;
  return attachment.kind === "image" ? `![Photo](${target})` : `[Recording](${target})`;
}

/// One paragraph per attachment, in upload order, or null when there is nothing to place.
export type AttachmentReferenceOperation = Readonly<{
  type: "append_paragraphs";
  paragraphs: string[];
}>;

export function attachmentReferenceOperation(
  attachments: readonly ReferencedAttachment[]
): AttachmentReferenceOperation | null {
  if (attachments.length === 0) return null;
  return Object.freeze({
    type: "append_paragraphs" as const,
    paragraphs: attachments.map(attachmentReference)
  });
}

/// The paragraphs the organizer places for a capture's uploads, in upload order.
///
/// These are the organizer's own words, never the model's. They are handed to the application
/// layer separately so the model's plan is still validated as the model's plan: appending them
/// to a validated plan made every capture with a photo fail source preservation, and pushed a
/// five-operation plan past the operation cap.
export function attachmentParagraphs(
  attachments: readonly ReferencedAttachment[]
): readonly string[] {
  return Object.freeze(attachments.map(attachmentReference));
}
