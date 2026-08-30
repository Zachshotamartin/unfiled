"use client";

import {
  ArchiveTrayIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  PencilSimpleIcon,
  PlusIcon,
  XIcon
} from "@phosphor-icons/react";
import type { Space } from "@unfiled/contracts";
import { type SyntheticEvent, useMemo, useState } from "react";

import { browserApi, productErrorMessage } from "@/lib/product/browser-api";
import { announceProductChange, createIdempotencyKey } from "@/lib/product/client";
import { usePagedResource } from "@/lib/product/use-paged-resource";

import { EmptyState, ResourceError, ResourceSkeleton } from "./resource-states";

function spaceKey(space: Space): string {
  return space.id;
}

function SpaceRow({
  canMoveDown,
  canMoveUp,
  onReorder,
  parentName,
  refresh,
  space
}: Readonly<{
  canMoveDown: boolean;
  canMoveUp: boolean;
  onReorder: (direction: -1 | 1) => Promise<void>;
  parentName: string | null;
  refresh: () => Promise<void>;
  space: Space;
}>) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(space.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rename(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (name.trim() === space.name) {
      setEditing(false);
      return;
    }
    setPending(true);
    try {
      await browserApi.updateSpace(space.id, {
        expectedRevision: space.currentRevision,
        idempotencyKey: createIdempotencyKey(),
        name
      });
      setEditing(false);
      announceProductChange(`space:${space.id}`);
      await refresh();
    } catch (reason) {
      setError(productErrorMessage(reason, "The space could not be renamed."));
    } finally {
      setPending(false);
    }
  }

  async function archive(): Promise<void> {
    setPending(true);
    try {
      await browserApi.archiveSpace(space.id, {
        expectedRevision: space.currentRevision,
        idempotencyKey: createIdempotencyKey(),
        archived: true
      });
      announceProductChange(`space:${space.id}`);
      await refresh();
    } catch (reason) {
      setError(productErrorMessage(reason, "The space could not be archived."));
    } finally {
      setPending(false);
    }
  }

  async function reorder(direction: -1 | 1): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await onReorder(direction);
    } catch (reason) {
      setError(productErrorMessage(reason, "The space order could not be saved."));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={`space-row ${parentName === null ? "" : "space-row-child"}`}>
      <div className="min-w-0 flex-1">
        {editing ? (
          <form onSubmit={(event) => void rename(event)} className="flex max-w-md gap-2">
            <label htmlFor={`space-${space.id}`} className="sr-only">
              Space name
            </label>
            <input
              id={`space-${space.id}`}
              className="editor-control"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={60}
              autoFocus
            />
            <button className="icon-button" type="submit" aria-label="Save name">
              <CheckIcon size={17} />
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="Cancel rename"
              onClick={() => {
                setEditing(false);
                setName(space.name);
              }}
            >
              <XIcon size={17} />
            </button>
          </form>
        ) : (
          <>
            <h2 className="text-lg font-medium">{space.name}</h2>
            <p className="mt-1 font-mono text-[11px] text-disabled-content">
              {parentName === null ? `/${space.slug}` : `${parentName} / ${space.name}`}
            </p>
          </>
        )}
        <p className="mt-2 min-h-5 text-xs text-critical" aria-live="polite">
          {error}
        </p>
      </div>
      {editing ? null : (
        <div className="flex gap-1">
          <button
            type="button"
            className="icon-button"
            disabled={pending || !canMoveUp}
            aria-label={`Move ${space.name} up`}
            onClick={() => void reorder(-1)}
          >
            <ArrowUpIcon size={17} />
          </button>
          <button
            type="button"
            className="icon-button"
            disabled={pending || !canMoveDown}
            aria-label={`Move ${space.name} down`}
            onClick={() => void reorder(1)}
          >
            <ArrowDownIcon size={17} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={`Rename ${space.name}`}
            onClick={() => setEditing(true)}
          >
            <PencilSimpleIcon size={17} />
          </button>
          <button
            type="button"
            className="icon-button"
            disabled={pending}
            aria-label={`Archive ${space.name}`}
            onClick={() => void archive()}
          >
            <ArchiveTrayIcon size={17} />
          </button>
        </div>
      )}
    </div>
  );
}

