"use client";

import type { Space } from "@unfiled/contracts";
import Link from "next/link";
import { type SyntheticEvent, useMemo, useState } from "react";

import { browserApi, productErrorMessage } from "@/lib/product/browser-api";
import { announceProductChange, createIdempotencyKey } from "@/lib/product/client";
import { usePagedResource } from "@/lib/product/use-paged-resource";

import { ResourceError, ResourceSkeleton } from "./resource-states";
import { UnfiledGlyph } from "./unfiled-glyph";

/**
 * Every space the account has, archived ones included. The list is loaded with
 * `includeArchived=true` because archiving is otherwise a one-way door: the archive endpoint
 * accepts `archived: false`, but nothing in the web could reach a space to send it.
 */
export const SPACES_QUERY = "/api/v1/spaces?limit=100&includeArchived=true";

function spaceKey(space: Space): string {
  return space.id;
}

export function isArchivedSpace(space: Space): boolean {
  return space.archivedAt !== null;
}

function byRank(left: Space, right: Space): number {
  return left.sortKey.localeCompare(right.sortKey) || left.name.localeCompare(right.name);
}

/** Roots first, each followed by its children: the one parent, one child hierarchy. */
export function orderSpaces(spaces: readonly Space[]): readonly Space[] {
  const roots = spaces.filter((space) => space.parentId === null).sort(byRank);
  const nestedIds = new Set<string>();
  const ordered = roots.flatMap((root) => {
    const children = spaces.filter((space) => space.parentId === root.id).sort(byRank);
    for (const child of children) nestedIds.add(child.id);
    return [root, ...children];
  });
  return [
    ...ordered,
    ...spaces.filter((space) => space.parentId !== null && !nestedIds.has(space.id))
  ];
}

export function SpaceCard({
  parentName,
  space
}: Readonly<{ parentName: string | null; space: Space }>) {
  return (
    <Link className="space-card" href={`/app/spaces/${space.id}`}>
      <UnfiledGlyph glyph="card" size={20} weight={1.8} />
      <span className="grid gap-1">
        <strong>{space.name}</strong>
        <span>{parentName === null ? `/${space.slug}` : `${parentName} / ${space.name}`}</span>
      </span>
    </Link>
  );
}

function ArchivedSpaceRow({
  refresh,
  space
}: Readonly<{ refresh: () => Promise<void>; space: Space }>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function restore(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await browserApi.archiveSpace(space.id, {
        expectedRevision: space.currentRevision,
        idempotencyKey: createIdempotencyKey(),
        archived: false
      });
      announceProductChange(`space:${space.id}`);
      await refresh();
    } catch (reason) {
      setError(productErrorMessage(reason, "The space could not be restored."));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mini-row">
      <div className="min-w-0">
        <p className="truncate">{space.name}</p>
        <p className="mt-1 min-h-4 text-xs text-critical" aria-live="polite">
          {error}
        </p>
      </div>
      <button
        type="button"
        className="quiet-button"
        disabled={pending}
        onClick={() => void restore()}
      >
        <UnfiledGlyph glyph="undo" size={15} weight={2} /> {pending ? "Restoring…" : "Restore"}
      </button>
    </div>
  );
}

/**
 * The Library's spaces: a grid of cards when any exist, each pushing that space's own page
 * (ADR-0019, decision 6). Notes without a space are simply listed under the grid; nothing is
 * labelled "Unfiled" after the app itself.
 */
export function SpacesView() {
  const resource = usePagedResource<Space>(SPACES_QUERY, spaceKey);
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const spaces = useMemo(() => resource.data?.items ?? [], [resource.data?.items]);
  const active = useMemo(
    () => orderSpaces(spaces.filter((space) => !isArchivedSpace(space))),
    [spaces]
  );
  const archived = useMemo(() => spaces.filter(isArchivedSpace), [spaces]);

  async function create(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await browserApi.createSpace({
        idempotencyKey: createIdempotencyKey(),
        name,
        parentId: parentId.length === 0 ? null : parentId
      });
      setName("");
      setParentId("");
      announceProductChange("space-created");
      await resource.refresh();
    } catch (reason) {
      setError(productErrorMessage(reason, "The space could not be created."));
    } finally {
      setPending(false);
    }
  }

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

  return (
    <div>
      {/* Spaces are a grid of cards when any exist; with none there is nothing to label. */}
      {active.length === 0 ? null : <h2 className="section-label mb-3.5">Spaces</h2>}
      {active.length === 0 ? null : (
        <div className="space-grid">
          {active.map((space) => (
            <SpaceCard
              key={space.id}
              space={space}
              parentName={
                space.parentId === null
                  ? null
                  : (spaces.find((candidate) => candidate.id === space.parentId)?.name ?? null)
              }
            />
          ))}
        </div>
      )}
      <details className="mt-4">
        <summary className="quiet-button">
          <UnfiledGlyph glyph="plus" size={15} weight={2.2} /> New space
        </summary>
        <form onSubmit={(event) => void create(event)} className="space-create-form">
          <div className="min-w-0 flex-1">
            <label htmlFor="space-name" className="field-label">
              Name
            </label>
            <input
              id="space-name"
              className="editor-control mt-2"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Life"
              maxLength={60}
              required
            />
          </div>
          <div className="min-w-0 flex-1">
            <label htmlFor="space-parent" className="field-label">
              Inside (optional)
            </label>
            <select
              id="space-parent"
              className="editor-select mt-2"
              value={parentId}
              onChange={(event) => setParentId(event.target.value)}
            >
              <option value="">Top level</option>
              {active
                .filter((space) => space.parentId === null)
                .map((space) => (
                  <option key={space.id} value={space.id}>
                    {space.name}
                  </option>
                ))}
            </select>
          </div>
          <button
            type="submit"
            className="button-primary self-end"
            disabled={pending || name.trim().length === 0}
          >
            {pending ? "Creating…" : "Create"}
          </button>
        </form>
        <p className="min-h-8 py-1 text-sm text-critical" role="alert">
          {error}
        </p>
      </details>
      {archived.length === 0 ? null : (
        <details className="mt-2">
          <summary className="quiet-button">
            <UnfiledGlyph glyph="archive" size={15} weight={2} /> Archived spaces ({archived.length}
            )
          </summary>
          <div className="mt-2">
            {archived.map((space) => (
              <ArchivedSpaceRow key={space.id} space={space} refresh={resource.refresh} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
