"use client";

import type {
  EntityId,
  GeneratedBlockDetailResponse,
  GeneratedBlockResolveRequest,
  PublicReviewResolution,
  ReviewItemDto
} from "@unfiled/contracts";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  browserApi,
  isAmbiguousProductMutationFailure,
  isStaleRevision,
  productErrorMessage
} from "@/lib/product/browser-api";
import { announceProductChange, createIdempotencyKey } from "@/lib/product/client";
import { useLiveResource } from "@/lib/product/use-live-resource";
import { usePagedResource } from "@/lib/product/use-paged-resource";

import {
  GeneratedBlockCard,
  generatedResolutionAttempt,
  type GeneratedResolutionAttempt
} from "./generated-blocks-surface";
import { EmptyState, ResourceError, ResourceSkeleton } from "./resource-states";
import { UnfiledGlyph, type UnfiledGlyphName } from "./unfiled-glyph";

type GeneratedResolution = GeneratedBlockResolveRequest["resolution"];
type ReviewResolution = Extract<PublicReviewResolution, { type: "dismiss" | "keep_both" }>;

type ReviewAttempt = Readonly<{
  idempotencyKey: string;
  resolution: ReviewResolution;
}>;

export function reviewDecisionAttempt(
  previous: ReviewAttempt | null | undefined,
  resolution: ReviewResolution,
  createKey: () => string = createIdempotencyKey
): ReviewAttempt {
  return previous?.resolution.type === resolution.type
    ? previous
    : { idempotencyKey: createKey(), resolution };
}

/**
 * Whether the owner is offered a way to clear this item themselves.
 *
 * Every review item may be dismissed except a generated-block expansion, which carries its own
 * accept/reject decision instead (`reviewResolutionMatchesSemantics`, packages/contracts/src/
 * review.ts). The controls used to render only for duplicate suggestions and one legacy consent
 * hold, so a `low_confidence` item -- the type the organizer creates most, from planner_ambiguity
 * -- arrived with no control at all. It could not be resolved from the web, so it came back on
 * every four-second poll for good and the Inbox could never say "Nothing waiting."
 */
export function reviewItemIsDismissable(item: ReviewItemDto): boolean {
  return item.proposal.type !== "generated_block";
}

function reviewKey(item: ReviewItemDto): string {
  return item.id;
}

export function reviewLabel(type: ReviewItemDto["type"]): string {
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
      return "AI-generated proposal";
  }
}

export function reviewCopy(item: ReviewItemDto): string {
  if (item.type === "structure_conflict") {
    return "The edit could not be reconciled without risking structured note data. The saved note was left unchanged.";
  }
  if (item.type === "revision_conflict") {
    return "A write targeted an older revision. The newer saved version won and no content was replaced.";
  }
  if (item.type === "duplicate_suggestion") {
    return "Unfiled found notes that may overlap. This is a suggestion only; nothing has been merged or removed.";
  }
  if (item.type === "pending_expansion" && item.proposal.type === "generated_block") {
    return "Generated text is waiting outside your editable note until you accept or reject it.";
  }
  if (item.type === "pending_expansion") {
    return "This older expansion request is held for safety. Dismissing it does not change your note.";
  }
  return "This item needs a decision before Unfiled can continue safely.";
}

function reviewGlyph(type: ReviewItemDto["type"]): UnfiledGlyphName {
  if (type === "structure_conflict") return "checklist";
  if (type === "revision_conflict") return "move";
  if (type === "pending_expansion") return "card";
  return "warning";
}

export function DuplicateReviewProposal({ item }: Readonly<{ item: ReviewItemDto }>) {
  if (item.proposal.type !== "duplicate_notes") return null;
  return (
    <div className="review-proposal" aria-label="Notes in this duplicate suggestion">
      <p>{item.proposal.explanation}</p>
      <ul className="review-note-links">
        {item.proposal.notes.map((note, index) => (
          <li key={note.noteId}>
            <Link href={`/app/notes/${note.noteId}`}>
              Open candidate {index + 1}
              <span>revision {note.revision}</span>
              <UnfiledGlyph glyph="arrow" size={14} weight={2} />
            </Link>
          </li>
        ))}
      </ul>
      <p className="review-safety-copy">
        Keep both and Dismiss are non-destructive. Neither action merges, deletes, archives, or
        rewrites a note.
      </p>
    </div>
  );
}

