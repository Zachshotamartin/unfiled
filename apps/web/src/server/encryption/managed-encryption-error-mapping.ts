import { ApiErrorCode, type ApiErrorCodeValue } from "@unfiled/contracts";
import {
  type EncryptedAggregateError,
  EncryptedAggregateErrorCode,
  type EncryptedAggregateErrorCodeValue
} from "@unfiled/encrypted-aggregate";

import { HttpError } from "@/server/api/errors";

import {
  type ServiceRpcError,
  ServiceRpcErrorCode,
  type ServiceRpcErrorCodeValue
} from "./service-rpc-client";

type HttpMapping = Readonly<{
  code: ApiErrorCodeValue;
  message: string;
  status: number;
}>;

const SERVICE_RPC_HTTP_MAPPING = {
  [ServiceRpcErrorCode.CONFLICT_REQUIRES_REVIEW]: {
    status: 409,
    code: ApiErrorCode.CONFLICT_REQUIRES_REVIEW,
    message: "That name is already in use."
  },
  [ServiceRpcErrorCode.FORBIDDEN]: {
    status: 403,
    code: ApiErrorCode.FORBIDDEN,
    message: "You do not have access to that item."
  },
  [ServiceRpcErrorCode.INVALID_IDEMPOTENCY_KEY]: {
    status: 409,
    code: ApiErrorCode.INVALID_IDEMPOTENCY_KEY,
    message: "That action key was already used for something different."
  },
  [ServiceRpcErrorCode.KEY_UNAVAILABLE]: {
    status: 503,
    code: ApiErrorCode.PROVIDER_UNAVAILABLE,
    message: "Encrypted storage is temporarily unavailable. Try again."
  },
  [ServiceRpcErrorCode.NOT_FOUND]: {
    status: 404,
    code: ApiErrorCode.NOT_FOUND,
    message: "That item was not found."
  },
  [ServiceRpcErrorCode.PROVIDER_UNAVAILABLE]: {
    status: 503,
    code: ApiErrorCode.PROVIDER_UNAVAILABLE,
    message: "Encrypted storage could not complete that action. Try again."
  },
  [ServiceRpcErrorCode.RATE_LIMITED]: {
    status: 429,
    code: ApiErrorCode.RATE_LIMITED,
    message: "Try again later."
  },
  [ServiceRpcErrorCode.ROUTING_RULE_DESTINATION_INVALID]: {
    status: 400,
    code: ApiErrorCode.VALIDATION_FAILED,
    message: "Choose an active destination and try again."
  },
  [ServiceRpcErrorCode.ROUTING_RULE_MATCH_STALE]: {
    status: 503,
    code: ApiErrorCode.PROVIDER_UNAVAILABLE,
    message: "Encrypted storage could not complete that action. Try again."
  },
  [ServiceRpcErrorCode.ROUTING_RULE_OBSERVATION_STALE]: {
    status: 503,
    code: ApiErrorCode.PROVIDER_UNAVAILABLE,
    message: "Encrypted storage could not complete that action. Try again."
  },
  [ServiceRpcErrorCode.STALE_MAINTENANCE_CURSOR]: {
    status: 503,
    code: ApiErrorCode.PROVIDER_UNAVAILABLE,
    message: "Encrypted storage could not complete that action. Try again."
  },
  [ServiceRpcErrorCode.STALE_REVISION]: {
    status: 409,
    code: ApiErrorCode.STALE_REVISION,
    message: ""
  },
  [ServiceRpcErrorCode.UNAUTHORIZED]: {
    status: 401,
    code: ApiErrorCode.UNAUTHORIZED,
    message: "Sign in to continue."
  },
  [ServiceRpcErrorCode.VALIDATION_FAILED]: {
    status: 400,
    code: ApiErrorCode.VALIDATION_FAILED,
    message: "Check this request and try again."
  }
} as const satisfies Record<ServiceRpcErrorCodeValue, HttpMapping>;

