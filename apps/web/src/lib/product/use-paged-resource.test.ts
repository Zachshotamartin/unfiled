import { describe, expect, it } from "vitest";

import {
  applyContinuationPage,
  continuationForFirstPage,
  emptyPagedContinuation,
  mergePageItems,
  type PagedContinuation,
  type PagedResponse
} from "./use-paged-resource";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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

  it("drops page two when a refreshed first-page snapshot arrives", async () => {
    const first: PagedResponse<{ id: string }> = {
      items: [{ id: "a" }],
      pageInfo: { hasMore: true, nextCursor: "cursor-a" }
    };
    const refreshed: PagedResponse<{ id: string }> = {
      items: [{ id: "a" }],
      pageInfo: { hasMore: true, nextCursor: "cursor-b" }
    };
    const initialLoad = {
      firstPage: first,
      items: [] as readonly { id: string }[],
      url: "/notes"
    };
    let continuation: PagedContinuation<{ id: string }> = applyContinuationPage(
      { ...emptyPagedContinuation("/notes", first), loading: true },
      initialLoad,
      {
        items: [{ id: "page-two" }],
        pageInfo: { hasMore: true, nextCursor: "cursor-two" }
      }
    );
    expect(continuationForFirstPage(continuation, "/notes", first).items).toEqual([
      { id: "page-two" }
    ]);

    const page = deferred<PagedResponse<{ id: string }>>();
    const pendingLoad = {
      firstPage: first,
      items: continuation.items,
      url: "/notes"
    };
    continuation = { ...continuation, loading: true };
    const pending = page.promise.then((result) => {
      continuation = applyContinuationPage(continuation, pendingLoad, result);
    });

    expect(continuationForFirstPage(continuation, "/notes", refreshed).items).toEqual([]);
    page.resolve({
      items: [{ id: "stale-page-two" }],
      pageInfo: { hasMore: false, nextCursor: null }
    });
    await pending;

    const current = continuationForFirstPage(continuation, "/notes", refreshed);
    expect(current.items).toEqual([]);
    expect(current.loading).toBe(false);
    expect(current.pageInfo).toBeNull();
  });
});
