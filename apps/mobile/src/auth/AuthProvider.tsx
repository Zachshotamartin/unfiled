import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
  type ReactElement
} from "react";
import { AppState } from "react-native";

import { mobileAuthApi, type MobileAuthApi } from "./authApi";
import {
  isSessionUsable,
  millisecondsUntilSessionRefresh,
  type AuthSession,
  type AuthSessionStore
} from "./session";
import {
  clearLocalSessionThenRevokeRemote,
  restorePersistedAuthState,
  shouldDiscardSessionAfterRefreshFailure
} from "./sessionLifecycle";
import { secureAuthSessionStore } from "./sessionRepository";

type AuthStatus = "loading" | "signed_in" | "signed_out";

interface AuthContextValue {
  getAccessToken: () => Promise<string | null>;
  lastProfileEmail: string | null;
  lastProfileId: string | null;
  requestCode: (email: string) => Promise<number>;
  session: AuthSession | null;
  signOut: () => Promise<void>;
  status: AuthStatus;
  verifyCode: (email: string, code: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface AuthProviderProps extends PropsWithChildren {
  api?: MobileAuthApi;
  store?: AuthSessionStore;
}

export function AuthProvider({
  api = mobileAuthApi,
  children,
  store = secureAuthSessionStore
}: AuthProviderProps): ReactElement {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [session, setSession] = useState<AuthSession | null>(null);
  const [lastProfileEmail, setLastProfileEmail] = useState<string | null>(null);
  const [lastProfileId, setLastProfileId] = useState<string | null>(null);
  const [refreshAttempt, setRefreshAttempt] = useState(0);
  const sessionRef = useRef<AuthSession | null>(null);
  const refreshPromiseRef = useRef<Promise<string | null> | null>(null);

  const publishSession = useCallback((nextSession: AuthSession | null): void => {
    sessionRef.current = nextSession;
    setSession(nextSession);
    setRefreshAttempt(0);
    if (nextSession !== null) {
      setLastProfileEmail(nextSession.user.email);
      setLastProfileId(nextSession.user.id);
    }
    setStatus(nextSession === null ? "signed_out" : "signed_in");
  }, []);

  useEffect(() => {
    let active = true;
    const isActive = (): boolean => active;
    void restorePersistedAuthState(api, store)
      .then((persisted) => {
        if (!isActive()) return;
        setLastProfileEmail(persisted.lastProfileEmail);
        setLastProfileId(persisted.lastProfileId);
        publishSession(persisted.session);
      })
      .catch(() => {
        if (isActive()) publishSession(null);
      });
    return () => {
      active = false;
    };
  }, [api, publishSession, store]);

  const getAccessToken = useCallback(async (): Promise<string | null> => {
    const readSession = (): AuthSession | null => sessionRef.current;
    const current = readSession();
    if (current === null) return null;
    if (isSessionUsable(current)) return current.accessToken;
    if (refreshPromiseRef.current !== null) return refreshPromiseRef.current;

    const refresh = (async (): Promise<string | null> => {
      try {
        const nextSession = await api.refresh(current.refreshToken);
        if (readSession() !== current) return readSession()?.accessToken ?? null;
        await store.saveSession(nextSession);
        const replacement = readSession();
        if (replacement !== current) {
          if (replacement === null) await store.clearSession();
          else await store.saveSession(replacement);
          return replacement?.accessToken ?? null;
        }
        publishSession(nextSession);
        return nextSession.accessToken;
      } catch (cause) {
        if (shouldDiscardSessionAfterRefreshFailure(cause) && sessionRef.current === current) {
          await store.clearSession();
          publishSession(null);
        }
        throw cause;
      } finally {
        refreshPromiseRef.current = null;
      }
    })();
    refreshPromiseRef.current = refresh;
    return refresh;
  }, [api, publishSession, store]);

  useEffect(() => {
    if (session === null) return;
    const refreshDelay = millisecondsUntilSessionRefresh(session);
    const delay = refreshAttempt > 0 ? Math.max(refreshDelay, 30_000) : refreshDelay;
    const timer = setTimeout(
      () => {
        void getAccessToken().catch(() => {
          setRefreshAttempt((attempt) => attempt + 1);
        });
      },
      Math.min(Math.max(delay, 250), 2_147_000_000)
    );
    return () => clearTimeout(timer);
  }, [getAccessToken, refreshAttempt, session]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void getAccessToken().catch(() => undefined);
    });
    return () => subscription.remove();
  }, [getAccessToken]);

  const requestCode = useCallback(
    (email: string): Promise<number> => api.requestCode(email),
    [api]
  );

  const verifyCode = useCallback(
    async (email: string, code: string): Promise<void> => {
      const nextSession = await api.verifyCode(email, code);
      await store.saveSession(nextSession);
      publishSession(nextSession);
    },
    [api, publishSession, store]
  );

  const signOut = useCallback(async (): Promise<void> => {
    const current = sessionRef.current;
    await clearLocalSessionThenRevokeRemote(current, api, store, () => publishSession(null));
  }, [api, publishSession, store]);

  const value = useMemo<AuthContextValue>(
    () => ({
      getAccessToken,
      lastProfileEmail,
      lastProfileId,
      requestCode,
      session,
      signOut,
      status,
      verifyCode
    }),
    [
      getAccessToken,
      lastProfileEmail,
      lastProfileId,
      requestCode,
      session,
      signOut,
      status,
      verifyCode
    ]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useSession(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === null) throw new Error("useSession must be used inside AuthProvider");
  return context;
}
