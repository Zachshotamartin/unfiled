"use client";

import type { EntityId } from "@unfiled/contracts";
import Link from "next/link";
import type { ReactNode } from "react";

import type { CaptureActivityItem, CaptureActivityStatus } from "@/lib/capture/capture-queue";

import { UnfiledGlyph, type UnfiledGlyphName } from "./unfiled-glyph";

export function captureStatusLabel(status: CaptureActivityStatus): string {
  switch (status) {
    case "waiting":
      return "Waiting to sync";
    case "sending":
      return "Syncing";
    case "retrying":
      return "Waiting to retry";
    case "permanent":
      return "Needs retry";
    case "queued":
      return "Queued";
    case "processing":
      return "Organizing";
    case "done":
      return "Done";
    case "needs_review":
      return "Needs review";
    case "failed":
      return "Failed";
    case "inbox":
      return "Safe in Inbox";
  }
}

/**
 * Only what needs the owner (ADR-0019, decision 9). A filed capture is a note in the Library, so
 * it never lingers in the Inbox — and nothing is left behind there when that note is deleted.
 */
export function captureNeedsOwner(status: CaptureActivityStatus): boolean {
  return status !== "done";
}

function statusGlyph(status: CaptureActivityStatus): UnfiledGlyphName {
  if (status === "failed" || status === "permanent") return "warning";
  if (status === "inbox" || status === "needs_review") return "tray";
  if (status === "waiting" || status === "retrying" || status === "sending") return "send";
  return "clock";
}

function formatCaptureTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short"
  });
}

type CaptureActivityProps = Readonly<{
  error: string | null;
  items: readonly CaptureActivityItem[];
  loading: boolean;
  onRetryLocal: (captureId: EntityId<"cap">) => void;
  onRetryRemote: (captureId: EntityId<"cap">) => void;
  /** The review decisions the Inbox now carries, since Review is no longer a destination. */
  reviewDecisions?: ReactNode;
  /** False while a review decision is listed above, so "nothing waiting" stays true. */
  reviewDecisionsEmpty?: boolean;
}>;

export function CaptureActivity({
  error,
  items,
  loading,
  onRetryLocal,
  onRetryRemote,
  reviewDecisions,
  reviewDecisionsEmpty = true
}: CaptureActivityProps) {
  const waiting = items.filter((item) => captureNeedsOwner(item.status));
  const nothingWaiting = waiting.length === 0 && reviewDecisionsEmpty;
  const providerUnavailable = waiting.some((item) => item.errorCode === "provider_unavailable");

  return (
    <section className="capture-activity" aria-labelledby="capture-activity-heading">
      <div className="capture-section-heading">
        <h2 id="capture-activity-heading">Needs you</h2>
        <span aria-live="polite">Updates every 4 seconds</span>
      </div>
      {providerUnavailable ? (
        <p className="capture-outage-banner" role="status">
          The AI provider is unavailable. Encrypted captures remain queued or safe in Inbox. If you
          have not added an OpenAI or Claude key yet, add one in{" "}
          <Link href="/app/settings">Settings</Link>; otherwise captures will be retried.
        </p>
      ) : null}
      {error === null ? null : (
        <div className="capture-inline-error" role="status">
          <UnfiledGlyph glyph="warning" size={17} weight={1.9} /> {error}
        </div>
      )}
      {reviewDecisions}
      {loading && nothingWaiting ? (
        <div
          className="capture-activity-loading"
          aria-label="Loading capture activity"
          aria-busy="true"
        >
          <div className="skeleton-block h-4 w-32" />
          <div className="skeleton-block mt-4 h-12 w-full" />
        </div>
      ) : null}
      {!loading && nothingWaiting ? (
        <p className="capture-activity-empty">
          Nothing waiting. Everything you wrote is filed in your Library.
        </p>
      ) : null}
      <div className="capture-activity-list">
        {waiting.map((item) => {
          const retryLocal = item.local && item.status === "permanent";
          const retryRemote = !item.local && item.status === "failed";
          return (
            <article key={item.id} className="capture-activity-row">
              <div className="capture-state-icon">
                <UnfiledGlyph glyph={statusGlyph(item.status)} size={18} weight={1.9} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="capture-activity-meta">
                  <strong>{captureStatusLabel(item.status)}</strong>
                  <time dateTime={item.clientCreatedAt}>
                    {formatCaptureTime(item.clientCreatedAt)}
                  </time>
                </div>
                <p className="capture-preview">
                  {item.preview ?? "Encrypted capture saved on this device."}
                </p>
              </div>
              {retryLocal || retryRemote ? (
                <button
                  type="button"
                  className="quiet-button shrink-0"
                  onClick={() => (retryLocal ? onRetryLocal(item.id) : onRetryRemote(item.id))}
                >
                  <UnfiledGlyph glyph="undo" size={15} weight={2} /> Retry
                </button>
              ) : item.serverAvailable ? (
                <Link className="quiet-button shrink-0" href={`/app/captures/${item.id}`}>
                  View <UnfiledGlyph glyph="arrow" size={15} weight={2} />
                </Link>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
