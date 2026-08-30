import type { ApiErrorCodeValue } from "@unfiled/contracts";

export class DomainError extends Error {
  public readonly code: ApiErrorCodeValue;

  public constructor(code: ApiErrorCodeValue, message: string) {
    super(`${code}: ${message}`);
    this.name = "DomainError";
    this.code = code;
  }
}
