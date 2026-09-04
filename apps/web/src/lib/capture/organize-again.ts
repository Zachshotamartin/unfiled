import {
  CaptureCreateRequestSchema,
  createEntityId,
  type CaptureCreateRequest,
  type CaptureDeleteRequest,
  type EntityId
} from "@unfiled/contracts";

import { createIdempotencyKey } from "@/lib/product/client";

/** The two calls organizing again needs, so the flow can be exercised without a browser. */
export type OrganizeAgainApi = Readonly<{
  createCapture: (input: CaptureCreateRequest) => Promise<unknown>;
  deleteCapture: (captureId: string, input: CaptureDeleteRequest) => Promise<unknown>;
}>;

export type OrganizeAgainSource = Readonly<{
  id: EntityId<"cap">;
  rawContent: string;
  expansionDisabled: boolean;
}>;

/** Directions as the contract takes them: trimmed, and absent rather than empty. */
export function normalizedGuidance(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed.slice(0, 500);
}

/**
 * A capture is sealed, so organizing it again makes a new one with the same words and the
 * owner's directions, then removes the one it replaces -- the order the phone uses
 * (AppModel.organizeAgain), so a failure leaves the original in place. Photos are not carried
 * over here: a browser tab has nowhere to hold their bytes, so a capture with photos says so.
 */
export async function organizeCaptureAgain(
  api: OrganizeAgainApi,
  source: OrganizeAgainSource,
  guidance: string | null,
  now: number = Date.now(),
  timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone
): Promise<EntityId<"cap">> {
  const directions = normalizedGuidance(guidance);
  const request = CaptureCreateRequestSchema.parse({
    clientCaptureId: createEntityId("cap"),
    rawContent: source.rawContent,
    source: "web",
    clientCreatedAt: new Date(now).toISOString(),
    clientTimezone: timeZone,
    privacy: "ai_assisted",
    expansionDisabled: source.expansionDisabled,
    ...(directions === null ? {} : { guidance: directions })
  });
  await api.createCapture(request);
  await api.deleteCapture(source.id, { idempotencyKey: createIdempotencyKey() });
  return request.clientCaptureId;
}
