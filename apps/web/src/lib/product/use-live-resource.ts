"use client";

import { ApiClientError } from "@unfiled/api-client";
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

export interface ResourceLoadEpoch {
  current: number;
}

export interface ResourceLoadFlight {
  current: Promise<void> | null;
}

type ResourceLoadCallbacks<T> = Readonly<{
  rejected: (reason: unknown) => void;
  resolved: (value: T) => void;
  settled: () => void;
}>;

export function supersedeResourceLoads(epoch: ResourceLoadEpoch): void {
  epoch.current += 1;
}

export async function runLatestResourceLoad<T>(
  epoch: ResourceLoadEpoch,
  loader: () => Promise<T>,
  callbacks: ResourceLoadCallbacks<T>
): Promise<void> {
  const requestEpoch = epoch.current + 1;
  epoch.current = requestEpoch;
  try {
    const value = await loader();
    if (epoch.current === requestEpoch) callbacks.resolved(value);
  } catch (reason) {
    if (epoch.current === requestEpoch) callbacks.rejected(reason);
  } finally {
    if (epoch.current === requestEpoch) callbacks.settled();
  }
}

/** Coalesces background polling without changing explicit latest-request-wins refreshes. */
export function runCoalescedResourceLoad(
  flight: ResourceLoadFlight,
  load: () => Promise<void>
): Promise<void> {
  if (flight.current !== null) return flight.current;
  const operation = Promise.resolve().then(load);
  flight.current = operation;
  void operation.then(
    () => {
      if (flight.current === operation) flight.current = null;
    },
    () => {
      if (flight.current === operation) flight.current = null;
    }
  );
  return operation;
}

export function useLiveResource<T>(url: string, loader?: () => Promise<T>): ResourceState<T> {
  const mounted = useRef(true);
  const loadEpoch = useRef(0);
  const scheduledLoad = useRef<Promise<void> | null>(null);
  const [data, setResourceData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    await runLatestResourceLoad(
      loadEpoch,
      () => (loader === undefined ? productRequest<T>(url, { cache: "no-store" }) : loader()),
      {
        resolved(next) {
          if (!mounted.current) return;
          setResourceData(next);
          setError(null);
          setOffline(false);
        },
        rejected(reason) {
          if (!mounted.current) return;
          const apiError = reason instanceof ProductApiError ? reason : null;
          const clientError = reason instanceof ApiClientError ? reason : null;
          setOffline(
            apiError?.body.code === "offline" ||
              clientError?.error.code === "offline" ||
              reason instanceof TypeError
          );
          setError(apiError?.message ?? clientError?.message ?? "Could not load this view.");
        },
        settled() {
          if (mounted.current) setLoading(false);
        }
      }
    );
  }, [loader, url]);

  const setData = useCallback((value: T): void => {
    supersedeResourceLoads(loadEpoch);
    if (!mounted.current) return;
    setResourceData(value);
    setError(null);
    setOffline(false);
    setLoading(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const handleRefresh = (): void => void refresh();
    const handleScheduledRefresh = (): void => {
      void runCoalescedResourceLoad(scheduledLoad, refresh);
    };
    const interval = window.setInterval(handleScheduledRefresh, LIVE_REFRESH_MS);
    window.addEventListener("focus", handleRefresh);
    window.addEventListener("online", handleRefresh);
    window.addEventListener("unfiled:change", handleRefresh);
    const channel =
      "BroadcastChannel" in window ? new BroadcastChannel("unfiled-product-events") : null;
    if (channel !== null) channel.onmessage = handleRefresh;

    return () => {
      mounted.current = false;
      supersedeResourceLoads(loadEpoch);
      scheduledLoad.current = null;
      window.clearInterval(interval);
      window.removeEventListener("focus", handleRefresh);
      window.removeEventListener("online", handleRefresh);
      window.removeEventListener("unfiled:change", handleRefresh);
      channel?.close();
    };
  }, [refresh]);

  return { data, error, loading, offline, refresh, setData };
}
