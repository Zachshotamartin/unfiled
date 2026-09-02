import { createHash, timingSafeEqual as actualTimingSafeEqual } from "node:crypto";
import type * as NodeCryptoModule from "node:crypto";

import { describe, expect, it, vi } from "vitest";

const observed = vi.hoisted(() => ({ lengths: [] as Readonly<[number, number]>[] }));

vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof NodeCryptoModule>();
  return {
    ...original,
    timingSafeEqual: vi.fn((left: NodeJS.ArrayBufferView, right: NodeJS.ArrayBufferView) => {
      observed.lengths.push([left.byteLength, right.byteLength]);
      return original.timingSafeEqual(left, right);
    })
  };
});

const { hasValidSearchBearerCredential } = await import("../src/auth.js");

const SECRET = "local-search-secret-with-at-least-32-characters";

describe("local search bearer comparison", () => {
  it("hashes every candidate to fixed-size material before constant-time comparison", () => {
    observed.lengths.length = 0;
    const attempts = [
      null,
      "",
      "Bearer wrong",
      `Bearer ${SECRET.slice(0, -1)}x`,
      `Bearer ${SECRET}`,
      "x".repeat(2_049)
    ];
    expect(attempts.map((header) => hasValidSearchBearerCredential(header, SECRET))).toEqual([
      false,
      false,
      false,
      false,
      true,
      false
    ]);
    expect(observed.lengths).toEqual(attempts.map(() => [32, 32]));
  });

  it("matches the SHA-256 digest comparison and never accepts prefixes or suffixes", () => {
    const expected = createHash("sha256").update(`Bearer ${SECRET}`).digest();
    const actual = createHash("sha256").update(`Bearer ${SECRET}`).digest();
    expect(actualTimingSafeEqual(actual, expected)).toBe(true);
    expect(hasValidSearchBearerCredential(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(hasValidSearchBearerCredential(`Bearer x${SECRET}`, SECRET)).toBe(false);
    actual.fill(0);
    expected.fill(0);
  });
});
