import { ApiErrorCode } from "@unfiled/contracts";

import { HttpError } from "../api/errors";
import type { AuthProvider, AuthSession, AuthUser } from "./supabase-auth";
import { supabaseAuthProvider } from "./supabase-auth";

export const ACCESS_COOKIE = "unfiled-access-token";
export const REFRESH_COOKIE = "unfiled-refresh-token";

export type AuthenticatedRequest = Readonly<{
  accessToken: string;
  cookies: readonly string[];
  user: AuthUser;
}>;

function cookieMap(request: Request): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
    const index = pair.indexOf("=");
    if (index < 1) continue;
    values.set(pair.slice(0, index).trim(), decodeURIComponent(pair.slice(index + 1).trim()));
  }
  return values;
}

function cookie(name: string, value: string, maxAge: number): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function sessionCookies(session: AuthSession): readonly string[] {
  return [
    cookie(ACCESS_COOKIE, session.accessToken, session.expiresIn),
    cookie(REFRESH_COOKIE, session.refreshToken, 60 * 60 * 24 * 30)
  ];
}

export function clearedSessionCookies(): readonly string[] {
  return [cookie(ACCESS_COOKIE, "", 0), cookie(REFRESH_COOKIE, "", 0)];
}

function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return null;
  const token = value.slice(7).trim();
  return token.length > 0 ? token : null;
}

export async function authenticateRequest(
  request: Request,
  provider: AuthProvider = supabaseAuthProvider
): Promise<AuthenticatedRequest> {
  const bearer = bearerToken(request);
  if (bearer !== null) {
    const user = await provider.getUser(bearer);
    if (user === null) {
      throw new HttpError(401, ApiErrorCode.UNAUTHORIZED, "Sign in to continue.");
    }
    return { accessToken: bearer, cookies: [], user };
  }

  const cookies = cookieMap(request);
  const accessToken = cookies.get(ACCESS_COOKIE);
  if (accessToken !== undefined) {
    const user = await provider.getUser(accessToken);
    if (user !== null) return { accessToken, cookies: [], user };
  }

  const refreshToken = cookies.get(REFRESH_COOKIE);
  const refreshed = refreshToken === undefined ? null : await provider.refresh(refreshToken);
  if (refreshed !== null) {
    return {
      accessToken: refreshed.accessToken,
      cookies: sessionCookies(refreshed),
      user: refreshed.user
    };
  }
  throw new HttpError(401, ApiErrorCode.UNAUTHORIZED, "Sign in to continue.");
}
