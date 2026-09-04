"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

type PendingPrivateSearch = Readonly<{
  query: string;
  sequence: number;
}>;

type PrivateSearchNavigationValue = Readonly<{
  consume: (sequence: number) => void;
  pending: PendingPrivateSearch | null;
}>;

const EMPTY_PRIVATE_SEARCH_NAVIGATION: PrivateSearchNavigationValue = Object.freeze({
  consume: () => undefined,
  pending: null
});

const PrivateSearchNavigationContext = createContext<PrivateSearchNavigationValue>(
  EMPTY_PRIVATE_SEARCH_NAVIGATION
);

export function normalizePrivateSearchNavigationQuery(value: string): string {
  return value.trim().slice(0, 200);
}

/**
 * Carries private wiki-link and tag searches across product routes in memory.
 * The search text is intentionally never placed in a URL, browser history, or
 * persistent client storage.
 */
export function PrivateSearchNavigationProvider({ children }: Readonly<{ children: ReactNode }>) {
  const router = useRouter();
  const sequence = useRef(0);
  const [pending, setPending] = useState<PendingPrivateSearch | null>(null);

  const consume = useCallback((consumedSequence: number): void => {
    setPending((current) => (current?.sequence === consumedSequence ? null : current));
  }, []);

  const navigate = useCallback(
    (value: string): void => {
      const query = normalizePrivateSearchNavigationQuery(value);
      if (query.length === 0) return;
      sequence.current += 1;
      setPending({ query, sequence: sequence.current });
      // Search is the Library's own field rather than a destination (ADR-0019, decision 6).
      router.push("/app/library");
    },
    [router]
  );

  useEffect(() => {
    function handlePrivateSearchClick(event: MouseEvent): void {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        !(event.target instanceof Element)
      ) {
        return;
      }
      const control = event.target.closest<HTMLButtonElement>("button[data-private-search-query]");
      if (control === null || control.disabled) return;
      const query = control.dataset.privateSearchQuery;
      if (query === undefined) return;
      event.preventDefault();
      navigate(query);
    }

    document.addEventListener("click", handlePrivateSearchClick);
    return () => document.removeEventListener("click", handlePrivateSearchClick);
  }, [navigate]);

  const value = useMemo<PrivateSearchNavigationValue>(
    () => ({ consume, pending }),
    [consume, pending]
  );
  return (
    <PrivateSearchNavigationContext.Provider value={value}>
      {children}
    </PrivateSearchNavigationContext.Provider>
  );
}

export function usePrivateSearchNavigation(): PrivateSearchNavigationValue {
  return useContext(PrivateSearchNavigationContext);
}
