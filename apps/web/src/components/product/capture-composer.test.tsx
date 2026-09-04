import type { EntityId } from "@unfiled/contracts";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { PendingCapturePhoto } from "@/lib/capture/capture-attachment-upload";

import { CaptureComposer, type CaptureComposerValue } from "./capture-composer";

const emptyValue: CaptureComposerValue = {
  expansionDisabled: false,
  explicitDestinationNoteId: null,
  rawContent: ""
};

type ComposerProps = Parameters<typeof CaptureComposer>[0];

function props(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return {
    acknowledgement: null,
    disabled: false,
    error: null,
    notes: [],
    onAddPhotos: vi.fn(),
    onChange: vi.fn(),
    onRemovePhoto: vi.fn(),
    onSubmit: vi.fn(),
    photoError: null,
    photos: [],
    preparingPhotos: false,
    value: emptyValue,
    ...overrides
  };
}

function photo(suffix: string): PendingCapturePhoto {
  return {
    attachmentId: `att_01J6M9Q7G4BMKB33GSG3NJ6D${suffix}` as EntityId<"att">,
    image: {
      bytes: new Uint8Array([255, 216, 255]),
      height: 800,
      mediaType: "image/jpeg",
      width: 1_200
    },
    previewUrl: `blob:https://unfiled.test/${suffix}`,
    stored: false
  };
}

interface InspectableProps {
  accept?: string;
  children?: ReactNode;
  disabled?: boolean;
  id?: string;
  multiple?: boolean;
  onChange?: (
    event: Readonly<{ target: { checked: boolean; files?: readonly File[]; value: string } }>
  ) => void;
  onClick?: () => void;
  type?: string;
}

function inspectElements(node: ReactNode): readonly ReactElement<InspectableProps>[] {
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<InspectableProps>;
  const descendants: ReactElement<InspectableProps>[] = [];
  Children.forEach(element.props.children, (child) => descendants.push(...inspectElements(child)));
  return [element, ...descendants];
}

describe("CaptureComposer", () => {
  it("keeps a blank capture local by disabling Save", () => {
    const html = renderToStaticMarkup(<CaptureComposer {...props()} />);

    expect(html).toContain("Write it down.");
    expect(html).toContain('maxLength="10000"');
    expect(html).toContain('autofocus=""');
    expect(html).toMatch(/<button[^>]+type="submit"[^>]+disabled=""[^>]*>/u);
    expect(html).not.toContain(" / 10,000");
  });

  it("offers no capture mode, because every capture is filed by the organizer", () => {
    const html = renderToStaticMarkup(
      <CaptureComposer
        {...props({
          acknowledgement: "Saved. Waiting to sync.",
          value: { ...emptyValue, rawContent: "x".repeat(9_000) }
        })}
      />
    );

    expect(html).toContain("9,000 / 10,000");
    expect(html).toContain("Saved. Waiting to sync.");
    // ADR-0021, decision 1. A "Keep private" capture is sealed under a key class the drain's
    // claim filter rejects, so the job it mints can never be claimed and it is never filed.
    expect(html).not.toContain("Keep private");
    expect(html).not.toContain("Never send this capture to an AI provider.");
    expect(html).not.toContain("private_manual");
  });

  it("maps each control to the canonical capture value", () => {
    const onChange = vi.fn<(value: CaptureComposerValue) => void>();
    const tree = CaptureComposer(props({ onChange }));
    const elements = inspectElements(tree);
    const textarea = elements.find((element) => element.props.id === "capture-text");
    const destination = elements.find((element) => element.props.id === "capture-destination");
    const toggles = elements.filter((element) => element.props.type === "checkbox");

    textarea?.props.onChange?.({ target: { checked: false, value: "remember this" } });
    destination?.props.onChange?.({
      target: { checked: false, value: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X" }
    });
    toggles[0]?.props.onChange?.({ target: { checked: false, value: "on" } });

    // Expansion is the only remaining toggle: there is no mode control left to map.
    expect(toggles).toHaveLength(1);
    expect(onChange).toHaveBeenNthCalledWith(1, {
      ...emptyValue,
      rawContent: "remember this"
    });
    expect(onChange).toHaveBeenNthCalledWith(2, {
      ...emptyValue,
      explicitDestinationNoteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X"
    });
    expect(onChange).toHaveBeenNthCalledWith(3, {
      ...emptyValue,
      expansionDisabled: true
    });
    const emitted: CaptureComposerValue | undefined = onChange.mock.calls[0]?.[0];
    expect(emitted).toBeDefined();
    expect(Object.keys(emitted ?? emptyValue)).not.toContain("privacy");
  });

  it("takes photos from the file picker and says they are not kept on this device", () => {
    const onAddPhotos = vi.fn<(files: readonly File[]) => void>();
    const tree = CaptureComposer(props({ onAddPhotos }));
    const picker = inspectElements(tree).find((element) => element.props.type === "file");
    const target = { checked: false, files: [new File([], "walk.jpg")], value: "walk.jpg" };

    picker?.props.onChange?.({ target });

    expect(picker?.props.accept).toBe("image/*");
    expect(picker?.props.multiple).toBe(true);
    expect(onAddPhotos).toHaveBeenCalledWith(target.files);
    // The picker keeps the file it was given, so a cleared value is what lets the same photo be
    // chosen twice.
    expect(target.value).toBe("");
    expect(renderToStaticMarkup(<CaptureComposer {...props()} />)).toContain(
      "They are not kept on this device"
    );
  });

  it("saves a photo with no words at all", () => {
    const html = renderToStaticMarkup(<CaptureComposer {...props({ photos: [photo("1X")] })} />);

    expect(html).not.toMatch(/<button[^>]+type="submit"[^>]+disabled=""[^>]*>/u);
    expect(html).toContain("blob:https://unfiled.test/1X");
    expect(html).toContain("Add another photo");
  });

  it("removes the photo the owner points at", () => {
    const onRemovePhoto = vi.fn<(attachmentId: EntityId<"att">) => void>();
    const photos = [photo("1X"), photo("2Y")];
    const tree = CaptureComposer(props({ onRemovePhoto, photos }));
    const removals = inspectElements(tree).filter((element) => element.props.type === "button");

    removals[1]?.props.onClick?.();

    expect(removals).toHaveLength(photos.length);
    expect(onRemovePhoto).toHaveBeenCalledWith(photos[1]?.attachmentId);
  });

  it("stops at four photos and says why the picker is closed", () => {
    const photos = ["1X", "2Y", "3Z", "4A"].map(photo);
    const tree = CaptureComposer(props({ photos }));
    const picker = inspectElements(tree).find((element) => element.props.type === "file");

    expect(picker?.props.disabled).toBe(true);
    expect(renderToStaticMarkup(<CaptureComposer {...props({ photos })} />)).toContain(
      "A capture carries up to 4 photos."
    );
  });
});
