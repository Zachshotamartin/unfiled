import { describe, expect, it } from "vitest";

import { parseListLabel } from "./list-label";

describe("parseListLabel (the web's copy of the organizer's rule)", () => {
  it("reads the name the owner gave a list, and only that", () => {
    expect(parseListLabel("todo list, buy milk, call mom")).toEqual({
      title: "Todo list",
      remainder: "buy milk, call mom"
    });
    expect(parseListLabel("Weekend plans: hike, brunch")?.title).toBe("Weekend plans");
    expect(parseListLabel("milk, eggs, bread")).toBeNull();
    expect(parseListLabel("note: milk, eggs")).toBeNull();
    expect(
      parseListLabel("project update: shipped offline capture. next step is sync tests")
    ).toBeNull();
    expect(parseListLabel("meet at 10:30, bring the deck")).toBeNull();
  });
});
