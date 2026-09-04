"use client";

import { MinusIcon, PlusIcon } from "@phosphor-icons/react";
import {
  LogStructuredDataSchema,
  type EntityId,
  type LogEntry,
  type LogFieldValue,
  type NoteDetail,
  type NoteDto
} from "@unfiled/contracts";
import { renderLogMarkdown } from "@unfiled/domain";
import { useEffect, useId, useMemo, useState } from "react";

type LogFieldUpdate = Readonly<{
  entryId: EntityId<"ent">;
  fieldKey: string;
  value: LogFieldValue;
}>;

function orderedEntries(entries: readonly LogEntry[]): LogEntry[] {
  return [...entries].sort(
    (left, right) =>
      left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id)
  );
}

function exerciseIdentity(entry: LogEntry): string | null {
  const exerciseKey = Object.keys(entry.fields).find(
    (key) => key.trim().toLocaleLowerCase("und") === "exercise"
  );
  if (exerciseKey === undefined) return null;
  const value = entry.fields[exerciseKey];
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLocaleLowerCase("und");
  return normalized.length === 0 ? null : normalized;
}

export function priorLogFieldValue(
  entries: readonly LogEntry[],
  entryId: EntityId<"ent">,
  fieldKey: string
): LogFieldValue | undefined {
  const chronological = orderedEntries(entries);
  const targetIndex = chronological.findIndex((entry) => entry.id === entryId);
  if (targetIndex < 0) return undefined;
  const target = chronological[targetIndex];
  if (target === undefined) return undefined;
  const identity = exerciseIdentity(target);
  if (identity === null || fieldKey.trim().toLocaleLowerCase("und") === "exercise") {
    return undefined;
  }
  for (let index = targetIndex - 1; index >= 0; index -= 1) {
    const candidate = chronological[index];
    if (candidate === undefined) continue;
    if (exerciseIdentity(candidate) !== identity || !(fieldKey in candidate.fields)) continue;
    return candidate.fields[fieldKey];
  }
  return undefined;
}

export function noteWithUpdatedLogField(note: NoteDetail, update: LogFieldUpdate): NoteDetail {
  const parsed = LogStructuredDataSchema.parse(note.structuredData);
  const entries = parsed.entries.map((entry) =>
    entry.id === update.entryId
      ? { ...entry, fields: { ...entry.fields, [update.fieldKey]: update.value } }
      : entry
  );
  const structuredData = LogStructuredDataSchema.parse({ schemaVersion: 1, entries });
  return {
    ...note,
    bodyMarkdown: renderLogMarkdown(structuredData),
    structuredData
  };
}

function draftValue(value: LogFieldValue): string {
  return value === null ? "" : String(value);
}

function previousLabel(value: LogFieldValue | undefined): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

function LogFieldEditor({
  disabled,
  entry,
  fieldKey,
  previous,
  value,
  onUpdate
}: Readonly<{
  disabled: boolean;
  entry: LogEntry;
  fieldKey: string;
  previous: LogFieldValue | undefined;
  value: LogFieldValue;
  onUpdate: (update: LogFieldUpdate) => void;
}>) {
  const controlId = useId();
  const [draft, setDraft] = useState(() => draftValue(value));
  const numeric = typeof value === "number" || (value === null && typeof previous === "number");
  const initial = draftValue(value);
  const changed = draft !== initial;
  const prior = previousLabel(previous);
  const parsedDraftNumber = draft.trim().length === 0 ? null : Number(draft);
  const validNumericDraft = parsedDraftNumber !== null && Number.isFinite(parsedDraftNumber);

  useEffect(() => setDraft(initial), [initial]);

  function submitDraft(): void {
    if (!changed || disabled) return;
    if (numeric) {
      if (!validNumericDraft) return;
      onUpdate({ entryId: entry.id, fieldKey, value: parsedDraftNumber });
      return;
    }
    onUpdate({ entryId: entry.id, fieldKey, value: draft });
  }

  function step(delta: number): void {
    if (disabled) return;
    const base = validNumericDraft
      ? parsedDraftNumber
      : typeof previous === "number"
        ? previous
        : 0;
    onUpdate({ entryId: entry.id, fieldKey, value: base + delta });
  }

  return (
    <div className="log-field">
      <label htmlFor={controlId}>{fieldKey}</label>
      <div className="log-field-editor">
        <input
          id={controlId}
          type={numeric ? "number" : "text"}
          inputMode={numeric ? "decimal" : "text"}
          value={draft}
          placeholder={prior}
          maxLength={numeric ? undefined : 500}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submitDraft();
            }
          }}
        />
        {numeric ? (
          <div className="log-stepper" aria-label={`${fieldKey} stepper`} role="group">
            <button
              type="button"
              disabled={disabled}
              aria-label={`Decrease ${fieldKey}`}
              onClick={() => step(-1)}
            >
              <MinusIcon size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              disabled={disabled}
              aria-label={`Increase ${fieldKey}`}
              onClick={() => step(1)}
            >
              <PlusIcon size={16} aria-hidden="true" />
            </button>
          </div>
        ) : null}
        <button
          type="button"
          className="log-field-save"
          aria-label={`Save ${fieldKey}`}
          disabled={disabled || !changed || (numeric && !validNumericDraft)}
          onClick={submitDraft}
        >
          Save
        </button>
      </div>
      {prior === undefined ? null : <small>Previous {prior}</small>}
    </div>
  );
}

export function LogSurface({
  disabled,
  note,
  onUpdate
}: Readonly<{
  disabled: boolean;
  note: NoteDto;
  onUpdate: (update: LogFieldUpdate) => void;
}>) {
  const parsed = useMemo(() => LogStructuredDataSchema.safeParse(note.structuredData), [note]);
  if (note.type !== "log" || !parsed.success) return null;
  const entries = [...parsed.data.entries].sort(
    (left, right) =>
      right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id)
  );
  return (
    <section className="log-surface" aria-labelledby="log-fields-heading">
      <header>
        <div>
          <span className="section-label">Structured log</span>
          <h2 id="log-fields-heading">Edit logged values</h2>
        </div>
        <p>{entries.length === 1 ? "1 entry" : `${entries.length} entries`}</p>
      </header>
      {entries.length === 0 ? (
        <p className="log-empty">This log has no entries yet.</p>
      ) : (
        <div className="log-entry-list">
          {entries.map((entry) => (
            <article key={entry.id} className="log-entry">
              <time dateTime={entry.occurredAt}>{new Date(entry.occurredAt).toLocaleString()}</time>
              <div className="log-field-list">
                {Object.entries(entry.fields)
                  .sort(([left], [right]) => left.localeCompare(right))
                  .map(([fieldKey, value]) => (
                    <LogFieldEditor
                      key={fieldKey}
                      disabled={disabled}
                      entry={entry}
                      fieldKey={fieldKey}
                      value={value}
                      previous={priorLogFieldValue(parsed.data.entries, entry.id, fieldKey)}
                      onUpdate={onUpdate}
                    />
                  ))}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
