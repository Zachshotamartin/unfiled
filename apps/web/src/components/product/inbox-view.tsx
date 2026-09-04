"use client";

import type { CaptureDetailResponse, EntityId, ProviderKeyResponse } from "@unfiled/contracts";
import { useCallback, useEffect, useState } from "react";

import { browserApi } from "@/lib/product/browser-api";
import { useLiveResource } from "@/lib/product/use-live-resource";

import { CaptureExperience, type CaptureEditRequest } from "./capture-experience";
import { DeskSettingsButton } from "./desk-menu";
import { PageHeading } from "./page-heading";
import { ReviewView } from "./review-view";

/** "Checking" while the lists load, then how many things need the owner, as the phone counts. */
export function inboxSummary(loading: boolean, waiting: number): string | undefined {
  if (loading) return "Checking";
  if (waiting === 0) return undefined;
  return waiting === 1 ? "1 waiting" : `${waiting} waiting`;
}

/**
 * The Inbox's attention lists come from three endpoints and have to agree on one sentence:
 * "nothing waiting" is only true when no review decision, no capture, and no missing key is
 * asking for the owner, the same count the iPhone app's `InboxAttention` sums.
 */
export function InboxView() {
  const [reviewCount, setReviewCount] = useState<number | null>(null);
  const [captureCount, setCaptureCount] = useState<number | null>(null);
  const [editRequest, setEditRequest] = useState<CaptureEditRequest | null>(null);
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

  // "Edit text" from a receipt arrives as ?edit=<capture>: the capture's words come back into the
  // composer, and saving replaces the sealed capture (ADR-0019, decision 6).
  useEffect(() => {
    const captureId = new URLSearchParams(window.location.search).get("edit");
    if (captureId === null || !/^cap_[0-9A-HJKMNP-TV-Z]{26}$/u.test(captureId)) return;
    let cancelled = false;
    void browserApi
      .getCapture(captureId)
      .then((response: CaptureDetailResponse) => {
        if (cancelled) return;
        setEditRequest({
          captureId: response.capture.id,
          rawContent: response.capture.rawContent,
          attachmentCount: response.capture.attachments.length
        });
        window.history.replaceState(null, "", "/app");
      })
      .catch(() => {
        /* A capture that cannot be read is left where it is; the Inbox still opens. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const editCapture = useCallback(
    (capture: Readonly<{ id: EntityId<"cap">; rawContent: string; attachmentCount: number }>) => {
      setEditRequest({
        captureId: capture.id,
        rawContent: capture.rawContent,
        attachmentCount: capture.attachmentCount
      });
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    []
  );

  const loading = reviewCount === null || captureCount === null;
  const waiting = (reviewCount ?? 0) + (captureCount ?? 0) + (providerKeyMissing ? 1 : 0);

  return (
    <>
      <PageHeading
        title="Inbox"
        subtitle={inboxSummary(loading, waiting)}
        action={<DeskSettingsButton />}
      />
      <div className="mt-8">
        <CaptureExperience
          editRequest={editRequest}
          onEditConsumed={() => setEditRequest(null)}
          onWaitingChange={setCaptureCount}
          providerKeyMissing={providerKeyMissing}
          reviewDecisions={<ReviewView onCountChange={setReviewCount} onEditText={editCapture} />}
          reviewDecisionsEmpty={reviewCount === 0}
        />
      </div>
    </>
  );
}
