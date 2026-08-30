"use client";

import { useCallback, useMemo, useState } from "react";

import { productRequest } from "./client";
import { useLiveResource } from "./use-live-resource";

export type PagedResponse<T> = Readonly<{
  items: readonly T[];
  pageInfo: Readonly<{
    hasMore: boolean;
    nextCursor: string | null;
  }>;
}>;

export function mergePageItems<T>(
  first: readonly T[],
  continuation: readonly T[],
  keyOf: (item: T) => string
): readonly T[] {
  const unique = new Map<string, T>();
  for (const item of first) unique.set(keyOf(item), item);
  for (const item of continuation) {
    const key = keyOf(item);
    if (!unique.has(key)) unique.set(key, item);
  }
  for (const item of first) unique.set(keyOf(item), item);
  return [...unique.values()];
}

export function usePagedResource<T>(url: string, keyOf: (item: T) => string) {
  const first = useLiveResource<PagedResponse<T>>(url);
  const [continuation, setContinuation] = useState<
    Readonly<{
      error: string | null;
      items: readonly T[];
      loading: boolean;
      pageInfo: PagedResponse<T>["pageInfo"] | null;
      url: string;
    }>
  >({ error: null, items: [], loading: false, pageInfo: null, url });
  const current =
    continuation.url === url
      ? continuation
      : { error: null, items: [], loading: false, pageInfo: null, url };
  const pageInfo = current.pageInfo ?? first.data?.pageInfo ?? null;

  const items = useMemo(() => {
    return mergePageItems(first.data?.items ?? [], current.items, keyOf);
  }, [current.items, first.data?.items, keyOf]);

  const loadMore = useCallback(async (): Promise<void> => {
    const cursor = pageInfo?.nextCursor;
    if (cursor === null || cursor === undefined || current.loading) return;
    setContinuation({ ...current, error: null, loading: true, url });
    try {
      const separator = url.includes("?") ? "&" : "?";
      const page = await productRequest<PagedResponse<T>>(
        `${url}${separator}cursor=${encodeURIComponent(cursor)}`,
        { cache: "no-store" }
      );
      setContinuation({
        error: null,
        items: [...current.items, ...page.items],
        loading: false,
        pageInfo: page.pageInfo,
        url
      });
    } catch (reason) {
      setContinuation({
        ...current,
        error: reason instanceof Error ? reason.message : "The next page could not be loaded.",
        loading: false,
        url
      });
    }
  }, [current, pageInfo?.nextCursor, url]);

  return {
    ...first,
    data: first.data === null || pageInfo === null ? null : { items, pageInfo },
    loadMore,
    loadingMore: current.loading,
    pageError: current.error
  };
}
