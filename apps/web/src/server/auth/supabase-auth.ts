import { createHmac } from "node:crypto";

import { ApiErrorCode } from "@unfiled/contracts";

import { ConfigurationError, HttpError } from "../api/errors";

export type AuthUser = Readonly<{ email: string; id: string }>;
export type AuthSession = Readonly<{
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  user: AuthUser;
}>;

type AuthConfiguration = Readonly<{
  anonKey: string;
  serviceRoleKey?: string;
  url: string;
}>;

function configuration(): AuthConfiguration {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (url === undefined || anonKey === undefined) throw new ConfigurationError();
  return {
    anonKey,
    url: url.replace(/\/$/u, ""),
    ...(process.env.SUPABASE_SERVICE_ROLE_KEY === undefined
      ? {}
      : { serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY })
  };
}

async function authFetch(path: string, init: RequestInit, bearer?: string): Promise<Response> {
  const config = configuration();
  const headers = new Headers(init.headers);
  headers.set("apikey", config.anonKey);
  headers.set("authorization", `Bearer ${bearer ?? config.anonKey}`);
  headers.set("content-type", "application/json");
  try {
    return await fetch(`${config.url}/auth/v1${path}`, { ...init, cache: "no-store", headers });
  } catch {
    throw providerUnavailable();
  }
}

function providerUnavailable(): HttpError {
  return new HttpError(
    503,
    ApiErrorCode.PROVIDER_UNAVAILABLE,
    "The identity service is temporarily unavailable. Try again."
  );
}

function providerRateLimit(response: Response): HttpError {
  return new HttpError(429, ApiErrorCode.RATE_LIMITED, "Try again later.", {
    retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")) ?? 60
  });
}

function requireAuthSession(value: unknown): AuthSession {
  const session = authSession(value);
  if (session === null) throw providerUnavailable();
  return session;
}

function authUser(value: unknown): AuthUser | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string") return null;
  return { id: record.id, email: typeof record.email === "string" ? record.email : "" };
}

function authSession(value: unknown): AuthSession | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const user = authUser(record.user);
  if (
    user === null ||
    typeof record.access_token !== "string" ||
    typeof record.refresh_token !== "string" ||
    typeof record.expires_in !== "number"
  ) {
    return null;
  }
  return {
    accessToken: record.access_token,
    refreshToken: record.refresh_token,
    expiresIn: record.expires_in,
    user
  };
}

export interface AuthProvider {
  getUser(accessToken: string): Promise<AuthUser | null>;
  refresh(refreshToken: string): Promise<AuthSession | null>;
  signInWithPassword(email: string, password: string): Promise<AuthSession>;
  signOut(accessToken: string): Promise<void>;
  /**
   * A session when the deployment confirms nothing, or null when it emailed a code and is
   * waiting for it. Null is a normal outcome, not a failure.
   */
  signUp(email: string, password: string): Promise<AuthSession | null>;
  /** Exchanges the emailed code for a session. */
  verifyEmail(email: string, code: string): Promise<AuthSession>;
  /** Sends another code. Says nothing about whether the address has an account. */
  resendVerification(email: string): Promise<void>;
}

function providerMessage(value: unknown): string {
  if (value === null || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const candidate = record.msg ?? record.message ?? record.error_description ?? record.error;
  return typeof candidate === "string" ? candidate.toLowerCase() : "";
}

export const supabaseAuthProvider: AuthProvider = {
  async getUser(accessToken) {
    const response = await authFetch("/user", { method: "GET" }, accessToken);
    if (response.status === 401 || response.status === 403) return null;
    if (response.status === 429) throw providerRateLimit(response);
    if (!response.ok) throw providerUnavailable();
    const user = authUser(await response.json().catch(() => null));
    if (user === null) throw providerUnavailable();
    return user;
  },
  async refresh(refreshToken) {
    const response = await authFetch("/token?grant_type=refresh_token", {
      method: "POST",
      body: JSON.stringify({ refresh_token: refreshToken })
    });
    if (response.status === 400 || response.status === 401 || response.status === 403) return null;
    if (response.status === 429) throw providerRateLimit(response);
    if (!response.ok) throw providerUnavailable();
    return requireAuthSession(await response.json().catch(() => null));
  },
  async signInWithPassword(email, password) {
    const response = await authFetch("/token?grant_type=password", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new HttpError(401, ApiErrorCode.UNAUTHORIZED, "Email or password is incorrect.");
    }
    if (response.status === 429) throw providerRateLimit(response);
    if (!response.ok) throw providerUnavailable();
    return requireAuthSession(await response.json().catch(() => null));
  },
  async signOut(accessToken) {
    const response = await authFetch("/logout?scope=global", { method: "POST" }, accessToken);
    if (response.status === 429) throw providerRateLimit(response);
    if (!response.ok) throw providerUnavailable();
  },
  async verifyEmail(email, code) {
    const response = await authFetch("/verify", {
      method: "POST",
      body: JSON.stringify({ type: "signup", email, token: code })
    });
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new HttpError(
        401,
        ApiErrorCode.UNAUTHORIZED,
        "That code is wrong or has expired. Ask for a new one."
      );
    }
    if (response.status === 429) throw providerRateLimit(response);
    if (!response.ok) throw providerUnavailable();
    return requireAuthSession(await response.json().catch(() => null));
  },
  async resendVerification(email) {
    const response = await authFetch("/resend", {
      method: "POST",
      body: JSON.stringify({ type: "signup", email })
    });
    if (response.status === 429) throw providerRateLimit(response);
    // An address without a pending confirmation is answered the same way as one with it, so a
    // caller cannot learn which addresses have accounts.
    if (response.status === 400 || response.status === 422) return;
    if (!response.ok) throw providerUnavailable();
  },
  async signUp(email, password) {
    const response = await authFetch("/signup", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });
    const body: unknown = await response.json().catch(() => null);
    if (response.status === 400 || response.status === 422) {
      const message = providerMessage(body);
      if (message.includes("already") || message.includes("registered")) {
        throw new HttpError(
          409,
          ApiErrorCode.ACCOUNT_EXISTS,
          "An account with this email already exists. Sign in instead."
        );
      }
      if (message.includes("password")) {
        throw new HttpError(400, ApiErrorCode.VALIDATION_FAILED, "Choose a longer password.");
      }
      throw new HttpError(400, ApiErrorCode.VALIDATION_FAILED, "Check your email and password.");
    }
    if (response.status === 429) throw providerRateLimit(response);
    if (!response.ok) throw providerUnavailable();
    const session = authSession(body);
    if (session === null) {
      // The account exists and the provider emailed a code instead of a session. The owner
      // finishes at verifyEmail; nothing has gone wrong.
      return null;
    }
    return session;
  }
};

