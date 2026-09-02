"use client";

import {
  ArrowClockwiseIcon,
  ArrowRightIcon,
  CloudSlashIcon,
  LinkSimpleIcon,
  TrayIcon
} from "@phosphor-icons/react";
import type { EntityId, NoteBacklinkDto, NoteSourceDto } from "@unfiled/contracts";
import Link from "next/link";
import { useCallback, useState } from "react";

import { browserApi } from "@/lib/product/browser-api";
import { usePagedResource } from "@/lib/product/use-paged-resource";

type ContextListProps<Item> = Readonly<{
  error: string | null;
  hasMore: boolean;
  items: readonly Item[];
  loading: boolean;
  loadingMore: boolean;
  offline: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  pageError: string | null;
}>;

function sourceKey(source: NoteSourceDto): string {
  return `${source.captureId}:${source.mutationId}`;
}

function backlinkKey(backlink: NoteBacklinkDto): string {
  return backlink.linkId;
}

function captureSourceLabel(source: NoteSourceDto["source"]): string {
  switch (source) {
    case "ios_lock_screen_widget":
      return "Lock Screen";
    case "share_sheet":
      return "Share sheet";
    case "mobile":
      return "iPhone";
    case "web":
      return "Web";
    case "import":
      return "Import";
  }
}

function ContextLoading({ label }: Readonly<{ label: string }>) {
  return (
    <div className="note-context-loading" aria-busy="true" aria-label={label}>
      <span className="skeleton-block" aria-hidden="true" />
      <span className="skeleton-block" aria-hidden="true" />
    </div>
  );
}

