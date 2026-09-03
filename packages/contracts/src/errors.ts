import { z } from "zod";

export const ApiErrorCode = {
  ACCOUNT_DELETION_FAILED: "account_deletion_failed",
  ACCOUNT_EXISTS: "account_exists",
  BUDGET_EXHAUSTED: "budget_exhausted",
  CAPTURE_TOO_LONG: "capture_too_long",
  CONFLICT_REQUIRES_REVIEW: "conflict_requires_review",
  FORBIDDEN: "forbidden",
  INVALID_CAPTURE: "invalid_capture",
  INVALID_IDEMPOTENCY_KEY: "invalid_idempotency_key",
  INVALID_PLAN: "invalid_plan",
  NOT_FOUND: "not_found",
  OFFLINE: "offline",
  PROVIDER_KEY_INVALID: "provider_key_invalid",
  PROVIDER_UNAVAILABLE: "provider_unavailable",
  RATE_LIMITED: "rate_limited",
  STALE_REVISION: "stale_revision",
  STRUCTURE_CONFLICT: "structure_conflict",
  UNAUTHORIZED: "unauthorized",
  VALIDATION_FAILED: "validation_failed"
} as const;

export const ApiErrorCodeSchema = z.enum(
  Object.values(ApiErrorCode) as [
    (typeof ApiErrorCode)[keyof typeof ApiErrorCode],
    ...(typeof ApiErrorCode)[keyof typeof ApiErrorCode][]
  ]
);

export type ApiErrorCodeValue = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = z.strictObject({
  code: ApiErrorCodeSchema,
  message: z.string().min(1).max(240),
  requestId: z.string().min(1),
  retryAfterSeconds: z.number().int().positive().optional(),
  details: z.record(z.string(), z.unknown()).optional()
});

export type ApiError = z.infer<typeof ApiErrorSchema>;
