"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ProductApiError, productRequest } from "./client";

export type ResourceState<T> = Readonly<{
  data: T | null;
  error: string | null;
  loading: boolean;
  offline: boolean;
  refresh: () => Promise<void>;
  setData: (value: T) => void;
}>;

const LIVE_REFRESH_MS = 4_000;

export function useLiveResource<T>(url: string): ResourceState<T> {
  const mounted = useRef(true);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await productRequest<T>(url, { cache: "no-store" });
      if (!mounted.current) return;
      setData(next);
      setError(null);
      setOffline(false);
    } catch (reason) {
      if (!mounted.current) return;
      const apiError = reason instanceof ProductApiError ? reason : null;
      setOffline(apiError?.body.code === "offline");
      setError(apiError?.message ?? "Could not load this view.");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const handleRefresh = (): void => void refresh();
    const interval = window.setInterval(handleRefresh, LIVE_REFRESH_MS);
    window.addEventListener("focus", handleRefresh);
    window.addEventListener("online", handleRefresh);
    window.addEventListener("unfiled:change", handleRefresh);
    const channel =
      "BroadcastChannel" in window ? new BroadcastChannel("unfiled-product-events") : null;
    if (channel !== null) channel.onmessage = handleRefresh;

    return () => {
      mounted.current = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", handleRefresh);
      window.removeEventListener("online", handleRefresh);
      window.removeEventListener("unfiled:change", handleRefresh);
      channel?.close();
    };
  }, [refresh]);

  return { data, error, loading, offline, refresh, setData };
}