function GeneratedReviewDecision({
  blockId,
  noteId,
  onResolved
}: Readonly<{
  blockId: EntityId<"blk">;
  noteId: EntityId<"note">;
  onResolved: (message: string) => void;
}>) {
  const load = useCallback(() => browserApi.getGeneratedBlock(blockId, noteId), [blockId, noteId]);
  const resource = useLiveResource<GeneratedBlockDetailResponse>(
    `/api/v1/generated-blocks/${blockId}`,
    load
  );
  const attempt = useRef<GeneratedResolutionAttempt | null>(null);
  const [pending, setPending] = useState<GeneratedResolution | null>(null);
  const [error, setError] = useState<string | null>(null);
  const block = resource.data?.block ?? null;

  const resolve = useCallback(
    async (resolution: GeneratedResolution): Promise<void> => {
      if (pending !== null || block?.state !== "proposed") return;
      const request = generatedResolutionAttempt(attempt.current, block, resolution);
      attempt.current = request;
      setPending(resolution);
      setError(null);
      try {
        const result = await browserApi.resolveGeneratedBlock(block, request);
        attempt.current = null;
        const message =
          result.block.state === "accepted"
            ? "AI-generated block accepted separately. Your note text was not changed."
            : "AI-generated block rejected. Your note text was not changed.";
        announceProductChange(`generated-block:${block.id}`);
        onResolved(message);
      } catch (reason) {
        if (isStaleRevision(reason)) {
          attempt.current = null;
          setError(productErrorMessage(reason, "This proposal changed elsewhere. Refreshed."));
          await resource.refresh();
        } else {
          if (!isAmbiguousProductMutationFailure(reason)) attempt.current = null;
          setError(
            productErrorMessage(
              reason,
              "The decision could not be confirmed. Retry to safely check the same request."
            )
          );
        }
      } finally {
        setPending(null);
      }
    },
    [block, onResolved, pending, resource]
  );

  if (resource.loading && resource.data === null) {
    return (
      <p className="review-inline-status" role="status">
        Loading the encrypted proposal…
      </p>
    );
  }
  if (resource.error !== null && resource.data === null) {
    return (
      <div className="review-proposal">
        <p className="text-sm text-critical" role="alert">
          {resource.error}
        </p>
        <button type="button" className="quiet-button mt-2" onClick={() => void resource.refresh()}>
          Try again
        </button>
      </div>
    );
  }
  if (block === null) {
    return (
      <div className="review-proposal">
        <p className="review-inline-status" role="status">
          This proposal is no longer available on the note. Refresh Review to reconcile its state.
        </p>
        <button type="button" className="quiet-button mt-2" onClick={() => void resource.refresh()}>
          Check again
        </button>
      </div>
    );
  }
  if (block.state !== "proposed") {
    return (
      <p className="review-inline-status" role="status">
        This block is already {block.state}. Review will reconcile automatically.
      </p>
    );
  }

  return (
    <div className="review-generated-decision">
      <GeneratedBlockCard
        block={block}
        pending={pending}
        onResolve={(value) => void resolve(value)}
      />
      <p className="review-inline-status text-critical" role="alert">
        {error}
      </p>
    </div>
  );
}

function MissingGeneratedBlockBinding() {
  return (
    <p className="review-inline-status text-critical" role="alert">
      This proposal is missing its note binding, so Unfiled will not apply a decision.
    </p>
  );
}

/**
 * The open review decisions. They live in the Inbox now (ADR-0019, decision 6): Review is no
 * longer a destination. `focusReviewItemId` narrows the list to one decision, which is what the
 * receipt's "Open Review" pushes; that page reads as decided once the item is resolved.
 */
