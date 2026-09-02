"use client";

import {
  ArrowClockwiseIcon,
  ArrowRightIcon,
  CheckCircleIcon,
  CloudArrowUpIcon,
  HourglassMediumIcon,
  TrayIcon,
  WarningCircleIcon
} from "@phosphor-icons/react";
import type { EntityId } from "@unfiled/contracts";
import Link from "next/link";

import type { CaptureActivityItem, CaptureActivityStatus } from "@/lib/capture/capture-queue";

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

function StatusIcon({ status }: Readonly<{ status: CaptureActivityStatus }>) {
  if (status === "done") return <CheckCircleIcon size={18} weight="fill" aria-hidden="true" />;
  if (status === "failed" || status === "permanent") {
    return <WarningCircleIcon size={18} aria-hidden="true" />;
  }
  if (status === "inbox" || status === "needs_review") {
    return <TrayIcon size={18} aria-hidden="true" />;
  }
  if (status === "waiting" || status === "retrying") {
    return <CloudArrowUpIcon size={18} aria-hidden="true" />;
  }
  return <HourglassMediumIcon size={18} aria-hidden="true" />;
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
}>;

export function CaptureActivity({
  error,
  items,
  loading,
  onRetryLocal,
  onRetryRemote
}: CaptureActivityProps) {
  const providerUnavailable = items.some((item) => item.errorCode === "provider_unavailable");

  return (
    <section className="capture-activity" aria-labelledby="capture-activity-heading">
      <div className="capture-section-heading">
        <h2 id="capture-activity-heading">Capture activity</h2>
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
          <WarningCircleIcon size={17} aria-hidden="true" /> {error}
        </div>
      )}
      {loading && items.length === 0 ? (
        <div
          className="capture-activity-loading"
          aria-label="Loading capture activity"
          aria-busy="true"
        >
          <div className="skeleton-block h-4 w-32" />
          <div className="skeleton-block mt-4 h-12 w-full" />
        </div>
      ) : null}
      {!loading && items.length === 0 ? (
        <p className="capture-activity-empty">Saved captures will show their progress here.</p>
      ) : null}
      <div className="capture-activity-list">
        {items.map((item) => {
          const retryLocal = item.local && item.status === "permanent";
          const retryRemote = !item.local && item.status === "failed";
          return (
            <article key={item.id} className="capture-activity-row">
              <div className="capture-state-icon">
                <StatusIcon status={item.status} />
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
                  <ArrowClockwiseIcon size={15} aria-hidden="true" /> Retry
                </button>
              ) : item.serverAvailable ? (
                <Link className="quiet-button shrink-0" href={`/app/captures/${item.id}`}>
                  View <ArrowRightIcon size={15} aria-hidden="true" />
                </Link>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