export function SpacesView() {
  const resource = usePagedResource<Space>("/api/v1/spaces?limit=100", spaceKey);
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const orderedSpaces = useMemo(() => {
    const items = resource.data?.items ?? [];
    const byRank = (left: Space, right: Space) =>
      left.sortKey.localeCompare(right.sortKey) || left.name.localeCompare(right.name);
    const roots = items.filter((space) => space.parentId === null).sort(byRank);
    const nestedIds = new Set<string>();
    const ordered = roots.flatMap((root) => {
      const children = items.filter((space) => space.parentId === root.id).sort(byRank);
      for (const child of children) nestedIds.add(child.id);
      return [root, ...children];
    });
    return [
      ...ordered,
      ...items.filter((space) => space.parentId !== null && !nestedIds.has(space.id))
    ];
  }, [resource.data?.items]);

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

  async function reorder(space: Space, direction: -1 | 1): Promise<void> {
    const siblings = (resource.data?.items ?? [])
      .filter((candidate) => candidate.parentId === space.parentId)
      .sort(
        (left, right) =>
          left.sortKey.localeCompare(right.sortKey) || left.name.localeCompare(right.name)
      );
    const index = siblings.findIndex((candidate) => candidate.id === space.id);
    const destination = index + direction;
    if (index < 0 || destination < 0 || destination >= siblings.length) return;
    const next = [...siblings];
    const moving = next[index];
    const displaced = next[destination];
    if (moving === undefined || displaced === undefined) return;
    next[index] = displaced;
    next[destination] = moving;
    await Promise.all(
      next.map((candidate, rank) =>
        browserApi.updateSpace(candidate.id, {
          expectedRevision: candidate.currentRevision,
          idempotencyKey: createIdempotencyKey(),
          sortKey: `r${String(rank).padStart(6, "0")}`
        })
      )
    );
    announceProductChange(`space-order:${space.parentId ?? "root"}`);
    await resource.refresh();
  }

  return (
    <div>
      <form onSubmit={(event) => void create(event)} className="space-create-form">
        <div className="min-w-0 flex-1">
          <label htmlFor="space-name" className="field-label">
            New space
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
            {resource.data?.items
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
          <PlusIcon size={17} /> {pending ? "Creating…" : "Create"}
        </button>
      </form>
      <p className="min-h-10 py-2 text-sm text-critical" role="alert">
        {error}
      </p>
      {resource.loading && resource.data === null ? (
        <ResourceSkeleton />
      ) : resource.error !== null && resource.data === null ? (
        <ResourceError
          message={resource.error}
          offline={resource.offline}
          retry={() => void resource.refresh()}
        />
      ) : resource.data?.items.length === 0 ? (
        <EmptyState
          title="No spaces yet."
          body="Spaces are optional. Add one when a group of notes starts to feel familiar."
        />
      ) : (
        <div className="border-t border-outline">
          {orderedSpaces.map((space) => {
            const siblings = (resource.data?.items ?? [])
              .filter((candidate) => candidate.parentId === space.parentId)
              .sort(
                (left, right) =>
                  left.sortKey.localeCompare(right.sortKey) || left.name.localeCompare(right.name)
              );
            const index = siblings.findIndex((candidate) => candidate.id === space.id);
            const parent =
              space.parentId === null
                ? null
                : (resource.data?.items.find((candidate) => candidate.id === space.parentId) ??
                  null);
            return (
              <SpaceRow
                key={space.id}
                space={space}
                parentName={parent?.name ?? null}
                canMoveUp={index > 0}
                canMoveDown={index >= 0 && index < siblings.length - 1}
                refresh={resource.refresh}
                onReorder={(direction) => reorder(space, direction)}
              />
            );
          })}
        </div>
      )}
      {resource.data?.pageInfo.hasMore ? (
        <div className="pagination-row">
          <button
            type="button"
            className="button-secondary"
            disabled={resource.loadingMore}
            onClick={() => void resource.loadMore()}
          >
            {resource.loadingMore ? "Loading…" : "Load more spaces"}
          </button>
        </div>
      ) : null}
      <p className="min-h-6 py-2 text-xs text-critical" role="alert">
        {resource.pageError}
      </p>
    </div>
  );
}