const AGGREGATE_HTTP_MAPPING = {
  [EncryptedAggregateErrorCode.AUTHORIZATION_FAILED]: {
    status: 403,
    code: ApiErrorCode.FORBIDDEN,
    message: "You do not have access to that item."
  },
  [EncryptedAggregateErrorCode.INVALID_INPUT]: {
    status: 400,
    code: ApiErrorCode.VALIDATION_FAILED,
    message: "Check this request and try again."
  },
  [EncryptedAggregateErrorCode.PAYLOAD_INVALID]: {
    status: 400,
    code: ApiErrorCode.VALIDATION_FAILED,
    message: "Check this request and try again."
  },
  [EncryptedAggregateErrorCode.REPLAY_MISMATCH]: {
    status: 409,
    code: ApiErrorCode.INVALID_IDEMPOTENCY_KEY,
    message: "That action key was already used for something different."
  },
  [EncryptedAggregateErrorCode.DECRYPTION_FAILED]: {
    status: 503,
    code: ApiErrorCode.PROVIDER_UNAVAILABLE,
    message: "Encrypted storage could not complete that action. Try again."
  },
  [EncryptedAggregateErrorCode.ENCRYPTION_FAILED]: {
    status: 503,
    code: ApiErrorCode.PROVIDER_UNAVAILABLE,
    message: "Encrypted storage could not complete that action. Try again."
  },
  [EncryptedAggregateErrorCode.INTEGRITY_CHECK_FAILED]: {
    status: 503,
    code: ApiErrorCode.PROVIDER_UNAVAILABLE,
    message: "Encrypted storage could not complete that action. Try again."
  },
  [EncryptedAggregateErrorCode.INVALID_RECORD]: {
    status: 503,
    code: ApiErrorCode.PROVIDER_UNAVAILABLE,
    message: "Encrypted storage could not complete that action. Try again."
  },
  [EncryptedAggregateErrorCode.KEY_CLASS_MISMATCH]: {
    status: 503,
    code: ApiErrorCode.PROVIDER_UNAVAILABLE,
    message: "Encrypted storage could not complete that action. Try again."
  },
  [EncryptedAggregateErrorCode.KEY_UNAVAILABLE]: {
    status: 503,
    code: ApiErrorCode.PROVIDER_UNAVAILABLE,
    message: "Encrypted storage is temporarily unavailable. Try again."
  },
  [EncryptedAggregateErrorCode.RESERVATION_INVALID]: {
    status: 503,
    code: ApiErrorCode.PROVIDER_UNAVAILABLE,
    message: "Encrypted storage could not complete that action. Try again."
  },
  [EncryptedAggregateErrorCode.UNSUPPORTED_RUNTIME]: {
    status: 503,
    code: ApiErrorCode.PROVIDER_UNAVAILABLE,
    message: "Encrypted storage could not complete that action. Try again."
  }
} as const satisfies Record<EncryptedAggregateErrorCodeValue, HttpMapping>;

function httpError(mapping: HttpMapping, cause: Error): HttpError {
  const error = new HttpError(mapping.status, mapping.code, mapping.message);
  error.cause = cause;
  return error;
}

export function mappedServiceRpcHttpError(
  error: ServiceRpcError,
  subject: "capture" | "note" | "provider key" | "routing rule" | "settings"
): HttpError {
  if (error.code === ServiceRpcErrorCode.STALE_REVISION) {
    return new HttpError(
      409,
      ApiErrorCode.STALE_REVISION,
      `This ${subject} changed somewhere else. Review the latest version.`
    );
  }
  return httpError(SERVICE_RPC_HTTP_MAPPING[error.code], error);
}

export function mappedEncryptedAggregateHttpError(error: EncryptedAggregateError): HttpError {
  return httpError(AGGREGATE_HTTP_MAPPING[error.code], error);
}
