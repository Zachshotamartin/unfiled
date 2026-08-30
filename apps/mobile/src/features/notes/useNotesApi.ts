import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";

import { useSession } from "../../auth/AuthProvider";
import {
  createMobileNotesApi,
  MobileNotesError,
  type MobileNoteDetail,
  type MobileNoteSummary,
  type MobileNotesApi,
  type MobileReviewItem,
  type MobileSearchResult,
  type MobileSpace,
  type MobileTag
} from "./mobileNotesApi";

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL ?? "http://localhost:3000";

export function useMobileNotesApi(): MobileNotesApi | null {
  const { getAccessToken, session } = useSession();
  return useMemo(
    () => (session === null ? null : createMobileNotesApi(API_BASE_URL, getAccessToken)),
    [getAccessToken, session]
  );
}

interface Resource<T> {
  error: string | null;
  loading: boolean;
  refresh(): Promise<void>;
  value: T;
}

function messageFor(error: unknown): string {
  return error instanceof MobileNotesError ? error.message : "Couldn't load this from Unfiled.";
}

function useResource<T>(initialValue: T, load: (() => Promise<T>) | null): Resource<T> {
  const [value, setValue] = useState(initialValue);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (load === null) return;
    setError(null);
    try {
      setValue(await load());
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setLoading(false);
    }
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh])
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  useEffect(() => {
    if (load === null) return;
    const timer = setInterval(() => void refresh(), 4_000);
    return () => clearInterval(timer);
  }, [load, refresh]);

  return { error, loading, refresh, value };
}

export function useNoteList(
  options: { archived?: boolean; deleted?: boolean; spaceId?: string } = {}
): Resource<MobileNoteSummary[]> {
  const api = useMobileNotesApi();
  const archived = options.archived;
  const deleted = options.deleted;
  const spaceId = options.spaceId;
  const load = useCallback(
    () => api?.listNotes({ archived, deleted, spaceId }) ?? Promise.resolve([]),
    [api, archived, deleted, spaceId]
  );
  return useResource([], api === null ? null : load);
}

export function useNoteDetail(noteId: string): Resource<MobileNoteDetail | null> {
  const api = useMobileNotesApi();
  const load = useCallback(() => api?.getNote(noteId) ?? Promise.resolve(null), [api, noteId]);
  return useResource(null, api === null ? null : load);
}

export function useSpaces(): Resource<MobileSpace[]> {
  const api = useMobileNotesApi();
  const load = useCallback(() => api?.listSpaces() ?? Promise.resolve([]), [api]);
  return useResource([], api === null ? null : load);
}

export function useTags(): Resource<MobileTag[]> {
  const api = useMobileNotesApi();
  const load = useCallback(() => api?.listTags() ?? Promise.resolve([]), [api]);
  return useResource([], api === null ? null : load);
}

export function useReviewItems(): Resource<MobileReviewItem[]> {
  const api = useMobileNotesApi();
  const load = useCallback(() => api?.listReviewItems() ?? Promise.resolve([]), [api]);
  return useResource([], api === null ? null : load);
}

export function useSearchResults(
  query: string,
  includeArchived: boolean
): Resource<MobileSearchResult[]> {
  const api = useMobileNotesApi();
  const trimmed = query.trim();
  const load = useCallback(
    () =>
      api === null || trimmed.length === 0
        ? Promise.resolve([])
        : api.search(trimmed, includeArchived),
    [api, includeArchived, trimmed]
  );
  return useResource([], api === null ? null : load);
}
