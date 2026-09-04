"use client";

import {
  entityIdSchema,
  type EntityId,
  type GeneratedBlockDto,
  type GeneratedBlockResolveRequest
} from "@unfiled/contracts";
import { useCallback, useMemo, useRef, useState } from "react";

import {
  browserApi,
  isAmbiguousProductMutationFailure,
  isStaleRevision,
  productErrorMessage
} from "@/lib/product/browser-api";
import { announceProductChange, createIdempotencyKey } from "@/lib/product/client";
import { usePagedResource, type PagedResourceLoader } from "@/lib/product/use-paged-resource";

import { UnfiledGlyph } from "./unfiled-glyph";

type Resolution = GeneratedBlockResolveRequest["resolution"];
export type GeneratedResolutionAttempt = Readonly<{
  expectedStateRevision: number;
  idempotencyKey: string;
  resolution: Resolution;
}>;

export function generatedResolutionAttempt(
  previous: GeneratedResolutionAttempt | null | undefined,
  block: Pick<GeneratedBlockDto, "stateRevision">,
  resolution: Resolution,
  createKey: () => string = createIdempotencyKey
): GeneratedResolutionAttempt {
  return previous?.expectedStateRevision === block.stateRevision &&
    previous.resolution === resolution
    ? previous
    : {
        expectedStateRevision: block.stateRevision,
        idempotencyKey: createKey(),
        resolution
      };
}

export function visibleGeneratedBlocks(
  blocks: readonly GeneratedBlockDto[]
): readonly GeneratedBlockDto[] {
  return blocks.filter((block) => block.state !== "rejected");
}

function generatedBlockKey(block: GeneratedBlockDto): string {
  return block.id;
}

export function GeneratedBlockCard({
  block,
  pending,
  onResolve
}: Readonly<{
  block: GeneratedBlockDto;
  pending: Resolution | null;
  onResolve: (resolution: Resolution) => void;
}>) {
  const proposed = block.state === "proposed";
  return (
    <article className="generated-block-card" aria-label={`AI-generated ${block.kind}`}>
      <div className="generated-block-label">
        <UnfiledGlyph glyph="card" size={15} weight={1.9} />
        <span>AI-generated</span>
        <span aria-hidden="true">·</span>
        <span>{proposed ? "Proposed" : "Accepted"}</span>
      </div>
      <p className="generated-block-content">{block.content}</p>
      <p className="generated-block-provenance">
        {block.kind} · {block.modelId} · prompt {block.promptVersion}
      </p>
      {proposed ? (
        <div className="generated-block-actions" aria-label="Generated content decision">
          <button
            type="button"
            className="button-primary"
            disabled={pending !== null}
            onClick={() => onResolve("accept")}
          >
            <UnfiledGlyph glyph="check" size={16} weight={2.2} />
            {pending === "accept" ? "Accepting…" : "Accept"}
          </button>
          <button
            type="button"
            className="button-secondary"
            disabled={pending !== null}
            onClick={() => onResolve("reject")}
          >
            <UnfiledGlyph glyph="close" size={16} weight={2.2} />
            {pending === "reject" ? "Rejecting…" : "Reject"}
          </button>
        </div>
      ) : (
        <p className="generated-block-terminal">
          <UnfiledGlyph glyph="check" size={15} weight={2.2} /> Accepted as a separate, read-only
          block
        </p>
      )}
    </article>
  );
}

