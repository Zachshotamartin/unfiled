import { EncryptedAggregateErrorCode, aggregateFailure } from "./errors.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

declare const authorizedOwnerBrand: unique symbol;

export type AuthorizedOwnerAccess = Readonly<{
  [authorizedOwnerBrand]: true;
}>;

export type AuthorizeAggregateOwnerInput = Readonly<{
  authenticatedOwnerId: string;
  resourceOwnerId: string;
}>;

const ownerByAccess = new WeakMap<object, string>();

function canonicalOwnerId(value: string): string {
  const canonical = value.toLowerCase();
  if (!UUID_PATTERN.test(canonical) || canonical === NIL_UUID) {
    aggregateFailure(EncryptedAggregateErrorCode.AUTHORIZATION_FAILED, "Owner access is invalid");
  }
  return canonical;
}

export function authorizeAggregateOwner(
  input: AuthorizeAggregateOwnerInput
): AuthorizedOwnerAccess {
  const authenticatedOwnerId = canonicalOwnerId(input.authenticatedOwnerId);
  const resourceOwnerId = canonicalOwnerId(input.resourceOwnerId);
  if (authenticatedOwnerId !== resourceOwnerId) {
    aggregateFailure(EncryptedAggregateErrorCode.AUTHORIZATION_FAILED, "Owner access was denied");
  }
  const access = Object.freeze({}) as AuthorizedOwnerAccess;
  ownerByAccess.set(access, resourceOwnerId);
  return access;
}

export function ownerIdFromAccess(access: AuthorizedOwnerAccess): string {
  const ownerId = ownerByAccess.get(access);
  if (ownerId === undefined) {
    aggregateFailure(EncryptedAggregateErrorCode.AUTHORIZATION_FAILED, "Owner access was denied");
  }
  return ownerId;
}
