"use client";

import {
  ApiClientError,
  ApiClientMalformedResponseError,
  createApiClient
} from "@unfiled/api-client";

import { ProductApiError } from "./client";

export const browserApi = createApiClient({
  baseUrl: "",
  getAccessToken: () => Promise.resolve(null)
});

export function productErrorMessage(reason: unknown, fallback: string): string {
  if (reason instanceof ApiClientError) return reason.message;
  if (reason instanceof ProductApiError) return reason.message;
  return fallback;
}

export function productRetryAfterSeconds(reason: unknown): number | undefined {
  if (reason instanceof ApiClientError) return reason.error.retryAfterSeconds;
  if (reason instanceof ProductApiError) return reason.body.retryAfterSeconds;
  return undefined;
}

export function isStaleRevision(reason: unknown): boolean {
  return (
    (reason instanceof ApiClientError && reason.error.code === "stale_revision") ||
    (reason instanceof ProductApiError && reason.body.code === "stale_revision")
  );
}

export function isAmbiguousProductMutationFailure(reason: unknown): boolean {
  if (reason instanceof TypeError || reason instanceof ApiClientMalformedResponseError) return true;
  if (reason instanceof ApiClientError) {
    return (
      reason.status >= 500 ||
      reason.error.code === "offline" ||
      reason.error.code === "provider_unavailable"
    );
  }
  if (reason instanceof ProductApiError) {
    return (
      reason.status === 0 ||
      reason.status >= 500 ||
      reason.body.code === "offline" ||
      reason.body.code === "provider_unavailable"
    );
  }
  return false;
}

/**
 * Replays one exact idempotent mutation after a transport-ambiguous outcome.
 * Callers must close over an immutable request, including its idempotency key.
 */
export async function retryAmbiguousProductMutation<T>(mutation: () => Promise<T>): Promise<T> {
  try {
    return await mutation();
  } catch (reason) {
    if (!isAmbiguousProductMutationFailure(reason)) throw reason;
    return mutation();
  }
}
