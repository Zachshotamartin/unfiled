import {
  ApiErrorCode,
  AuthPasswordSignInRequestSchema,
  AuthPasswordSignUpRequestSchema,
  AuthRefreshRequestSchema
} from "@unfiled/contracts";

import { authenticateRequest, clearedSessionCookies, sessionCookies } from "@/server/auth/session";
import {
  consumeAuthQuota,
  supabaseAuthProvider,
  type AuthProvider,
  type AuthSession
} from "@/server/auth/supabase-auth";

import { errorResponse, HttpError, jsonResponse, readJsonObject } from "./errors";

export type AuthHandlerDependencies = Readonly<{
  consumeQuota?: (email: string, ipAddress: string) => Promise<void>;
  provider?: AuthProvider;
}>;

function clientIp(request: Request): string {
  const forwarded =
    request.headers.get("x-vercel-forwarded-for") ?? request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() ?? "unknown";
}

function invalidAuthBody(): HttpError {
  return new HttpError(
    400,
    ApiErrorCode.VALIDATION_FAILED,
    "Enter a valid email address and a password of at least 8 characters."
  );
}

function sessionResponse(session: AuthSession): Response {
  const expiresAt = new Date(Date.now() + session.expiresIn * 1_000).toISOString();
  return jsonResponse(
    {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt,
      user: session.user
    },
    200,
    sessionCookies(session)
  );
}

export function createAuthHandlers(dependencies: AuthHandlerDependencies = {}) {
  const provider = dependencies.provider ?? supabaseAuthProvider;
  const quota = dependencies.consumeQuota ?? consumeAuthQuota;

  return Object.freeze({
    /** Creates an account; every attempt consumes the hourly quota to slow enumeration. */
    async signUp(request: Request): Promise<Response> {
      try {
        const parsed = AuthPasswordSignUpRequestSchema.safeParse(await readJsonObject(request));
        if (!parsed.success) throw invalidAuthBody();
        await quota(parsed.data.email, clientIp(request));
        const session = await provider.signUp(parsed.data.email, parsed.data.password);
        return sessionResponse(session);
      } catch (error) {
        return errorResponse(error, request);
      }
    },

    /** Signs in; only rejected credentials consume the hourly quota, so normal use is never blocked. */
    async signIn(request: Request): Promise<Response> {
      try {
        const parsed = AuthPasswordSignInRequestSchema.safeParse(await readJsonObject(request));
        if (!parsed.success) throw invalidAuthBody();
        let session: AuthSession;
        try {
          session = await provider.signInWithPassword(parsed.data.email, parsed.data.password);
        } catch (error) {
          if (error instanceof HttpError && error.status === 401) {
            await quota(parsed.data.email, clientIp(request));
          }
          throw error;
        }
        return sessionResponse(session);
      } catch (error) {
        return errorResponse(error, request);
      }
    },

    async refresh(request: Request): Promise<Response> {
      try {
        const parsed = AuthRefreshRequestSchema.safeParse(await readJsonObject(request));
        if (!parsed.success) throw invalidAuthBody();
        const session = await provider.refresh(parsed.data.refreshToken);
        if (session === null) {
          throw new HttpError(
            401,
            ApiErrorCode.UNAUTHORIZED,
            "Your session has ended. Sign in again."
          );
        }
        const expiresAt = new Date(Date.now() + session.expiresIn * 1_000).toISOString();
        return jsonResponse(
          {
            accessToken: session.accessToken,
            refreshToken: session.refreshToken,
            expiresAt,
            user: session.user
          },
          200,
          sessionCookies(session)
        );
      } catch (error) {
        return errorResponse(error, request);
      }
    },

    async session(request: Request): Promise<Response> {
      try {
        const session = await authenticateRequest(request, provider);
        return jsonResponse({ user: session.user }, 200, session.cookies);
      } catch (error) {
        return errorResponse(error, request);
      }
    },

    async signOut(request: Request): Promise<Response> {
      try {
        const session = await authenticateRequest(request, provider);
        await provider.signOut(session.accessToken);
        return jsonResponse({ signedOut: true }, 200, clearedSessionCookies());
      } catch (error) {
        const response = errorResponse(error, request);
        for (const cookie of clearedSessionCookies()) response.headers.append("set-cookie", cookie);
        return response;
      }
    }
  });
}

export const authHandlers = createAuthHandlers();
