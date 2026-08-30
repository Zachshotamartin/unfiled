import { describe, expect, it } from "vitest";

import {
  createEditorHistory,
  pushEditorState,
  redoEditorState,
  undoEditorState
} from "../src/index.js";

describe("editor-local undo and redo", () => {
  it("records immutable local states and clears redo on a new edit", () => {
    const initial = createEditorHistory("first");
    const second = pushEditorState(initial, "second");
    const third = pushEditorState(second, "third");
    const undone = undoEditorState(third);
    const branched = pushEditorState(undone, "branch");

    expect(initial.present).toBe("first");
    expect(undone).toMatchObject({ present: "second", canUndo: true, canRedo: true });
    expect(branched).toMatchObject({ present: "branch", canRedo: false });
    expect(redoEditorState(undone).present).toBe("third");
  });

  it("stays unchanged at history boundaries and honors the configured bound", () => {
    const initial = createEditorHistory(0, 2);
    const bounded = pushEditorState(pushEditorState(pushEditorState(initial, 1), 2), 3);
    expect(bounded.past).toEqual([1, 2]);
    expect(undoEditorState(undoEditorState(undoEditorState(bounded))).present).toBe(1);
    expect(redoEditorState(initial)).toBe(initial);
    expect(pushEditorState(initial, 0)).toBe(initial);
    expect(() => createEditorHistory("invalid", 0)).toThrow(RangeError);
    expect(() => createEditorHistory("invalid", 1.5)).toThrow(RangeError);
  });
});
