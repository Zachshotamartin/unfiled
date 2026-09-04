"use client";

import type {
  EntityId,
  MutationResult,
  NoteDetail,
  NoteDetailResponse,
  NoteDto,
  LogFieldValue
} from "@unfiled/contracts";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  browserApi,
  isAmbiguousProductMutationFailure,
  isStaleRevision,
  productErrorMessage,
  retryAmbiguousProductMutation
} from "@/lib/product/browser-api";
import { announceProductChange, createIdempotencyKey } from "@/lib/product/client";
import { draftSaveAttempt, type DraftSaveAttempt } from "@/lib/product/draft-save";
import { useLiveResource } from "@/lib/product/use-live-resource";

import { ChecklistSurface } from "./checklist-surface";
import { GeneratedBlocksSurface } from "./generated-blocks-surface";
import { LogSurface, noteWithUpdatedLogField } from "./log-surface";
import { MarkdownPreview } from "./markdown-preview";
import { NoteInspector } from "./note-inspector";
import { ResourceError, ResourceSkeleton } from "./resource-states";
import { UnfiledGlyph } from "./unfiled-glyph";

type DraftSnapshot = Readonly<{
  body: string;
  title: string;
}>;

function differsFromNote(draft: DraftSnapshot, note: NoteDto | null): boolean {
  return note !== null && (draft.title !== note.title || draft.body !== note.bodyMarkdown);
}

/**
 * What a save sends. The editor no longer carries a key class: ADR-0021 removed the mode from
 * the product, and a note sealed `private_manual` is one only this surface can see and only this
 * surface can undo — it is never indexed and the organizer can never read it as a destination.
 */
export function noteUpdatePayload(
  draft: DraftSnapshot,
  expectedRevision: number,
  idempotencyKey: string
): Readonly<{
  bodyMarkdown: string;
  expectedRevision: number;
  idempotencyKey: string;
  title: string;
}> {
  return {
    bodyMarkdown: draft.body,
    expectedRevision,
    idempotencyKey,
    title: draft.title.trim().length === 0 ? "Untitled note" : draft.title.trim()
  };
}

function replaceItem(note: NoteDetail, itemId: EntityId<"itm">, checked: boolean): NoteDetail {
  const key = note.type === "project" ? "checklistItems" : "items";
  const structured = note.structuredData as Readonly<Record<string, unknown>>;
  const values: readonly unknown[] = Array.isArray(structured[key]) ? structured[key] : [];
  return {
    ...note,
    structuredData: {
      ...structured,
      [key]: values.map((candidate) => {
        if (candidate === null || typeof candidate !== "object") return candidate;
        const item = candidate as Record<string, unknown>;
        return item.id === itemId ? { ...item, checked } : item;
      })
    } as NoteDto["structuredData"]
  };
}

