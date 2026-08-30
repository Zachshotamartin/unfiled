import { z } from "zod";

export const IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, "Use a portable idempotency key");

export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;

export const ExpectedRevisionSchema = z.number().int().positive();
export type ExpectedRevision = z.infer<typeof ExpectedRevisionSchema>;

export const IdempotentWriteSchema = z.strictObject({
  idempotencyKey: IdempotencyKeySchema
});

export const RevisionedWriteSchema = z.strictObject({
  expectedRevision: ExpectedRevisionSchema,
  idempotencyKey: IdempotencyKeySchema
});
