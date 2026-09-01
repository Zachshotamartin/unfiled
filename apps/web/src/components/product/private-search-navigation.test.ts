import { describe, expect, it } from "vitest";

import { normalizePrivateSearchNavigationQuery } from "./private-search-navigation";

describe("private search navigation", () => {
  it("normalizes and bounds in-memory queries", () => {
    expect(normalizePrivateSearchNavigationQuery("  Weekly plan  ")).toBe("Weekly plan");
    expect(normalizePrivateSearchNavigationQuery("x".repeat(201))).toHaveLength(200);
  });
});
