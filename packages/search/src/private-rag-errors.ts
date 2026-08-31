export const privateRagValidationErrorCodes = [
  "invalid_shape",
  "unsupported_version",
  "unsupported_encoding",
  "invalid_model",
  "invalid_dimensions",
  "invalid_base64url",
  "non_finite_embedding",
  "invalid_note_id",
  "invalid_revision",
  "invalid_text",
  "invalid_timestamp",
  "payload_too_large",
  "non_canonical_payload",
  "context_mismatch"
] as const;

export type PrivateRagValidationErrorCode = (typeof privateRagValidationErrorCodes)[number];

export class PrivateRagValidationError extends Error {
  readonly code: PrivateRagValidationErrorCode;

  constructor(code: PrivateRagValidationErrorCode) {
    super(code);
    this.name = "PrivateRagValidationError";
    this.code = code;
  }
}

export function privateRagValidationFailure(code: PrivateRagValidationErrorCode): never {
  throw new PrivateRagValidationError(code);
}
