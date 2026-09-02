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

export type PagedResourceLoader<T> = (cursor?: string) => Promise<PagedResponse<T>>;

export type PagedContinuation<T> = Readonly<{
  error: string | null;
  firstPage: PagedResponse<T> | null;
  items: readonly T[];
  loading: boolean;
  pageInfo: PagedResponse<T>["pageInfo"] | null;
  url: string;
}>;

type PagedContinuationLoad<T> = Readonly<{
  firstPage: PagedResponse<T> | null;
  items: readonly T[];
  url: string;
}>;

export function emptyPagedContinuation<T>(
  url: string,
  firstPage: PagedResponse<T> | null
): PagedContinuation<T> {
  return { error: null, firstPage, items: [], loading: false, pageInfo: null, url };
}

export function continuationForFirstPage<T>(
  continuation: PagedContinuation<T>,
  url: string,
  firstPage: PagedResponse<T> | null
): PagedContinuation<T> {
  return continuation.url === url && continuation.firstPage === firstPage
    ? continuation
    : emptyPagedContinuation(url, firstPage);
}

export function applyContinuationPage<T>(
  continuation: PagedContinuation<T>,
  load: PagedContinuationLoad<T>,
  page: PagedResponse<T>
): PagedContinuation<T> {
  if (continuation.url !== load.url || continuation.firstPage !== load.firstPage) {
    return continuation;
  }
  return {
    error: null,
    firstPage: load.firstPage,
    items: [...load.items, ...page.items],
    loading: false,
    pageInfo: page.pageInfo,
    url: load.url
  };
}

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

export function usePagedResource<T>(
  url: string,
  keyOf: (item: T) => string,
  loader?: PagedResourceLoader<T>
) {
  const loadFirst = useCallback(
    () =>
      loader === undefined
        ? productRequest<PagedResponse<T>>(url, { cache: "no-store" })
        : loader(),
    [loader, url]
  );
  const first = useLiveResource<PagedResponse<T>>(url, loadFirst);
  const [continuation, setContinuation] = useState<PagedContinuation<T>>(() =>
    emptyPagedContinuation(url, null)
  );
  const current = continuationForFirstPage(continuation, url, first.data);
  const pageInfo = current.pageInfo ?? first.data?.pageInfo ?? null;

  const items = useMemo(() => {
    return mergePageItems(first.data?.items ?? [], current.items, keyOf);
  }, [current.items, first.data?.items, keyOf]);

  const loadMore = useCallback(async (): Promise<void> => {
    const cursor = pageInfo?.nextCursor;
    if (cursor === null || cursor === undefined || current.loading) return;
    const load = { firstPage: current.firstPage, items: current.items, url };
    setContinuation({ ...current, error: null, loading: true, url });
    try {
      const page =
        loader === undefined
          ? await productRequest<PagedResponse<T>>(
              `${url}${url.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`,
              { cache: "no-store" }
            )
          : await loader(cursor);
      setContinuation((latest) => applyContinuationPage(latest, load, page));
    } catch (reason) {
      setContinuation((latest) =>
        latest.url === load.url && latest.firstPage === load.firstPage
          ? {
              ...latest,
              error:
                reason instanceof Error ? reason.message : "The next page could not be loaded.",
              loading: false
            }
          : latest
      );
    }
  }, [current, loader, pageInfo?.nextCursor, url]);

  return {
    ...first,
    data: first.data === null || pageInfo === null ? null : { items, pageInfo },
    loadMore,
    loadingMore: current.loading,
    pageError: current.error
  };
}
