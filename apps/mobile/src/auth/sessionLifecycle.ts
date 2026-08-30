import type { MobileAuthApi } from "./authApi";
import { MobileAuthError } from "./authApi";
import {
  isSessionUsable,
  type AuthSession,
  type AuthSessionStore,
  type PersistedAuthState
} from "./session";

export function shouldDiscardSessionAfterRefreshFailure(cause: unknown): boolean {
  return cause instanceof MobileAuthError && cause.status === 401 && cause.code === "unauthorized";
}

export async function restorePersistedAuthState(
  api: MobileAuthApi,
  store: AuthSessionStore
): Promise<PersistedAuthState> {
  const persisted = await store.load();
  if (persisted.session === null || isSessionUsable(persisted.session)) return persisted;

  let session: AuthSession;
  try {
    session = await api.refresh(persisted.session.refreshToken);
  } catch (cause) {
    if (!shouldDiscardSessionAfterRefreshFailure(cause)) return persisted;
    await store.clearSession();
    return { ...persisted, session: null };
  }

  await store.saveSession(session);
  return {
    lastProfileEmail: session.user.email,
    lastProfileId: session.user.id,
    session
  };
}

export async function clearLocalSessionThenRevokeRemote(
  session: AuthSession | null,
  api: MobileAuthApi,
  store: AuthSessionStore,
  onLocalSessionCleared: () => void = () => undefined
): Promise<void> {
  await store.clearSession();
  onLocalSessionCleared();
  if (session !== null) await api.signOut(session.accessToken);
}
