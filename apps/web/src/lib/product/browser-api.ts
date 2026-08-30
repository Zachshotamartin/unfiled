"use client";

import { ApiClientError, createApiClient } from "@unfiled/api-client";

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
