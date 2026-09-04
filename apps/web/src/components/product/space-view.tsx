"use client";

import type { EntityId, Space } from "@unfiled/contracts";
import Link from "next/link";
import { type SyntheticEvent, useMemo, useState } from "react";

import { browserApi, productErrorMessage } from "@/lib/product/browser-api";
import { announceProductChange, createIdempotencyKey } from "@/lib/product/client";
import { usePagedResource } from "@/lib/product/use-paged-resource";

import { NoteLibrary } from "./note-library";
import { PageHeading } from "./page-heading";
import { SPACES_QUERY, isArchivedSpace, orderSpaces } from "./spaces-view";
import { ResourceError, ResourceSkeleton } from "./resource-states";
import { UnfiledGlyph } from "./unfiled-glyph";

function spaceKey(space: Space): string {
  return space.id;
}

/** Siblings share a parent; reordering only ever moves a space among them. */
export function siblingsOf(spaces: readonly Space[], space: Space): readonly Space[] {
  return orderSpaces(spaces.filter((candidate) => !isArchivedSpace(candidate))).filter(
    (candidate) => candidate.parentId === space.parentId
  );
}

/**
 * A space's own page (ADR-0019, decision 6): the notes filed there, and the controls that used
 * to crowd the Spaces list — rename, order among siblings, archive, and the restore that makes
 * archiving reversible.
 */
export function SpaceView({ spaceId }: Readonly<{ spaceId: EntityId<"spc"> }>) {
  const resource = usePagedResource<Space>(SPACES_QUERY, spaceKey);
  const [draftName, setDraftName] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const spaces = useMemo(() => resource.data?.items ?? [], [resource.data?.items]);
  const space = spaces.find((candidate) => candidate.id === spaceId) ?? null;

  if (resource.loading && resource.data === null) return <ResourceSkeleton rows={2} />;
  if (resource.error !== null && resource.data === null) {
    return (
      <ResourceError
        message={resource.error}
        offline={resource.offline}
        retry={() => void resource.refresh()}
      />
    );
  }
  if (space === null) {
    return (
      <section className="empty-state" role="alert">
        <h2>This space is not in your library.</h2>
        <p className="mt-3 max-w-md leading-7 text-muted-content">
          It may have been removed on another device.
        </p>
        <Link href="/app/library" className="button-secondary mt-6">
          Back to Library
        </Link>
      </section>
    );
  }

  const siblings = siblingsOf(spaces, space);
  const parentName =
    space.parentId === null
      ? null
      : (spaces.find((candidate) => candidate.id === space.parentId)?.name ?? null);
  const index = siblings.findIndex((candidate) => candidate.id === space.id);
  const archived = isArchivedSpace(space);

  async function rename(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (space === null || draftName === null || draftName.trim() === space.name) {
      setDraftName(null);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await browserApi.updateSpace(space.id, {
        expectedRevision: space.currentRevision,
        idempotencyKey: createIdempotencyKey(),
        name: draftName
      });
      setDraftName(null);
      announceProductChange(`space:${space.id}`);
      await resource.refresh();
    } catch (reason) {
      setError(productErrorMessage(reason, "The space could not be renamed."));
    } finally {
      setPending(false);
    }
  }

  async function setArchived(next: boolean): Promise<void> {
    if (space === null) return;
    setPending(true);
    setError(null);
    try {
      await browserApi.archiveSpace(space.id, {
        expectedRevision: space.currentRevision,
        idempotencyKey: createIdempotencyKey(),
        archived: next
      });
      announceProductChange(`space:${space.id}`);
      await resource.refresh();
    } catch (reason) {
      setError(
        productErrorMessage(
          reason,
          next ? "The space could not be archived." : "The space could not be restored."
        )
      );
    } finally {
      setPending(false);
    }
  }

  async function reorder(direction: -1 | 1): Promise<void> {
    const destination = index + direction;
    if (index < 0 || destination < 0 || destination >= siblings.length) return;
    const next = [...siblings];
    const moving = next[index];
    const displaced = next[destination];
    if (moving === undefined || displaced === undefined) return;
    next[index] = displaced;
    next[destination] = moving;
    setPending(true);
    setError(null);
    try {
      await Promise.all(
        next.map((candidate, rank) =>
          browserApi.updateSpace(candidate.id, {
            expectedRevision: candidate.currentRevision,
            idempotencyKey: createIdempotencyKey(),
            sortKey: `r${String(rank).padStart(6, "0")}`
          })
        )
      );
      announceProductChange(`space-order:${moving.parentId ?? "root"}`);
      await resource.refresh();
    } catch (reason) {
      setError(productErrorMessage(reason, "The space order could not be saved."));
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      {parentName === null ? (
        <PageHeading title={space.name} />
      ) : (
        <PageHeading title={space.name} eyebrow={parentName} />
      )}
      {archived ? (
        <p className="offline-strip" role="status">
          Archived · this space is hidden from the Library and from destination pickers
        </p>
      ) : null}
      <details className="mt-4">
        <summary className="quiet-button">
          <UnfiledGlyph glyph="sliders" size={15} weight={2} /> Space settings
        </summary>
        <div className="mt-3 grid gap-3">
          <form onSubmit={(event) => void rename(event)} className="flex max-w-md gap-2">
            <label htmlFor="space-name" className="sr-only">
              Space name
            </label>
            <input
              id="space-name"
              className="editor-control"
              value={draftName ?? space.name}
              onChange={(event) => setDraftName(event.target.value)}
              maxLength={60}
            />
            <button className="icon-button" type="submit" aria-label="Save name" disabled={pending}>
              <UnfiledGlyph glyph="check" size={17} weight={2} />
            </button>
          </form>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="icon-button"
              disabled={pending || index <= 0}
              aria-label={`Move ${space.name} up`}
              onClick={() => void reorder(-1)}
            >
              <UnfiledGlyph glyph="up" size={17} weight={2} />
            </button>
            <button
              type="button"
              className="icon-button"
              disabled={pending || index < 0 || index >= siblings.length - 1}
              aria-label={`Move ${space.name} down`}
              onClick={() => void reorder(1)}
            >
              <UnfiledGlyph glyph="down" size={17} weight={2} />
            </button>
            <button
              type="button"
              className="button-secondary"
              disabled={pending}
              onClick={() => void setArchived(!archived)}
            >
              <UnfiledGlyph glyph={archived ? "undo" : "archive"} size={16} weight={2} />
              {archived ? "Restore space" : "Archive space"}
            </button>
          </div>
          <p className="min-h-5 text-sm text-critical" role="alert">
            {error}
          </p>
        </div>
      </details>
      <section aria-label={`Notes in ${space.name}`} className="mt-8">
        <NoteLibrary
          grouped
          query={`/api/v1/notes?spaceId=${space.id}&limit=50`}
          emptyTitle="No notes here yet."
          emptyBody="Captures the organizer files into this space will appear here."
        />
      </section>
    </div>
  );
}
