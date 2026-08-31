export const EncryptedAggregateErrorCode = Object.freeze({
  AUTHORIZATION_FAILED: "authorization_failed",
  DECRYPTION_FAILED: "decryption_failed",
  ENCRYPTION_FAILED: "encryption_failed",
  INTEGRITY_CHECK_FAILED: "integrity_check_failed",
  INVALID_INPUT: "invalid_input",
  INVALID_RECORD: "invalid_record",
  KEY_CLASS_MISMATCH: "key_class_mismatch",
  KEY_UNAVAILABLE: "key_unavailable",
  PAYLOAD_INVALID: "payload_invalid",
  REPLAY_MISMATCH: "replay_mismatch",
  RESERVATION_INVALID: "reservation_invalid",
  UNSUPPORTED_RUNTIME: "unsupported_runtime"
} as const);

export type EncryptedAggregateErrorCodeValue =
  (typeof EncryptedAggregateErrorCode)[keyof typeof EncryptedAggregateErrorCode];

export class EncryptedAggregateError extends Error {
  readonly code: EncryptedAggregateErrorCodeValue;

  constructor(code: EncryptedAggregateErrorCodeValue, message: string) {
    super(message);
    this.name = "EncryptedAggregateError";
    this.code = code;
  }
}

export function aggregateFailure(code: EncryptedAggregateErrorCodeValue, message: string): never {
  throw new EncryptedAggregateError(code, message);
}