export function GeneratedBlocksSurface({ noteId }: Readonly<{ noteId: EntityId<"note"> }>) {
  const loadPage = useCallback<PagedResourceLoader<GeneratedBlockDto>>(
    (cursor) =>
      browserApi.listGeneratedBlocks(
        noteId,
        cursor === undefined ? {} : { cursor: entityIdSchema("blk").parse(cursor) }
      ),
    [noteId]
  );
  const resource = usePagedResource<GeneratedBlockDto>(
    `/api/v1/notes/${noteId}/generated-blocks`,
    generatedBlockKey,
    loadPage
  );
  const attempts = useRef(new Map<string, GeneratedResolutionAttempt>());
  const heading = useRef<HTMLHeadingElement>(null);
  const [pending, setPending] = useState<Readonly<{
    blockId: string;
    resolution: Resolution;
  }> | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const blocks = useMemo(
    () => visibleGeneratedBlocks(resource.data?.items ?? []),
    [resource.data?.items]
  );

  const resolve = useCallback(
    async (block: GeneratedBlockDto, resolution: Resolution): Promise<void> => {
      if (pending !== null || block.state !== "proposed") return;
      const attempt = generatedResolutionAttempt(attempts.current.get(block.id), block, resolution);
      attempts.current.set(block.id, attempt);
      setPending({ blockId: block.id, resolution });
      setError(null);
      setMessage(null);
      try {
        const result = await browserApi.resolveGeneratedBlock(block, attempt);
        attempts.current.delete(block.id);
        const current = resource.data?.items ?? [];
        resource.setData({
          pageInfo: resource.data?.pageInfo ?? { hasMore: false, nextCursor: null },
          items:
            result.block.state === "rejected"
              ? current.filter((candidate) => candidate.id !== block.id)
              : current.map((candidate) =>
                  candidate.id === result.block.id ? result.block : candidate
                )
        });
        setMessage(
          result.block.state === "accepted"
            ? "AI-generated block accepted. Your note text was not changed."
            : "AI-generated block rejected. Your note text was not changed."
        );
        announceProductChange(`generated-block:${block.id}`);
        if (result.replayed) await resource.refresh();
        if (result.block.state === "rejected") {
          window.requestAnimationFrame(() => heading.current?.focus());
        }
      } catch (reason) {
        if (isStaleRevision(reason)) {
          attempts.current.delete(block.id);
          setError(productErrorMessage(reason, "This proposal changed elsewhere. Refreshed."));
          await resource.refresh();
        } else {
          if (!isAmbiguousProductMutationFailure(reason)) attempts.current.delete(block.id);
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
    [pending, resource]
  );

  if (resource.loading && resource.data === null) {
    return (
      <p className="generated-block-loading" role="status">
        Checking for AI-generated blocks…
      </p>
    );
  }
  if (resource.error !== null && resource.data === null) {
    return (
      <section className="generated-blocks-section" aria-label="AI-generated blocks">
        <p className="text-sm text-critical" role="alert">
          {resource.error}
        </p>
        <button type="button" className="quiet-button mt-2" onClick={() => void resource.refresh()}>
          Try again
        </button>
      </section>
    );
  }
  if (
    blocks.length === 0 &&
    resource.data?.pageInfo.hasMore !== true &&
    message === null &&
    error === null
  ) {
    return null;
  }

  return (
    <section className="generated-blocks-section" aria-labelledby="generated-blocks-title">
      <div className="generated-blocks-heading">
        <div>
          <p className="eyebrow">Separate from your note</p>
          <h2 id="generated-blocks-title" ref={heading} tabIndex={-1}>
            AI-generated blocks
          </h2>
        </div>
        <p>{blocks.length} visible</p>
      </div>
      <div className="generated-block-list">
        {blocks.map((block) => (
          <GeneratedBlockCard
            key={block.id}
            block={block}
            pending={pending?.blockId === block.id ? pending.resolution : null}
            onResolve={(resolution) => void resolve(block, resolution)}
          />
        ))}
      </div>
      <p
        className={
          error === null ? "generated-block-status" : "generated-block-status text-critical"
        }
        aria-live="polite"
        role={error === null ? "status" : "alert"}
      >
        {error ?? message}
      </p>
      {resource.data?.pageInfo.hasMore ? (
        <div className="pagination-row">
          <button
            type="button"
            className="button-secondary"
            disabled={resource.loadingMore}
            onClick={() => void resource.loadMore()}
          >
            {resource.loadingMore ? "Loading…" : "Load more AI-generated blocks"}
          </button>
        </div>
      ) : null}
      <p className="min-h-6 py-2 text-xs text-critical" role="alert">
        {resource.pageError}
      </p>
    </section>
  );
}