interface QuotaEntry {
  readonly at: number;
  readonly key: string;
}
const localQuota: QuotaEntry[] = [];
const HOUR_MS = 60 * 60 * 1_000;

function parseRetryAfter(value: string | null): number | null {
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds > 0 && seconds <= 3_600 ? seconds : null;
}

function localRetryAfter(key: string, limit: number, timestamp: number): number {
  const attempts = localQuota.filter((entry) => entry.key === key);
  if (attempts.length < limit || attempts[0] === undefined) return 0;
  return Math.max(1, Math.min(3_600, Math.ceil((attempts[0].at + HOUR_MS - timestamp) / 1_000)));
}

function hmac(value: string): string {
  const pepper = process.env.AUTH_RATE_LIMIT_PEPPER ?? "unfiled-local-auth-rate-limit";
  return createHmac("sha256", pepper).update(value).digest("hex");
}

/** Hourly per-email and per-IP attempt quota shared by account creation and failed sign-ins. */
export async function consumeAuthQuota(email: string, ipAddress: string): Promise<void> {
  const config = configuration();
  const emailHash = hmac(`email:${email}`);
  const ipHash = hmac(`ip:${ipAddress}`);

  if (config.serviceRoleKey !== undefined && process.env.AUTH_RATE_LIMIT_PEPPER !== undefined) {
    const response = await fetch(`${config.url}/rest/v1/rpc/consume_auth_otp_quota`, {
      method: "POST",
      headers: {
        apikey: config.serviceRoleKey,
        authorization: `Bearer ${config.serviceRoleKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ p_email_hash: emailHash, p_ip_hash: ipHash })
    });
    const result: unknown = await response.json().catch(() => null);
    const errorCode =
      result !== null && typeof result === "object" && "code" in result
        ? (result as { code?: unknown }).code
        : undefined;
    if (response.status === 429 || errorCode === ApiErrorCode.RATE_LIMITED) {
      throw new HttpError(429, ApiErrorCode.RATE_LIMITED, "Too many attempts. Try again later.", {
        retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")) ?? 60
      });
    }
    if (!response.ok) {
      throw new HttpError(
        503,
        ApiErrorCode.PROVIDER_UNAVAILABLE,
        "Sign-in is temporarily unavailable. Try again."
      );
    }
    if (
      result === null ||
      typeof result !== "object" ||
      (result as { allowed?: unknown }).allowed !== true
    ) {
      throw new HttpError(
        503,
        ApiErrorCode.PROVIDER_UNAVAILABLE,
        "Sign-in is temporarily unavailable. Try again."
      );
    }
    return;
  }

  if (process.env.NODE_ENV === "production") throw new ConfigurationError();
  const now = Date.now();
  while (localQuota[0] !== undefined && now - localQuota[0].at >= HOUR_MS) localQuota.shift();
  const emailCount = localQuota.filter((entry) => entry.key === emailHash).length;
  const ipCount = localQuota.filter((entry) => entry.key === ipHash).length;
  if (emailCount >= 5 || ipCount >= 20) {
    const retryAfterSeconds = Math.max(
      localRetryAfter(emailHash, 5, now),
      localRetryAfter(ipHash, 20, now)
    );
    throw new HttpError(429, ApiErrorCode.RATE_LIMITED, "Too many attempts. Try again later.", {
      retryAfterSeconds
    });
  }
  localQuota.push({ at: now, key: emailHash }, { at: now, key: ipHash });
}
