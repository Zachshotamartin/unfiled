"use client";

import type { EntityId, NoteSummary } from "@unfiled/contracts";
import type { SyntheticEvent } from "react";

import { UnfiledGlyph } from "./unfiled-glyph";

/**
 * The composer no longer asks how a capture should be handled. Every capture is filed by the
 * organizer (ADR-0021, decision 1), so there is no privacy field here and none in the value the
 * composer produces: a `private_manual` capture mints a job the drain can never claim, because
 * `claim_organization_jobs` only accepts `capture.privacy = 'ai_assisted'`.
 */
export type CaptureComposerValue = Readonly<{
  expansionDisabled: boolean;
  explicitDestinationNoteId: EntityId<"note"> | null;
  rawContent: string;
}>;

type CaptureComposerProps = Readonly<{
  acknowledgement: string | null;
  disabled: boolean;
  error: string | null;
  notes: readonly NoteSummary[];
  onChange: (value: CaptureComposerValue) => void;
  onSubmit: (event: SyntheticEvent<HTMLFormElement>) => void;
  value: CaptureComposerValue;
}>;

export function CaptureComposer({
  acknowledgement,
  disabled,
  error,
  notes,
  onChange,
  onSubmit,
  value
}: CaptureComposerProps) {
  const length = value.rawContent.length;
  const invalid = length > 10_000 || value.rawContent.trim().length === 0;

  return (
    <section className="capture-composer" aria-labelledby="capture-heading">
      <div className="capture-composer-intro">
        <h2 id="capture-heading">Write it down.</h2>
        <p>Save first. Unfiled works out where it belongs after.</p>
      </div>
      <form onSubmit={onSubmit} className="capture-form">
        <label className="field-label" htmlFor="capture-text">
          Capture
        </label>
        <textarea
          id="capture-text"
          autoFocus
          className="capture-input"
          disabled={disabled}
          maxLength={10_000}
          placeholder="Add bananas, bench 135 x 8, remember the Roosevelt method..."
          rows={4}
          value={value.rawContent}
          aria-describedby="capture-help capture-count capture-error"
          aria-invalid={error === null ? undefined : true}
          onChange={(event) => onChange({ ...value, rawContent: event.target.value })}
        />
        <div className="capture-form-meta">
          <p id="capture-help">No title or folder needed.</p>
          <span id="capture-count" aria-live="polite">
            {length >= 9_000 ? `${length.toLocaleString()} / 10,000` : ""}
          </span>
        </div>

        <details className="capture-options">
          <summary>
            <UnfiledGlyph glyph="sliders" size={17} weight={1.9} /> Options
          </summary>
          <div className="capture-options-grid">
            <label className="capture-option-field" htmlFor="capture-destination">
              <span>Send directly to</span>
              <select
                id="capture-destination"
                className="editor-select"
                disabled={disabled}
                value={value.explicitDestinationNoteId ?? ""}
                onChange={(event) =>
                  onChange({
                    ...value,
                    explicitDestinationNoteId:
                      event.target.value === "" ? null : (event.target.value as EntityId<"note">)
                  })
                }
              >
                <option value="">Let Unfiled decide</option>
                {notes.map((note) => (
                  <option key={note.id} value={note.id}>
                    {note.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="capture-toggle">
              <input
                type="checkbox"
                checked={!value.expansionDisabled}
                disabled={disabled}
                onChange={(event) =>
                  onChange({ ...value, expansionDisabled: !event.target.checked })
                }
              />
              <span>
                <strong>Add a short expansion</strong>
                Allow a clearly labeled AI-generated block when it helps.
              </span>
            </label>
          </div>
        </details>

        <div className="capture-submit-row">
          <div className="capture-feedback">
            <p id="capture-error" role="alert">
              {error}
            </p>
            <p role="status" aria-live="polite">
              {acknowledgement === null ? null : (
                <>
                  <UnfiledGlyph glyph="check" size={15} weight={2.2} /> {acknowledgement}
                </>
              )}
            </p>
          </div>
          <button type="submit" className="button-primary" disabled={disabled || invalid}>
            <UnfiledGlyph glyph="send" size={17} weight={2.2} /> Save
          </button>
        </div>
      </form>
    </section>
  );
}
