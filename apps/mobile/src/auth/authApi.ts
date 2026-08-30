import { ApiClientError, createApiClient } from "@unfiled/api-client";

import { normalizeEmail, type AuthSession } from "./session";

export class MobileAuthError extends Error {
  readonly code: string;
  readonly retryAfterSeconds: number | undefined;
  readonly status: number;

  constructor(code: string, message: string, status: number, retryAfterSeconds?: number) {
    super(message);
    this.name = "MobileAuthError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function mobileAuthErrorMessage(error: MobileAuthError): string {
  return error.retryAfterSeconds === undefined
    ? error.message
    : `${error.message} Try again in ${error.retryAfterSeconds}s.`;
}

export interface MobileAuthApi {
  refresh: (refreshToken: string) => Promise<AuthSession>;
  requestCode: (email: string) => Promise<number>;
  signOut: (accessToken: string) => Promise<void>;
  verifyCode: (email: string, code: string) => Promise<AuthSession>;
}

type FetchLike = typeof fetch;

function mapError(reason: unknown): MobileAuthError {
  if (reason instanceof ApiClientError) {
    return new MobileAuthError(
      reason.error.code,
      reason.error.message,
      reason.status,
      reason.error.retryAfterSeconds
    );
  }
  if (reason instanceof Error && reason.name === "ZodError") {
    return new MobileAuthError("validation_failed", "Check your sign-in details.", 400);
  }
  return new MobileAuthError("offline", "Connect to the internet and try again.", 0);
}

async function mapResult<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (reason) {
    throw mapError(reason);
  }
}

export function createMobileAuthApi(baseUrl: string, fetcher: FetchLike = fetch): MobileAuthApi {
  const client = createApiClient({
    baseUrl,
    fetch: fetcher,
    getAccessToken: () => Promise.resolve(null)
  });
  const apiOrigin = baseUrl.replace(/\/+$/u, "");

  return {
    refresh: (refreshToken) => mapResult(() => client.refreshAuth({ refreshToken })),

    async requestCode(email): Promise<number> {
      const response = await mapResult(() => client.requestOtp({ email: normalizeEmail(email) }));
      return response.retryAfterSeconds;
    },

    async signOut(accessToken): Promise<void> {
      let response: Response;
      try {
        response = await fetcher(`${apiOrigin}/api/v1/auth/sign-out`, {
          headers: { authorization: `Bearer ${accessToken}` },
          method: "POST"
        });
      } catch {
        throw new MobileAuthError("offline", "Connect to the internet and try again.", 0);
      }
      if (!response.ok) {
        throw new MobileAuthError(
          "request_failed",
          "Remote sign-out could not finish.",
          response.status
        );
      }
    },

    verifyCode: (email, code) =>
      mapResult(() => client.verifyOtp({ code, email: normalizeEmail(email) }))
  };
}

export const mobileAuthApi = createMobileAuthApi(
  process.env.EXPO_PUBLIC_API_BASE_URL ?? "http://localhost:3000"
);
