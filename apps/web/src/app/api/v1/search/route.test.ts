import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("private search route transport", () => {
  it("rejects legacy GET search without reflecting its query", async () => {
    const canary = "legacy-query-canary";
    const response = GET(
      new Request(`https://unfiled.test/api/v1/search?q=${encodeURIComponent(canary)}`)
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(await response.text()).not.toContain(canary);
  });
});
