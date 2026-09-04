"use client";

import { useState } from "react";

import { CaptureExperience } from "./capture-experience";
import { ReviewView } from "./review-view";

/**
 * The Inbox's two attention lists, which come from two endpoints and have to agree on one
 * sentence: "nothing waiting" is only true when neither a review decision nor a capture is
 * asking for the owner, the same count the iPhone app's `InboxAttention` sums.
 */
export function InboxView() {
  const [reviewsEmpty, setReviewsEmpty] = useState(true);
  return (
    <CaptureExperience
      reviewDecisions={<ReviewView onEmptyChange={setReviewsEmpty} />}
      reviewDecisionsEmpty={reviewsEmpty}
    />
  );
}
