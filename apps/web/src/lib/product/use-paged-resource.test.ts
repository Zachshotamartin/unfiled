import { describe, expect, it } from "vitest";

import { mergePageItems } from "./use-paged-resource";

describe("paged resource merging", () => {
  it("keeps first-page order and lets freshly polled values win duplicate ids", () => {
    const merged = mergePageItems(
      [
        { id: "a", title: "Fresh A" },
        { id: "b", title: "Fresh B" }
      ],
      [
        { id: "b", title: "Stale B" },
        { id: "c", title: "Page two C" }
      ],
      (item) => item.id
    );

    expect(merged).toEqual([
      { id: "a", title: "Fresh A" },
      { id: "b", title: "Fresh B" },
      { id: "c", title: "Page two C" }
    ]);
  });
});
