import { ApiClientError, ApiClientMalformedResponseError } from "@unfiled/api-client";
import { describe, expect, it } from "vitest";

import { isAmbiguousProductMutationFailure } from "./browser-api";
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
});
