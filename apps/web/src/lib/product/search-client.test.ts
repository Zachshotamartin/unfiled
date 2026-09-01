import { manualNoteFixtures } from "@unfiled/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { requestSearchPage } from "./search-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("private browser search client", () => {
  it("puts every search field in a no-store POST body, never in the URL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [manualNoteFixtures.searchResult],
          pageInfo: { hasMore: false, nextCursor: null }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetcher);

    await requestSearchPage({
      query: " private thought ",
      archive: "include",
      cursor: "opaque-cursor",
      limit: 17
    });

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    if (typeof url !== "string") throw new TypeError("Expected a relative search URL");
    expect(url).toBe("/api/v1/search");
    expect(url).not.toContain("private thought");
    expect(init).toMatchObject({ cache: "no-store", method: "POST" });
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(await new Response(init?.body).json()).toEqual({
      query: "private thought",
      archive: "include",
      cursor: "opaque-cursor",
      limit: 17
    });
  });

  it("rejects query-era and unknown fields before transport", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    await expect(requestSearchPage({ query: "valid", q: "legacy" } as never)).rejects.toBeDefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
