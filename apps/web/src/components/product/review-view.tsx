"use client";

import type {
  CaptureDetailResponse,
  CaptureReceipt,
  CaptureReceiptResponse,
  EntityId,
  GeneratedBlockDetailResponse,
  GeneratedBlockResolveRequest,
  NoteSummary,
  OrganizationPlan,
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
import { CardSkeleton, EmptyState, ResourceError } from "./resource-states";
import {
  letUnfiledDecide,
  noteTypeForCaptureKind,
  receiptBoundTo,
  reviewAllowedActions,
  reviewSuggestedDestinations,
  reviewSuggestedNewNote,
  suggestedNoteTitle
} from "./review-actions";
import { reviewReasonSentences } from "./review-reasons";
import { organizeCaptureAgain } from "@/lib/capture/organize-again";
import { UnfiledGlyph } from "./unfiled-glyph";

type GeneratedResolution = GeneratedBlockResolveRequest["resolution"];
type ReviewResolution = PublicReviewResolution;

type ReviewAttempt = Readonly<{
  idempotencyKey: string;
  resolution: ReviewResolution;
}>;

export function reviewDecisionAttempt(
  previous: ReviewAttempt | null | undefined,
  resolution: ReviewResolution,
  createKey: () => string = createIdempotencyKey
): ReviewAttempt {
  // The same decision keeps its key so a retry is safe; a different target is a new decision.
  return previous !== null &&
    previous !== undefined &&
    JSON.stringify(previous.resolution) === JSON.stringify(resolution)
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

function noteKey(note: NoteSummary): string {
  return note.id;
}

export function reviewLabel(type: ReviewItemDto["type"]): string {
  switch (type) {
    case "structure_conflict":
      return "Structured note conflict";
    case "revision_conflict":
      return "The note changed while filing";
    case "duplicate_suggestion":
      return "Possible duplicate note";
    case "failed_job":
      return "Organization needs another attempt";
    case "low_confidence":
      return "Low-confidence destination";
    case "pending_expansion":
      return "Expansion needs approval";
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
  onCountChange,
  onEditText,
  onEmptyChange
}: Readonly<{
  focusReviewItemId?: EntityId<"rvw">;
  /** How many open decisions there are, for the Inbox heading. */
  onCountChange?: (count: number) => void;
  /** "Edit text": the capture's words go back to the composer, and saving replaces it. */
  onEditText?: (
    capture: Readonly<{ id: EntityId<"cap">; rawContent: string; attachmentCount: number }>
  ) => void;
  onEmptyChange?: (empty: boolean) => void;
}> = {}) {
  const resource = usePagedResource<ReviewItemDto>(
    "/api/v1/review-items?state=open&limit=30",
    reviewKey
  );
  const notes = usePagedResource<NoteSummary>("/api/v1/notes?limit=100", noteKey);
  const attempts = useRef(new Map<string, ReviewAttempt>());
  const listRegion = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<Readonly<{
    reviewItemId: string;
    resolution: ReviewResolution["type"] | "delete" | "organize_again";
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
    async (
      item: ReviewItemDto,
      resolution: ReviewResolution,
      successMessage?: string
    ): Promise<void> => {
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
          successMessage ??
          (result.reviewItem.resolution?.type === "keep_both"
            ? "Both notes kept unchanged. Nothing was merged, removed, or rewritten."
            : "Closed. No note was changed.");
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

  const deleteCapture = useCallback(
    async (item: ReviewItemDto): Promise<void> => {
      if (pending !== null || item.captureId === null) return;
      setPending({ reviewItemId: item.id, resolution: "delete" });
      setError(null);
      setMessage(null);
      try {
        await browserApi.deleteCapture(item.captureId, { idempotencyKey: createIdempotencyKey() });
        removeResolvedItem(item.id, "Capture deleted. Nothing was filed.");
        await resource.refresh();
      } catch (reason) {
        setError(productErrorMessage(reason, "The capture could not be deleted."));
      } finally {
        setPending(null);
      }
    },
    [pending, removeResolvedItem, resource]
  );

  const organizeAgain = useCallback(
    async (item: ReviewItemDto, capture: ReviewCapture, guidance: string): Promise<void> => {
      if (pending !== null) return;
      setPending({ reviewItemId: item.id, resolution: "organize_again" });
      setError(null);
      setMessage(null);
      try {
        await organizeCaptureAgain(browserApi, capture, guidance);
        removeResolvedItem(
          item.id,
          guidance.trim().length === 0
            ? "Organizing again."
            : "Organizing again with your directions."
        );
        await resource.refresh();
      } catch (reason) {
        setError(
          productErrorMessage(reason, "That capture could not be organized again. Try once more.")
        );
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
  useEffect(() => {
    onEmptyChange?.(items.length === 0);
    if (resource.data !== null) onCountChange?.(items.length);
  }, [items.length, onCountChange, onEmptyChange, resource.data]);

  if (resource.loading && resource.data === null) return <CardSkeleton cards={2} />;
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
      <div className="review-card-list">
        {items.map((item, index) => (
          <ReviewCard
            key={item.id}
            index={index}
            item={item}
            notes={notes.data?.items ?? []}
            onDelete={(target) => void deleteCapture(target)}
            onEditText={onEditText}
            onOrganizeAgain={(target, capture, guidance) =>
              void organizeAgain(target, capture, guidance)
            }
            onRemoved={removeResolvedItem}
            onResolve={(target, resolution, nextMessage) =>
              void resolveReview(target, resolution, nextMessage)
            }
            pending={pending}
            total={items.length}
          />
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

/** The phone's review card (ReviewView.swift): the capture, why it stopped, where it could go. */
/** What organizing again and editing need from the capture: its words and its settings. */
type ReviewCapture = Readonly<{
  id: EntityId<"cap">;
  rawContent: string;
  expansionDisabled: boolean;
  attachmentCount: number;
}>;

type ReviewCardProps = Readonly<{
  index: number;
  item: ReviewItemDto;
  notes: readonly NoteSummary[];
  onDelete: (item: ReviewItemDto) => void;
  onEditText?: ((capture: ReviewCapture) => void) | undefined;
  onOrganizeAgain: (item: ReviewItemDto, capture: ReviewCapture, guidance: string) => void;
  onRemoved: (reviewItemId: string, nextMessage: string) => void;
  onResolve: (item: ReviewItemDto, resolution: ReviewResolution, message?: string) => void;
  pending: Readonly<{ reviewItemId: string; resolution: string }> | null;
  total: number;
}>;

export function ReviewCard(props: ReviewCardProps) {
  return props.item.captureId === null ? (
    <ReviewCardBody {...props} capture={null} receipt={null} />
  ) : (
    <CaptureReviewCard {...props} captureId={props.item.captureId} />
  );
}

function CaptureReviewCard({
  captureId,
  ...props
}: ReviewCardProps & Readonly<{ captureId: EntityId<"cap"> }>) {
  const capture = useLiveResource<CaptureDetailResponse>(`/api/v1/captures/${captureId}`);
  const receipt = useLiveResource<CaptureReceiptResponse>(`/api/v1/captures/${captureId}/receipt`);
  return (
    <ReviewCardBody
      {...props}
      capture={
        capture.data === null
          ? null
          : {
              id: capture.data.capture.id,
              rawContent: capture.data.capture.rawContent,
              expansionDisabled: capture.data.capture.expansionDisabled,
              attachmentCount: capture.data.capture.attachments.length
            }
      }
      receipt={receipt.data?.receipt ?? null}
    />
  );
}

function ReviewCardBody({
  capture,
  index,
  item,
  notes,
  onDelete,
  onEditText,
  onOrganizeAgain,
  onRemoved,
  onResolve,
  pending,
  receipt,
  total
}: ReviewCardProps &
  Readonly<{
    capture: ReviewCapture | null;
    receipt: CaptureReceipt | null;
  }>) {
  const [directions, setDirections] = useState("");
  const allowed = reviewAllowedActions(item, receipt);
  const bound = receiptBoundTo(item, receipt);
  const reasons = reviewReasonSentences(bound?.reasonCodes ?? []);
  const suggested = reviewSuggestedDestinations(item, notes);
  const newNote = reviewSuggestedNewNote(item);
  const captureText = capture?.rawContent ?? "";
  const decision = letUnfiledDecide(item, allowed, notes, captureText);
  const duplicate = item.proposal.type === "duplicate_notes";
  const generatedProposal = item.proposal.type === "generated_block" ? item.proposal : null;
  const busy = pending !== null;
  const itemPending = pending?.reviewItemId === item.id ? pending.resolution : null;
  const position = (value: number) => value.toString().padStart(2, "0");

  return (
    <article className="review-card" aria-labelledby={`review-${item.id}-title`}>
      <div className="review-card-head">
        <p className="eyebrow">
          <UnfiledGlyph glyph="tray" size={15} weight={1.9} /> Needs your input
        </p>
        <span className="review-card-position">
          {position(index + 1)} / {position(total)}
        </span>
      </div>
      <h2 id={`review-${item.id}-title`} className="review-card-title">
        {reviewLabel(item.type)}
      </h2>
      {captureText.length > 0 ? (
        <p className="review-thought">{captureText}</p>
      ) : (
        <p className="review-copy">{reviewCopy(item)}</p>
      )}
      {reasons.length > 0 ? (
        <section className="review-reasons" aria-label="Why it stopped">
          <p className="eyebrow">Why it stopped</p>
          {reasons.map((sentence) => (
            <p key={sentence}>{sentence}</p>
          ))}
        </section>
      ) : null}
      {duplicate ? <DuplicateReviewProposal item={item} /> : null}
      {generatedProposal !== null && item.noteId !== null ? (
        <GeneratedReviewDecision
          blockId={generatedProposal.blockId}
          noteId={item.noteId}
          onResolved={(nextMessage) => onRemoved(item.id, nextMessage)}
        />
      ) : null}
      {generatedProposal !== null && item.noteId === null ? <MissingGeneratedBlockBinding /> : null}
      {allowed.includes("route") && suggested.length > 0 ? (
        <section className="review-destinations" aria-label="Suggested destinations">
          <p className="eyebrow">Suggested destinations</p>
          <div className="review-destination-list">
            {suggested.map((note) => (
              <button
                key={note.id}
                type="button"
                className="review-destination"
                disabled={busy}
                onClick={() =>
                  onResolve(
                    item,
                    { type: "route", noteId: note.id, expectedRevision: note.currentRevision },
                    `Filed into ${note.title}.`
                  )
                }
              >
                <UnfiledGlyph glyph="move" size={15} weight={1.9} /> {note.title}
              </button>
            ))}
          </div>
        </section>
      ) : null}
      {allowed.length === 0 || generatedProposal !== null ? null : (
        <div className="review-actions" aria-label="Review decision">
          {decision !== null ? (
            <button
              type="button"
              className="button-primary"
              disabled={busy}
              onClick={() =>
                onResolve(
                  item,
                  decision,
                  decision.type === "route" ? "Filed where Unfiled suggested." : "Started a note."
                )
              }
            >
              <UnfiledGlyph glyph="check" size={16} weight={2.2} />
              {itemPending === decision.type ? "Saving your choice…" : "Let Unfiled decide"}
            </button>
          ) : null}
          {allowed.includes("create") ? (
            <button
              type="button"
              className="button-secondary"
              disabled={busy}
              onClick={() =>
                onResolve(
                  item,
                  {
                    type: "create",
                    title: newNote?.title ?? suggestedNoteTitle(captureText),
                    noteType: newNote?.noteType ?? noteTypeForCaptureKind(reviewCaptureKind(item)),
                    spaceId: null
                  },
                  "Started a note."
                )
              }
            >
              <UnfiledGlyph glyph="plus" size={16} weight={2.2} />
              {newNote === null ? "New note" : `New note: ${newNote.title}`}
            </button>
          ) : null}
          {allowed.includes("keep_both") ? (
            <button
              type="button"
              className="button-primary"
              disabled={busy}
              onClick={() => onResolve(item, { type: "keep_both" })}
            >
              <UnfiledGlyph glyph="library" size={16} weight={2.2} />
              {itemPending === "keep_both" ? "Keeping…" : "Keep both notes"}
            </button>
          ) : null}
          {capture !== null ? (
            <>
              <button
                type="button"
                className="button-secondary"
                disabled={busy || onEditText === undefined}
                onClick={() => onEditText?.(capture)}
              >
                <UnfiledGlyph glyph="pen" size={16} weight={2.2} /> Edit text
              </button>
            </>
          ) : null}
          {item.captureId === null ? (
            allowed.includes("dismiss") ? (
              <button
                type="button"
                className="button-secondary"
                disabled={busy}
                onClick={() => onResolve(item, { type: "dismiss" })}
              >
                <UnfiledGlyph glyph="close" size={16} weight={2.2} />
                {itemPending === "dismiss" ? "Closing…" : "Not now"}
              </button>
            ) : null
          ) : (
            <button
              type="button"
              className="button-secondary"
              disabled={busy}
              onClick={() => onDelete(item)}
            >
              <UnfiledGlyph glyph="trash" size={16} weight={2.2} />
              {itemPending === "delete" ? "Deleting…" : "Delete capture"}
            </button>
          )}
        </div>
      )}
      {capture !== null ? (
        <form
          className="review-directions"
          onSubmit={(event) => {
            event.preventDefault();
            onOrganizeAgain(item, capture, directions);
          }}
        >
          <label htmlFor={`review-directions-${item.id}`} className="sr-only">
            Directions for organizing again
          </label>
          <input
            id={`review-directions-${item.id}`}
            className="editor-control"
            maxLength={500}
            placeholder="Tell Unfiled what to do (optional)"
            value={directions}
            disabled={busy}
            onChange={(event) => setDirections(event.target.value)}
          />
          <button type="submit" className="button-secondary" disabled={busy}>
            <UnfiledGlyph glyph="send" size={16} weight={2.2} />
            {itemPending === "organize_again" ? "Organizing…" : "Organize again"}
          </button>
          {capture.attachmentCount === 0 ? null : (
            <p className="review-copy">
              Its photos stay with the original; a browser tab cannot carry them over.
            </p>
          )}
        </form>
      ) : null}
      {duplicate ? (
        <p className="review-safety-copy">
          Keeping both changes neither note. Not now also leaves both notes untouched.
        </p>
      ) : null}
      <div className="review-card-footer">
        {item.captureId === null ? null : (
          <span>
            <UnfiledGlyph glyph="clock" size={14} weight={1.9} /> Original preserved
          </span>
        )}
        {item.noteId === null || generatedProposal !== null ? null : (
          <Link className="quiet-button" href={`/app/notes/${item.noteId}`}>
            Open note <UnfiledGlyph glyph="arrow" size={15} weight={2} />
          </Link>
        )}
      </div>
    </article>
  );
}

function reviewCaptureKind(item: ReviewItemDto): OrganizationPlan["captureKind"] {
  return item.proposal.type === "route_capture" ? item.proposal.plan.captureKind : "freeform";
}
