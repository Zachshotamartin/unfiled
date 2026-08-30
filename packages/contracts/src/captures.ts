import { z } from "zod";

import { CaptureSourceSchema, CaptureStatusSchema, PrivacyModeSchema } from "./enums.js";
import { ApiErrorCodeSchema } from "./errors.js";
import { entityIdSchema } from "./ids.js";

const rawContentSchema = z
  .string()
  .min(1)
  .max(10_000)
  .refine((value) => value.trim().length > 0, "Capture cannot contain only whitespace");

export const CaptureCreateRequestSchema = z.strictObject({
  clientCaptureId: entityIdSchema("cap"),
  rawContent: rawContentSchema,
  source: CaptureSourceSchema,
  deviceId: z.string().max(120).optional(),
  clientCreatedAt: z.iso.datetime({ offset: true }),
  clientTimezone: z.string().min(1).max(100),
  privacy: PrivacyModeSchema,
  explicitDestinationNoteId: entityIdSchema("note").optional(),
  expansionDisabled: z.boolean()
});

export type CaptureCreateRequest = z.infer<typeof CaptureCreateRequestSchema>;

export const CaptureSchema = z.strictObject({
  id: entityIdSchema("cap"),
  rawContent: rawContentSchema,
  source: CaptureSourceSchema,
  privacy: PrivacyModeSchema,
  clientCreatedAt: z.iso.datetime({ offset: true }),
  receivedAt: z.iso.datetime({ offset: true }),
  status: CaptureStatusSchema,
  lastErrorCode: ApiErrorCodeSchema.nullable()
});

export type Capture = z.infer<typeof CaptureSchema>;

export const CaptureCreateResponseSchema = z.strictObject({
  capture: CaptureSchema,
  jobId: entityIdSchema("job"),
  replayed: z.boolean()
});

export type CaptureCreateResponse = z.infer<typeof CaptureCreateResponseSchema>;
