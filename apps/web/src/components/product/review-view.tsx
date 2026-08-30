"use client";

import {
  ArrowRightIcon,
  BracketsCurlyIcon,
  GitDiffIcon,
  WarningCircleIcon
} from "@phosphor-icons/react";
import type { ReviewItemDto } from "@unfiled/contracts";
import Link from "next/link";

import { usePagedResource } from "@/lib/product/use-paged-resource";

import { EmptyState, ResourceError, ResourceSkeleton } from "./resource-states";

function reviewKey(item: ReviewItemDto): string {
  return item.id;
}

function reviewLabel(type: ReviewItemDto["type"]): string {
  switch (type) {
    case "structure_conflict":
      return "Structure conflict";
    case "revision_conflict":
      return "Revision conflict";
    case "duplicate_suggestion":
      return "Possible duplicate";
    case "failed_job":
      return "Processing failed";
    case "low_confidence":
      return "Needs a destination";
    case "pending_expansion":
      return "Expansion pending";
  }
}

function reviewCopy(item: ReviewItemDto): string {
  if (item.type === "structure_conflict") {
    return "The edit could not be reconciled without risking structured note data. The saved note was left unchanged.";
  }
  if (item.type === "revision_conflict") {
    return "A write targeted an older revision. The newer saved version won and no content was replaced.";
  }
  return "This item needs a decision before Unfiled can continue safely.";
}

function ReviewIcon({ type }: Readonly<{ type: ReviewItemDto["type"] }>) {
  if (type === "structure_conflict") return <BracketsCurlyIcon size={19} aria-hidden="true" />;
  if (type === "revision_conflict") return <GitDiffIcon size={19} aria-hidden="true" />;
  return <WarningCircleIcon size={19} aria-hidden="true" />;
}

export function ReviewView() {
  const resource = usePagedResource<ReviewItemDto>(
    "/api/v1/review-items?state=open&limit=30",
    reviewKey
  );

  if (resource.loading && resource.data === null) return <ResourceSkeleton rows={4} />;
  if (resource.error !== null && resource.data === null) {
    return (
      <ResourceError
        message={resource.error}
        offline={resource.offline}
        retry={() => void resource.refresh()}
      />
    );
  }
  if (resource.data?.items.length === 0) {
    return (
      <EmptyState
        title="Nothing needs review."
        body="Conflicting edits and structure questions will wait here without changing the saved note."
      />
    );
  }

  return (
    <div>
      <div className="border-t border-outline">
        {resource.data?.items.map((item) => (
          <article key={item.id} className="review-row">
            <div className="review-icon">
              <ReviewIcon type={item.type} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h2 className="text-lg font-medium">{reviewLabel(item.type)}</h2>
                <time
                  className="font-mono text-[11px] text-disabled-content"
                  dateTime={item.createdAt}
                >
                  {new Date(item.createdAt).toLocaleString()}
                </time>
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-content">
                {reviewCopy(item)}
              </p>
            </div>
            {item.noteId === null ? null : (
              <Link className="quiet-button shrink-0" href={`/app/notes/${item.noteId}`}>
                Open note <ArrowRightIcon size={15} aria-hidden="true" />
              </Link>
            )}
          </article>
        ))}
      </div>
      {resource.data?.pageInfo.hasMore ? (
        <div className="pagination-row">
          <button
            type="button"
            className="button-secondary"
            disabled={resource.loadingMore}
            onClick={() => void resource.loadMore()}
          >
            {resource.loadingMore ? "Loading…" : "Load more review items"}
          </button>
        </div>
      ) : null}
      <p className="min-h-6 py-2 text-xs text-critical" role="alert">
        {resource.pageError}
      </p>
    </div>
  );
}
