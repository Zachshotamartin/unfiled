import { describe, expect, it, vi } from "vitest";

import { draftSaveAttempt } from "./draft-save";

describe("draft save idempotency", () => {
  it("keeps one key for retries of an unchanged draft and rotates it after an edit", () => {
    const createKey = vi
      .fn<() => string>()
      .mockReturnValueOnce("web_first")
      .mockReturnValueOnce("web_second");
    const first = draftSaveAttempt(null, "revision-1:draft-a", createKey);
    const retry = draftSaveAttempt(first, "revision-1:draft-a", createKey);
    const edited = draftSaveAttempt(retry, "revision-1:draft-b", createKey);

    expect(retry).toBe(first);
    expect(edited.idempotencyKey).toBe("web_second");
    expect(createKey).toHaveBeenCalledTimes(2);
  });
});
