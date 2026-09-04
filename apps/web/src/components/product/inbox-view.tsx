"use client";

import type { ProviderKeyResponse } from "@unfiled/contracts";
import { useState } from "react";

import { useLiveResource } from "@/lib/product/use-live-resource";

import { CaptureExperience } from "./capture-experience";
import { ReviewView } from "./review-view";

/**
 * The Inbox's attention lists come from three endpoints and have to agree on one sentence:
 * "nothing waiting" is only true when no review decision, no capture, and no missing key is
 * asking for the owner, the same count the iPhone app's `InboxAttention` sums.
 */
export function InboxView() {
  const [reviewsEmpty, setReviewsEmpty] = useState(true);
  const openAi = useLiveResource<ProviderKeyResponse>("/api/v1/me/provider-key?provider=openai");
  const anthropic = useLiveResource<ProviderKeyResponse>(
    "/api/v1/me/provider-key?provider=anthropic"
  );
  // The card appears only once both answers are in and both are empty; while either is still
  // loading nothing is claimed, so a key that exists never flashes the card on the way in.
  const providerKeyMissing =
    openAi.data !== null &&
    anthropic.data !== null &&
    openAi.data.providerKey === null &&
    anthropic.data.providerKey === null;
  return (
    <CaptureExperience
      providerKeyMissing={providerKeyMissing}
      reviewDecisions={<ReviewView onEmptyChange={setReviewsEmpty} />}
      reviewDecisionsEmpty={reviewsEmpty}
    />
  );
}