export function ReviewView({
  focusReviewItemId,
  onEmptyChange
}: Readonly<{
  focusReviewItemId?: EntityId<"rvw">;
  onEmptyChange?: (empty: boolean) => void;
}> = {}) {
  const resource = usePagedResource<ReviewItemDto>(
    "/api/v1/review-items?state=open&limit=30",
    reviewKey
  );
  const attempts = useRef(new Map<string, ReviewAttempt>());
  const listRegion = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<Readonly<{
    reviewItemId: string;
    resolution: ReviewResolution["type"];
  }> | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const removeResolvedItem = useCallback(
    (reviewItemId: string, nextMessage: string): void => {
      const current = resource.data;
      if (current !== null) {
        resource.setData({
          ...current,
          items: current.items.filter((item) => item.id !== reviewItemId)
        });
      }
      setError(null);
      setMessage(nextMessage);
      announceProductChange(`review-item:${reviewItemId}`);
      window.requestAnimationFrame(() => listRegion.current?.focus());
    },
    [resource]
  );

  const resolveReview = useCallback(
    async (item: ReviewItemDto, resolution: ReviewResolution): Promise<void> => {
      if (pending !== null) return;
      const request = reviewDecisionAttempt(attempts.current.get(item.id), resolution);
      attempts.current.set(item.id, request);
      setPending({ reviewItemId: item.id, resolution: resolution.type });
      setError(null);
      setMessage(null);
      try {
        const result = await browserApi.resolveReviewItem(item.id, request);
        attempts.current.delete(item.id);
        const nextMessage =
          result.reviewItem.resolution?.type === "keep_both"
            ? "Both notes kept unchanged. Nothing was merged, removed, or rewritten."
            : "Suggestion dismissed. No note was changed.";
        removeResolvedItem(item.id, nextMessage);
        if (result.replayed) await resource.refresh();
      } catch (reason) {
        if (isStaleRevision(reason)) {
          attempts.current.delete(item.id);
          setError(productErrorMessage(reason, "This review item changed elsewhere. Refreshed."));
          await resource.refresh();
        } else {
          if (!isAmbiguousProductMutationFailure(reason)) attempts.current.delete(item.id);
          setError(
            productErrorMessage(
              reason,
              "The decision could not be confirmed. Retry to safely check the same request."
            )
          );
        }
      } finally {
        setPending(null);
      }
    },
    [pending, removeResolvedItem, resource]
  );

  const items = (resource.data?.items ?? []).filter(
    (item) => focusReviewItemId === undefined || item.id === focusReviewItemId
  );
  // The Inbox says "nothing waiting" only when this list is empty too, so it has to be told.
  //
  // This runs before the loading and error returns below, not after them. Sitting after, it was
  // reached only once data had arrived, so the first render ran no hooks and the second ran one,
  // and React tore down the whole page rather than the list: every view of the app showed "This
  // page did not load" while every request behind it had answered 200.
  useEffect(() => onEmptyChange?.(items.length === 0), [items.length, onEmptyChange]);

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
  if (items.length === 0 && message === null && error === null) {
    // In the Inbox this list is one part of "Needs you", which already says when nothing is
    // waiting; a second empty state stacked under the first would say it twice.
    return focusReviewItemId === undefined ? null : (
      <EmptyState
        title="This review is already decided."
        body="Nothing is waiting on it. The capture's receipt shows what happened."
      />
    );
  }

  return (
    <div ref={listRegion} tabIndex={-1} aria-label="Open review decisions">
      <p
        className="review-view-status"
        aria-live="polite"
        role={error === null ? "status" : "alert"}
      >
        {error ?? message}
      </p>
      <div className="border-t border-outline">
        {items.map((item) => {
          const duplicate = item.proposal.type === "duplicate_notes";
          const generatedProposal = item.proposal.type === "generated_block" ? item.proposal : null;
          const dismissable = reviewItemIsDismissable(item);
          const itemPending = pending?.reviewItemId === item.id ? pending.resolution : null;
          return (
            <article key={item.id} className="review-row">
              <div className="review-icon">
                <UnfiledGlyph glyph={reviewGlyph(item.type)} size={19} weight={1.9} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <h2 className="settings-section-title">{reviewLabel(item.type)}</h2>
                  <time className="text-[11px] text-muted-content" dateTime={item.createdAt}>
                    {new Date(item.createdAt).toLocaleString()}
                  </time>
                </div>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-content">
                  {reviewCopy(item)}
                </p>
                {duplicate ? <DuplicateReviewProposal item={item} /> : null}
                {generatedProposal !== null && item.noteId !== null ? (
                  <GeneratedReviewDecision
                    blockId={generatedProposal.blockId}
                    noteId={item.noteId}
                    onResolved={(nextMessage) => removeResolvedItem(item.id, nextMessage)}
                  />
                ) : null}
                {generatedProposal !== null && item.noteId === null ? (
                  <MissingGeneratedBlockBinding />
                ) : null}
                {dismissable ? (
                  <div className="review-actions" aria-label="Review decision">
                    {duplicate ? (
                      <button
                        type="button"
                        className="button-primary"
                        disabled={pending !== null}
                        onClick={() => void resolveReview(item, { type: "keep_both" })}
                      >
                        <UnfiledGlyph glyph="check" size={16} weight={2.2} />
                        {itemPending === "keep_both" ? "Keeping…" : "Keep both"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="button-secondary"
                      disabled={pending !== null}
                      onClick={() => void resolveReview(item, { type: "dismiss" })}
                    >
                      <UnfiledGlyph glyph="close" size={16} weight={2.2} />
                      {itemPending === "dismiss" ? "Dismissing…" : "Dismiss"}
                    </button>
                  </div>
                ) : null}
              </div>
              {item.noteId === null || generatedProposal !== null ? null : (
                <Link className="quiet-button shrink-0" href={`/app/notes/${item.noteId}`}>
                  Open note <UnfiledGlyph glyph="arrow" size={15} weight={2} />
                </Link>
              )}
            </article>
          );
        })}
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
