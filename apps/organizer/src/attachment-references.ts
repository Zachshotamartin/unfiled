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

/// Places the attachment references after the owner's own words in a materialized write.
/// The model's plan is validated for source preservation before this runs, so the
/// references are the organizer's own placement, never model text. Review decisions
/// carry no operations and are returned unchanged.
export function withAttachmentReferences(
  command: MaterializedOrganizationCommand,
  attachments: readonly ReferencedAttachment[]
): MaterializedOrganizationCommand {
  const operation = attachmentReferenceOperation(attachments);
  if (operation === null || command.kind === "review") return command;
  const placed = Object.freeze([...command.operations, operation]);
  const validatedPlan = {
    ...command.validatedPlan,
    operations: [...command.validatedPlan.operations, operation]
  };
  return command.kind === "append"
    ? Object.freeze({ ...command, operations: placed, validatedPlan })
    : Object.freeze({ ...command, operations: placed, validatedPlan });
}
