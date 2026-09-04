"use client";

import type { EntityId, MutationResult, NoteDto, NoteRevisionDto, Space } from "@unfiled/contracts";
import { useState } from "react";

import { browserApi, isStaleRevision, productErrorMessage } from "@/lib/product/browser-api";
import { announceProductChange, createIdempotencyKey } from "@/lib/product/client";
import { usePagedResource } from "@/lib/product/use-paged-resource";

import { MarkdownPreview } from "./markdown-preview";
import { UnfiledGlyph } from "./unfiled-glyph";

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
  const revisions = usePagedResource<NoteRevisionDto>(
    `/api/v1/notes/${note.id}/revisions?limit=30`,
    entityKey
  );
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

      <details className="inspector-section">
        <summary className="inspector-summary">
          <UnfiledGlyph glyph="undo" size={16} weight={1.9} /> History{" "}
          <span>{revisions.data?.items.length ?? "…"}</span>
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
                  <UnfiledGlyph glyph="search" size={14} weight={1.9} /> View
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
                <UnfiledGlyph glyph="close" size={16} weight={1.9} />
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
            <UnfiledGlyph glyph="archive" size={17} weight={1.9} />{" "}
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
              <UnfiledGlyph glyph="trash" size={17} weight={1.9} /> Move to recently deleted
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
              <UnfiledGlyph glyph="undo" size={17} weight={1.9} /> Restore deleted note
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
