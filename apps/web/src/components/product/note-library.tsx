"use client";

import type { NoteSummary } from "@unfiled/contracts";
import Link from "next/link";
import { useState } from "react";

import { browserApi, productErrorMessage } from "@/lib/product/browser-api";
import { createIdempotencyKey } from "@/lib/product/client";
import { usePagedResource } from "@/lib/product/use-paged-resource";

import { groupNotesByDay } from "./note-grouping";
import { EmptyState, ResourceError, ResourceSkeleton } from "./resource-states";
import { UnfiledGlyph } from "./unfiled-glyph";

function formatRelative(value: string): string {
  const timestamp = new Date(value);
  const day = timestamp.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const time = timestamp.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day} · ${time}`;
}

/** Where a note can be restored from: the archive, or the recovery window after deletion. */
export type RestorableFrom = "archived" | "deleted";

export function NoteRow({
  note,
  restore
}: Readonly<{
  note: NoteSummary;
  restore?: Readonly<{ pending: boolean; onRestore: () => void }> | undefined;
}>) {
  if (restore !== undefined) {
    return (
      <div className="note-row group">
        <div className="flex items-start justify-between gap-5">
          <Link href={`/app/notes/${note.id}`} className="min-w-0 flex-1">
            <h3 className="note-row-title truncate">{note.title}</h3>
            <p className="mt-2 text-sm text-muted-content">
              <time dateTime={note.updatedAt}>{formatRelative(note.updatedAt)}</time>
              {note.archivedAt === null ? "" : " · Archived"}
              {note.deletedAt === null ? "" : " · Recently deleted"}
            </p>
          </Link>
          <button
            type="button"
            className="button-secondary shrink-0"
            disabled={restore.pending}
            onClick={restore.onRestore}
          >
            <UnfiledGlyph glyph="undo" size={16} weight={2.2} />
            {restore.pending ? "Restoring…" : "Restore"}
          </button>
        </div>
      </div>
    );
  }
  return (
    <Link href={`/app/notes/${note.id}`} className="note-row group">
      {/* A row is for reading: the title and when it changed. The phone shows no type or
          revision label on a note (ADR-0019, decision 6), and neither does a row here. */}
      <div className="flex items-start justify-between gap-5">
        <div className="min-w-0">
          <h3 className="note-row-title truncate">{note.title}</h3>
          <p className="mt-2 text-sm text-muted-content">
            <time dateTime={note.updatedAt}>{formatRelative(note.updatedAt)}</time>
            {note.archivedAt === null ? "" : " · Archived"}
            {note.deletedAt === null ? "" : " · Recently deleted"}
          </p>
        </div>
        <span className="mt-1 shrink-0 text-muted-content transition-transform group-hover:translate-x-1 group-hover:text-action">
          <UnfiledGlyph glyph="arrow" size={18} weight={1.9} />
        </span>
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
  grouped = false,
  query = "/api/v1/notes?limit=50",
  restorableFrom
}: Readonly<{
  emptyBody?: string;
  emptyTitle?: string;
  /** The Library groups by day; the archive and the recovery window read as one flat list. */
  grouped?: boolean;
  query?: string;
  /** When set, every row offers Restore: back to notes from the archive or the recovery window. */
  restorableFrom?: RestorableFrom;
}>) {
  const resource = usePagedResource<NoteSummary>(query, noteKey);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  async function restore(note: NoteSummary): Promise<void> {
    if (restoring !== null || restorableFrom === undefined) return;
    setRestoring(note.id);
    setRestoreError(null);
    try {
      const request = {
        expectedRevision: note.currentRevision,
        idempotencyKey: createIdempotencyKey()
      };
      if (restorableFrom === "archived") {
        await browserApi.archiveNote(note.id, { ...request, archived: false });
      } else {
        await browserApi.restoreDeletedNote(note.id, request);
      }
      await resource.refresh();
    } catch (reason) {
      setRestoreError(productErrorMessage(reason, "The note could not be restored."));
    } finally {
      setRestoring(null);
    }
  }

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
            Write something <UnfiledGlyph glyph="arrow" size={17} weight={2.2} />
          </Link>
        }
      />
    );
  }

  const groups = grouped
    ? groupNotesByDay(resource.data.items)
    : [{ notes: resource.data.items, title: "" }];

  return (
    <div>
      {resource.offline ? (
        <p className="offline-strip" role="status">
          Offline · showing the last loaded library
        </p>
      ) : null}
      {groups.map((group) => (
        <section key={group.title || "all"} aria-label={group.title || undefined}>
          {group.title === "" ? null : (
            <h2 className="section-label mt-8 mb-3.5 first:mt-0">{group.title}</h2>
          )}
          <div className="border-t border-outline">
            {group.notes.map((note) => (
              <NoteRow
                key={note.id}
                note={note}
                restore={
                  restorableFrom === undefined
                    ? undefined
                    : { pending: restoring === note.id, onRestore: () => void restore(note) }
                }
              />
            ))}
          </div>
        </section>
      ))}
      {restoreError === null ? null : (
        <p className="mt-3 text-sm text-critical" role="alert">
          {restoreError}
        </p>
      )}
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
