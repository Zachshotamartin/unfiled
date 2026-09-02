import { ApiClientError, ApiClientMalformedResponseError } from "@unfiled/api-client";
import { describe, expect, it, vi } from "vitest";

import { isAmbiguousProductMutationFailure, retryAmbiguousProductMutation } from "./browser-api";
import { ProductApiError } from "./client";

const apiError = (code: "offline" | "provider_unavailable" | "stale_revision") => ({
  code,
  message: code,
  requestId: "req_test"
});

describe("browser API mutation errors", () => {
  it("retains idempotency keys for network and provider-availability ambiguity", () => {
    expect(isAmbiguousProductMutationFailure(new TypeError("fetch failed"))).toBe(true);
    expect(isAmbiguousProductMutationFailure(new ApiClientMalformedResponseError(200))).toBe(true);
    expect(
      isAmbiguousProductMutationFailure(new ApiClientError(503, apiError("provider_unavailable")))
    ).toBe(true);
    expect(isAmbiguousProductMutationFailure(new ProductApiError(0, apiError("offline")))).toBe(
      true
    );
  });

  it("allows a fresh key after a deterministic stale-revision response", () => {
    expect(
      isAmbiguousProductMutationFailure(new ApiClientError(409, apiError("stale_revision")))
    ).toBe(false);
  });

  it("replays one exact operation after a transport-ambiguous failure", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce("durable receipt");

    await expect(retryAmbiguousProductMutation(operation)).resolves.toBe("durable receipt");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not replay a definitive failure", async () => {
    const failure = new Error("definitive");
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(failure);

    await expect(retryAmbiguousProductMutation(operation)).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("surfaces a second ambiguous failure without looping", async () => {
    const failure = new TypeError("still offline");
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(failure);

    await expect(retryAmbiguousProductMutation(operation)).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