function ContextError({
  message,
  offline,
  onRetry
}: Readonly<{ message: string; offline: boolean; onRetry: () => void }>) {
  const Icon = offline ? CloudSlashIcon : ArrowClockwiseIcon;
  return (
    <div className="note-context-state" role="alert">
      <Icon size={18} aria-hidden="true" />
      <div>
        <strong>{offline ? "You’re offline." : "This section didn’t load."}</strong>
        <p>{message}</p>
        <button type="button" className="quiet-button" onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}

function PageControls({
  hasMore,
  loadingMore,
  onLoadMore,
  pageError
}: Readonly<{
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  pageError: string | null;
}>) {
  return (
    <div className="note-context-page-controls">
      {hasMore ? (
        <button
          type="button"
          className="button-secondary"
          disabled={loadingMore}
          onClick={onLoadMore}
        >
          {loadingMore ? "Loading" : "Load more"}
        </button>
      ) : null}
      <p role={pageError === null ? undefined : "alert"}>{pageError}</p>
    </div>
  );
}

export function NoteSourcesList(props: ContextListProps<NoteSourceDto>) {
  if (props.loading && props.items.length === 0) {
    return <ContextLoading label="Loading source captures" />;
  }
  if (props.error !== null && props.items.length === 0) {
    return <ContextError message={props.error} offline={props.offline} onRetry={props.onRetry} />;
  }
  if (props.items.length === 0) {
    return <p className="note-context-empty">No source captures are attached to this note yet.</p>;
  }
  return (
    <div>
      <div className="note-context-list" aria-label="Source captures">
        {props.items.map((source) => (
          <article key={sourceKey(source)} className="note-context-source">
            <p>{source.rawContent}</p>
            <footer>
              <span>{captureSourceLabel(source.source)}</span>
              <time dateTime={source.clientCreatedAt}>
                {new Date(source.clientCreatedAt).toLocaleString()}
              </time>
              {source.relation === "source_removed" ? (
                <strong>Removed from note</strong>
              ) : source.insertedItemIds.length > 0 ? (
                <span>
                  {source.insertedItemIds.length} inserted{" "}
                  {source.insertedItemIds.length === 1 ? "item" : "items"}
                </span>
              ) : null}
            </footer>
          </article>
        ))}
      </div>
      <PageControls
        hasMore={props.hasMore}
        loadingMore={props.loadingMore}
        onLoadMore={props.onLoadMore}
        pageError={props.pageError}
      />
    </div>
  );
}

export function NoteBacklinksList(props: ContextListProps<NoteBacklinkDto>) {
  if (props.loading && props.items.length === 0) {
    return <ContextLoading label="Loading backlinks" />;
  }
  if (props.error !== null && props.items.length === 0) {
    return <ContextError message={props.error} offline={props.offline} onRetry={props.onRetry} />;
  }
  if (props.items.length === 0) {
    return <p className="note-context-empty">No notes link back to this one yet.</p>;
  }
  return (
    <div>
      <div className="note-context-list" aria-label="Backlinks">
        {props.items.map((backlink) => (
          <Link
            key={backlink.linkId}
            href={`/app/notes/${backlink.fromNoteId}`}
            className="note-context-backlink"
          >
            <span>
              <strong>{backlink.fromTitle}</strong>
              <small>
                {backlink.linkType === "reference" ? "Reference" : "Related note"}
                <time dateTime={backlink.createdAt}>
                  {new Date(backlink.createdAt).toLocaleDateString()}
                </time>
              </small>
            </span>
            <ArrowRightIcon size={16} aria-hidden="true" />
          </Link>
        ))}
      </div>
      <PageControls
        hasMore={props.hasMore}
        loadingMore={props.loadingMore}
        onLoadMore={props.onLoadMore}
        pageError={props.pageError}
      />
    </div>
  );
}

function SourcesResource({ noteId }: Readonly<{ noteId: EntityId<"note"> }>) {
  const loader = useCallback(
    (cursor?: string) => browserApi.listNoteSources(noteId, { cursor, limit: 30 }),
    [noteId]
  );
  const resource = usePagedResource(`note-sources:${noteId}`, sourceKey, loader);
  return (
    <NoteSourcesList
      items={resource.data?.items ?? []}
      hasMore={resource.data?.pageInfo.hasMore ?? false}
      loading={resource.loading}
      error={resource.error}
      offline={resource.offline}
      loadingMore={resource.loadingMore}
      pageError={resource.pageError}
      onRetry={() => void resource.refresh()}
      onLoadMore={() => void resource.loadMore()}
    />
  );
}

function BacklinksResource({ noteId }: Readonly<{ noteId: EntityId<"note"> }>) {
  const loader = useCallback(
    (cursor?: string) => browserApi.listNoteBacklinks(noteId, { cursor, limit: 30 }),
    [noteId]
  );
  const resource = usePagedResource(`note-backlinks:${noteId}`, backlinkKey, loader);
  return (
    <NoteBacklinksList
      items={resource.data?.items ?? []}
      hasMore={resource.data?.pageInfo.hasMore ?? false}
      loading={resource.loading}
      error={resource.error}
      offline={resource.offline}
      loadingMore={resource.loadingMore}
      pageError={resource.pageError}
      onRetry={() => void resource.refresh()}
      onLoadMore={() => void resource.loadMore()}
    />
  );
}

export function NoteContextSections({ noteId }: Readonly<{ noteId: EntityId<"note"> }>) {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [backlinksOpen, setBacklinksOpen] = useState(false);
  return (
    <>
      <details
        className="inspector-section"
        onToggle={(event) => setBacklinksOpen(event.currentTarget.open)}
      >
        <summary className="inspector-summary">
          <LinkSimpleIcon size={16} aria-hidden="true" /> Backlinks <span>View</span>
        </summary>
        {backlinksOpen ? <BacklinksResource noteId={noteId} /> : null}
      </details>
      <details
        className="inspector-section"
        onToggle={(event) => setSourcesOpen(event.currentTarget.open)}
      >
        <summary className="inspector-summary">
          <TrayIcon size={16} aria-hidden="true" /> Sources <span>View</span>
        </summary>
        {sourcesOpen ? <SourcesResource noteId={noteId} /> : null}
      </details>
    </>
  );
}
