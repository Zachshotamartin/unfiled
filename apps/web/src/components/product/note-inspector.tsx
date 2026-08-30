"use client";

import {
  ArchiveTrayIcon,
  ArrowCounterClockwiseIcon,
  EyeIcon,
  LinkSimpleIcon,
  PlusIcon,
  TagIcon,
  TrashIcon,
  XIcon
} from "@phosphor-icons/react";
import type {
  EntityId,
  MutationResult,
  NoteDto,
  NoteSummary,
  NoteRevisionDto,
  Space,
  Tag
} from "@unfiled/contracts";
import { type SyntheticEvent, useState } from "react";

import { browserApi, isStaleRevision, productErrorMessage } from "@/lib/product/browser-api";
import { announceProductChange, createIdempotencyKey } from "@/lib/product/client";
import type { NoteLinkRecord } from "@/lib/product/types";
import { useLiveResource } from "@/lib/product/use-live-resource";
import { usePagedResource } from "@/lib/product/use-paged-resource";

import { MarkdownPreview } from "./markdown-preview";

type InspectorProps = Readonly<{
  note: NoteDto;
  onConflict: (message: string) => void;
  onMutation: (result: MutationResult, message: string) => void;
}>;

function entityKey(entity: Readonly<{ id: string }>): string {
  return entity.id;
}

function revisionSource(source: NoteRevisionDto["source"]): string {
  switch (source) {
    case "interactive":
      return "Checklist edit";
    case "organization":
      return "Organization";
    case "import":
      return "Import";
    case "undo":
      return "Undo";
    case "manual":
      return "Manual save";
  }
}

