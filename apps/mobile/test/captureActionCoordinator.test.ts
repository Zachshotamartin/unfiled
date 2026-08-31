import { ApiClientError } from "@unfiled/api-client";
import type { CaptureDeleteRequest, CaptureDeleteResponse } from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  drainCaptureDeleteIntents,
  executeCaptureDeleteIntent,
  type CaptureDeleteIntentStore
} from "../src/features/capture/captureActionCoordinator";
import type { CaptureDeleteIntent } from "../src/features/capture/captureActionIntents";

const PROFILE_ID = "00000000-0000-4000-8000-000000000001";
const CAPTURE_ID = "cap_01J6M9Q7R5K4N3P2T1V0WXYZAB" as const;

function intent(): CaptureDeleteIntent {
  return {
    actionSignature: `delete:${CAPTURE_ID}:source:`,
    actionType: "delete",
    captureId: CAPTURE_ID,
    idempotencyKey: "mobile-delete:01J6M9Q7R5K4N3P2T1V0WXYZAB",
    profileId: PROFILE_ID,
    request: {
      expectedNoteRevisions: [],
      idempotencyKey: "mobile-delete:01J6M9Q7R5K4N3P2T1V0WXYZAB",
      removeInsertedContent: false
    },
    requestJson: JSON.stringify({
      expectedNoteRevisions: [],
      idempotencyKey: "mobile-delete:01J6M9Q7R5K4N3P2T1V0WXYZAB",
      removeInsertedContent: false
    }),
    state: "pending",
    targetId: CAPTURE_ID
  };
}

function response(): CaptureDeleteResponse {
  return {
    captureId: CAPTURE_ID,
    contentRemovalMutations: [],
    deletedAt: "2026-08-30T18:30:00.000Z",
    removedInsertedContent: false,
    replayed: true,
    sourceRemovedFromNoteIds: []
  };
}

function store(initial: CaptureDeleteIntent[] = [intent()]) {
  let values = initial;
  const adapter: CaptureDeleteIntentStore = {
    cancel: vi.fn((value: CaptureDeleteIntent) => {
      values = values.filter(({ actionSignature }) => actionSignature !== value.actionSignature);
      return Promise.resolve();
    }),
    complete: vi.fn((value: CaptureDeleteIntent) => {
      values = values.filter(({ actionSignature }) => actionSignature !== value.actionSignature);
      return Promise.resolve();
    }),
    list: vi.fn(() => Promise.resolve(values))
  };
  return { adapter, values: () => values };
}

function apiError(status: number, code: "not_found" | "stale_revision") {
  return new ApiClientError(status, {
    code,
    message: "Safe error",
    requestId: "req_capture_delete"
  });
}

describe("durable capture action coordinator", () => {
  it("retains an intent after a lost response and reuses its exact request after restart", async () => {
    const persistence = store();
    const firstSend = vi.fn((captureId: string, request: CaptureDeleteRequest) => {
      void captureId;
      void request;
      return Promise.reject(new TypeError("connection reset"));
    });
    const first = await executeCaptureDeleteIntent({
      intent: intent(),
      send: firstSend,
      store: persistence.adapter
    });

    expect(first).toBe("retry_later");
    expect(persistence.values()).toHaveLength(1);

    const replaySend = vi.fn((captureId: string, request: CaptureDeleteRequest) => {
      void captureId;
      void request;
      return Promise.resolve(response());
    });
    const restarted = await drainCaptureDeleteIntents({
      profileId: PROFILE_ID,
      send: replaySend,
      store: persistence.adapter
    });

    expect(restarted).toEqual({ completed: 1, retained: 0 });
    expect(replaySend).toHaveBeenCalledWith(CAPTURE_ID, intent().request);
    expect(firstSend.mock.calls[0]?.[1]).toEqual(replaySend.mock.calls[0]?.[1]);
    expect(persistence.values()).toHaveLength(0);
  });

  it("treats authoritative absence as completed but restores a stale conflicting deletion", async () => {
    const alreadyAbsent = store();
    await expect(
      executeCaptureDeleteIntent({
        intent: intent(),
        send: () => Promise.reject(apiError(404, "not_found")),
        store: alreadyAbsent.adapter
      })
    ).resolves.toBe("completed");
    expect(alreadyAbsent.adapter.complete).toHaveBeenCalledOnce();

    const stale = store();
    await expect(
      executeCaptureDeleteIntent({
        intent: intent(),
        send: () => Promise.reject(apiError(409, "stale_revision")),
        store: stale.adapter
      })
    ).resolves.toBe("cancelled");
    expect(stale.adapter.cancel).toHaveBeenCalledOnce();
  });

  it("retains retryable server failures and pauses replay when authentication expires", async () => {
    const retryable = store();
    await expect(
      executeCaptureDeleteIntent({
        intent: intent(),
        send: () => Promise.reject(apiError(503, "not_found")),
        store: retryable.adapter
      })
    ).resolves.toBe("retry_later");
    expect(retryable.adapter.cancel).not.toHaveBeenCalled();
    expect(retryable.adapter.complete).not.toHaveBeenCalled();

    const signedOut = store();
    await expect(
      executeCaptureDeleteIntent({
        intent: intent(),
        send: () => Promise.reject(apiError(401, "not_found")),
        store: signedOut.adapter
      })
    ).resolves.toBe("waiting_for_sign_in");
    expect(signedOut.values()).toHaveLength(1);
  });
});
