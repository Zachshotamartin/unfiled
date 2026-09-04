"use client";

import type {
  CorrectionDestination,
  EntityId,
  NoteSummary,
  NoteType,
  Space
} from "@unfiled/contracts";
import { type SyntheticEvent, useEffect, useState } from "react";

import { browserApi, productErrorMessage } from "@/lib/product/browser-api";
import { createIdempotencyKey } from "@/lib/product/client";

const NOTE_TYPES: readonly NoteType[] = ["generic", "list", "log", "principle", "project"];

export type CorrectionOutcome = Readonly<{ kind: "applied" | "needs_review"; message: string }>;

export function correctionOutcomeMessage(outcome: "applied" | "needs_review"): string {
  return outcome === "applied"
    ? "Moved. The original note kept every revision and the new one holds the content."
    : "Unfiled could not reverse the original filing exactly, so it opened a review in your Inbox.";
}

/**
 * The receipt's "Move" action, wired to `POST /decisions/{id}/correct`. The link this replaced
 * carried the capture and decision ids to a page that read neither, so a filing could not be
 * corrected from the web at all; the endpoint and the api-client method already existed.
 */
export function ReceiptCorrection({
  decisionId,
  onCorrected,
  sourceNoteId
}: Readonly<{
  decisionId: EntityId<"dec">;
  onCorrected: (outcome: CorrectionOutcome) => void;
  sourceNoteId: EntityId<"note">;
}>) {
  const [notes, setNotes] = useState<readonly NoteSummary[]>([]);
  const [spaces, setSpaces] = useState<readonly Space[]>([]);
  const [mode, setMode] = useState<CorrectionDestination["type"]>("existing_note");
  const [destinationNoteId, setDestinationNoteId] = useState("");
  const [title, setTitle] = useState("");
  const [noteType, setNoteType] = useState<NoteType>("generic");
  const [spaceId, setSpaceId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([browserApi.listNotes({ limit: 100 }), browserApi.listSpaces({ limit: 100 })])
      .then(([notePage, spacePage]) => {
        if (cancelled) return;
        setNotes(notePage.items.filter((note) => note.id !== sourceNoteId));
        setSpaces(spacePage.items);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(productErrorMessage(reason, "Your notes could not be loaded."));
      });
    return () => {
      cancelled = true;
    };
  }, [sourceNoteId]);

  async function buildDestination(): Promise<CorrectionDestination> {
    if (mode === "new_note") {
      return {
        type: "new_note",
        title: title.trim(),
        noteType,
        spaceId: spaceId === "" ? null : (spaceId as EntityId<"spc">)
      };
    }
    // An existing destination is written against the revision the owner is looking at, so a
    // concurrent edit refuses the move instead of overwriting it.
    const destination = await browserApi.getNote(destinationNoteId);
    return {
      type: "existing_note",
      noteId: destination.note.id,
      expectedRevision: destination.note.currentRevision
    };
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const source = await browserApi.getNote(sourceNoteId);
      const result = await browserApi.correctDecision(decisionId, {
        idempotencyKey: createIdempotencyKey(),
        source: { noteId: source.note.id, expectedRevision: source.note.currentRevision },
        destination: await buildDestination()
      });
      onCorrected({
        kind: result.outcome,
        message: correctionOutcomeMessage(result.outcome)
      });
    } catch (reason) {
      setError(productErrorMessage(reason, "This filing could not be moved."));
    } finally {
      setPending(false);
    }
  }

  const incomplete =
    mode === "existing_note" ? destinationNoteId.length === 0 : title.trim().length === 0;

  return (
    <form className="correction-form" onSubmit={(event) => void submit(event)}>
      <p>
        Move what this capture added to a different note. The original note keeps its revisions;
        nothing is deleted.
      </p>
      <label className="field-label" htmlFor="correction-mode">
        Destination
      </label>
      <select
        id="correction-mode"
        className="editor-select"
        value={mode}
        onChange={(event) => setMode(event.target.value as CorrectionDestination["type"])}
      >
        <option value="existing_note">An existing note</option>
        <option value="new_note">A new note</option>
      </select>
      {mode === "existing_note" ? (
        <>
          <label className="field-label" htmlFor="correction-note">
            Note
          </label>
          <select
            id="correction-note"
            className="editor-select"
            value={destinationNoteId}
            onChange={(event) => setDestinationNoteId(event.target.value)}
          >
            <option value="">Choose a note</option>
            {notes.map((note) => (
              <option key={note.id} value={note.id}>
                {note.title}
              </option>
            ))}
          </select>
        </>
      ) : (
        <>
          <label className="field-label" htmlFor="correction-title">
            Title
          </label>
          <input
            id="correction-title"
            className="editor-control"
            maxLength={200}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <label className="field-label" htmlFor="correction-type">
            Kind
          </label>
          <select
            id="correction-type"
            className="editor-select"
            value={noteType}
            onChange={(event) => setNoteType(event.target.value as NoteType)}
          >
            {NOTE_TYPES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <label className="field-label" htmlFor="correction-space">
            Space
          </label>
          <select
            id="correction-space"
            className="editor-select"
            value={spaceId}
            onChange={(event) => setSpaceId(event.target.value)}
          >
            <option value="">No space</option>
            {spaces.map((space) => (
              <option key={space.id} value={space.id}>
                {space.name}
              </option>
            ))}
          </select>
        </>
      )}
      <div className="correction-actions">
        <button type="submit" className="button-primary" disabled={pending || incomplete}>
          {pending ? "Moving…" : "Move it"}
        </button>
      </div>
      <p className="min-h-5 text-sm text-critical" role="alert">
        {error}
      </p>
    </form>
  );
}
