"use client";

import type { EntityId, NoteSummary } from "@unfiled/contracts";
import type { ChangeEvent, SyntheticEvent } from "react";

import type { PendingCapturePhoto } from "@/lib/capture/capture-attachment-upload";
import {
  canSendCapture,
  MAX_CAPTURE_CHARACTERS,
  MAX_CAPTURE_PHOTOS,
  remainingCapturePhotos
} from "@/lib/capture/capture-composer-rules";

import { attachmentThumbnailSize } from "./capture-attachment";
import { UnfiledGlyph } from "./unfiled-glyph";

/**
 * The composer no longer asks how a capture should be handled. Every capture is filed by the
 * organizer (ADR-0021, decision 1), so there is no privacy field here and none in the value the
 * composer produces: a `private_manual` capture mints a job the drain can never claim, because
 * `claim_organization_jobs` only accepts `capture.privacy = 'ai_assisted'`.
 *
 * Photos are not part of this value. The value is what the encrypted draft keeps between visits,
 * and a draft holds words; the photos live beside it for as long as the tab does, which is what
 * the owner is told beneath the picker.
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
  onAddPhotos: (files: readonly File[]) => void;
  onChange: (value: CaptureComposerValue) => void;
  onRemovePhoto: (attachmentId: EntityId<"att">) => void;
  onSubmit: (event: SyntheticEvent<HTMLFormElement>) => void;
  photoError: string | null;
  photos: readonly PendingCapturePhoto[];
  preparingPhotos: boolean;
  value: CaptureComposerValue;
}>;

export function CaptureComposer({
  acknowledgement,
  disabled,
  error,
  notes,
  onAddPhotos,
  onChange,
  onRemovePhoto,
  onSubmit,
  photoError,
  photos,
  preparingPhotos,
  value
}: CaptureComposerProps) {
  const length = value.rawContent.length;
  const sendable = canSendCapture(value.rawContent, photos.length);
  const remainingPhotos = remainingCapturePhotos(photos.length);

  function selectPhotos(event: ChangeEvent<HTMLInputElement>): void {
    const files = [...(event.target.files ?? [])];
    // The same file has to be choosable twice: a picker that still holds it fires no change.
    event.target.value = "";
    if (files.length > 0) onAddPhotos(files);
  }

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
          maxLength={MAX_CAPTURE_CHARACTERS}
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
            {length >= 9_000
              ? `${length.toLocaleString()} / ${MAX_CAPTURE_CHARACTERS.toLocaleString()}`
              : ""}
          </span>
        </div>

        {photos.length === 0 ? null : (
          <div className="attachment-grid" aria-label="Photos on this capture">
            {photos.map((photo) => {
              const size = attachmentThumbnailSize(photo.image.width, photo.image.height);
              return (
                <figure className="attachment-figure" key={photo.attachmentId}>
                  <img
                    alt="Photo waiting to be saved with this capture"
                    height={size.height}
                    src={photo.previewUrl}
                    width={size.width}
                  />
                  <figcaption>
                    <button
                      type="button"
                      className="quiet-button"
                      disabled={disabled}
                      onClick={() => onRemovePhoto(photo.attachmentId)}
                    >
                      <UnfiledGlyph glyph="close" size={14} weight={2.2} /> Remove
                    </button>
                  </figcaption>
                </figure>
              );
            })}
          </div>
        )}

        <div className="capture-form-meta items-center">
          <label
            className={
              disabled || preparingPhotos || remainingPhotos === 0
                ? "quiet-button pointer-events-none opacity-50"
                : "quiet-button cursor-pointer"
            }
          >
            <UnfiledGlyph glyph="camera" size={17} weight={1.9} />{" "}
            {preparingPhotos
              ? "Preparing photo..."
              : photos.length === 0
                ? "Add a photo"
                : "Add another photo"}
            <input
              accept="image/*"
              className="sr-only"
              disabled={disabled || preparingPhotos || remainingPhotos === 0}
              multiple
              type="file"
              aria-describedby="capture-photo-help capture-photo-error"
              onChange={selectPhotos}
            />
          </label>
          <p id="capture-photo-help">
            {remainingPhotos === 0
              ? `A capture carries up to ${MAX_CAPTURE_PHOTOS} photos.`
              : "Photos are uploaded when you save. They are not kept on this device, so saving one needs a connection."}
          </p>
        </div>
        <div className="capture-feedback">
          <p id="capture-photo-error" role="alert">
            {photoError}
          </p>
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
          <button type="submit" className="button-primary" disabled={disabled || !sendable}>
            <UnfiledGlyph glyph="send" size={17} weight={2.2} /> Save
          </button>
        </div>
      </form>
    </section>
  );
}
