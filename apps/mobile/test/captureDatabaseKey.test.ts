import { describe, expect, it, vi } from "vitest";

import { createCaptureDatabaseKeyLoader } from "../src/features/capture/captureDatabaseKeyCore";

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItemAsync: vi.fn(() => Promise.resolve(value)),
    setItemAsync: vi.fn((_key: string, nextValue: string) => {
      value = nextValue;
      return Promise.resolve();
    })
  };
}

describe("capture database key", () => {
  it("generates, verifies, and memoizes a 256-bit key in protected storage", async () => {
    const storage = memoryStorage();
    const randomBytes = vi.fn(() => Promise.resolve(Uint8Array.from({ length: 32 }, (_, i) => i)));
    const load = createCaptureDatabaseKeyLoader({
      randomBytes,
      storage,
      storageKey: "test.capture.key"
    });

    const first = await load();
    const second = await load();

    expect(first).toHaveLength(64);
    expect(first).toBe(second);
    expect(randomBytes).toHaveBeenCalledOnce();
    expect(storage.setItemAsync).toHaveBeenCalledOnce();
  });

  it("fails closed when protected key material is malformed", async () => {
    const load = createCaptureDatabaseKeyLoader({
      randomBytes: () => Promise.resolve(new Uint8Array(32)),
      storage: memoryStorage("not-a-key"),
      storageKey: "test.capture.key"
    });

    await expect(load()).rejects.toThrow("protected capture database key is invalid");
  });

  it("fails closed when protected storage cannot verify its write", async () => {
    const storage = {
      getItemAsync: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null),
      setItemAsync: vi.fn().mockResolvedValue(undefined)
    };
    const load = createCaptureDatabaseKeyLoader({
      randomBytes: () => Promise.resolve(new Uint8Array(32)),
      storage,
      storageKey: "test.capture.key"
    });

    await expect(load()).rejects.toThrow("could not be verified");
  });
});
