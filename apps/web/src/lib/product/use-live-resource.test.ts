import { describe, expect, it, vi } from "vitest";

import {
  runCoalescedResourceLoad,
  sameResourceValue,
  runLatestResourceLoad,
  supersedeResourceLoads,
  type ResourceLoadEpoch,
  type ResourceLoadFlight
} from "./use-live-resource";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function callbacks<T>(resolved: (value: T) => void) {
  return {
    rejected: vi.fn(),
    resolved: vi.fn(resolved),
    settled: vi.fn()
  };
}

describe("live resource request ordering", () => {
  it("lets only the latest-started refresh publish when loads resolve out of order", async () => {
    const epoch: ResourceLoadEpoch = { current: 0 };
    const first = deferred<string>();
    const second = deferred<string>();
    let value = "initial";
    const firstCallbacks = callbacks<string>((next) => {
      value = next;
    });
    const secondCallbacks = callbacks<string>((next) => {
      value = next;
    });

    const firstLoad = runLatestResourceLoad(epoch, () => first.promise, firstCallbacks);
    const secondLoad = runLatestResourceLoad(epoch, () => second.promise, secondCallbacks);
    second.resolve("newer");
    await secondLoad;
    first.resolve("older");
    await firstLoad;

    expect(value).toBe("newer");
    expect(secondCallbacks.resolved).toHaveBeenCalledOnce();
    expect(secondCallbacks.settled).toHaveBeenCalledOnce();
    expect(firstCallbacks.resolved).not.toHaveBeenCalled();
    expect(firstCallbacks.settled).not.toHaveBeenCalled();
  });

  it("protects mutation data from an older load until a newer refresh starts", async () => {
    const epoch: ResourceLoadEpoch = { current: 0 };
    const stale = deferred<string>();
    let value = "initial";
    const staleCallbacks = callbacks<string>((next) => {
      value = next;
    });
    const staleLoad = runLatestResourceLoad(epoch, () => stale.promise, staleCallbacks);

    expect(value).toBe("initial");
    supersedeResourceLoads(epoch);
    value = "mutation";
    stale.resolve("stale load");
    await staleLoad;

    expect(value).toBe("mutation");
    expect(staleCallbacks.resolved).not.toHaveBeenCalled();

    const authoritative = deferred<string>();
    const authoritativeCallbacks = callbacks<string>((next) => {
      value = next;
    });
    const authoritativeLoad = runLatestResourceLoad(
      epoch,
      () => authoritative.promise,
      authoritativeCallbacks
    );
    authoritative.resolve("authoritative refresh");
    await authoritativeLoad;

    expect(value).toBe("authoritative refresh");
    expect(authoritativeCallbacks.resolved).toHaveBeenCalledOnce();
  });

  it("coalesces scheduled refreshes while a slow load is still in flight", async () => {
    const flight: ResourceLoadFlight = { current: null };
    const slow = deferred<undefined>();
    const load = vi.fn(() => slow.promise);

    const first = runCoalescedResourceLoad(flight, load);
    const duplicate = runCoalescedResourceLoad(flight, load);

    expect(duplicate).toBe(first);
    await Promise.resolve();
    expect(load).toHaveBeenCalledOnce();

    slow.resolve(undefined);
    await first;
    await Promise.resolve();
    expect(flight.current).toBeNull();

    await runCoalescedResourceLoad(flight, () => Promise.resolve());
    expect(flight.current).toBeNull();
  });
});

describe("holding an unchanged poll", () => {
  // Every four seconds a poll parsed the same bytes into a brand new object and stored it. Callers
  // key off identity -- usePagedResource treats a new first page as a fresh list -- so the Library,
  // Review, Spaces, revisions, backlinks and generated blocks all threw away every page the owner
  // had loaded, four seconds after they loaded it. Nothing asserted identity survived a poll, so
  // nothing caught it.
  const page = {
    items: [{ id: "note_a", title: "Kitchen tap" }],
    pageInfo: { hasMore: true, nextCursor: "cursor-a" }
  };

  it("treats a re-parsed identical response as the response already on screen", () => {
    const reparsed = JSON.parse(JSON.stringify(page)) as typeof page;
    expect(reparsed).not.toBe(page);
    expect(sameResourceValue(page, reparsed)).toBe(true);
  });

  it("still reports a response whose content moved on", () => {
    expect(
      sameResourceValue(page, {
        ...page,
        pageInfo: { hasMore: true, nextCursor: "cursor-b" }
      })
    ).toBe(false);
    expect(
      sameResourceValue(page, {
        ...page,
        items: [{ id: "note_a", title: "Kitchen tap, plumber booked" }]
      })
    ).toBe(false);
    expect(sameResourceValue(null, page)).toBe(false);
  });

  it("answers 'different' rather than throwing on a value it cannot serialize", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(sameResourceValue(cyclic, cyclic)).toBe(true);
    expect(sameResourceValue({ a: 1 }, cyclic)).toBe(false);
  });
});
