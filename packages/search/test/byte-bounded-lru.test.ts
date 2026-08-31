import { describe, expect, it, vi } from "vitest";

import { ByteBoundedLruCache, PRIVATE_RAG_CACHE_TTL_MS } from "../src/index.js";

describe("ByteBoundedLruCache", () => {
  it("evicts least-recently-used entries by bytes and disposes values", () => {
    const disposed: string[] = [];
    const cache = new ByteBoundedLruCache<string, string>({
      maxBytes: 5,
      dispose: (value) => disposed.push(value)
    });
    expect(cache.set("a", "alpha", 2)).toBe(true);
    expect(cache.set("b", "bravo", 2)).toBe(true);
    expect(cache.get("a")).toBe("alpha");
    expect(cache.set("c", "charlie", 2)).toBe(true);
    expect(cache.get("b")).toBeUndefined();
    expect(disposed).toEqual(["bravo"]);
    expect(cache.currentBytes).toBe(4);
  });

  it("expires after at most five minutes and supports scoped invalidation", () => {
    let now = 10;
    const dispose = vi.fn();
    const cache = new ByteBoundedLruCache<string, { owner: string }>({
      maxBytes: 10,
      ttlMs: 100,
      now: () => now,
      dispose
    });
    cache.set("a", { owner: "one" }, 2);
    cache.set("b", { owner: "two" }, 2);
    expect(cache.deleteWhere((value) => value.owner === "one")).toBe(1);
    now = 110;
    expect(cache.pruneExpired()).toBe(1);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(cache.currentBytes).toBe(0);
    expect(
      () => new ByteBoundedLruCache({ maxBytes: 1, ttlMs: PRIVATE_RAG_CACHE_TTL_MS + 1 })
    ).toThrow("ttl_ms_exceeds_private_rag_maximum");
  });

  it("rejects invalid sizes and declines an entry larger than its byte budget", () => {
    const cache = new ByteBoundedLruCache<string, string>({ maxBytes: 2 });
    expect(cache.set("large", "value", 3)).toBe(false);
    expect(cache.size).toBe(0);
    expect(() => cache.set("bad", "value", -1)).toThrow(
      "size_bytes_must_be_a_non_negative_safe_integer"
    );
  });
});
