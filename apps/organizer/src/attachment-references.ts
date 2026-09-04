/// Where a photo or recording sits inside a note body. The scheme is opaque to
/// the model, which never sees attachment identifiers; the organizer places
/// these references itself after the plan is authorized.
export const ATTACHMENT_REFERENCE_SCHEME = "unfiled-attachment:" as const;

type ReferencedAttachment = Readonly<{ attachmentId: `att_${string}`; kind: "image" | "audio" }>;

export function attachmentReference(attachment: ReferencedAttachment): string {
  const target = `${ATTACHMENT_REFERENCE_SCHEME}${attachment.attachmentId}`;
  return attachment.kind === "image" ? `![Photo](${target})` : `[Recording](${target})`;
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
