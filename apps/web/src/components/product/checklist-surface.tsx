"use client";

import type { EntityId, NoteDto } from "@unfiled/contracts";
import { useState } from "react";

import { UnfiledGlyph } from "./unfiled-glyph";

type Item = Readonly<{ checked: boolean; id: EntityId<"itm">; text: string }>;

function items(note: NoteDto): readonly Item[] {
  const structured = note.structuredData as Readonly<Record<string, unknown>>;
  const value = structured[note.type === "project" ? "checklistItems" : "items"];
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (candidate === null || typeof candidate !== "object") return [];
    const item = candidate as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      !item.id.startsWith("itm_") ||
      typeof item.checked !== "boolean" ||
      typeof item.text !== "string"
    )
      return [];
    return [{ checked: item.checked, id: item.id as EntityId<"itm">, text: item.text }];
  });
}

export function ChecklistSurface({
  disabled,
  note,
  onToggle
}: Readonly<{
  disabled: boolean;
  note: NoteDto;
  onToggle: (itemId: EntityId<"itm">, checked: boolean) => void;
}>) {
  const checklist = items(note);
  const [announcement, setAnnouncement] = useState("");
  if (checklist.length === 0 || (note.type !== "list" && note.type !== "project")) return null;
  const remaining = checklist.filter((item) => !item.checked);
  const completed = checklist.filter((item) => item.checked);

  function toggle(item: Item, checked: boolean): void {
    const nextRemaining =
      checklist.filter((candidate) => candidate.id !== item.id && !candidate.checked).length +
      (checked ? 0 : 1);
    setAnnouncement(
      `${item.text}, ${checked ? "checked" : "unchecked"}, ${nextRemaining} of ${checklist.length} remaining.`
    );
    onToggle(item.id, checked);
  }

  function rows(values: readonly Item[]) {
    return values.map((item) => (
      <label key={item.id} className="checklist-row" role="listitem">
        <input
          type="checkbox"
          className="sr-only"
          checked={item.checked}
          disabled={disabled}
          aria-label={`${item.text}, ${item.checked ? "checked" : "unchecked"}`}
          onChange={(event) => toggle(item, event.target.checked)}
        />
        <span className={`check-box ${item.checked ? "check-box-checked" : ""}`} aria-hidden="true">
          {item.checked ? <UnfiledGlyph glyph="check" size={13} weight={2.2} /> : null}
        </span>
        <span className={item.checked ? "text-muted-content line-through" : "text-content"}>
          {item.text}
        </span>
      </label>
    ));
  }

  return (
    <section aria-labelledby="checklist-heading" className="checklist-surface">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="checklist-heading" className="eyebrow">
          Interactive checklist
        </h2>
        <span className="font-mono text-[11px] text-disabled-content">
          {completed.length}/{checklist.length}
        </span>
      </div>
      <div className="mt-4 border-t border-outline" role="list" aria-label="Remaining items">
        {rows(remaining)}
        {remaining.length === 0 ? (
          <p className="checklist-complete-copy">Everything is complete.</p>
        ) : null}
      </div>
      {completed.length === 0 ? null : (
        <details className="completed-group">
          <summary>
            <span>Completed</span>
            <span>{completed.length}</span>
          </summary>
          <div role="list" aria-label="Completed items">
            {rows(completed)}
          </div>
        </details>
      )}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </section>
  );
}
