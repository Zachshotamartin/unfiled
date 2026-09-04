import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CaptureComposer, type CaptureComposerValue } from "./capture-composer";

const emptyValue: CaptureComposerValue = {
  expansionDisabled: false,
  explicitDestinationNoteId: null,
  rawContent: ""
};

interface InspectableProps {
  children?: ReactNode;
  id?: string;
  onChange?: (event: Readonly<{ target: Readonly<{ checked: boolean; value: string }> }>) => void;
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
    const html = renderToStaticMarkup(
      <CaptureComposer
        acknowledgement={null}
        disabled={false}
        error={null}
        notes={[]}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        value={emptyValue}
      />
    );

    expect(html).toContain("Write it down.");
    expect(html).toContain('maxLength="10000"');
    expect(html).toContain('autofocus=""');
    expect(html).toMatch(/<button[^>]+type="submit"[^>]+disabled=""[^>]*>/u);
    expect(html).not.toContain(" / 10,000");
  });

  it("offers no capture mode, because every capture is filed by the organizer", () => {
    const html = renderToStaticMarkup(
      <CaptureComposer
        acknowledgement="Saved. Waiting to sync."
        disabled={false}
        error={null}
        notes={[]}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        value={{ ...emptyValue, rawContent: "x".repeat(9_000) }}
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
    const tree = CaptureComposer({
      acknowledgement: null,
      disabled: false,
      error: null,
      notes: [],
      onChange,
      onSubmit: vi.fn(),
      value: emptyValue
    });
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
});
