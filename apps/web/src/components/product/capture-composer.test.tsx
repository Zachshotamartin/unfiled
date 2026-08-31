import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CaptureComposer, type CaptureComposerValue } from "./capture-composer";

const emptyValue: CaptureComposerValue = {
  expansionDisabled: false,
  explicitDestinationNoteId: null,
  privacy: "ai_assisted",
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

  it("shows the late counter and makes AI expansion unavailable for private captures", () => {
    const html = renderToStaticMarkup(
      <CaptureComposer
        acknowledgement="Saved. Waiting to sync."
        disabled={false}
        error={null}
        notes={[]}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        value={{
          ...emptyValue,
          expansionDisabled: true,
          privacy: "private_manual",
          rawContent: "x".repeat(9_000)
        }}
      />
    );

    expect(html).toContain("9,000 / 10,000");
    expect(html).toContain("Never send this capture to an AI provider.");
    expect(html).toContain("Saved. Waiting to sync.");
    expect(html.match(/disabled=""/gu)).toHaveLength(1);
  });

  it("maps each control to the canonical capture value", () => {
    const onChange = vi.fn();
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
    toggles[0]?.props.onChange?.({ target: { checked: true, value: "on" } });
    toggles[1]?.props.onChange?.({ target: { checked: false, value: "on" } });

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
      expansionDisabled: true,
      privacy: "private_manual"
    });
    expect(onChange).toHaveBeenNthCalledWith(4, {
      ...emptyValue,
      expansionDisabled: true
    });
  });
});
