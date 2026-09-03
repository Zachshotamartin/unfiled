import type { ModelOperation } from "@unfiled/contracts";

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
export function attachmentReferenceOperation(
  attachments: readonly ReferencedAttachment[]
): ModelOperation | null {
  if (attachments.length === 0) return null;
  return Object.freeze({
    type: "append_paragraphs" as const,
    paragraphs: attachments.map(attachmentReference)
  });
}

type MaterializedWrite = Readonly<{
  kind: string;
  operations: readonly ModelOperation[];
  validatedPlan: Readonly<{ operations: readonly ModelOperation[] }>;
}>;

/// Places the attachment references after the owner's own words in a materialized write.
/// The model's plan is validated for source preservation before this runs, so the
/// references are the organizer's own placement, never model text. Review decisions
/// carry no operations and are returned unchanged.
export function withAttachmentReferences<Command extends MaterializedWrite>(
  command: Command,
  attachments: readonly ReferencedAttachment[]
): Command {
  const operation = attachmentReferenceOperation(attachments);
  if (operation === null || (command.kind !== "append" && command.kind !== "create"))
    return command;
  return Object.freeze({
    ...command,
    operations: Object.freeze([...command.operations, operation]),
    validatedPlan: Object.freeze({
      ...command.validatedPlan,
      operations: Object.freeze([...command.validatedPlan.operations, operation])
    })
  });
}
