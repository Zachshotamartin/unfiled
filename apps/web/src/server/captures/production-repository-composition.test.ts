import { captureV1Fixture } from "@unfiled/contracts";
import { describe, expect, it, vi } from "vitest";

import { ServiceRpcError } from "@/server/encryption/service-rpc-client";

import { createProductionCaptureComposition } from "./production-repository-composition";
import type { CaptureRepository } from "./repository";
import { captureRepositoryTarget } from "./rollout-aware-repository";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const context = Object.freeze({ accessToken: "owner-token", userId: OWNER_ID });

function repository(): CaptureRepository {
  return {
    createCapture: vi.fn<CaptureRepository["createCapture"]>(),
    deleteCapture: vi.fn<CaptureRepository["deleteCapture"]>(),
    getCapture: vi.fn<CaptureRepository["getCapture"]>(),
    getReceipt: vi.fn<CaptureRepository["getReceipt"]>(),
    listCaptures: vi.fn<CaptureRepository["listCaptures"]>(),
    retryCapture: vi.fn<CaptureRepository["retryCapture"]>()
  };
}

function readiness() {
  return {
    readyForEncryptedRead: false,
    requiredObjectCount: 1,
    exactVerifiedObjectCount: 0,
    missingObjectCount: 1,
    missingBySurface: { note_content: 1 },
    activeKeySlots: 4,
    taxonomyEpochReady: true,
    backfillComplete: false
  };
}

function rollout(state: "expanded" | "dual_write" | "encrypted_read") {
  return {
    found: true,
    state,
    writeMode: state === "expanded" ? "legacy" : "encrypted",
    readMode: state === "encrypted_read" ? "encrypted" : "legacy",
    backfill: {
      cursor: "01:note_content:note_01",
      complete: false,
      encryptedObjectCount: 0,
      verifiedObjectCount: 0
    },
    plaintextScrub: null,
    readiness: readiness()
  };
}

function response(value: unknown): Response {
  return Response.json(value);
}

describe("production capture repository composition", () => {
  it.each([
    ["expanded", "createCapture", "legacy"],
    ["expanded", "getCapture", "legacy"],
    ["dual_write", "createCapture", "encrypted"],
    ["dual_write", "getCapture", "legacy"],
    ["encrypted_read", "createCapture", "encrypted"],
    ["encrypted_read", "getCapture", "encrypted"],
    ["encrypted_only", "createCapture", "encrypted"],
    ["encrypted_only", "getCapture", "encrypted"],
    ["contracted", "createCapture", "encrypted"],
    ["contracted", "getCapture", "encrypted"]
  ] as const)("routes %s %s to %s", (state, method, target) => {
    expect(captureRepositoryTarget(state, method)).toBe(target);
  });

  it("routes dual-write writes to encrypted storage and reads to legacy storage", async () => {
    const legacy = repository();
    const encrypted = repository();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(rollout("dual_write")))
      .mockResolvedValueOnce(response(rollout("dual_write")));
    const composition = createProductionCaptureComposition({
      legacy,
      encrypted,
      fetch: fetcher,
      environment: {
        NEXT_PUBLIC_SUPABASE_URL: "https://capture-rollout.test",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key"
      }
    });

    await composition.createCapture(context, captureV1Fixture);
    await composition.listCaptures(context, { limit: 30 });
    expect(encrypted.createCapture).toHaveBeenCalledOnce();
    expect(legacy.createCapture).not.toHaveBeenCalled();
    expect(legacy.listCaptures).toHaveBeenCalledOnce();
    expect(encrypted.listCaptures).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["expanded", "legacy"],
    ["encrypted_read", "encrypted"]
  ] as const)("routes %s reads to %s storage", async (state, expected) => {
    const legacy = repository();
    const encrypted = repository();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(rollout(state)));
    const composition = createProductionCaptureComposition({
      legacy,
      encrypted,
      fetch: fetcher,
      environment: {
        NEXT_PUBLIC_SUPABASE_URL: "https://capture-rollout.test",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key"
      }
    });

    await composition.getCapture(context, captureV1Fixture.clientCaptureId);
    expect(expected === "legacy" ? legacy.getCapture : encrypted.getCapture).toHaveBeenCalledOnce();
    expect(expected === "legacy" ? encrypted.getCapture : legacy.getCapture).not.toHaveBeenCalled();
  });

  it("never falls back after malformed rollout or encrypted-runtime failures", async () => {
    const legacy = repository();
    const encrypted = repository();
    const malformedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response({ ...rollout("encrypted_read"), plaintextLeak: "do not accept" })
      );
    const malformed = createProductionCaptureComposition({
      legacy,
      encrypted,
      fetch: malformedFetch,
      environment: {
        NEXT_PUBLIC_SUPABASE_URL: "https://capture-rollout.test",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key"
      }
    });
    await expect(
      malformed.getCapture(context, captureV1Fixture.clientCaptureId)
    ).rejects.toBeInstanceOf(ServiceRpcError);
    expect(legacy.getCapture).not.toHaveBeenCalled();
    expect(encrypted.getCapture).not.toHaveBeenCalled();

    const kmsFailure = new Error("kms unavailable");
    vi.mocked(encrypted.createCapture).mockRejectedValueOnce(kmsFailure);
    const failedEncrypted = createProductionCaptureComposition({
      legacy,
      encrypted,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response(rollout("dual_write"))),
      environment: {
        NEXT_PUBLIC_SUPABASE_URL: "https://capture-rollout.test",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key"
      }
    });
    await expect(failedEncrypted.createCapture(context, captureV1Fixture)).rejects.toBe(kmsFailure);
    expect(legacy.createCapture).not.toHaveBeenCalled();
  });

  it("forwards the request abort signal to authoritative rollout lookup", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(rollout("expanded")));
    const composition = createProductionCaptureComposition({
      legacy: repository(),
      encrypted: repository(),
      fetch: fetcher,
      signal: controller.signal,
      environment: {
        NEXT_PUBLIC_SUPABASE_URL: "https://capture-rollout.test",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key"
      }
    });

    await composition.getReceipt(context, captureV1Fixture.clientCaptureId);
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
});
