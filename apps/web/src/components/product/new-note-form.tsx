"use client";

import { ArrowLeftIcon, FloppyDiskIcon } from "@phosphor-icons/react";
import type { EntityId, NoteSummary, NoteType, PrivacyMode, Space, Tag } from "@unfiled/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type SyntheticEvent, useMemo, useState } from "react";

import { browserApi, productErrorMessage } from "@/lib/product/browser-api";
import { announceProductChange, createIdempotencyKey } from "@/lib/product/client";
import { usePagedResource } from "@/lib/product/use-paged-resource";

import { MarkdownPreview } from "./markdown-preview";

function fallbackTitle(title: string, body: string): string {
  if (title.trim().length > 0) return title.trim();
  const firstLine = body
    .split("\n")
    .find((line) => line.trim().length > 0)
    ?.trim();
  return firstLine?.slice(0, 80) ?? "Untitled note";
}

function entityKey(entity: Readonly<{ id: string }>): string {
  return entity.id;
}

export function NewNoteForm() {
  const router = useRouter();
  const spaces = usePagedResource<Space>("/api/v1/spaces?limit=100", entityKey);
  const tags = usePagedResource<Tag>("/api/v1/tags?limit=100", entityKey);
  const notes = usePagedResource<NoteSummary>("/api/v1/notes?limit=100", entityKey);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [type, setType] = useState<NoteType>("generic");
  const [privacy, setPrivacy] = useState<PrivacyMode>("ai_assisted");
  const [spaceId, setSpaceId] = useState("");
  const [tagIds, setTagIds] = useState<readonly EntityId<"tag">[]>([]);
  const [linkedNoteIds, setLinkedNoteIds] = useState<readonly EntityId<"note">[]>([]);
  const [preview, setPreview] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useMemo(createIdempotencyKey, []);

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await browserApi.createNote({
        idempotencyKey,
        title: fallbackTitle(title, body),
        type,
        privacy,
        bodyMarkdown: body,
        tagIds: [...tagIds],
        links: linkedNoteIds.map((toNoteId) => ({ toNoteId, linkType: "related" })),
        ...(spaceId.length === 0 ? {} : { spaceId: spaceId })
      });
      announceProductChange("note-created");
      router.replace(`/app/notes/${result.note.id}`);
    } catch (reason) {
      setError(productErrorMessage(reason, "The note could not be created."));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="editor-sheet">
      <div className="editor-toolbar">
        <Link href="/app/notes" className="toolbar-button">
          <ArrowLeftIcon size={17} aria-hidden="true" /> Notes
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className="toolbar-button"
            aria-pressed={preview}
            onClick={() => setPreview((value) => !value)}
          >
            {preview ? "Write" : "Preview"}
          </button>
          <button type="submit" className="button-primary" disabled={pending}>
            <FloppyDiskIcon size={17} weight="bold" aria-hidden="true" />{" "}
            {pending ? "Creating…" : "Create note"}
          </button>
        </div>
      </div>

      <div className="editor-meta-grid">
        <div>
          <label htmlFor="new-note-type" className="field-label">
            Kind
          </label>
          <select
            id="new-note-type"
            className="editor-select mt-2"
            value={type}
            onChange={(event) => setType(event.target.value as NoteType)}
          >
            <option value="generic">Note</option>
            <option value="list">List</option>
            <option value="log">Log</option>
            <option value="principle">Principle</option>
            <option value="project">Project</option>
          </select>
        </div>
        <div>
          <label htmlFor="new-note-space" className="field-label">
            Space
          </label>
          <select
            id="new-note-space"
            className="editor-select mt-2"
            value={spaceId}
            onChange={(event) => setSpaceId(event.target.value)}
            disabled={spaces.loading}
          >
            <option value="">No space yet</option>
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
        </div>
        <div>
          <label htmlFor="new-note-privacy" className="field-label">
            AI access
          </label>
          <select
            id="new-note-privacy"
            className="editor-select mt-2"
            value={privacy}
            onChange={(event) => setPrivacy(event.target.value as PrivacyMode)}
          >
            <option value="ai_assisted">Allowed</option>
            <option value="private_manual">Private manual</option>
          </select>
        </div>
      </div>

      <details className="create-relations">
        <summary>
          Tags and links
          <span>{tagIds.length + linkedNoteIds.length} selected</span>
        </summary>
        <div className="create-relations-grid">
          <fieldset>
            <legend className="field-label">Tags</legend>
            <div className="relation-picker mt-3">
              {tags.data?.items.map((tag) => {
                const selected = tagIds.includes(tag.id);
                return (
                  <label key={tag.id}>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={(event) =>
                        setTagIds((current) =>
                          event.target.checked
                            ? [...current, tag.id]
                            : current.filter((id) => id !== tag.id)
                        )
                      }
                    />
                    <span>#{tag.name}</span>
                  </label>
                );
              })}
              {tags.data?.items.length === 0 ? (
                <p>No tags yet. You can create one from a saved note.</p>
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
          </fieldset>
          <fieldset>
            <legend className="field-label">Related notes</legend>
            <div className="relation-picker mt-3">
              {notes.data?.items.map((candidate) => {
                const selected = linkedNoteIds.includes(candidate.id);
                return (
                  <label key={candidate.id}>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={(event) =>
                        setLinkedNoteIds((current) =>
                          event.target.checked
                            ? [...current, candidate.id]
                            : current.filter((id) => id !== candidate.id)
                        )
                      }
                    />
                    <span>{candidate.title}</span>
                  </label>
                );
              })}
              {notes.data?.items.length === 0 ? <p>No other notes to link yet.</p> : null}
              {notes.data?.pageInfo.hasMore ? (
                <button
                  type="button"
                  className="quiet-button"
                  disabled={notes.loadingMore}
                  onClick={() => void notes.loadMore()}
                >
                  Load more notes
                </button>
              ) : null}
            </div>
          </fieldset>
        </div>
      </details>

      <div className="editor-document">
        {preview ? (
          <section aria-label="Markdown preview" className="editor-preview">
            <MarkdownPreview markdown={body} />
          </section>
        ) : (
          <>
            <label htmlFor="new-note-title" className="sr-only">
              Title (optional)
            </label>
            <input
              id="new-note-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Untitled is fine"
              maxLength={200}
              className="editor-title"
            />
            <label htmlFor="new-note-body" className="sr-only">
              Note in Markdown
            </label>
            <textarea
              id="new-note-body"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Start anywhere…"
              maxLength={200_000}
              className="editor-body"
              autoFocus
            />
          </>
        )}
      </div>
      <p className="editor-status" aria-live="polite">
        {error ?? "Markdown supported"}
      </p>
    </form>
  );
}
