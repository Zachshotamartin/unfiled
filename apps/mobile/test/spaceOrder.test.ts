import { describe, expect, it } from "vitest";

import { rankSpacesAfterMove } from "../src/features/notes/spaceOrder";

const spaces = [
  { id: "first", currentRevision: 1, sortKey: "a0" },
  { id: "second", currentRevision: 2, sortKey: "a0" },
  { id: "third", currentRevision: 3, sortKey: "a0" }
] as const;

describe("rankSpacesAfterMove", () => {
  it("turns duplicate default keys into stable ranks in the requested order", () => {
    expect(rankSpacesAfterMove(spaces, 1, -1)).toEqual([
      { id: "second", currentRevision: 2, sortKey: "r000000" },
      { id: "first", currentRevision: 1, sortKey: "r000001" },
      { id: "third", currentRevision: 3, sortKey: "r000002" }
    ]);
  });

  it("updates only the swapped ranks after the order has been normalized", () => {
    const normalized = spaces.map((space, index) => ({
      ...space,
      sortKey: `r${String(index).padStart(6, "0")}`
    }));
    expect(rankSpacesAfterMove(normalized, 1, 1)).toEqual([
      { id: "third", currentRevision: 3, sortKey: "r000001" },
      { id: "second", currentRevision: 2, sortKey: "r000002" }
    ]);
  });

  it("does nothing at a list boundary", () => {
    expect(rankSpacesAfterMove(spaces, 0, -1)).toEqual([]);
    expect(rankSpacesAfterMove(spaces, 2, 1)).toEqual([]);
  });
});