export function NoteInspector({ note, onConflict, onMutation }: InspectorProps) {
  const spaces = usePagedResource<Space>("/api/v1/spaces?limit=100", entityKey);
  const tags = usePagedResource<Tag>("/api/v1/tags?limit=100", entityKey);
  const links = useLiveResource<{ items: readonly NoteLinkRecord[] }>(
    `/api/v1/notes/${note.id}/links`
  );
  const revisions = usePagedResource<NoteRevisionDto>(
    `/api/v1/notes/${note.id}/revisions?limit=30`,
    entityKey
  );
  const notes = usePagedResource<NoteSummary>("/api/v1/notes?limit=100", entityKey);
  const [tagName, setTagName] = useState("");
  const [linkTarget, setLinkTarget] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<NoteRevisionDto | null>(null);

  async function mutate(label: string, action: () => Promise<MutationResult>): Promise<void> {
    setPending(label);
    setError(null);
    try {
      const result = await action();
      onMutation(result, label);
      announceProductChange(`note:${note.id}`);
    } catch (reason) {
      if (isStaleRevision(reason))
        onConflict(productErrorMessage(reason, "This note changed elsewhere."));
      else setError(productErrorMessage(reason, `${label} could not be completed.`));
    } finally {
      setPending(null);
    }
  }

  function write() {
    return { expectedRevision: note.currentRevision, idempotencyKey: createIdempotencyKey() };
  }

  async function move(spaceId: string): Promise<void> {
    await mutate("Moved", () =>
      browserApi.moveNote(note.id, {
        ...write(),
        spaceId: spaceId.length === 0 ? null : (spaceId as EntityId<"spc">)
      })
    );
  }

  async function setTag(tagId: EntityId<"tag">, linked: boolean): Promise<void> {
    await mutate(linked ? "Tag added" : "Tag removed", () =>
      linked
        ? browserApi.linkNoteTag(note.id, { ...write(), tagId })
        : browserApi.unlinkNoteTag(note.id, tagId, write())
    );
  }

  async function createAndLinkTag(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (tagName.trim().length === 0) return;
    setPending("Creating tag");
    setError(null);
    try {
      const created = await browserApi.createTag({
        idempotencyKey: createIdempotencyKey(),
        name: tagName
      });
      setTagName("");
      await tags.refresh();
      await setTag(created.tag.id, true);
    } catch (reason) {
      setError(productErrorMessage(reason, "The tag could not be created."));
      setPending(null);
    }
  }

  async function addLink(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (linkTarget.length === 0) return;
    const input = {
      ...write(),
      linkType: "related" as const,
      toNoteId: linkTarget as EntityId<"note">
    };
    await mutate("Link added", () => browserApi.createNoteLink(note.id, input));
    setLinkTarget("");
    await links.refresh();
  }

  async function removeLink(link: NoteLinkRecord): Promise<void> {
    const input = {
      ...write(),
      linkType: link.linkType,
      toNoteId: link.toNoteId
    };
    await mutate("Link removed", () => browserApi.deleteNoteLink(note.id, link.id, input));
    await links.refresh();
  }

  return (
    <aside className="note-inspector" aria-label="Note details and history">
      <section className="inspector-section">
        <label htmlFor="note-space" className="field-label">
          Space
        </label>
        <select
          id="note-space"
          className="editor-select mt-2"
          value={note.spaceId ?? ""}
          disabled={pending !== null || spaces.loading}
          onChange={(event) => void move(event.target.value)}
        >
          <option value="">No space</option>
          {spaces.data?.items.map((space) => (
            <option key={space.id} value={space.id}>
              {space.name}
            </option>
          ))}
        </select>
        {spaces.data?.pageInfo.hasMore ? (
          <button
            type="button"
            className="quiet-button mt-1"
            disabled={spaces.loadingMore}
            onClick={() => void spaces.loadMore()}
          >
            Load more spaces
          </button>
        ) : null}
      </section>

      <details open className="inspector-section">
        <summary className="inspector-summary">
          <TagIcon size={16} aria-hidden="true" /> Tags <span>{note.tagIds.length}</span>
        </summary>
        <div className="mt-4 grid gap-1">
          {tags.data?.items.map((tag) => {
            const linked = note.tagIds.includes(tag.id);
            return (
              <label key={tag.id} className="tag-option">
                <input
                  type="checkbox"
                  checked={linked}
                  disabled={pending !== null}
                  onChange={(event) => void setTag(tag.id, event.target.checked)}
                />{" "}
                <span>#{tag.name}</span>
              </label>
            );
          })}
          {tags.data?.items.length === 0 ? (
            <p className="text-sm text-muted-content">No tags yet.</p>
          ) : null}
          {tags.data?.pageInfo.hasMore ? (
            <button
              type="button"
              className="quiet-button"
              disabled={tags.loadingMore}
              onClick={() => void tags.loadMore()}
            >
              Load more tags
            </button>
          ) : null}
        </div>
        <form onSubmit={(event) => void createAndLinkTag(event)} className="mt-4 flex gap-2">
          <label htmlFor="new-tag" className="sr-only">
            New tag
          </label>
          <input
            id="new-tag"
            className="editor-control min-w-0"
            value={tagName}
            onChange={(event) => setTagName(event.target.value)}
            placeholder="new tag"
            maxLength={40}
          />
          <button
            type="submit"
            className="icon-button"
            aria-label="Create and add tag"
            disabled={pending !== null}
          >
            <PlusIcon size={17} />
          </button>
        </form>
      </details>

      <details className="inspector-section">
        <summary className="inspector-summary">
          <LinkSimpleIcon size={16} aria-hidden="true" /> Links{" "}
          <span>{links.data?.items.length ?? note.links.length}</span>
        </summary>
        <div className="mt-4 border-t border-outline">
          {links.data?.items.map((link) => (
            <div key={link.id} className="mini-row">
              <span className="truncate">{link.targetTitle}</span>
              <button type="button" className="quiet-button" onClick={() => void removeLink(link)}>
                Remove
              </button>
            </div>
          ))}
          {links.data?.items.length === 0 ? (
            <p className="py-4 text-sm text-muted-content">No linked notes.</p>
          ) : null}
        </div>
        <form onSubmit={(event) => void addLink(event)} className="mt-4 flex gap-2">
          <label htmlFor="link-target" className="sr-only">
            Note to link
          </label>
          <select
            id="link-target"
            className="editor-select min-w-0"
            value={linkTarget}
            onChange={(event) => setLinkTarget(event.target.value)}
          >
            <option value="">Choose a note…</option>
            {notes.data?.items
              .filter((candidate) => candidate.id !== note.id)
              .map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.title}
                </option>
              ))}
          </select>
          <button
            type="submit"
            className="icon-button"
            aria-label="Link note"
            disabled={pending !== null || linkTarget.length === 0}
          >
            <PlusIcon size={17} />
          </button>
        </form>
        {notes.data?.pageInfo.hasMore ? (
          <button
            type="button"
            className="quiet-button mt-2"
            disabled={notes.loadingMore}
            onClick={() => void notes.loadMore()}
          >
            Load more notes
          </button>
        ) : null}
      </details>

      <details open className="inspector-section">
        <summary className="inspector-summary">
          <ArrowCounterClockwiseIcon size={16} aria-hidden="true" /> Revisions{" "}
          <span>{revisions.data?.items.length ?? "–"}</span>
        </summary>
        <div className="mt-4 border-t border-outline">
          {revisions.data?.items.map((revision) => (
            <div key={revision.id} className="revision-row">
              <div>
                <span>
                  v{revision.revision} · {revisionSource(revision.source)}
                </span>
                <time dateTime={revision.createdAt}>
                  {new Date(revision.createdAt).toLocaleDateString()}
                </time>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="quiet-button"
                  onClick={() => setSnapshot(revision)}
                >
                  <EyeIcon size={14} /> View
                </button>
                {revision.revision === note.currentRevision ? (
                  <span className="eyebrow">Current</span>
                ) : (
                  <button
                    type="button"
                    className="quiet-button"
                    disabled={pending !== null}
                    onClick={() =>
                      void mutate("Revision restored", () =>
                        browserApi.restoreNoteRevision(note.id, {
                          ...write(),
                          revisionId: revision.id
                        })
                      )
                    }
                  >
                    Restore
                  </button>
                )}
              </div>
            </div>
          ))}
          {revisions.data?.pageInfo.hasMore ? (
            <button
              type="button"
              className="quiet-button"
              disabled={revisions.loadingMore}
              onClick={() => void revisions.loadMore()}
            >
              Load older revisions
            </button>
          ) : null}
        </div>
        {snapshot === null ? null : (
          <section className="revision-snapshot" aria-labelledby="revision-snapshot-title">
            <header>
              <div>
                <span className="eyebrow">Historical snapshot · v{snapshot.revision}</span>
                <h3 id="revision-snapshot-title">{snapshot.title}</h3>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close revision snapshot"
                onClick={() => setSnapshot(null)}
              >
                <XIcon size={16} />
              </button>
            </header>
            <dl>
              <div>
                <dt>Kind</dt>
                <dd>{snapshot.type}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>{revisionSource(snapshot.source)}</dd>
              </div>
              <div>
                <dt>Privacy</dt>
                <dd>{snapshot.privacy === "private_manual" ? "Private manual" : "AI allowed"}</dd>
              </div>
              <div>
                <dt>Relations</dt>
                <dd>
                  {snapshot.tagIds.length} tags · {snapshot.links.length} links
                </dd>
              </div>
            </dl>
            <div className="revision-snapshot-body">
              <MarkdownPreview markdown={snapshot.bodyMarkdown} />
            </div>
          </section>
        )}
      </details>

      <section className="inspector-section">
        <h2 className="field-label">State</h2>
        <div className="mt-3 grid gap-2">
          <button
            type="button"
            className="destructive-row"
            disabled={pending !== null}
            onClick={() =>
              void mutate(note.archivedAt === null ? "Archived" : "Restored", () =>
                browserApi.archiveNote(note.id, { ...write(), archived: note.archivedAt === null })
              )
            }
          >
            <ArchiveTrayIcon size={17} aria-hidden="true" />{" "}
            {note.archivedAt === null ? "Archive note" : "Return to notes"}
          </button>
          {note.deletedAt === null ? (
            <button
              type="button"
              className="destructive-row"
              disabled={pending !== null}
              onClick={() =>
                void mutate("Moved to recently deleted", () =>
                  browserApi.softDeleteNote(note.id, write())
                )
              }
            >
              <TrashIcon size={17} aria-hidden="true" /> Move to recently deleted
            </button>
          ) : (
            <button
              type="button"
              className="destructive-row"
              disabled={pending !== null}
              onClick={() =>
                void mutate("Note restored", () => browserApi.restoreDeletedNote(note.id, write()))
              }
            >
              <ArrowCounterClockwiseIcon size={17} aria-hidden="true" /> Restore deleted note
            </button>
          )}
        </div>
      </section>

      <p className="min-h-7 px-5 py-3 text-xs text-critical" aria-live="polite">
        {error ?? (pending === null ? "" : `${pending}…`)}
      </p>
    </aside>
  );
}
