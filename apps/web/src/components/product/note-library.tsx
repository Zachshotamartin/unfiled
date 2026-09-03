"use client";

import { ArrowRightIcon } from "@phosphor-icons/react";
import type { NoteSummary } from "@unfiled/contracts";
import Link from "next/link";

import { usePagedResource } from "@/lib/product/use-paged-resource";

import { EmptyState, ResourceError, ResourceSkeleton } from "./resource-states";

function formatRelative(value: string): string {
  const timestamp = new Date(value);
  const day = timestamp.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const time = timestamp.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day} · ${time}`;
}

function NoteRow({ note }: Readonly<{ note: NoteSummary }>) {
  return (
    <Link href={`/app/notes/${note.id}`} className="note-row group">
      <div className="flex items-center justify-between gap-5">
        <span className="eyebrow">{note.type}</span>
        <time dateTime={note.updatedAt} className="font-mono text-[11px] text-disabled-content">
          {formatRelative(note.updatedAt)}
        </time>
      </div>
      <div className="mt-3 flex items-start justify-between gap-5">
        <div className="min-w-0">
          <h2 className="truncate text-xl font-medium tracking-[-0.025em]">{note.title}</h2>
          <p className="mt-2 text-sm text-muted-content">
            Revision {note.currentRevision}
            {note.archivedAt === null ? "" : " · Archived"}
            {note.deletedAt === null ? "" : " · Recently deleted"}
          </p>
        </div>
        <ArrowRightIcon
          size={18}
          className="mt-1 shrink-0 text-disabled-content transition-transform group-hover:translate-x-1 group-hover:text-action"
          aria-hidden="true"
        />
      </div>
    </Link>
  );
}

function noteKey(note: NoteSummary): string {
  return note.id;
}

export function NoteLibrary({
  emptyBody = "Write the first line. You can decide where it belongs later.",
  emptyTitle = "Nothing here yet.",
  query = "/api/v1/notes?limit=50"
}: Readonly<{ emptyBody?: string; emptyTitle?: string; query?: string }>) {
  const resource = usePagedResource<NoteSummary>(query, noteKey);

  if (resource.loading && resource.data === null) return <ResourceSkeleton />;
  if (resource.error !== null && resource.data === null) {
    return (
      <ResourceError
        message={resource.error}
        offline={resource.offline}
        retry={() => void resource.refresh()}
      />
    );
  }
  if (resource.data === null || resource.data.items.length === 0) {
    return (
      <EmptyState
        title={emptyTitle}
        body={emptyBody}
        action={
          <Link href="/app" className="button-primary">
            Capture something <ArrowRightIcon size={17} weight="bold" aria-hidden="true" />
          </Link>
        }
      />
    );
  }

  return (
    <div>
      {resource.offline ? (
        <p className="offline-strip" role="status">
          Offline · showing the last loaded library
        </p>
      ) : null}
      <div className="border-t border-outline">
        {resource.data.items.map((note) => (
          <NoteRow key={note.id} note={note} />
        ))}
      </div>
      {resource.data.pageInfo.hasMore ? (
        <div className="pagination-row">
          <button
            type="button"
            className="button-secondary"
            disabled={resource.loadingMore}
            onClick={() => void resource.loadMore()}
          >
            {resource.loadingMore ? "Loading…" : "Load more notes"}
          </button>
        </div>
      ) : null}
      <p className="min-h-6 py-2 text-xs text-critical" role="alert">
        {resource.pageError}
      </p>
    </div>
  );
}
