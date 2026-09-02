/**
 * The only operational error exposed by the user-search boundary.
 *
 * Deliberately carries no provider, database, ticket, owner, query, or
 * transport detail. Callers may safely map every instance to lexical-only
 * search without logging the rejected input.
 */
export class EncryptedUserSearchError extends Error {
  public constructor() {
    super("Encrypted semantic search is unavailable.");
    this.name = "EncryptedUserSearchError";
  }
}

export function encryptedUserSearchFailure(): never {
  throw new EncryptedUserSearchError();
}
