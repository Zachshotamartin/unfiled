import type { AuthSession as ContractAuthSession } from "@unfiled/contracts";

export type AuthSession = ContractAuthSession;

export interface PersistedAuthState {
  lastProfileEmail: string | null;
  lastProfileId: string | null;
  session: AuthSession | null;
}

export interface AuthSessionStore {
  clearSession: () => Promise<void>;
  load: () => Promise<PersistedAuthState>;
  saveSession: (session: AuthSession) => Promise<void>;
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isSessionUsable(
  session: AuthSession | null,
  now = Date.now(),
  refreshWindowMs = 60_000
): boolean {
  if (session === null) return false;
  const expiresAt = Date.parse(session.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now + refreshWindowMs;
}

export function millisecondsUntilSessionRefresh(
  session: AuthSession | null,
  now = Date.now(),
  refreshWindowMs = 60_000
): number {
  if (session === null) return 0;
  const expiresAt = Date.parse(session.expiresAt);
  if (!Number.isFinite(expiresAt)) return 0;
  return Math.max(0, expiresAt - now - refreshWindowMs);
}

export function assertAuthSession(value: unknown): AuthSession {
  if (typeof value !== "object" || value === null) throw new TypeError("Invalid auth session");
  const record = value as Record<string, unknown>;
  const fields = ["accessToken", "expiresAt", "refreshToken"] as const;
  for (const field of fields) {
    if (typeof record[field] !== "string" || record[field].length === 0) {
      throw new TypeError(`Invalid auth session field: ${field}`);
    }
  }
  if (typeof record.user !== "object" || record.user === null) {
    throw new TypeError("Invalid auth session user");
  }
  const user = record.user as Record<string, unknown>;
  if (typeof user.id !== "string" || typeof user.email !== "string") {
    throw new TypeError("Invalid auth session user");
  }
  const session: AuthSession = {
    accessToken: record.accessToken as string,
    expiresAt: record.expiresAt as string,
    refreshToken: record.refreshToken as string,
    user: { email: normalizeEmail(user.email), id: user.id }
  };
  if (!Number.isFinite(Date.parse(session.expiresAt)))
    throw new TypeError("Invalid session expiry");
  return session;
}