export function NoteEditor({ noteId }: Readonly<{ noteId: EntityId<"note"> }>) {
  const resource = useLiveResource<NoteDetailResponse>(`/api/v1/notes/${noteId}`);
  const note = resource.data?.note ?? null;
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draftRevision, setDraftRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ mutationId: EntityId<"mut">; revision: number } | null>(null);
  const [pastDrafts, setPastDrafts] = useState<readonly DraftSnapshot[]>([]);
  const [futureDrafts, setFutureDrafts] = useState<readonly DraftSnapshot[]>([]);
  const saveAttempt = useRef<DraftSaveAttempt | null>(null);
  const logSaveAttempt = useRef<DraftSaveAttempt | null>(null);

  useEffect(() => {
    if (note === null) return;
    if (draftRevision === 0 || (!dirty && draftRevision !== note.currentRevision)) {
      setTitle(note.title);
      setBody(note.bodyMarkdown);
      setDraftRevision(note.currentRevision);
      setDirty(false);
      setConflict(null);
      setPastDrafts([]);
      setFutureDrafts([]);
      saveAttempt.current = null;
      logSaveAttempt.current = null;
      return;
    }
    if (dirty && draftRevision !== note.currentRevision) {
      if (title === note.title && body === note.bodyMarkdown) {
        setDraftRevision(note.currentRevision);
        setDirty(false);
        setConflict(null);
        setMessage("Saved");
        setPastDrafts([]);
        setFutureDrafts([]);
        saveAttempt.current = null;
      } else {
        setConflict("This note changed in another window or device.");
      }
    }
  }, [body, dirty, draftRevision, note, title]);

  const changed = useMemo(
    () => note !== null && (title !== note.title || body !== note.bodyMarkdown),
    [body, note, title]
  );

  const acceptMutation = useCallback(
    (result: MutationResult, nextMessage: string) => {
      resource.setData({ note: result.note });
      setTitle(result.note.title);
      setBody(result.note.bodyMarkdown);
      setDraftRevision(result.note.currentRevision);
      setDirty(false);
      setConflict(null);
      setMessage(nextMessage);
      setError(null);
      setPastDrafts([]);
      setFutureDrafts([]);
      saveAttempt.current = null;
      logSaveAttempt.current = null;
      setUndo(
        result.undo.eligible
          ? { mutationId: result.mutationId, revision: result.note.currentRevision }
          : null
      );
    },
    [resource]
  );

  const updateDraft = useCallback(
    (next: DraftSnapshot): void => {
      const current = { title, body };
      if (next.title === current.title && next.body === current.body) return;
      setPastDrafts((history) => [...history, current].slice(-100));
      setFutureDrafts([]);
      setTitle(next.title);
      setBody(next.body);
      setDirty(differsFromNote(next, note));
      setMessage(null);
      saveAttempt.current = null;
      logSaveAttempt.current = null;
    },
    [body, note, title]
  );

  const undoDraft = useCallback((): void => {
    const previous = pastDrafts.at(-1);
    if (previous === undefined || pending) return;
    const current = { title, body };
    setPastDrafts((history) => history.slice(0, -1));
    setFutureDrafts((history) => [...history, current].slice(-100));
    setTitle(previous.title);
    setBody(previous.body);
    setDirty(differsFromNote(previous, note));
    setMessage("Draft edit undone");
    saveAttempt.current = null;
    logSaveAttempt.current = null;
  }, [body, note, pastDrafts, pending, title]);

  const redoDraft = useCallback((): void => {
    const next = futureDrafts.at(-1);
    if (next === undefined || pending) return;
    const current = { title, body };
    setFutureDrafts((history) => history.slice(0, -1));
    setPastDrafts((history) => [...history, current].slice(-100));
    setTitle(next.title);
    setBody(next.body);
    setDirty(differsFromNote(next, note));
    setMessage("Draft edit redone");
    saveAttempt.current = null;
  }, [body, futureDrafts, note, pending, title]);

  const save = useCallback(async (): Promise<void> => {
    if (note === null || !changed || pending || conflict !== null) return;
    setPending(true);
    setError(null);
    setMessage(null);
    const fingerprint = JSON.stringify({ body, draftRevision, title: title.trim() });
    const attempt = draftSaveAttempt(saveAttempt.current, fingerprint, createIdempotencyKey);
    saveAttempt.current = attempt;
    try {
      const result = await browserApi.updateNote(
        note.id,
        noteUpdatePayload({ body, title }, draftRevision, attempt.idempotencyKey)
      );
      acceptMutation(result, "Saved");
      announceProductChange(`note:${note.id}`);
    } catch (reason) {
      if (isStaleRevision(reason))
        setConflict(productErrorMessage(reason, "This note changed elsewhere."));
      else setError(productErrorMessage(reason, "This note could not be saved."));
    } finally {
      setPending(false);
    }
  }, [acceptMutation, body, changed, conflict, draftRevision, note, pending, title]);

  useEffect(() => {
    const keyboardSave = (event: KeyboardEvent): void => {
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      } else if (command && event.key.toLowerCase() === "z" && event.shiftKey) {
        event.preventDefault();
        redoDraft();
      } else if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undoDraft();
      } else if (event.ctrlKey && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redoDraft();
      }
    };
    window.addEventListener("keydown", keyboardSave);
    return () => window.removeEventListener("keydown", keyboardSave);
  }, [redoDraft, save, undoDraft]);

  async function toggleItem(itemId: EntityId<"itm">, checked: boolean): Promise<void> {
    if (note === null || pending) return;
    const before = note;
    resource.setData({ note: replaceItem(note, itemId, checked) });
    setPending(true);
    setError(null);
    try {
      const result = await browserApi.applyNoteOperations(note.id, {
        expectedRevision: note.currentRevision,
        idempotencyKey: createIdempotencyKey(),
        operations: [{ type: "toggle_item_checked", itemId, checked }]
      });
      acceptMutation(result, checked ? "Item completed" : "Item reopened");
      announceProductChange(`note:${note.id}`);
    } catch (reason) {
      resource.setData({ note: before });
      await resource.refresh();
      if (isStaleRevision(reason))
        setConflict(productErrorMessage(reason, "This note changed elsewhere."));
      else setError(productErrorMessage(reason, "The checklist change did not save."));
    } finally {
      setPending(false);
    }
  }

  async function updateLogField(
    entryId: EntityId<"ent">,
    fieldKey: string,
    value: LogFieldValue
  ): Promise<void> {
    if (note === null || pending || dirty || conflict !== null) return;
    const before = note;
    const optimistic = noteWithUpdatedLogField(note, { entryId, fieldKey, value });
    const fingerprint = JSON.stringify({
      entryId,
      expectedRevision: note.currentRevision,
      fieldKey,
      noteId: note.id,
      value
    });
    const attempt = draftSaveAttempt(logSaveAttempt.current, fingerprint, createIdempotencyKey);
    logSaveAttempt.current = attempt;
    const request = {
      expectedRevision: note.currentRevision,
      idempotencyKey: attempt.idempotencyKey,
      operations: [{ type: "update_log_field" as const, entryId, fieldPath: [fieldKey], value }]
    };
    resource.setData({ note: optimistic });
    setPending(true);
    setError(null);
    try {
      // A response can disappear after the server commits. Replay the exact
      // request once so the durable idempotency receipt decides the outcome.
      const result = await retryAmbiguousProductMutation(() =>
        browserApi.applyNoteOperations(note.id, request)
      );
      acceptMutation(result, `${fieldKey} updated`);
      logSaveAttempt.current = null;
      announceProductChange(`note:${note.id}`);
    } catch (reason) {
      if (!isAmbiguousProductMutationFailure(reason)) logSaveAttempt.current = null;
      resource.setData({ note: before });
      await resource.refresh();
      if (isStaleRevision(reason))
        setConflict(productErrorMessage(reason, "This log changed elsewhere."));
      else
        setError(
          productErrorMessage(
            reason,
            isAmbiguousProductMutationFailure(reason)
              ? "The result could not be confirmed. Retry to check the same change safely."
              : "The log field change did not save."
          )
        );
    } finally {
      setPending(false);
    }
  }

  async function undoLast(): Promise<void> {
    if (undo === null || pending) return;
    setPending(true);
    try {
      const result = await browserApi.undoMutation(undo.mutationId, {
        expectedRevision: undo.revision,
        idempotencyKey: createIdempotencyKey()
      });
      acceptMutation(result, "Change undone");
      setUndo(null);
      announceProductChange(`note:${noteId}`);
    } catch (reason) {
      if (isStaleRevision(reason))
        setConflict(productErrorMessage(reason, "Undo is no longer safe."));
      else setError(productErrorMessage(reason, "That change can no longer be undone."));
    } finally {
      setPending(false);
    }
  }

  async function loadLatest(): Promise<void> {
    setDirty(false);
    setDraftRevision(0);
    setConflict(null);
    await resource.refresh();
  }

  if (resource.loading && resource.data === null)
    return (
      <main id="main-content" className="product-page">
        <ResourceSkeleton rows={5} />
      </main>
    );
  if (resource.error !== null && resource.data === null)
    return (
      <main id="main-content" className="product-page">
        <ResourceError
          message={resource.error}
          offline={resource.offline}
          retry={() => void resource.refresh()}
        />
      </main>
    );
  if (note === null) return null;

  return (
    <main id="main-content" className="note-editor-page">
      <div className="note-editor-main">
        <div className="editor-toolbar sticky top-0 z-10 bg-page/95 backdrop-blur-sm">
          <Link
            href={note.deletedAt === null ? "/app/library" : "/app/archive"}
            className="toolbar-button"
          >
            <UnfiledGlyph glyph="back" size={17} weight={1.9} /> Library
          </Link>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              className="icon-button"
              disabled={pastDrafts.length === 0 || pending}
              aria-label="Undo draft edit"
              title="Undo (⌘Z)"
              onClick={undoDraft}
            >
              <UnfiledGlyph glyph="undo" size={17} weight={1.9} />
            </button>
            <button
              type="button"
              className="icon-button"
              disabled={futureDrafts.length === 0 || pending}
              aria-label="Redo draft edit"
              title="Redo (⇧⌘Z)"
              onClick={redoDraft}
            >
              <UnfiledGlyph glyph="undo" size={17} weight={1.9} />
            </button>
            <button
              type="button"
              className="toolbar-button"
              aria-pressed={preview}
              onClick={() => setPreview((value) => !value)}
            >
              {preview ? "Write" : "Preview"}
            </button>
            <button
              type="button"
              className="button-primary"
              disabled={!changed || pending || conflict !== null || note.deletedAt !== null}
              onClick={() => void save()}
            >
              <UnfiledGlyph glyph="check" size={17} weight={2.2} /> {pending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>

        {resource.offline ? (
          <p className="offline-strip" role="status">
            Offline · edits stay on this screen until you reconnect
          </p>
        ) : null}
        {conflict === null ? null : (
          <section className="conflict-banner" role="alert" aria-labelledby="conflict-title">
            <UnfiledGlyph glyph="warning" size={22} weight={1.9} />
            <div className="min-w-0 flex-1">
              <h2 id="conflict-title" className="font-semibold">
                Review before replacing anything
              </h2>
              <p className="mt-1 text-sm text-muted-content">
                {conflict} Copy your draft or load the latest saved version.
              </p>
            </div>
            <button
              type="button"
              className="quiet-button"
              onClick={() => void navigator.clipboard.writeText(`${title}\n\n${body}`)}
            >
              <UnfiledGlyph glyph="library" size={15} weight={1.9} /> Copy draft
            </button>
            <button type="button" className="button-secondary" onClick={() => void loadLatest()}>
              Load latest
            </button>
          </section>
        )}

        <div className="editor-document">
          <div className="mb-8 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-outline pb-4">
            <span className="eyebrow">{note.type}</span>
            <span className="text-[11px] text-muted-content">revision {note.currentRevision}</span>
          </div>
          {preview ? (
            <section aria-label="Markdown preview" className="editor-preview">
              <MarkdownPreview markdown={body} />
            </section>
          ) : (
            <>
              <label htmlFor="note-title" className="sr-only">
                Note title
              </label>
              <input
                id="note-title"
                className="editor-title"
                value={title}
                maxLength={200}
                onChange={(event) => updateDraft({ title: event.target.value, body })}
              />
              {note.type === "log" ? (
                <p className="log-editor-guidance">
                  Edit this note’s structured values below. Each saved field creates a revision you
                  can undo.
                </p>
              ) : (
                <>
                  <label htmlFor="note-body" className="sr-only">
                    Note body in Markdown
                  </label>
                  <textarea
                    id="note-body"
                    className="editor-body"
                    value={body}
                    maxLength={200_000}
                    onChange={(event) => updateDraft({ title, body: event.target.value })}
                  />
                </>
              )}
            </>
          )}
        </div>

        <ChecklistSurface
          note={note}
          disabled={pending || conflict !== null}
          onToggle={(itemId, checked) => void toggleItem(itemId, checked)}
        />

        <LogSurface
          note={note}
          disabled={pending || dirty || conflict !== null || resource.offline}
          onUpdate={({ entryId, fieldKey, value }) => void updateLogField(entryId, fieldKey, value)}
        />

        <GeneratedBlocksSurface noteId={note.id} />

        <div className="editor-status" aria-live="polite">
          <span className={error === null ? "text-muted-content" : "text-critical"}>
            {error ?? (changed ? "Unsaved changes · ⌘S to save" : (message ?? "Up to date"))}
          </span>
          {undo === null ? null : (
            <button
              type="button"
              onClick={() => void undoLast()}
              className="ml-auto inline-flex min-h-10 items-center gap-2 text-sm text-content"
            >
              <UnfiledGlyph glyph="close" size={14} weight={1.9} /> Undo last change
            </button>
          )}
          {message === null || error !== null ? null : (
            <UnfiledGlyph glyph="checkCircle" size={16} weight={1.9} className="text-action" />
          )}
        </div>
      </div>
      <NoteInspector note={note} onConflict={setConflict} onMutation={acceptMutation} />
    </main>
  );
}
